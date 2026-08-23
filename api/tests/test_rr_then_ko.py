"""Round-robin then knockout, end to end (#1227, ADR "rr-then-ko cuts both stages
upfront and seeds qualifiers rematch-free").

The draw strategy, the results strategy and the qualifier-seed assignment are pure and
are tested from literals in ``test_draws.py`` / ``test_results.py``. What this file
tests is everything *between* them and a director: the request boundary that admits a
qualifier count for exactly one draw type, the settings row it lands on, the freeze that
holds it still once a draw exists, the cut that emits both stages, the seam that seats a
finished group's qualifiers into the bracket, and the results block the
tournament-detail page reads back.

The load-bearing one is
``test_a_finished_group_seats_its_qualifiers_into_the_bracket``. Qualification is
decided by the same tiebreak chain the standings are ordered by, which means the seam
has to hand ``advance()`` the fixtures' **game counts**; the projection
did not load them, so every fixture arrived with ``games=None`` and the strategy refused
(``MissingFixtureGames``). Nothing else in the suite reads that field, so nothing else
would have noticed. That test is green only when real game counts flow through the seam.
"""

import uuid
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime, timedelta
from itertools import combinations
from typing import Any

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import match_calls
from app.match_voiding import void_match
from app.models import (
    DrawType,
    Match,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentEventReservation,
    TournamentEventStageGroup,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.schemas.tournament import MAX_QUALIFIERS_PER_GROUP
from app.tournament_draw_settings import draw_settings_of
from app.tournament_queries import stage_ids_for_events
from app.tournaments import TOURNAMENT_CREATE, TOURNAMENT_VIEW
from tests._helpers import (
    grant_permissions,
    joined_to_reservation,
    make_user,
    opponent_session,
    stage_id_at,
    start_session,
)

RR_THEN_KO = DrawType.rr_then_ko.value

#: Three reservations, sent with **no ``id``** — a reservation id is a server-minted
#: uuid (ADR 20260801) and the create shape has no field for one. The tests that need
#: to name a group look its id up by its reservation's name (:func:`_group_id`).
RESERVATIONS: list[dict[str, Any]] = [
    {
        "name": f"Reservation {letter.upper()}",
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
        "name": "Groups then Bracket Open",
        "address": {
            "venue": "Berkeley TT Club",
            "street": "2727 Milvia St",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94703",
            "country": "USA",
        },
        "table_catalogue": [{"label": "Table 1", "court": "A"}],
    }


def _event_payload(**overrides: Any) -> dict[str, Any]:
    """An ``rr-then-ko`` event over three groups, taking the top 2 out of each.

    Best-of-3 and **unrated** by default: an unrated match self-accepts on the
    proposal, so playing a group out needs one request per match instead of two, and
    nothing here is about the rating pipeline.
    """
    payload: dict[str, Any] = {
        "name": "Open Singles",
        "format": "singles",
        "draw_type": RR_THEN_KO,
        "qualifiers_per_group": 2,
        "max_players": 64,
        "entry_fee": 0,
        "timezone": "America/Chicago",
        "slot": {"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        "match_settings": {"rated": False, "length_games": 3},
        "predicates": [],
        "reservations": list(RESERVATIONS),
    }
    payload.update(overrides)
    return payload


async def _group_id(db_session: AsyncSession, event_id: str, name: str) -> uuid.UUID:
    """The id of the **group-stage** group whose reservation is named ``name`` — the
    lookup every assertion about a fixture's ``group_id`` goes through, since the id
    is the server's (ADR 20260801).

    Scoped to the group stage — always position 0 (#1484) — because the knockout
    stage's own single group can map to the SAME reservation (``position % reservation
    count`` puts both stage 0's first group and the whole-of-stage-1 group at
    ``0 % N``), which would otherwise make this lookup ambiguous.

    The name lives on the reservation and the id on the group, so this walks the join:
    the two halves the wire once served under a single name."""
    stage_id = await stage_id_at(db_session, uuid.UUID(event_id), 0)
    return (
        await db_session.execute(
            joined_to_reservation(select(TournamentEventStageGroup.id)).where(
                TournamentEventStageGroup.stage_id == stage_id,
                TournamentEventReservation.name == name,
            )
        )
    ).scalar_one()


async def _reservations(
    db_session: AsyncSession, event_id: str
) -> list[TournamentEventReservation]:
    """The event's reservation rows in their own order — what a ``reservations``
    PATCH cites (#1387: a group is the server's, so a payload is built from the
    reservations, never from the groups)."""
    return list(
        (
            await db_session.execute(
                select(TournamentEventReservation)
                .where(TournamentEventReservation.event_id == uuid.UUID(event_id))
                .order_by(TournamentEventReservation.position)
            )
        )
        .scalars()
        .all()
    )


async def _group_ids(db_session: AsyncSession, event_id: str) -> list[uuid.UUID]:
    """The event's GROUP STAGE's own group ids, in its own group order — always
    position 0 (#1484): the round-robin pool groups this file's assertions are about,
    never the knockout stage's own (single, separately-mapped) group."""
    stage_id = await stage_id_at(db_session, uuid.UUID(event_id), 0)
    return list(
        (
            await db_session.execute(
                select(TournamentEventStageGroup.id)
                .where(TournamentEventStageGroup.stage_id == stage_id)
                .order_by(TournamentEventStageGroup.position)
            )
        )
        .scalars()
        .all()
    )


def _is_knockout(fixture: TournamentFixture) -> bool:
    """Whether ``fixture`` belongs to this composite's KNOCKOUT stage — its own
    ``single-elim`` stage, never the group stage's ``round-robin`` (#1484: both now
    name a real group of their own, so ``group_id is None`` no longer tells them
    apart — the knockout stage's fixtures carry their own single group's id, mapped
    the same way the group stage's are)."""
    return fixture.stage.draw_type is DrawType.single_elim


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
                .where(
                    TournamentFixture.stage_id.in_(
                        stage_ids_for_events([uuid.UUID(event_id)])
                    )
                )
                .order_by(
                    TournamentFixture.group_id.asc().nulls_last(),
                    TournamentFixture.round,
                    TournamentFixture.position,
                )
            )
        )
        .scalars()
        .all()
    )


