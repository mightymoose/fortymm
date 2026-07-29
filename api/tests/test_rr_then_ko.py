"""Round-robin then knockout, end to end (#1227, ADR "rr-then-ko cuts both stages
upfront and seeds qualifiers rematch-free").

The draw strategy, the results strategy and the qualifier-seed assignment are pure and
are tested from literals in ``test_draws.py`` / ``test_results.py``. What this file
tests is everything *between* them and a director: the request boundary that admits a
qualifier count for exactly one draw type, the settings row it lands on, the freeze that
holds it still once a draw exists, the cut that emits both stages, the seam that seats a
finished pool's qualifiers into the bracket, and the results block the tournament-detail
page reads back.

The load-bearing one is
``test_a_finished_pool_seats_its_qualifiers_into_the_bracket``. Qualification is
decided by the same tiebreak chain the standings are ordered by, which means the seam
has to hand ``advance()`` the fixtures' **game counts**; the projection
did not load them, so every fixture arrived with ``games=None`` and the strategy refused
(``MissingFixtureGames``). Nothing else in the suite reads that field, so nothing else
would have noticed. That test is green only when real game counts flow through the seam.
"""

import uuid
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import match_calls
from app.models import (
    DrawType,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.tournaments import TOURNAMENT_CREATE, TOURNAMENT_VIEW
from tests._helpers import (
    grant_permissions,
    make_user,
    opponent_session,
    start_session,
)

RR_THEN_KO = DrawType.rr_then_ko.value

POOLS: list[dict[str, Any]] = [
    {
        "id": f"p-{letter}",
        "name": f"Pool {letter.upper()}",
        "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
        "table_ids": ["t1"],
    }
    for letter in ("a", "b", "c")
]


@pytest_asyncio.fixture
async def authed_client(
    api_client: AsyncClient, db_session: AsyncSession
) -> AsyncIterator[tuple[AsyncClient, User]]:
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, (TOURNAMENT_VIEW, TOURNAMENT_CREATE))
    yield api_client, user


def _tournament_payload() -> dict[str, Any]:
    return {
        "name": "Pools then Bracket Open",
        "address": {
            "venue": "Berkeley TT Club",
            "street": "2727 Milvia St",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94703",
            "country": "USA",
        },
        "table_catalogue": [{"id": "t1", "label": "Table 1", "court": "A"}],
    }