def _stored_qualifiers(event: TournamentEvent) -> int | None:
    """The qualifier count this event has **stored**, parsed back out of its settings
    row's JSON object (ADR "a draw type's settings are one NOT NULL JSON object").

    Read through the storage boundary rather than off a column, because there is no
    column any more: ``{"qualifiers_per_group": K}`` is the whole of an ``rr-then-ko``
    row's settings, and ``None`` is what the arms with no knockout stage answer.
    """
    return draw_settings_of(event.draw_settings).qualifiers_per_group


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
    # The catalogue's first row, by the id the server minted: ``table_id`` is a foreign
    # key since ADR 20260801, so the ``"t1"`` alias is no longer a table. Every fixture
    # onto the one table — a double-booking is a flag on read, never a refusal.
    table_id = str(tournament.tables[0].id)
    for fixture in fixtures:
        await match_calls.apply_manual_placement(
            db,
            tournament,
            fixture,
            table_id=table_id,
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

    created = await _create_event(client, tournament_id, qualifiers_per_group=3)

    assert created.status_code == 201, created.text
    event = await _settings_of(db_session, created.json()["id"])
    assert event.draw_settings.draw_type is DrawType.rr_then_ko
    assert _stored_qualifiers(event) == 3


@pytest.mark.parametrize("draw_type", ["round-robin", "single-elim"])
async def test_a_qualifier_count_on_another_draw_type_is_422(
    authed_client: tuple[AsyncClient, User], draw_type: str, db_session: AsyncSession
) -> None:
    """**Refused at the boundary, never silently dropped.**

    "The top 2 from each group advance" is meaningless for a round-robin (there is no
    cut to size) and for a single-elim (there are no groups to cut from). Accepting the
    number and dropping it would run an event the director did not ask for and show
    them nothing. This 422 is now the ONLY thing standing there: the settings table's
    ``CASE`` ``CHECK`` was dropped with the column it named, so a blob carrying a
    qualifier count for a round-robin is a row Postgres accepts. Both other draw types
    are asked, because a union that had lost one arm's ``extra="forbid"`` would look
    identical on a one-slug test.
    """
    client, _ = authed_client
    tournament_id = await _tournament(client)

    response = await _create_event(
        client,
        tournament_id,
        draw_type=draw_type,
        qualifiers_per_group=2,
        reservations=[],
    )

    assert response.status_code == 422, response.text
    assert "qualifiers_per_group" in response.text
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
    del payload["qualifiers_per_group"]

    response = await client.post(
        f"/v1/tournaments/{tournament_id}/events", json=payload
    )

    assert response.status_code == 422, response.text
    assert "qualifiers_per_group" in response.text


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

    response = await _create_event(client, tournament_id, qualifiers_per_group=count)

    assert response.status_code == 422, response.text
    assert "qualifiers_per_group" in response.text


# The other end of the same static bound. ``INT32_OVERFLOW`` is the number that made
# this a defect rather than a nicety: it is one past what the ``Integer`` column holds,
# so before the ceiling it reached the driver and came back a **500** — and the client's
# generic error copy then told the organizer "nothing you did caused it", which was
# false. ``MAX_QUALIFIERS_PER_GROUP + 1`` is the quieter half: storable, so it answered
# ``201 Created`` and left an event whose draw could never be cut.
INT32_OVERFLOW = 2_147_483_648


@pytest.mark.parametrize("count", [MAX_QUALIFIERS_PER_GROUP + 1, INT32_OVERFLOW])
async def test_a_qualifier_count_above_the_ceiling_is_422(
    authed_client: tuple[AsyncClient, User], count: int, db_session: AsyncSession
) -> None:
    """**422, and specifically not 500.** The status is the whole assertion: an
    unbounded K let a form value walk past the boundary into the column.

    The ceiling is not the domain rule — K can never exceed the smallest group's size in
    a real event, and the cut already refuses that by name (``DegenerateDraw``). This is
    the boundary refusing counts that are nonsense on their face, and it belongs here
    because the alternative was a crash the organizer was told they had not caused.
    """
    client, _ = authed_client
    tournament_id = await _tournament(client)

    response = await _create_event(client, tournament_id, qualifiers_per_group=count)

    assert response.status_code == 422, response.text
    assert "qualifiers_per_group" in response.text
    # Refused at the boundary means refused before persistence.
    events = (
        await db_session.execute(
            select(TournamentEvent).where(
                TournamentEvent.tournament_id == uuid.UUID(tournament_id)
            )
        )
    ).scalars()
    assert list(events) == []


async def test_a_qualifier_count_at_the_ceiling_is_accepted(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The bound is **inclusive**, and it is pinned so the refusal above cannot be
    satisfied by an off-by-one that also refuses the last legal number.

    A K of 1000 is absurd for a real group and the cut will say so when the field is
    known. That is deliberately not this layer's call: a configuration legal when it was
    written must not depend on who has entered yet."""
    client, _ = authed_client
    tournament_id = await _tournament(client)

    created = await _create_event(
        client, tournament_id, qualifiers_per_group=MAX_QUALIFIERS_PER_GROUP
    )

    assert created.status_code == 201, created.text
    event = await _settings_of(db_session, created.json()["id"])
    assert _stored_qualifiers(event) == MAX_QUALIFIERS_PER_GROUP


@pytest.mark.parametrize("count", [MAX_QUALIFIERS_PER_GROUP + 1, INT32_OVERFLOW])
async def test_patching_a_qualifier_count_above_the_ceiling_is_422(
    authed_client: tuple[AsyncClient, User], count: int, db_session: AsyncSession
) -> None:
    """The patch schema shares the create schema's alias, so both verbs hold the same
    ceiling. Asserted rather than assumed: a value create refuses but PATCH accepts
    defeats create's boundary entirely — the event is born small and then edited into
    the 500."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event_id = (await _create_event(client, tournament_id)).json()["id"]

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event_id}",
        json={"draw_type": RR_THEN_KO, "qualifiers_per_group": count},
    )

    assert response.status_code == 422, response.text
    assert "qualifiers_per_group" in response.text
    event = await _settings_of(db_session, event_id)
    assert _stored_qualifiers(event) == 2, "a refusal wrote nothing"