def _event_payload(**overrides: Any) -> dict[str, Any]:
    """An ``rr-then-ko`` event over three pools, taking the top 2 out of each.

    Best-of-3 and **unrated** by default: an unrated match self-accepts on the
    proposal, so playing a pool out needs one request per match instead of two, and
    nothing here is about the rating pipeline.
    """
    payload: dict[str, Any] = {
        "name": "Open Singles",
        "format": "singles",
        "draw_type": RR_THEN_KO,
        "qualifiers_per_pool": 2,
        "max_players": 64,
        "entry_fee": 0,
        "timezone": "America/Chicago",
        "slot": {"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        "match_settings": {"rated": False, "length_games": 3},
        "predicates": [],
        "pools": list(POOLS),
    }
    payload.update(overrides)
    return payload


async def _tournament(client: AsyncClient) -> str:
    created = await client.post("/v1/tournaments", json=_tournament_payload())
    assert created.status_code == 201, created.text
    tournament_id: str = created.json()["id"]
    return tournament_id


async def _create_event(
    client: AsyncClient, tournament_id: str, **overrides: Any
) -> Any:
    return await client.post(
        f"/v1/tournaments/{tournament_id}/events", json=_event_payload(**overrides)
    )


async def _enter(
    db: AsyncSession, event_id: str, user: User, *, seed: int, minutes: int
) -> TournamentEntry:
    entry = TournamentEntry(
        event_id=uuid.UUID(event_id),
        user_id=user.id,
        status=TournamentEntryStatus.entered,
        seed=seed,
        created_at=datetime(2026, 6, 1, 9, 0, tzinfo=UTC) + timedelta(minutes=minutes),
    )
    db.add(entry)
    await db.commit()
    return entry


async def _cut(client: AsyncClient, tournament_id: str, event_id: str) -> Any:
    return await client.post(f"/v1/tournaments/{tournament_id}/events/{event_id}/draw")


async def _fixtures(db: AsyncSession, event_id: str) -> list[TournamentFixture]:
    return list(
        (
            await db.execute(
                select(TournamentFixture)
                .where(TournamentFixture.event_id == uuid.UUID(event_id))
                .order_by(
                    TournamentFixture.pool_id.asc().nulls_last(),
                    TournamentFixture.round,
                    TournamentFixture.position,
                )
            )
        )
        .scalars()
        .all()
    )


async def _settings_of(db: AsyncSession, event_id: str) -> TournamentEvent:
    db.expire_all()
    return (
        await db.execute(
            select(TournamentEvent).where(TournamentEvent.id == uuid.UUID(event_id))
        )
    ).scalar_one()


async def _set_status(
    db: AsyncSession, tournament_id: str, status: TournamentStatus
) -> None:
    tournament = (
        await db.execute(
            select(Tournament).where(Tournament.id == uuid.UUID(tournament_id))
        )
    ).scalar_one()
    tournament.status = status
    await db.commit()


async def _call(
    db: AsyncSession, tournament_id: str, fixtures: Sequence[TournamentFixture]
) -> None:
    """Route each materialized fixture through the real call, so its ``pending`` match
    flips to ``in_progress`` and becomes scorable (#1073)."""
    tournament = await db.get(Tournament, uuid.UUID(tournament_id))
    assert tournament is not None
    for fixture in fixtures:
        await match_calls.apply_manual_placement(
            db,
            tournament,
            fixture,
            table_id="t1",
            scheduled_start=datetime(2026, 6, 1, 10, 0),
            event_timezone="America/Chicago",
        )
    await db.commit()


async def _win(
    fixture: TournamentFixture,
    *,
    clients_by_entry: dict[uuid.UUID, AsyncClient],
    winner_entry_id: uuid.UUID,
    games: tuple[int, int] = (2, 0),
) -> None:
    """Play a materialized fixture's match out through the real score endpoints, the
    named entry taking it by ``games``.

    ``games`` is ``(winner_games, loser_games)`` — settable because the qualifier order
    is decided by a chain that runs through **game difference and games won**, so a
    test that only ever played 2–0 could not tell a strategy reading games from one
    reading wins alone. Side 1 is ``entry_a`` and side 2 is ``entry_b`` (#788).
    """
    assert fixture.match_id is not None
    side_1_wins = winner_entry_id == fixture.entry_a_id
    winner_games, loser_games = games
    # The loser's games first, so the board's LAST game is the decider — a result
    # carrying games past the decider is refused at the score boundary.
    board = [(5, 11)] * loser_games + [(11, 5)] * winner_games
    response = await clients_by_entry[winner_entry_id].post(
        f"/v1/matches/{fixture.match_id}/results",
        json={
            "games": [
                {
                    "game_number": n,
                    "side_1_points": (a if side_1_wins else b),
                    "side_2_points": (b if side_1_wins else a),
                }
                for n, (a, b) in enumerate(board, start=1)
            ]
        },
    )
    assert response.status_code == 201, response.text


async def _event_read(client: AsyncClient, tournament_id: str) -> dict[str, Any]:
    response = await client.get(f"/v1/tournaments/{tournament_id}")
    assert response.status_code == 200, response.text
    (event,) = response.json()["events"]
    read: dict[str, Any] = event
    return read


# ----- the request boundary: a qualifier count belongs to exactly one draw type ------


async def test_creating_an_rr_then_ko_event_persists_its_qualifier_count(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The whole configuration lands on the settings row: the slug *and* the K.

    Asserted from the database rather than the response, because the row is the thing
    the cut reads — a response echoing a number nothing stored would satisfy a wire
    assertion and cut a different draw.
    """
    client, _ = authed_client
    tournament_id = await _tournament(client)

    created = await _create_event(client, tournament_id, qualifiers_per_pool=3)

    assert created.status_code == 201, created.text
    event = await _settings_of(db_session, created.json()["id"])
    assert event.draw_settings.draw_type is DrawType.rr_then_ko
    assert event.draw_settings.qualifiers_per_pool == 3


@pytest.mark.parametrize("draw_type", ["round-robin", "single-elim"])
async def test_a_qualifier_count_on_another_draw_type_is_422(
    authed_client: tuple[AsyncClient, User], draw_type: str, db_session: AsyncSession
) -> None:
    """**Refused at the boundary, never silently dropped.**

    "The top 2 from each pool advance" is meaningless for a round-robin (there is no
    cut to size) and for a single-elim (there are no pools to cut from). Accepting the
    number and dropping it would run an event the director did not ask for and show
    them nothing; the settings table's CHECK would refuse the row anyway, which is a
    500, not an answer. Both other draw types are asked, because a union that had lost
    one arm's ``extra="forbid"`` would look identical on a one-slug test.
    """
    client, _ = authed_client
    tournament_id = await _tournament(client)

    response = await _create_event(
        client, tournament_id, draw_type=draw_type, qualifiers_per_pool=2, pools=[]
    )

    assert response.status_code == 422, response.text
    assert "qualifiers_per_pool" in response.text
    # Refused at the boundary means refused before persistence.
    events = (
        await db_session.execute(
            select(TournamentEvent).where(
                TournamentEvent.tournament_id == uuid.UUID(tournament_id)
            )
        )
    ).scalars()
    assert list(events) == []


async def test_an_rr_then_ko_event_without_a_qualifier_count_is_422(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """There is no defensible default. "2" is a convention, not a fact about the event,
    and a bracket cut for a K nobody chose is the worst kind of failure: it looks like
    it worked."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    payload = _event_payload()
    del payload["qualifiers_per_pool"]

    response = await client.post(
        f"/v1/tournaments/{tournament_id}/events", json=payload
    )

    assert response.status_code == 422, response.text
    assert "qualifiers_per_pool" in response.text


@pytest.mark.parametrize("count", [0, -1])
async def test_a_qualifier_count_below_one_is_422(
    authed_client: tuple[AsyncClient, User], count: int
) -> None:
    """``K >= 1`` is the STATIC half of the legal configuration space, so it is a
    boundary rule: zero advances nobody and a negative is not a count. The two bounds
    that move with the entrant count (``P × K >= 2``, ``K <= ⌊N/P⌋``) are deliberately
    not here — they are refused at the cut, where the field is known."""
    client, _ = authed_client
    tournament_id = await _tournament(client)

    response = await _create_event(client, tournament_id, qualifiers_per_pool=count)

    assert response.status_code == 422, response.text
    assert "qualifiers_per_pool" in response.text


async def test_patching_a_qualifier_count_without_its_draw_type_is_422(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """The draw configuration is patched **as a unit**.

    Which draw types carry a qualifier count is a fact about the ``(draw_type, K)``
    pair; a patch carrying only ``K`` does not hold that pair, so judging it would mean
    reading the event's stored draw type two layers in, after the request had already
    been accepted. The refusal says what to send instead.
    """
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event_id = (await _create_event(client, tournament_id)).json()["id"]

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event_id}",
        json={"qualifiers_per_pool": 3},
    )

    assert response.status_code == 422, response.text
    assert "draw_type" in response.text


async def test_the_qualifier_count_is_editable_while_no_draw_exists(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The freeze below is about a **cut** draw. Before one, the configuration is
    ordinary editable event configuration — this is the edit the freeze exists to
    permit, and without it the 409 test could pass against a rule that refused every
    change."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event_id = (await _create_event(client, tournament_id)).json()["id"]

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event_id}",
        json={"draw_type": RR_THEN_KO, "qualifiers_per_pool": 3},
    )

    assert response.status_code == 200, response.text
    event = await _settings_of(db_session, event_id)
    assert event.draw_settings.qualifiers_per_pool == 3