async def test_patching_a_qualifier_count_at_the_ceiling_is_accepted(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The inclusive half of the bound on the patch verb, for the same reason as on
    create: a ceiling that also refused the last legal number would satisfy every
    refusal test above."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event_id = (await _create_event(client, tournament_id)).json()["id"]

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event_id}",
        json={
            "draw_type": RR_THEN_KO,
            "qualifiers_per_group": MAX_QUALIFIERS_PER_GROUP,
        },
    )

    assert response.status_code == 200, response.text
    event = await _settings_of(db_session, event_id)
    assert _stored_qualifiers(event) == MAX_QUALIFIERS_PER_GROUP


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
        json={"qualifiers_per_group": 3},
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
        json={"draw_type": RR_THEN_KO, "qualifiers_per_group": 3},
    )

    assert response.status_code == 200, response.text
    event = await _settings_of(db_session, event_id)
    assert _stored_qualifiers(event) == 3


async def test_patching_away_from_rr_then_ko_clears_the_qualifier_count(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The draw type and its settings are one fact, written together: a draw type moved
    back to round-robin leaves an empty settings object behind, not the K the event used
    to take. Nothing in the database refuses the slug-only write any more — the ``CASE``
    ``CHECK`` is gone — so ``store_draw_settings`` writing the pair together is all
    that prevents it, which is exactly why this test exists."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    # One reservation, not the default three (#1482 caps a round-robin event at
    # one): this test is about the SETTINGS clearing when the draw type moves, not
    # about how many reservations the event has.
    event_id = (
        await _create_event(client, tournament_id, reservations=[RESERVATIONS[0]])
    ).json()["id"]

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event_id}",
        json={"draw_type": "round-robin"},
    )

    assert response.status_code == 200, response.text
    event = await _settings_of(db_session, event_id)
    assert event.draw_settings.draw_type is DrawType.round_robin
    assert _stored_qualifiers(event) is None


# ----- the read: the stored qualifier count comes back ------------------------------
#
# The event read carries ``qualifiers_per_group`` beside ``draw_type`` because the
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

    created = await _create_event(client, tournament_id, qualifiers_per_group=3)

    assert created.status_code == 201, created.text
    assert created.json()["qualifiers_per_group"] == 3
    assert (await _event_read(client, tournament_id))["qualifiers_per_group"] == 3
    event = await _settings_of(db_session, created.json()["id"])
    assert _stored_qualifiers(event) == 3


@pytest.mark.parametrize("draw_type", ["round-robin", "single-elim"])
async def test_a_draw_type_with_no_knockout_stage_reads_back_no_qualifier_count(
    authed_client: tuple[AsyncClient, User], draw_type: str
) -> None:
    """``null``, and the key is **present**.

    The other side of the pairing, and it has to be asserted or the read is one-sided:
    a field hard-wired to the requested K, or defaulted to some convention, would pass
    the rr-then-ko test above and quietly tell a director that their round-robin
    advances two per group — a configuration the write union says cannot exist. (It used
    to be the settings table's ``CASE`` ``CHECK`` saying so too; that constraint went
    with the column, so the union is the only one saying it now.) Both of the count-less
    draw types are asked, because a read keyed off a single slug would look right on a
    one-slug test.

    ``in`` before the value, so "the field vanished from the response" reds as itself
    rather than as ``KeyError`` — the client distinguishes *absent* (an older server)
    from *null* (this draw type takes no count).
    """
    client, _ = authed_client
    tournament_id = await _tournament(client)
    payload = _event_payload(draw_type=draw_type, reservations=[])
    del payload["qualifiers_per_group"]

    created = await client.post(f"/v1/tournaments/{tournament_id}/events", json=payload)

    assert created.status_code == 201, created.text
    assert "qualifiers_per_group" in created.json()
    assert created.json()["qualifiers_per_group"] is None
    read = await _event_read(client, tournament_id)
    assert "qualifiers_per_group" in read
    assert read["qualifiers_per_group"] is None


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
        json={"draw_type": RR_THEN_KO, "qualifiers_per_group": 4},
    )

    assert response.status_code == 200, response.text
    assert response.json()["qualifiers_per_group"] == 4
    assert (await _event_read(client, tournament_id))["qualifiers_per_group"] == 4