async def test_patching_away_from_rr_then_ko_clears_the_qualifier_count(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The two columns are one fact, written together: a draw type moved back to
    round-robin leaves NULL behind, not the K the event used to take. Writing the slug
    alone would leave a pairing the settings table's CHECK refuses outright."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event_id = (await _create_event(client, tournament_id)).json()["id"]

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event_id}",
        json={"draw_type": "round-robin"},
    )

    assert response.status_code == 200, response.text
    event = await _settings_of(db_session, event_id)
    assert event.draw_settings.draw_type is DrawType.round_robin
    assert event.draw_settings.qualifiers_per_pool is None


# ----- the read: the stored qualifier count comes back ------------------------------
#
# The event read carries ``qualifiers_per_pool`` beside ``draw_type`` because the
# configuration is edited as a PAIR: the editor always sends the draw type, and the
# server parses ``(draw_type, K)`` together with K required and no default. A client
# that cannot read K back has to supply one on every PATCH — which pre-draw silently
# overwrites the director's number and post-draw trips the freeze with a 409 for an edit
# nobody made. So "the number the director chose survives a round trip" is the claim,
# and it is asserted on all three shaping paths (create, detail GET, patch), which are
# three call sites of one serializer and would otherwise be free to drift.


async def test_an_rr_then_ko_events_qualifier_count_reads_back(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """Created with K=3, read back as 3 — and 3 is what the settings row holds.

    The stored column is asserted alongside the two response bodies on purpose: a read
    that echoed the *request* would satisfy the wire assertions while the cut used some
    other number, which is the failure the wire alone cannot see.
    """
    client, _ = authed_client
    tournament_id = await _tournament(client)

    created = await _create_event(client, tournament_id, qualifiers_per_pool=3)

    assert created.status_code == 201, created.text
    assert created.json()["qualifiers_per_pool"] == 3
    assert (await _event_read(client, tournament_id))["qualifiers_per_pool"] == 3
    event = await _settings_of(db_session, created.json()["id"])
    assert event.draw_settings.qualifiers_per_pool == 3


@pytest.mark.parametrize("draw_type", ["round-robin", "single-elim"])
async def test_a_draw_type_with_no_knockout_stage_reads_back_no_qualifier_count(
    authed_client: tuple[AsyncClient, User], draw_type: str
) -> None:
    """``null``, and the key is **present**.

    The other side of the pairing, and it has to be asserted or the read is one-sided:
    a field hard-wired to the requested K, or defaulted to some convention, would pass
    the rr-then-ko test above and quietly tell a director that their round-robin
    advances two per pool — a configuration the settings table's ``CHECK`` says cannot
    exist. Both of the count-less draw types are asked, because a read keyed off a
    single slug would look right on a one-slug test.

    ``in`` before the value, so "the field vanished from the response" reds as itself
    rather than as ``KeyError`` — the client distinguishes *absent* (an older server)
    from *null* (this draw type takes no count).
    """
    client, _ = authed_client
    tournament_id = await _tournament(client)
    payload = _event_payload(draw_type=draw_type, pools=[])
    del payload["qualifiers_per_pool"]

    created = await client.post(f"/v1/tournaments/{tournament_id}/events", json=payload)

    assert created.status_code == 201, created.text
    assert "qualifiers_per_pool" in created.json()
    assert created.json()["qualifiers_per_pool"] is None
    read = await _event_read(client, tournament_id)
    assert "qualifiers_per_pool" in read
    assert read["qualifiers_per_pool"] is None


async def test_editing_the_qualifier_count_reads_the_edited_value_back(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """The round trip the editor actually runs: PATCH the pair, and the response the
    form re-seeds itself from carries the K just written — not the one it replaced.

    The edited event is reloaded and reprojected by a *different* shaping path than the
    create, so it gets its own assertion; a read wired only into the create path would
    hand the editor a stale number the moment the director changed it.
    """
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event_id = (await _create_event(client, tournament_id)).json()["id"]

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event_id}",
        json={"draw_type": RR_THEN_KO, "qualifiers_per_pool": 4},
    )

    assert response.status_code == 200, response.text
    assert response.json()["qualifiers_per_pool"] == 4
    assert (await _event_read(client, tournament_id))["qualifiers_per_pool"] == 4