async def test_patching_away_from_rr_then_ko_reads_back_no_qualifier_count(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """The clear is visible on the wire too. ``configure`` writes both columns together,
    so the count goes NULL when the draw type moves — and the editor has to *see* that,
    or it re-sends the count it still believes in and gets a 422 for a round-robin event
    carrying a K."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    # One reservation, not the default three (#1482 caps a round-robin event at
    # one): this test is about the READ reflecting the cleared count, not about how
    # many reservations the event has.
    event_id = (
        await _create_event(client, tournament_id, reservations=[RESERVATIONS[0]])
    ).json()["id"]

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event_id}",
        json={"draw_type": "round-robin"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["qualifiers_per_group"] is None
    assert (await _event_read(client, tournament_id))["qualifiers_per_group"] is None


# ----- the cut: both stages in one stroke -------------------------------------------


async def _twelve_entrant_event(
    client: AsyncClient, db: AsyncSession, **overrides: Any
) -> tuple[str, str, list[TournamentEntry]]:
    """An rr-then-ko event with a stated field of twelve seeded entrants.

    Seeds and registration times are both pinned, so which group each entrant snakes
    into is a fact of the fixture rather than of how fast the rows were written.
    """
    tournament_id = await _tournament(client)
    event_id = (await _create_event(client, tournament_id, **overrides)).json()["id"]
    entries = [
        await _enter(db, event_id, await make_user(db, f"rrko{n}"), seed=n, minutes=n)
        for n in range(1, 13)
    ]
    return tournament_id, event_id, entries


async def test_the_cut_emits_the_groups_and_the_whole_bracket(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """One stroke, two stages: three groups of four (18 group fixtures) plus the
    bracket for the 6 qualifiers, cut before anybody has played.

    The bracket is cut upfront because ``AdvancePlan`` can express only a side-fill —
    there is deliberately no way for ``advance()`` to create a fixture — and it costs
    nothing, since ``P × K`` is known at cut time. Its fixtures belong to the
    KNOCKOUT stage (#1484: its own single group, never the group stage's) with every
    side TBD, and its rounds restart at 1.
    """
    client, _ = authed_client
    tournament_id, event_id, _ = await _twelve_entrant_event(client, db_session)

    assert (await _cut(client, tournament_id, event_id)).status_code == 201

    fixtures = await _fixtures(db_session, event_id)
    grouped = [f for f in fixtures if not _is_knockout(f)]
    bracket = [f for f in fixtures if _is_knockout(f)]
    # Three groups of four: every pairing within a group, six per group.
    assert sorted(str(f.group_id) for f in grouped) == sorted(
        [str(group_id) for group_id in await _group_ids(db_session, event_id)] * 6
    )
    assert all(
        f.entry_a_id is not None and f.entry_b_id is not None for f in grouped
    ), "every group pairing is known at the cut"
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


async def test_a_knockout_and_swiss_stage_are_distinguishable_by_stage_not_group(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The regression pin for ADR 20260815's whole reason to exist.

    A swiss draw's rounds and an rr-then-ko draw's knockout bracket are BOTH
    un-grouped (``group_id IS NULL``) — the ambiguity that once rendered a swiss
    draw's rounds as a knockout bracket, because a reader told the two apart from the
    event's overall draw type instead of from each fixture's own stage
    (``web-client/src/components/tournaments/data/draw.ts:147``, cited in the ADR's
    Context). Two SEPARATE events, one of each shape, so this is a claim about telling
    the two apart, not merely about one event's own consistency.

    Every un-grouped fixture now carries a ``stage_id`` (ADR 20260815 decision 5), and
    every event serves its ``stages`` with each one's OWN ``draw_type`` (decision 1).
    ``group_id IS NULL`` cannot make this assertion — it is the same value on both
    events' un-grouped fixtures — so this is a claim only ``stage_id`` can prove.

    **Falsification** (``.claude/rules/verify-the-artifact-under-test.md``): point
    ``app.tournament_queries.fixtures_by_event`` at the wrong stage id (e.g.
    ``fixture.id`` instead of ``fixture.stage_id``) and confirm this reds — the wrong
    id resolves to no stage in either event's ``stages`` array, or to the wrong one.
    """
    client, _ = authed_client
    tournament_id, event_id, _ = await _twelve_entrant_event(client, db_session)
    assert (await _cut(client, tournament_id, event_id)).status_code == 201

    swiss_payload = {
        "name": "Swiss Singles",
        "format": "singles",
        "draw_type": DrawType.swiss.value,
        # A field of two can play at most one rematch-free round.
        "rounds": 1,
        "max_players": 64,
        "entry_fee": 0,
        "timezone": "America/Chicago",
        "slot": {"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        "match_settings": {"rated": False, "length_games": 3},
        "predicates": [],
        "reservations": [],
    }
    created_swiss = await client.post(
        f"/v1/tournaments/{tournament_id}/events", json=swiss_payload
    )
    assert created_swiss.status_code == 201, created_swiss.text
    swiss_event_id = created_swiss.json()["id"]
    swiss_a = await make_user(db_session, "swiss-a")
    swiss_b = await make_user(db_session, "swiss-b")
    await _enter(db_session, swiss_event_id, swiss_a, seed=1, minutes=1)
    await _enter(db_session, swiss_event_id, swiss_b, seed=2, minutes=2)
    assert (await _cut(client, tournament_id, swiss_event_id)).status_code == 201

    response = await client.get(f"/v1/tournaments/{tournament_id}")
    assert response.status_code == 200, response.text
    events = {e["id"]: e for e in response.json()["events"]}
    rr_then_ko_event = events[event_id]
    swiss_event = events[swiss_event_id]

    def _stage_draw_type(event: dict[str, Any], stage_id: str) -> str:
        by_id = {s["id"]: s["draw_type"] for s in event["stages"]}
        assert stage_id in by_id, (
            f"fixture stage_id {stage_id!r} names no stage of event {event['id']!r} "
            f"(stages: {by_id!r}) — a fixture's stage_id must resolve into its own "
            "event's stages array"
        )
        return by_id[stage_id]

    # The two sets whose formats a reader has to tell apart: the composite's knockout
    # half, and the swiss event's whole draw. Selected by ROUND SHAPE — every fixture
    # of each — not by ``group_id``, which since #1483 says nothing about either: the
    # swiss rounds name their stage's group and the knockout half does not yet
    # (#1484), so a reader keying on it would now get the two backwards rather than
    # merely confuse them.
    bracket_fixtures = [
        f
        for f in rr_then_ko_event["fixtures"]
        if _stage_draw_type(rr_then_ko_event, f["stage_id"]) != "round-robin"
    ]
    swiss_fixtures = list(swiss_event["fixtures"])
    assert bracket_fixtures, "the bracket must have fixtures to distinguish"
    assert swiss_fixtures, "a swiss draw must have fixtures to distinguish"

    # Nothing on the row itself separates a swiss round from a knockout round — same
    # columns, both sides TBD on the later ones of each. The STAGE does.
    assert {
        _stage_draw_type(rr_then_ko_event, f["stage_id"]) for f in bracket_fixtures
    } == {"single-elim"}
    assert {_stage_draw_type(swiss_event, f["stage_id"]) for f in swiss_fixtures} == {
        "swiss"
    }


async def test_cutting_for_more_qualifiers_than_the_smallest_group_holds_is_refused(
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
        await _create_event(client, tournament_id, qualifiers_per_group=5)
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
        "Taking 5 qualifiers from each group is more than the 4 entrants in the "
        "smallest group — take fewer qualifiers from each group, or add entrants."
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
    three groups' worth of thirds with nowhere to sit — which past this refusal is a
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
        url, json={"draw_type": RR_THEN_KO, "qualifiers_per_group": 2}
    )
    refused = await client.patch(
        url, json={"draw_type": RR_THEN_KO, "qualifiers_per_group": 3}
    )

    assert unchanged.status_code == 200, unchanged.text
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"] == (
        "This event's draw is already cut, so the number of qualifiers per group is "
        "frozen: its knockout bracket was cut for the top 2 out of each group of a "
        "“rr-then-ko” draw, and changing that count would leave qualifiers with no "
        "slot to be seated into. To change it, remove the draw first, then cut it "
        "again."
    )
    event = await _settings_of(db_session, event_id)
    assert _stored_qualifiers(event) == 2, "a refusal wrote nothing"


async def test_a_patch_response_still_splits_groups_from_the_bracket(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The PATCH response (``app.tournament_serialization.shape_event_read``) projects
    a cut rr-then-ko event's results through the SAME group-vs-bracket split the
    tournament-detail GET does, even though it does not serve the event's ``stages``
    array on its own wire body (``EventStageRead``'s documented "not projected on this
    page" case).

    That split now reads each fixture's own ``stage_id`` (ADR 20260815) rather than
    ``group_id IS NULL``, and doing so needs the real stage rows — which this adapter
    does not otherwise load. A version of ``shape_event_read`` that forgot to load them
    (passing an empty map to ``event_results``) would silently return a
    ``standings_then_finishes`` block with an EMPTY ``groups`` list on every PATCH of a
    cut two-stage event: this pins that against regressing.
    """
    client, _ = authed_client
    tournament_id, event_id, _ = await _twelve_entrant_event(client, db_session)
    assert (await _cut(client, tournament_id, event_id)).status_code == 201

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event_id}",
        json={"draw_type": RR_THEN_KO, "qualifiers_per_group": 2},
    )

    assert response.status_code == 200, response.text
    results = response.json()["results"]
    assert results["kind"] == "standings_then_finishes"
    assert [group["group_id"] for group in results["groups"]] == [
        str(group_id) for group_id in await _group_ids(db_session, event_id)
    ], "the group stage's fixtures must still be found and grouped by group"
    assert all(len(group["rows"]) == 4 for group in results["groups"]), (
        "each of the three groups of four entrants stands its whole field"
    )


# ----- the seam: a finished group seats its qualifiers ------------------------------


async def test_a_finished_group_seats_its_qualifiers_into_the_bracket(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """**The one that proves the game counts reach ``advance()``.**

    Twelve entrants, three groups of four, top two out of each. One group is played out
    in full through the real score routes while the other two are untouched; the moment
    its last match completes, that group's top two are seated into their predetermined
    bracket slots — and the other groups' slots stay TBD, because a seat is filled per
    group, as that group finishes, not per event.

    **Who qualifies is decided by the games, not by the wins.** Seed 1 takes all three
    of their matches; the other three form a beat-cycle (6 beats 7, 7 beats 12, 12 beats
    6) and finish level on **one win apiece**. Wins alone cannot separate them, and
    head-to-head does not apply to a three-way tie, so the second qualifying place is
    settled by **game difference** — 7 at −1, 6 at −2, 12 at −4 — which exists only if
    the seam loaded the fixtures' game counts. A group played 2–0 throughout would be
    ordered identically by a games-blind strategy, and this test would then be evidence
    about nothing.

    Reservation A holds seeds 1, 6, 7, 12 (the snake deals 1..P then back), whose users
    are the four with clients here.
    """
    client, owner = authed_client
    async with (
        opponent_session(db_session, "rrko-b") as (client_b, user_b),
        opponent_session(db_session, "rrko-c") as (client_c, user_c),
        opponent_session(db_session, "rrko-d") as (client_d, user_d),
    ):
        tournament_id = await _tournament(client)
        event_id = (await _create_event(client, tournament_id)).json()["id"]
        # Seeds 1, 6, 7, 12 snake into group A; the eight extras fill B and C.
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

        group_a_id = await _group_id(db_session, event_id, "Reservation A")
        group_a = [
            f for f in await _fixtures(db_session, event_id) if f.group_id == group_a_id
        ]
        assert len(group_a) == 6, "a group of four is six pairings"
        await _call(db_session, tournament_id, group_a)
        group_a_id = await _group_id(db_session, event_id, "Reservation A")
        group_a = [
            f for f in await _fixtures(db_session, event_id) if f.group_id == group_a_id
        ]

        clients = {
            entries[1].id: client,
            entries[6].id: client_b,
            entries[7].id: client_c,
            entries[12].id: client_d,
        }
        by_pair = {frozenset({f.entry_a_id, f.entry_b_id}): f for f in group_a}

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

        bracket = [f for f in await _fixtures(db_session, event_id) if _is_knockout(f)]
        seated = {
            entry_id
            for f in bracket
            for entry_id in (f.entry_a_id, f.entry_b_id)
            if entry_id is not None
        }
        assert seated == {entries[1].id, entries[7].id}, (
            "exactly group A's top two are seated — and the runner-up is the one the "
            "standings' game-difference tiebreak names, which wins alone cannot pick"
        )
        # Nothing is ready to play: every knockout fixture still has a TBD side, so none
        # of them materialized into a match.
        assert all(f.match_id is None for f in bracket)


def _reservation_payload(reservation: TournamentEventReservation) -> dict[str, Any]:
    """The full :class:`~app.schemas.tournament.ReservationUpsert` a PATCH must send
    to *cite* an existing reservation: an id alone is not enough, since the shape
    carries ``name``, ``slot`` and ``table_ids`` too.

    The id is the **reservation's own** — the wire diffs
    (``apply_event_reservations``) on the reservation's id, not the group's, so
    citing a group's id here would name no reservation this event has. ``table_ids``
    is sent empty rather than round-tripped — a table this test's tournament does not
    have is dropped silently (``app.tournament_reservations._reservation_tables``) —
    so the emptiness itself asserts nothing either way."""
    return {
        "id": str(reservation.id),
        "name": reservation.name,
        "slot": {
            "date": reservation.slot_date.isoformat(),
            "start": reservation.slot_start.strftime("%H:%M"),
            "end": reservation.slot_end.strftime("%H:%M"),
        },
        "table_ids": [],
    }


async def test_a_group_reorder_mid_draw_is_refused_and_seating_stays_correct(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The end-to-end regression for the mutable-``group_position`` bug
    (``app.tournament_events._enforce_group_set_frozen``'s reorder guard).

    Two groups of **three**, top two per group (six entrants rather than the twelve
    other tests in this file use — see below for why): the cut derives the count from
    the real field (#1387, ``ceil(6 / 5)``), and the snake deals seeds 1, 4, 5 into
    group A and 2, 3, 6 into group B. Group A is played out first — the LOWER seed
    always wins, so its two matches touching seed 1 and its one match between 4 and 5
    leave 1 and 4 as its only winners, and therefore its top two — and they seat into
    their predetermined bracket slots. A PATCH then cites the SAME three reservations
    (the event has three, the third mapped to no group), reversed, and is refused with
    a `409` naming the reservation order as frozen — group B is still playing, and its
    qualifiers have not been seated yet. Group B is then played out, and its own top
    two (seeds 2 and 3) seat in too, alongside group A's untouched pair — exactly four
    distinct entrants seated, nobody doubled and nobody dropped.

    Three-a-side rather than four-a-side on purpose: in a group of three, "the lower
    seed always wins" makes every one of a group's three matches won by one of its own
    top two (the third match is between them), so only two real player sessions are
    needed per group. A group of four adds a match between its bottom two seeds, whose
    winner is neither — a third client this test has no use for otherwise.

    **Falsification** (``.claude/rules/verify-the-artifact-under-test.md``): revert
    ``_enforce_group_set_frozen``'s reorder branch to the old id-SET comparison (so a
    same-set, different-order payload is treated as unchanged) and this test's own
    ``assert reorder.status_code == 409`` reds — confirmed directly, along with
    ``tests/test_tournament_events.py::test_update_event_frozen_group_reorder_is_refused``,
    which reds with ``DID NOT RAISE GroupSetFrozenError`` against the same revert.
    Past that assertion the reorder DOES restamp each group's ``position`` exactly as
    documented (``apply_event_reservations``'s "re-positioned as this payload says"),
    which is what ``tests/test_draws.py::test_rr_then_ko_labels_groups_by_the_directors_
    position_not_sorted_ids`` pins at the pure-strategy layer: a position swap alone
    flips which physical group a knockout seed is labelled against. This test does not
    press further into that HTTP round trip past the 409 — a reorder that reaches the
    response serializer is a path the guard makes permanently unreachable, and a
    previous probe of it (with the guard removed) hit an unrelated lazy-load crash in
    ``app.tournament_reservations.group_read``, not a clean 200 to build a
    strand/double-seat assertion on. The mechanism is proven at the two layers above
    instead.
    """
    client, owner = authed_client
    async with (
        opponent_session(db_session, "reorder-4") as (client_4, user_4),
        opponent_session(db_session, "reorder-2") as (client_2, user_2),
        opponent_session(db_session, "reorder-3") as (client_3, user_3),
    ):
        tournament_id = await _tournament(client)
        event_id = (
            await _create_event(client, tournament_id, qualifiers_per_group=2)
        ).json()["id"]
        # Seeds 1, 4, 5 snake into group A; 2, 3, 6 into group B.
        players = {1: owner, 4: user_4, 2: user_2, 3: user_3}
        entries: dict[int, TournamentEntry] = {}
        for seed in range(1, 7):
            user = players.get(seed) or await make_user(db_session, f"reorder{seed}")
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
        clients_by_entry = {
            entries[1].id: client,
            entries[4].id: client_4,
            entries[2].id: client_2,
            entries[3].id: client_3,
        }

        async def _play_group(
            reservation_name: str, seeds: tuple[int, int, int]
        ) -> None:
            """Play one group of three out in full — the LOWER seed always wins, 2-0 —
            so its finishing order (and therefore its qualifiers) is simply its two
            lowest seeds, with no tiebreak needed and no third client."""
            group_id = await _group_id(db_session, event_id, reservation_name)
            fixtures = [
                f
                for f in await _fixtures(db_session, event_id)
                if f.group_id == group_id
            ]
            await _call(db_session, tournament_id, fixtures)
            fixtures = [
                f
                for f in await _fixtures(db_session, event_id)
                if f.group_id == group_id
            ]
            by_pair = {frozenset({f.entry_a_id, f.entry_b_id}): f for f in fixtures}
            for a, b in combinations(seeds, 2):
                winner = min(a, b)
                fixture = by_pair[frozenset({entries[a].id, entries[b].id})]
                await _win(
                    fixture,
                    clients_by_entry=clients_by_entry,
                    winner_entry_id=entries[winner].id,
                )

        await _play_group("Reservation A", (1, 4, 5))

        def _seated(fixtures: Sequence[TournamentFixture]) -> set[uuid.UUID]:
            return {
                entry_id
                for f in fixtures
                if _is_knockout(f)
                for entry_id in (f.entry_a_id, f.entry_b_id)
                if entry_id is not None
            }

        assert _seated(await _fixtures(db_session, event_id)) == {
            entries[1].id,
            entries[4].id,
        }, "group A's top two must already be seated before the reorder is attempted"

        reservations = await _reservations(db_session, event_id)
        stored_order = await _group_ids(db_session, event_id)
        reorder = await client.patch(
            f"/v1/tournaments/{tournament_id}/events/{event_id}",
            json={
                "reservations": [
                    _reservation_payload(reservation)
                    for reservation in reversed(reservations)
                ]
            },
        )
        assert reorder.status_code == 409, reorder.text
        assert "order of its reservations is frozen" in reorder.json()["detail"]
        assert await _group_ids(db_session, event_id) == stored_order, (
            "a refused reorder writes nothing — the stored order is unchanged"
        )

        await _play_group("Reservation B", (2, 3, 6))

        assert _seated(await _fixtures(db_session, event_id)) == {
            entries[1].id,
            entries[4].id,
            entries[2].id,
            entries[3].id,
        }, "both finished groups' qualifiers are seated, once each, with nobody dropped"


@pytest.mark.parametrize("reorder", [True, False], ids=["reordered", "same-order"])
async def test_a_reservations_patch_before_any_draw_is_cut_is_accepted(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession, reorder: bool
) -> None:
    """The permitted sibling of the refusal above, run all the way through the HTTP
    response serializer rather than stopping at a service-layer call: once a draw is
    cut, `_enforce_group_set_frozen` refuses a reorder before serialization is ever
    reached, so this path was never observable through that guard.

    **This was an `xfail(strict=True)` until the group/reservation split, and it pinned
    a real 500.** ANY PATCH whose body carried the reservations key returned 500,
    reordered or
    resent unchanged: `update_event` ends with `await db.refresh(event)`, which left the
    venue side of each group expired rather than eagerly reloaded, and `group_read`
    then touched it during response serialization — a lazy load, which under async
    raises `MissingGreenlet`. No test exercised a `reservations` PATCH over HTTP before
    this one, so it had never been caught.

    The split fixed it incidentally, and structurally rather than by luck: a group
    reaches its reservation through `lazy="joined"` relationships, so the reservation
    and its mapping arrive in whatever SELECT loads the group instead of waiting to be
    fetched on access. The one collection still loaded separately, the reservation's
    `tables`, chains its `selectin` off that same load. There is nothing left for the
    refresh to leave behind.

    Parametrized because the crash did not depend on the order actually changing: a
    same-order resend (the shape a director's plain venue edit takes) 500'd exactly as a
    reorder did, and both must now answer 200.
    """
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event_id = (await _create_event(client, tournament_id)).json()["id"]

    reservations = await _reservations(db_session, event_id)
    assert len(reservations) > 1, (
        "a reorder needs at least two reservations to be meaningful"
    )
    sent = list(reversed(reservations)) if reorder else reservations
    expected_order = [reservation.id for reservation in sent]
    group_ids = await _group_ids(db_session, event_id)

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event_id}",
        json={
            "reservations": [_reservation_payload(reservation) for reservation in sent]
        },
    )

    assert response.status_code == 200, response.text
    assert [
        reservation.id for reservation in await _reservations(db_session, event_id)
    ] == expected_order
    # The groups are the server's and keep their identities across a reservation
    # reorder (#1387): only the mapping moves, re-read as ``position % reservation
    # count`` against the new order.
    assert await _group_ids(db_session, event_id) == group_ids
    body = response.json()
    by_position = {
        reservation["position"]: reservation["id"]
        for reservation in body["reservations"]
    }
    groups = sorted(body["groups"], key=lambda group: group["position"])
    assert [group["reservation_id"] for group in groups] == [
        by_position[group["position"] % len(by_position)] for group in groups
    ]


async def test_a_group_holding_a_voided_pairing_still_seats_its_qualifiers(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """**A voided pairing must not wedge the event.**

    The same twelve entrants, the same group A, and the same five scorelines as the
    test above — except that group A's sixth pairing (6 v 12) is played and then
    **voided**, which is what an account merge's self-play collision does to a match
    that has already been scored (ADR-0013). Voiding takes it out of ``completed`` (so
    its games go away) but leaves the ``winner_entry_id`` the completion wrote back on
    the fixture, so the fixture reads *decided, with no games* forever.

    Before the fix, "a group is finished when every fixture carries a score" counted
    that pairing, so group A sat one score short of finishing **permanently**: its
    qualifiers were never seated, the knockout never became ready, no champion was ever
    crowned, and there was nothing a director could do about it. Meanwhile the
    standings — which already exclude voided pairings from a group's ``fixture_count``
    — showed that very group ``complete``. Two layers disagreeing about whether the
    group was over.

    **The runner-up flips, which is what makes this evidence about the ordering.** With
    6 v 12 counted, 6, 7 and 12 form a beat-cycle on one win apiece and game difference
    seats **7**. With it voided, 6 and 7 are a plain two-way tie that head-to-head
    settles for **6**: a different qualifier, reachable only by ordering the group on
    the results that survive. And it is asserted against the standings table read back
    off the tournament payload rather than against a hardcoded pair, so "the qualifiers
    are the top of the table a director is reading" is checked, not assumed.
    """
    client, owner = authed_client
    async with (
        opponent_session(db_session, "void-b") as (client_b, user_b),
        opponent_session(db_session, "void-c") as (client_c, user_c),
        opponent_session(db_session, "void-d") as (client_d, user_d),
    ):
        tournament_id = await _tournament(client)
        event_id = (await _create_event(client, tournament_id)).json()["id"]
        players = {1: owner, 6: user_b, 7: user_c, 12: user_d}
        entries: dict[int, TournamentEntry] = {}
        for seed in range(1, 13):
            user = players.get(seed) or await make_user(db_session, f"voidextra{seed}")
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

        group_a_id = await _group_id(db_session, event_id, "Reservation A")
        group_a = [
            f for f in await _fixtures(db_session, event_id) if f.group_id == group_a_id
        ]
        await _call(db_session, tournament_id, group_a)
        group_a_id = await _group_id(db_session, event_id, "Reservation A")
        group_a = [
            f for f in await _fixtures(db_session, event_id) if f.group_id == group_a_id
        ]
        clients = {
            entries[1].id: client,
            entries[6].id: client_b,
            entries[7].id: client_c,
            entries[12].id: client_d,
        }
        by_pair = {frozenset({f.entry_a_id, f.entry_b_id}): f for f in group_a}

        def fixture_between(a: int, b: int) -> TournamentFixture:
            return by_pair[frozenset({entries[a].id, entries[b].id})]

        # Played first, so the completion writes a winner back onto the fixture — then
        # voided, which strands that winner with no games. The nastiest of the two real
        # shapes, and the one a naive "decided but gameless" check mistakes for a
        # projection that forgot to load its game counts.
        collision = fixture_between(6, 12)
        await _win(
            collision,
            clients_by_entry=clients,
            winner_entry_id=entries[12].id,
            games=(2, 0),
        )
        match = await db_session.get(Match, collision.match_id)
        assert match is not None
        await void_match(db_session, match)
        await db_session.commit()

        for winner, loser, games in (
            (1, 6, (2, 1)),
            (1, 7, (2, 0)),
            (1, 12, (2, 0)),
            (6, 7, (2, 1)),
            (7, 12, (2, 0)),
        ):
            await _win(
                fixture_between(winner, loser),
                clients_by_entry=clients,
                winner_entry_id=entries[winner].id,
                games=games,
            )

        results = (await _event_read(client, tournament_id))["results"]

    bracket = [f for f in await _fixtures(db_session, event_id) if _is_knockout(f)]
    seated = {
        entry_id
        for f in bracket
        for entry_id in (f.entry_a_id, f.entry_b_id)
        if entry_id is not None
    }
    assert seated == {entries[1].id, entries[6].id}, (
        "the group finished on the five results that survived the void, and seated "
        "the two the surviving results put on top — 6, not the 7 the beat-cycle would "
        "have"
    )
    # And the two layers agree, which is the whole point: the group the bracket
    # treated as over is the group the director's table calls ``complete``, and the
    # qualifiers are its top two rows.
    (group_a_read,) = [
        group
        for group in results["groups"]
        if group["group_id"]
        == str(await _group_id(db_session, event_id, "Reservation A"))
    ]
    assert group_a_read["complete"] is True
    assert [row["entry_id"] for row in group_a_read["rows"][:2]] == [
        str(entries[1].id),
        str(entries[6].id),
    ]


async def test_the_results_read_out_as_both_stages(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The tournament-detail payload carries the third arm of the results union.

    ``kind: "standings_then_finishes"``, with one block per stage: the group tables
    read exactly as a round-robin's do (the same models), and the finishes list exactly
    as a single-elim's does. It is live and partial, like every other results shape —
    the played group is ``complete`` while its neighbours are not, the bracket has
    produced no finishes yet, and there is **no champion**, because a champion comes
    from the bracket's final and never from topping a group.
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
    assert [group["group_id"] for group in results["groups"]] == [
        str(group_id) for group_id in await _group_ids(db_session, event_id)
    ]
    assert all(group["complete"] is False for group in results["groups"])
    (group_a,) = [
        group
        for group in results["groups"]
        if group["group_id"]
        == str(await _group_id(db_session, event_id, "Reservation A"))
    ]
    leader = group_a["rows"][0]
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