async def test_patching_away_from_rr_then_ko_reads_back_no_qualifier_count(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """The clear is visible on the wire too. ``configure`` writes both columns together,
    so the count goes NULL when the draw type moves — and the editor has to *see* that,
    or it re-sends the count it still believes in and gets a 422 for a round-robin event
    carrying a K."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event_id = (await _create_event(client, tournament_id)).json()["id"]

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event_id}",
        json={"draw_type": "round-robin"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["qualifiers_per_pool"] is None
    assert (await _event_read(client, tournament_id))["qualifiers_per_pool"] is None


# ----- the cut: both stages in one stroke -------------------------------------------


async def _twelve_entrant_event(
    client: AsyncClient, db: AsyncSession, **overrides: Any
) -> tuple[str, str, list[TournamentEntry]]:
    """An rr-then-ko event with a stated field of twelve seeded entrants.

    Seeds and registration times are both pinned, so which pool each entrant snakes
    into is a fact of the fixture rather than of how fast the rows were written.
    """
    tournament_id = await _tournament(client)
    event_id = (await _create_event(client, tournament_id, **overrides)).json()["id"]
    entries = [
        await _enter(db, event_id, await make_user(db, f"rrko{n}"), seed=n, minutes=n)
        for n in range(1, 13)
    ]
    return tournament_id, event_id, entries


async def test_the_cut_emits_the_pools_and_the_whole_bracket(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """One stroke, two stages: three pools of four (18 pool fixtures) plus the bracket
    for the 6 qualifiers, cut before anybody has played.

    The bracket is cut upfront because ``AdvancePlan`` can express only a side-fill —
    there is deliberately no way for ``advance()`` to create a fixture — and it costs
    nothing, since ``P × K`` is known at cut time. Its fixtures are ``pool_id IS NULL``
    (that *is* the knockout stage) with every side TBD, and its rounds restart at 1.
    """
    client, _ = authed_client
    tournament_id, event_id, _ = await _twelve_entrant_event(client, db_session)

    assert (await _cut(client, tournament_id, event_id)).status_code == 201

    fixtures = await _fixtures(db_session, event_id)
    pooled = [f for f in fixtures if f.pool_id is not None]
    bracket = [f for f in fixtures if f.pool_id is None]
    # Three pools of four: every pairing within a pool, six per pool.
    assert sorted(p.pool_id for p in pooled) == sorted(
        [pool["id"] for pool in POOLS] * 6
    )
    assert all(f.entry_a_id is not None and f.entry_b_id is not None for f in pooled), (
        "every pool pairing is known at the cut"
    )
    # 6 qualifiers → a bracket of 8: 4 quarterfinals (two of them byes, so absent),
    # 2 semifinals, 1 final. A bye is the ABSENCE of a fixture (ADR-0786).
    assert sorted((f.round, f.position) for f in bracket) == [
        (1, 2),
        (1, 3),
        (2, 1),
        (2, 2),
        (3, 1),
    ]
    assert all(f.entry_a_id is None and f.entry_b_id is None for f in bracket), (
        "nobody has qualified, so every knockout side is TBD"
    )


async def test_cutting_for_more_qualifiers_than_the_smallest_pool_holds_is_refused(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """A moving bound, refused at the cut in the director's own language — and it names
    the two ways out.

    It cannot live at the request boundary: it depends on the entrant count, which
    moves. A configuration that was legal when it was written must not become
    unwritable because a player withdrew.
    """
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event_id = (
        await _create_event(client, tournament_id, qualifiers_per_pool=5)
    ).json()["id"]
    for n in range(1, 13):
        await _enter(
            db_session,
            event_id,
            await make_user(db_session, f"few{n}"),
            seed=n,
            minutes=n,
        )

    response = await _cut(client, tournament_id, event_id)

    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail == (
        "Taking 5 qualifiers from each pool is more than the 4 entrants in the "
        "smallest pool — take fewer qualifiers from each pool, or add entrants."
    )
    assert await _fixtures(db_session, event_id) == [], (
        "a refused cut writes nothing at all"
    )


async def test_the_qualifier_count_is_frozen_once_the_draw_is_cut(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """409, exactly as the draw type freezes — and it is not hypothetical.

    The bracket is cut upfront for ``P × K`` and qualifiers are seated into
    predetermined slots. A bracket cut at K=2 and then advanced at K=3 would leave
    three pools' worth of thirds with nowhere to sit — which past this refusal is a
    ``MissingBracketSlot`` (a 500 nobody can act on), so the 409 is what makes it a
    sentence a director can. Re-sending the SAME configuration is not a
    change and is allowed, which is what makes this a freeze on the edit rather than on
    the key being present.
    """
    client, _ = authed_client
    tournament_id, event_id, _ = await _twelve_entrant_event(client, db_session)
    assert (await _cut(client, tournament_id, event_id)).status_code == 201
    url = f"/v1/tournaments/{tournament_id}/events/{event_id}"

    unchanged = await client.patch(
        url, json={"draw_type": RR_THEN_KO, "qualifiers_per_pool": 2}
    )
    refused = await client.patch(
        url, json={"draw_type": RR_THEN_KO, "qualifiers_per_pool": 3}
    )

    assert unchanged.status_code == 200, unchanged.text
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"] == (
        "This event's draw is already cut, so the number of qualifiers per pool is "
        "frozen: its knockout bracket was cut for the top 2 out of each pool of a "
        "“rr-then-ko” draw, and changing that count would leave qualifiers with no "
        "slot to be seated into. To change it, remove the draw first, then cut it "
        "again."
    )
    event = await _settings_of(db_session, event_id)
    assert event.draw_settings.qualifiers_per_pool == 2, "a refusal wrote nothing"


# ----- the seam: a finished pool seats its qualifiers -------------------------------


async def test_a_finished_pool_seats_its_qualifiers_into_the_bracket(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """**The one that proves the game counts reach ``advance()``.**

    Twelve entrants, three pools of four, top two out of each. One pool is played out
    in full through the real score routes while the other two are untouched; the moment
    its last match completes, that pool's top two are seated into their predetermined
    bracket slots — and the other pools' slots stay TBD, because a seat is filled per
    pool, as that pool finishes, not per event.

    **Who qualifies is decided by the games, not by the wins.** Seed 1 takes all three
    of their matches; the other three form a beat-cycle (6 beats 7, 7 beats 12, 12 beats
    6) and finish level on **one win apiece**. Wins alone cannot separate them, and
    head-to-head does not apply to a three-way tie, so the second qualifying place is
    settled by **game difference** — 7 at −1, 6 at −2, 12 at −4 — which exists only if
    the seam loaded the fixtures' game counts. A pool played 2–0 throughout would be
    ordered identically by a games-blind strategy, and this test would then be evidence
    about nothing.

    Pool A holds seeds 1, 6, 7, 12 (the snake deals 1..P then back), whose users are
    the four with clients here.
    """
    client, owner = authed_client
    async with (
        opponent_session(db_session, "rrko-b") as (client_b, user_b),
        opponent_session(db_session, "rrko-c") as (client_c, user_c),
        opponent_session(db_session, "rrko-d") as (client_d, user_d),
    ):
        tournament_id = await _tournament(client)
        event_id = (await _create_event(client, tournament_id)).json()["id"]
        # Seeds 1, 6, 7, 12 snake into pool A; the eight extras fill B and C.
        players = {1: owner, 6: user_b, 7: user_c, 12: user_d}
        entries: dict[int, TournamentEntry] = {}
        for seed in range(1, 13):
            user = players.get(seed) or await make_user(db_session, f"extra{seed}")
            entries[seed] = await _enter(
                db_session, event_id, user, seed=seed, minutes=seed
            )
        assert (await _cut(client, tournament_id, event_id)).status_code == 201
        await _set_status(db_session, tournament_id, TournamentStatus.published)
        live = await client.post(
            f"/v1/tournaments/{tournament_id}/transitions", json={"to": "live"}
        )
        assert live.status_code == 201, live.text

        pool_a = [
            f for f in await _fixtures(db_session, event_id) if f.pool_id == "p-a"
        ]
        assert len(pool_a) == 6, "a pool of four is six pairings"
        await _call(db_session, tournament_id, pool_a)
        pool_a = [
            f for f in await _fixtures(db_session, event_id) if f.pool_id == "p-a"
        ]

        clients = {
            entries[1].id: client,
            entries[6].id: client_b,
            entries[7].id: client_c,
            entries[12].id: client_d,
        }
        by_pair = {frozenset({f.entry_a_id, f.entry_b_id}): f for f in pool_a}

        def fixture_between(a: int, b: int) -> TournamentFixture:
            return by_pair[frozenset({entries[a].id, entries[b].id})]

        # Seed 1 takes all three, dropping one game on the way.
        await _win(
            fixture_between(1, 6),
            clients_by_entry=clients,
            winner_entry_id=entries[1].id,
            games=(2, 1),
        )
        await _win(
            fixture_between(1, 7),
            clients_by_entry=clients,
            winner_entry_id=entries[1].id,
            games=(2, 0),
        )
        await _win(
            fixture_between(1, 12),
            clients_by_entry=clients,
            winner_entry_id=entries[1].id,
            games=(2, 0),
        )
        # The beat-cycle: 6 → 7 → 12 → 6, one win each, so nothing but the games can
        # place them. Game difference comes out 7 (−1), 6 (−2), 12 (−4).
        await _win(
            fixture_between(6, 7),
            clients_by_entry=clients,
            winner_entry_id=entries[6].id,
            games=(2, 1),
        )
        await _win(
            fixture_between(7, 12),
            clients_by_entry=clients,
            winner_entry_id=entries[7].id,
            games=(2, 0),
        )
        await _win(
            fixture_between(6, 12),
            clients_by_entry=clients,
            winner_entry_id=entries[12].id,
            games=(2, 0),
        )

        bracket = [
            f for f in await _fixtures(db_session, event_id) if f.pool_id is None
        ]
        seated = {
            entry_id
            for f in bracket
            for entry_id in (f.entry_a_id, f.entry_b_id)
            if entry_id is not None
        }
        assert seated == {entries[1].id, entries[7].id}, (
            "exactly pool A's top two are seated — and the runner-up is the one the "
            "standings' game-difference tiebreak names, which wins alone cannot pick"
        )
        # Nothing is ready to play: every knockout fixture still has a TBD side, so none
        # of them materialized into a match.
        assert all(f.match_id is None for f in bracket)


async def test_the_results_read_out_as_both_stages(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The tournament-detail payload carries the third arm of the results union.

    ``kind: "standings_then_finishes"``, with one block per stage: the pool tables read
    exactly as a round-robin's do (the same models), and the finishes list exactly as a
    single-elim's does. It is live and partial, like every other results shape — the
    played pool is ``complete`` while its neighbours are not, the bracket has produced
    no finishes yet, and there is **no champion**, because a champion comes from the
    bracket's final and never from topping a pool.
    """
    client, owner = authed_client
    async with opponent_session(db_session, "rrko-solo") as (client_b, user_b):
        tournament_id = await _tournament(client)
        event_id = (await _create_event(client, tournament_id)).json()["id"]
        players = {1: owner, 6: user_b}
        entries: dict[int, TournamentEntry] = {}
        for seed in range(1, 13):
            user = players.get(seed) or await make_user(db_session, f"read{seed}")
            entries[seed] = await _enter(
                db_session, event_id, user, seed=seed, minutes=seed
            )
        assert (await _cut(client, tournament_id, event_id)).status_code == 201
        await _set_status(db_session, tournament_id, TournamentStatus.published)
        assert (
            await client.post(
                f"/v1/tournaments/{tournament_id}/transitions", json={"to": "live"}
            )
        ).status_code == 201
        one = next(
            f
            for f in await _fixtures(db_session, event_id)
            if {f.entry_a_id, f.entry_b_id} == {entries[1].id, entries[6].id}
        )
        await _call(db_session, tournament_id, [one])
        (one,) = [f for f in await _fixtures(db_session, event_id) if f.id == one.id]
        await _win(
            one,
            clients_by_entry={entries[1].id: client, entries[6].id: client_b},
            winner_entry_id=entries[1].id,
            games=(2, 1),
        )

    results = (await _event_read(client, tournament_id))["results"]

    assert results["kind"] == "standings_then_finishes"
    assert results["complete"] is False
    assert results["champion"] is None
    assert [pool["pool_id"] for pool in results["pools"]] == ["p-a", "p-b", "p-c"]
    assert all(pool["complete"] is False for pool in results["pools"])
    (pool_a,) = [pool for pool in results["pools"] if pool["pool_id"] == "p-a"]
    leader = pool_a["rows"][0]
    assert leader["entry_id"] == str(entries[1].id)
    assert (leader["wins"], leader["games_won"], leader["games_lost"]) == (1, 2, 1)
    assert results["finishes"] == [], "nobody has been knocked out yet"


async def test_an_uncut_rr_then_ko_event_has_no_results(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """``null``, not an empty two-stage block: an event with no draw has nothing to
    stand, and that is the one case the results are absent for."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    await _create_event(client, tournament_id)

    assert (await _event_read(client, tournament_id))["results"] is None
