"""Swiss, end to end as far as this slice goes (#1276, ADR "swiss pre-cuts every round
and pairs each one on advance").

The strategy itself is pure and is tested from literals in ``test_draws.py``; the
standings shape is tested the same way in ``test_results.py``. What this file tests is
everything *between* them and a director: the request boundary that requires a round
count for exactly one draw type, the settings row it lands on, the wire it reads back
on, the cut that writes every round at once, and the completion seam that pairs the
next round when the current one is done.

That last one is here rather than only in ``test_draws.py`` because a pure strategy
that pairs perfectly is **inert** unless the seam hands it the two things it needs: the
fixtures' game counts, and the event's **entrants** (a byed entrant sits in no fixture,
so the seated set is not the field). Both are loaded in
``app.tournament_materialization``, neither is visible to a unit test, and getting
either wrong stalls a live event silently rather than failing.
"""

import uuid
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.draws import _swiss_seated_pairings
from app.models import (
    DrawType,
    Match,
    MatchStatus,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.results import SwissResults
from app.schemas.tournament import (
    MAX_SWISS_ROUNDS,
    TournamentEntrantRead,
    TournamentFixtureRead,
)
from app.tournament_draw_settings import draw_settings_of
from app.tournament_draws import DrawCurrency, draw_currency_by_event, fixture_state
from app.tournament_materialization import materialize_event
from app.tournament_queries import stage_ids_for_events
from app.tournament_serialization import _field_input, _seated_pairings
from app.tournaments import TOURNAMENT_CREATE
from tests._helpers import (
    counted_statements,
    grant_permissions,
    make_user,
    opponent_session,
    patch_event,
    start_session,
)

# The tournament suite's own lifecycle helpers, imported rather than re-declared so a
# change to how a tournament is started (or a status is staged) reaches this file too —
# including how a materialized fixture is called to a table and played out, so a swiss
# match completes by exactly the route a round-robin or knockout one does.
from tests.test_tournaments import (
    _call_fixtures,
    _go_live,
    _set_status,
    _win_fixture_match,
    _withdraw,
)

SWISS = DrawType.swiss.value


@pytest_asyncio.fixture
async def authed_client(
    api_client: AsyncClient, db_session: AsyncSession
) -> AsyncIterator[tuple[AsyncClient, User]]:
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, (TOURNAMENT_CREATE,))
    yield api_client, user


def _tournament_payload() -> dict[str, Any]:
    return {
        "name": "Swiss Open",
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
    """A swiss event of three rounds.

    **No groups**: swiss is group-less, and sending reservations an un-grouped draw
    type ignores would make every assertion below about a shape the format does not
    have.
    """
    payload: dict[str, Any] = {
        "name": "Open Singles",
        "format": "singles",
        "draw_type": SWISS,
        "rounds": 3,
        "max_players": 64,
        "entry_fee": 0,
        "timezone": "America/Chicago",
        "slot": {"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        "match_settings": {"rated": False, "length_games": 3},
        "predicates": [],
        "reservations": [],
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


async def _settings_of(db: AsyncSession, event_id: str) -> TournamentEvent:
    db.expire_all()
    return (
        await db.execute(
            select(TournamentEvent).where(TournamentEvent.id == uuid.UUID(event_id))
        )
    ).scalar_one()


def _stored_rounds(event: TournamentEvent) -> int | None:
    """The round count this event has **stored**, parsed back out of its settings row's
    JSON object (ADR "a draw type's settings are one NOT NULL JSON object")."""
    return draw_settings_of(event.draw_settings).rounds


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


async def _field(
    client: AsyncClient, db: AsyncSession, size: int, **overrides: Any
) -> tuple[str, str, list[TournamentEntry]]:
    """A swiss event with a stated field of ``size`` seeded entrants, seed ``n`` being
    the ``n``-th in the draw order."""
    tournament_id = await _tournament(client)
    event_id = (await _create_event(client, tournament_id, **overrides)).json()["id"]
    entries = [
        await _enter(db, event_id, await make_user(db, f"swiss{n}"), seed=n, minutes=n)
        for n in range(1, size + 1)
    ]
    return tournament_id, event_id, entries


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
                .order_by(TournamentFixture.round, TournamentFixture.position)
            )
        )
        .scalars()
        .all()
    )


async def _event_read(client: AsyncClient, tournament_id: str) -> dict[str, Any]:
    response = await client.get(f"/v1/tournaments/{tournament_id}")
    assert response.status_code == 200, response.text
    (event,) = response.json()["events"]
    read: dict[str, Any] = event
    return read


# ----- the request boundary: a round count belongs to exactly one draw type ----------


async def test_creating_a_swiss_event_persists_its_round_count(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The whole configuration lands on the settings row: the slug *and* the R.

    Asserted from the database rather than the response, because the row is what the
    cut reads — a response echoing a number nothing stored would satisfy a wire
    assertion and then cut a draw of a different length.
    """
    client, _ = authed_client
    tournament_id = await _tournament(client)

    created = await _create_event(client, tournament_id, rounds=5)

    assert created.status_code == 201, created.text
    event = await _settings_of(db_session, created.json()["id"])
    assert event.draw_settings.draw_type is DrawType.swiss
    assert _stored_rounds(event) == 5


async def test_a_swiss_event_without_a_round_count_is_422(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """There is no defensible default. ``ceil(log2 N)`` is the convention, and deriving
    it would move the length of a day the director has already booked tables for — so
    the omission is refused at the boundary, naming the field, and no event is written.
    """
    client, _ = authed_client
    tournament_id = await _tournament(client)
    payload = _event_payload()
    del payload["rounds"]

    response = await client.post(
        f"/v1/tournaments/{tournament_id}/events", json=payload
    )

    assert response.status_code == 422, response.text
    assert "rounds" in response.text
    events = (
        await db_session.execute(
            select(TournamentEvent).where(
                TournamentEvent.tournament_id == uuid.UUID(tournament_id)
            )
        )
    ).scalars()
    assert list(events) == [], "a refusal at the boundary writes nothing"


@pytest.mark.parametrize("draw_type", ["round-robin", "single-elim", "rr-then-ko"])
async def test_a_round_count_on_another_draw_type_is_422(
    authed_client: tuple[AsyncClient, User], draw_type: str
) -> None:
    """**Refused at the boundary, never silently dropped.** "Play 3 rounds" means
    nothing to a round-robin (the circle method decides how many there are), to a
    bracket (its depth follows from the field) or to a two-stage draw (neither stage
    has a chosen count). Every other draw type is asked, because a union that had lost
    one arm's ``extra="forbid"`` would look identical on a one-slug test."""
    client, _ = authed_client
    tournament_id = await _tournament(client)

    response = await _create_event(
        client,
        tournament_id,
        draw_type=draw_type,
        rounds=3,
        **({"qualifiers_per_group": 2} if draw_type == "rr-then-ko" else {}),
    )

    assert response.status_code == 422, response.text
    assert "rounds" in response.text


@pytest.mark.parametrize("rounds", [0, -1, MAX_SWISS_ROUNDS + 1, 2_147_483_648])
async def test_a_round_count_outside_the_static_bounds_is_422(
    authed_client: tuple[AsyncClient, User], rounds: int
) -> None:
    """``1 <= R <= MAX_SWISS_ROUNDS`` is the static half of the legal space: zero rounds
    play nothing, a negative is not a count, and the top end keeps a form value from
    walking into an ``Integer`` column as a 500. The bound that moves with the field
    (``R <= N - 1``) is deliberately not here — it is refused at the cut."""
    client, _ = authed_client
    tournament_id = await _tournament(client)

    response = await _create_event(client, tournament_id, rounds=rounds)

    assert response.status_code == 422, response.text
    assert "rounds" in response.text


async def test_a_round_count_at_the_ceiling_is_accepted(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The bound is **inclusive**, pinned so the refusal above cannot be satisfied by an
    off-by-one that also refuses the last legal number."""
    client, _ = authed_client
    tournament_id = await _tournament(client)

    created = await _create_event(client, tournament_id, rounds=MAX_SWISS_ROUNDS)

    assert created.status_code == 201, created.text
    event = await _settings_of(db_session, created.json()["id"])
    assert _stored_rounds(event) == MAX_SWISS_ROUNDS


async def test_the_round_count_reads_back_flat_beside_the_draw_type(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """The editor has to see the stored R, because the arm requires one on every PATCH
    of a swiss event — a rename that guessed a round count would silently re-cut the
    director's day."""
    client, _ = authed_client
    tournament_id = await _tournament(client)

    created = await _create_event(client, tournament_id, rounds=4)

    assert created.json()["rounds"] == 4
    assert created.json()["qualifiers_per_group"] is None
    read = await _event_read(client, tournament_id)
    assert read["rounds"] == 4
    assert read["draw_type"] == SWISS


async def test_another_draw_type_reads_back_no_round_count(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """``null`` for every draw type that has no chosen round count — a fact, not
    missing data, and the same shape the qualifier count takes on the arms with no
    knockout stage."""
    client, _ = authed_client
    tournament_id = await _tournament(client)

    created = await _create_event(
        client, tournament_id, draw_type="round-robin", rounds=None
    )

    assert created.status_code == 201, created.text
    assert created.json()["rounds"] is None


async def test_patching_a_round_count_without_its_draw_type_is_422(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """The draw configuration is patched **as a unit**, exactly as the qualifier count
    is: which draw types carry a round count is a fact about the pair, and a patch
    carrying only ``rounds`` does not hold it."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event_id = (await _create_event(client, tournament_id)).json()["id"]

    response = await patch_event(client, tournament_id, event_id, {"rounds": 5})

    assert response.status_code == 422, response.text
    assert "draw_type" in response.text


async def test_patching_away_from_swiss_clears_the_round_count(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The pair is written together, so a draw type moved to round-robin leaves no
    round count behind — and the wire says so, or the editor re-sends a number the
    boundary now refuses."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event_id = (await _create_event(client, tournament_id)).json()["id"]

    response = await patch_event(
        client, tournament_id, event_id, {"draw_type": "round-robin"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["rounds"] is None
    event = await _settings_of(db_session, event_id)
    assert _stored_rounds(event) is None


# ----- the cut: every round at once --------------------------------------------------


async def test_the_cut_writes_every_round_with_round_one_seated(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """Eight entrants, three rounds: 12 fixtures, cut in one stroke.

    Round 1 carries both sides, seeded from the draw order — top half against bottom
    half, so seed 1 meets seed 5. Rounds 2 and 3 exist with both sides NULL, which
    means TBD and nothing else (ADR-0786).

    Every fixture names the event's **one group** (#1483), which is what confines the
    rounds to the reservation the director booked. That is a scheduling fact, not a
    format one: swiss still ranks one field in one table, and no surface labels these
    rounds with a group — the stage's own draw type is what decides that
    (``app.draws.seats_both_sides_at_cut``).
    """
    client, _ = authed_client
    tournament_id, event_id, entries = await _field(client, db_session, 8)

    assert (await _cut(client, tournament_id, event_id)).status_code == 201

    fixtures = await _fixtures(db_session, event_id)
    assert len(fixtures) == 12
    group_ids = {f.group_id for f in fixtures}
    assert len(group_ids) == 1 and None not in group_ids, (
        "every swiss fixture is dealt into the event's one group, so the solver can "
        f"reach its reservation through it — got {group_ids!r}"
    )

    by_seed = {entry.seed: entry.id for entry in entries}
    round_one = [f for f in fixtures if f.round == 1]
    assert [(f.position, f.entry_a_id, f.entry_b_id) for f in round_one] == [
        (1, by_seed[1], by_seed[5]),
        (2, by_seed[2], by_seed[6]),
        (3, by_seed[3], by_seed[7]),
        (4, by_seed[4], by_seed[8]),
    ]

    later = [f for f in fixtures if f.round > 1]
    assert sorted((f.round, f.position) for f in later) == [
        (2, 1),
        (2, 2),
        (2, 3),
        (2, 4),
        (3, 1),
        (3, 2),
        (3, 3),
        (3, 4),
    ]
    assert all(f.entry_a_id is None and f.entry_b_id is None for f in later)


async def test_an_odd_field_cuts_one_fewer_pairing_a_round(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """Seven entrants, two rounds: three pairings a round, and the entrant sitting out
    has **no fixture** — a bye is the absence of a row, never a row with a NULL side
    (CONTEXT.md, "Bye"). Which entrant that is, round by round, is the next slice's
    problem; in round 1, with nobody yet on a score, it is the lowest seed."""
    client, _ = authed_client
    tournament_id, event_id, entries = await _field(client, db_session, 7, rounds=2)

    assert (await _cut(client, tournament_id, event_id)).status_code == 201

    fixtures = await _fixtures(db_session, event_id)
    assert len(fixtures) == 6
    round_one = [f for f in fixtures if f.round == 1]
    seated = {f.entry_a_id for f in round_one} | {f.entry_b_id for f in round_one}
    by_seed = {entry.seed: entry.id for entry in entries}
    assert seated == {by_seed[seed] for seed in range(1, 7)}
    assert by_seed[7] not in seated


async def test_the_standings_carry_the_whole_field_including_the_byed_entrant(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """A cut swiss event reads out as one group-less table over **every** entrant.

    Seven entrants means one of them has no round-1 fixture at all — a bye is the
    absence of a row — so a table derived from the fixtures' sides would seat six and
    quietly leave the seventh off the standings they are entitled to a row on. The
    field comes off the event's entrants for exactly that reason.
    """
    client, _ = authed_client
    tournament_id, event_id, entries = await _field(client, db_session, 7, rounds=2)
    assert (await _cut(client, tournament_id, event_id)).status_code == 201

    results = (await _event_read(client, tournament_id))["results"]

    assert results["kind"] == "swiss_standings"
    assert {row["entry_id"] for row in results["rows"]} == {
        str(entry.id) for entry in entries
    }
    assert [row["rank"] for row in results["rows"]] == [1, 2, 3, 4, 5, 6, 7]
    assert all(row["played"] == 0 for row in results["rows"]), "nobody has played yet"
    assert all(row["buchholz"] == 0 for row in results["rows"]), (
        "the column swiss adds reaches the wire — every figure is zero here because "
        "nobody has an opponent yet; a real one is pinned in tests/test_results.py"
    )
    assert results["complete"] is False
    assert results["champion"] is None


async def test_cutting_more_rounds_than_the_field_can_play_rematch_free_is_refused(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """A moving bound, refused at the cut in the director's own language, naming both
    ways out — and nothing is written.

    It cannot live at the request boundary: it depends on the entrant count, which
    moves. A round count that was legal when it was written must not become unwritable
    because a player withdrew.
    """
    client, _ = authed_client
    tournament_id, event_id, _ = await _field(client, db_session, 5, rounds=9)

    response = await _cut(client, tournament_id, event_id)

    assert response.status_code == 422, response.text
    assert response.json()["detail"] == (
        "9 rounds is more than the 5 rounds a field of 5 entrants can play without a "
        "rematch — play fewer rounds, or add entrants."
    )
    assert await _fixtures(db_session, event_id) == [], (
        "a refused cut writes nothing at all"
    )


async def test_an_odd_field_cuts_a_full_n_rounds(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The QA-found refusal, from the director's end: five entrants, five rounds, cut.

    An odd field byes one entrant a round, so five rounds give everybody four matches
    and one round off — every opponent met, nothing repeated. The bound was ``n - 1``
    for every field, which refused this 201 as if it were a rematch.
    """
    client, _ = authed_client
    tournament_id, event_id, _ = await _field(client, db_session, 5, rounds=5)

    assert (await _cut(client, tournament_id, event_id)).status_code == 201

    fixtures = await _fixtures(db_session, event_id)
    assert len(fixtures) == 10  # 5 rounds × ⌊5/2⌋
    assert sorted({f.round for f in fixtures}) == [1, 2, 3, 4, 5]


async def test_the_round_count_is_frozen_once_the_draw_is_cut(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """409, exactly as the draw type freezes, and for the same concrete reason: every
    round's fixtures are already rows in the database, so raising R would leave the
    added rounds with none and lowering it would leave fixtures no round claims."""
    client, _ = authed_client
    tournament_id, event_id, _ = await _field(client, db_session, 8)
    assert (await _cut(client, tournament_id, event_id)).status_code == 201

    response = await patch_event(
        client, tournament_id, event_id, {"draw_type": SWISS, "rounds": 5}
    )

    assert response.status_code == 409, response.text
    assert "rounds is frozen" in response.json()["detail"]
    event = await _settings_of(db_session, event_id)
    assert _stored_rounds(event) == 3, "a refusal wrote nothing"


async def test_the_round_count_is_editable_while_no_draw_exists(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The freeze above is about a **cut** draw. Before one, the round count is ordinary
    editable configuration — without this the 409 test could pass against a rule that
    refused every change."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event_id = (await _create_event(client, tournament_id)).json()["id"]

    response = await patch_event(
        client, tournament_id, event_id, {"draw_type": SWISS, "rounds": 6}
    )

    assert response.status_code == 200, response.text
    assert response.json()["rounds"] == 6
    event = await _settings_of(db_session, event_id)
    assert _stored_rounds(event) == 6


# ----- draw currency: a byed entrant is covered, a latecomer is not ------------------


async def _currency(db: AsyncSession, event_id: str) -> DrawCurrency:
    """Where this event's draw stands relative to its field — read through the same
    loader the go-live precondition asks."""
    event_uuid = uuid.UUID(event_id)
    db.expire_all()
    return (await draw_currency_by_event(db, [event_uuid]))[event_uuid]


async def test_an_odd_swiss_field_reads_current_and_can_go_live(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """**A bye is not a missing player.** Seven entrants across two rounds means one of
    them sits out round 1, and a bye is the absence of a fixture row — so the byed
    entrant is seated in no fixture at all.

    Currency compares the fixtures' seated entries against the active ones, and that
    comparison read the bye as an entrant the draw had failed to cover: the draw came
    back ``stale`` and go-live answered 409 for an odd field that had just been cut
    from exactly those entrants. Nothing a director could do would clear it — re-cutting
    deals the same bye — so an odd-field swiss event could be configured, entered and
    cut, and then never start.
    """
    client, _ = authed_client
    tournament_id, event_id, _ = await _field(client, db_session, 7, rounds=2)
    assert (await _cut(client, tournament_id, event_id)).status_code == 201
    await _set_status(db_session, tournament_id, TournamentStatus.published)

    assert await _currency(db_session, event_id) is DrawCurrency.current

    started = await _go_live(client, tournament_id)
    assert started.status_code == 201, started.text


async def test_a_swiss_draw_is_stale_when_an_entry_lands_after_the_cut(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The check the bye must not blunt: somebody entered after the cut.

    Seven entrants are cut (six seated, one byed) and an eighth arrives. Two of the
    eight are now seated nowhere, which is one more than a single round's bye can
    account for — so the draw is stale and the director is told to cut it again, exactly
    as they would be for a round-robin.
    """
    client, _ = authed_client
    tournament_id, event_id, _ = await _field(client, db_session, 7, rounds=2)
    assert (await _cut(client, tournament_id, event_id)).status_code == 201
    await _set_status(db_session, tournament_id, TournamentStatus.published)
    await _enter(
        db_session,
        event_id,
        await make_user(db_session, "swiss-latecomer"),
        seed=8,
        minutes=8,
    )

    assert await _currency(db_session, event_id) is DrawCurrency.stale

    refused = await _go_live(client, tournament_id)
    assert refused.status_code == 409, refused.text
    assert "no longer matches its entrants" in refused.json()["detail"]


async def test_a_swiss_draw_is_stale_when_a_seated_entrant_withdraws(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The other direction, and the one a bye allowance must not swallow: the draw seats
    somebody who has **left**. An entry the fixtures still name is not covered by "one
    entrant may be unseated" — it is the opposite complaint, and it stays a 409."""
    client, _ = authed_client
    tournament_id, event_id, entries = await _field(client, db_session, 8, rounds=2)
    assert (await _cut(client, tournament_id, event_id)).status_code == 201
    await _set_status(db_session, tournament_id, TournamentStatus.published)
    await _withdraw(db_session, entries[0])

    assert await _currency(db_session, event_id) is DrawCurrency.stale

    refused = await _go_live(client, tournament_id)
    assert refused.status_code == 409, refused.text


async def test_two_late_entries_exhaust_the_bye_allowance_and_are_stale(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The allowance is **one** entrant, not "swiss stopped checking": eight are cut and
    two more arrive, so two of the ten are seated nowhere and no single round's bye can
    account for them."""
    client, _ = authed_client
    tournament_id, event_id, _ = await _field(client, db_session, 8, rounds=2)
    assert (await _cut(client, tournament_id, event_id)).status_code == 201
    await _set_status(db_session, tournament_id, TournamentStatus.published)
    for n in (9, 10):
        await _enter(
            db_session,
            event_id,
            await make_user(db_session, f"swiss-late-{n}"),
            seed=n,
            minutes=n,
        )

    assert await _currency(db_session, event_id) is DrawCurrency.stale
    assert (await _go_live(client, tournament_id)).status_code == 409


async def test_a_lone_latecomer_leaving_an_odd_field_reads_as_that_rounds_bye(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """**The known limit of the allowance, pinned rather than left to be discovered.**

    Eight entrants are cut and a ninth arrives. That draw holds exactly the rows a draw
    cut for nine holds — ⌊8/2⌋ and ⌊9/2⌋ are the same four fixtures a round, and the
    byed entrant of a nine-player cut is recorded nowhere either. So the two states are
    indistinguishable, and this one reads ``current``: the latecomer is treated as the
    entrant sitting round 1 out.

    The direction of the error is deliberate. On swiss it costs the newcomer a bye,
    which the format hands somebody every odd round anyway. It is *not* a licence taken
    for the other draw types, where an unseated entrant would play no match at all: the
    test above them still shows a round-robin refusing the identical movement of the
    field, and ``test_two_late_entries_exhaust_the_bye_allowance_and_are_stale`` shows
    the allowance stops at one.
    """
    client, _ = authed_client
    tournament_id, event_id, _ = await _field(client, db_session, 8, rounds=2)
    assert (await _cut(client, tournament_id, event_id)).status_code == 201
    await _set_status(db_session, tournament_id, TournamentStatus.published)
    await _enter(
        db_session,
        event_id,
        await make_user(db_session, "swiss-ninth"),
        seed=9,
        minutes=9,
    )

    assert await _currency(db_session, event_id) is DrawCurrency.current
    assert (await _go_live(client, tournament_id)).status_code == 201


# ----- the completion seam: a decided round pairs the next one -----------------------


async def test_completing_every_round_one_match_pairs_and_materializes_round_two(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """**The whole slice, through the real endpoints.** Four entrants, three rounds. The
    cut seats round 1 (1v3, 2v4) and leaves rounds 2 and 3 empty; go-live materializes
    round 1 and nothing else. One result is not a table, so it pairs nothing. The
    *second* result completes the round, and round 2 pairs the two winners against each
    other and the two losers against each other — becoming matches in the same
    transaction.

    Round 1 is played as an **upset** (seed 3 beats seed 1) so that the answer is one
    only the standings give: pairing by the draw order would meet 1v2 and 3v4, and
    re-pairing round 1 would meet 1v3 and 2v4. Neither is what this asserts.

    Pairs are compared **unordered**, and that is the honest thing rather than a
    weakening. The two winners are level on wins, game difference and games won, so the
    order between them — and therefore which pairing takes position 1, and which entrant
    lands on side ``a`` — falls to the entry-id tiebreak, and an entry id here is a
    server-minted uuid. The rank-ordered ``position`` claim is pinned in
    ``test_draws.py``, where the ids are literals and the order is a fact.

    What only this test can catch: the seam
    (``app.tournament_materialization.materialize_event``) loading the game counts and
    the **entrants** the strategy needs. A unit test cannot see either, and either one
    missing leaves a live swiss event stalled after round 1 with nothing in the logs.
    """
    client, owner = authed_client
    async with (
        opponent_session(db_session, "swiss-two") as (client_2, user_2),
        opponent_session(db_session, "swiss-three") as (client_3, user_3),
        opponent_session(db_session, "swiss-four") as (client_4, user_4),
    ):
        tournament_id = await _tournament(client)
        event_id = (await _create_event(client, tournament_id)).json()["id"]
        entries = [
            await _enter(db_session, event_id, user, seed=seed, minutes=seed)
            for seed, user in enumerate((owner, user_2, user_3, user_4), start=1)
        ]
        assert (await _cut(client, tournament_id, event_id)).status_code == 201
        await _set_status(db_session, tournament_id, TournamentStatus.published)
        assert (await _go_live(client, tournament_id)).status_code == 201
        # The ids as plain values, taken once: the ORM entries are expired by the
        # ``expire_all`` below (and by the seam's own commits), and re-reading an
        # attribute off an expired instance in async context is a ``MissingGreenlet``,
        # not a lazy load.
        entry_ids = [entry.id for entry in entries]
        clients = dict(
            zip(entry_ids, [client, client_2, client_3, client_4], strict=True)
        )
        seed_of = {entry_id: seed for seed, entry_id in enumerate(entry_ids, start=1)}

        def pairs(
            fixtures: list[TournamentFixture], round_number: int
        ) -> set[frozenset[int]]:
            """Each of the round's pairings as a set of seeds, unordered."""
            return {
                frozenset(
                    seed
                    for entry_id in (f.entry_a_id, f.entry_b_id)
                    if (seed := seed_of.get(entry_id)) is not None
                )
                for f in fixtures
                if f.round == round_number
            }

        def is_unpaired(fixtures: list[TournamentFixture], round_number: int) -> bool:
            return all(
                f.entry_a_id is None and f.entry_b_id is None
                for f in fixtures
                if f.round == round_number
            )

        rows = await _fixtures(db_session, event_id)
        round_one = [f for f in rows if f.round == 1]
        assert pairs(rows, 1) == {frozenset({1, 3}), frozenset({2, 4})}, "the cut's own"
        assert all(f.match_id is not None for f in round_one), "round 1 materialized"
        assert is_unpaired(rows, 2), "round 2 is TBD until round 1 is decided"

        await _call_fixtures(db_session, tournament_id, round_one)
        # The upset: seed 3 takes the first fixture, so the winners are seeds 3 and 2.
        await _win_fixture_match(
            round_one[0],
            clients_by_entry=clients,
            winner_entry_id=entry_ids[2],
            rated=False,
        )

        db_session.expire_all()
        rows = await _fixtures(db_session, event_id)
        assert is_unpaired(rows, 2), (
            "one result is not a table — the round is paired off all of them or none"
        )

        await _win_fixture_match(
            round_one[1],
            clients_by_entry=clients,
            winner_entry_id=entry_ids[1],
            rated=False,
        )

        db_session.expire_all()
        rows = await _fixtures(db_session, event_id)
        assert pairs(rows, 2) == {frozenset({2, 3}), frozenset({1, 4})}, (
            "the two winners meet and the two losers meet — which is the standings' "
            "answer, and neither the draw order's (1v2, 3v4) nor round 1's own (1v3, "
            "2v4)"
        )
        assert all(f.match_id is not None for f in rows if f.round == 2), (
            "and the paired round materializes in the same transaction"
        )
        assert is_unpaired(rows, 3), "round 3 waits for round 2's table"


async def test_a_byed_entrant_is_credited_with_a_win_worth_zero_games(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """**The bye scores, end to end.** Three entrants over two rounds: round 1 pairs
    seeds 1 and 2 and seed 3 sits out. Seed 2 wins it, and the table then reads
    2, 3, 1 — the byed entrant credited with a win and placed above the player who lost
    a real match, but below the player who won one.

    The row is the assertion that matters: **played 1, won 1, and no games either way**.
    A nominal 3-0 for the bye would be invisible in the wins column and would show up
    here as game counts nobody played, which is exactly the game difference that would
    float a byed entrant over somebody who beat a real opponent.

    Round 2 is paired in the same breath, seating the byed entrant and passing the bye
    to seed 1 — the entrant who has not had one.
    """
    client, owner = authed_client
    async with (
        opponent_session(db_session, "swiss-bye-two") as (client_2, user_2),
        opponent_session(db_session, "swiss-bye-three") as (client_3, user_3),
    ):
        tournament_id = await _tournament(client)
        event_id = (await _create_event(client, tournament_id, rounds=2)).json()["id"]
        entries = [
            await _enter(db_session, event_id, user, seed=seed, minutes=seed)
            for seed, user in enumerate((owner, user_2, user_3), start=1)
        ]
        assert (await _cut(client, tournament_id, event_id)).status_code == 201
        await _set_status(db_session, tournament_id, TournamentStatus.published)
        assert (await _go_live(client, tournament_id)).status_code == 201
        entry_ids = [entry.id for entry in entries]
        clients = dict(zip(entry_ids, [client, client_2, client_3], strict=True))

        rows = await _fixtures(db_session, event_id)
        round_one = [f for f in rows if f.round == 1]
        await _call_fixtures(db_session, tournament_id, round_one)
        await _win_fixture_match(
            round_one[0],
            clients_by_entry=clients,
            winner_entry_id=entry_ids[1],
            rated=False,
        )

        db_session.expire_all()
        results = (await _event_read(client, tournament_id))["results"]

        by_entry = {row["entry_id"]: row for row in results["rows"]}
        byed = by_entry[str(entry_ids[2])]
        assert (byed["played"], byed["wins"], byed["losses"]) == (1, 1, 0)
        assert (byed["games_won"], byed["games_lost"]) == (0, 0), (
            "a bye is worth zero games — a nominal score would be a game difference "
            "nobody played for"
        )
        assert [row["entry_id"] for row in results["rows"]] == [
            str(entry_ids[1]),
            str(entry_ids[2]),
            str(entry_ids[0]),
        ], "the winner, then the bye, then the loser"

        fixtures = await _fixtures(db_session, event_id)
        (round_two,) = [f for f in fixtures if f.round == 2]
        assert {round_two.entry_a_id, round_two.entry_b_id} == {
            entry_ids[1],
            entry_ids[2],
        }, "round 2 seats the byed entrant, and the bye passes to the seed without one"


async def test_a_field_that_shrinks_mid_event_still_plays_out_and_finishes(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """**The whole of both bugs, through the real endpoints.** Four entrants, three
    rounds — two rows a round. The cut seats round 1 (1v3, 2v4) and go-live materializes
    it. Seed 4 then **withdraws while the event is live**, and the three survivors make
    one pairing a round, so rounds 2 and 3 each keep a row nothing will ever seat.

    Read as pending, that row made its round neither wholly unpaired nor decided: round
    2 was paired and then round 3 never was, on that advance and every one after, with
    no move a director could make — a played draw cannot be un-cut. And the row was
    counted as a pairing still to come, so the event could not read ``complete`` even
    once every match that existed had been played.

    Seed 4 is in no round after the first, which is also what made them look byed. The
    table below is where that shows: **one match, one loss**, not the two bye wins a
    departed player was collecting.

    Round 2 repeats round 1's 1v3, and that is the standings speaking rather than a
    slip. Seed 4's departure takes seed 2's only result with it, so seed 2 has no wins
    and **no opposition** — Buchholz 0, below seed 3, who at least lost to the leader.
    The table reads 1, 3, 2, seed 2 takes the bye, and the two left have already met:
    the documented last resort, which pairs them again rather than stranding the round.

    **The withdrawal is written as the statement that causes it in production.** The
    ordinary withdrawal endpoint is window-gated and answers 409 on a live event, so
    nothing here could reach the pairing code through it. ``app.account_merge`` can and
    does: when a guest who is already playing claims a verified account that is also
    entered, the merge flips the colliding entry to ``withdrawn`` — deliberately, rather
    than deleting it, *because* the row seats fixtures that have been played. This is
    that ``UPDATE``. Driving ``merge_user`` itself would add a re-pointed user, a voided
    self-play match and a re-solve without adding anything this asserts.
    """
    client, owner = authed_client
    async with (
        opponent_session(db_session, "swiss-shrink-two") as (client_2, user_2),
        opponent_session(db_session, "swiss-shrink-three") as (client_3, user_3),
        opponent_session(db_session, "swiss-shrink-four") as (client_4, user_4),
    ):
        tournament_id = await _tournament(client)
        event_id = (await _create_event(client, tournament_id)).json()["id"]
        entries = [
            await _enter(db_session, event_id, user, seed=seed, minutes=seed)
            for seed, user in enumerate((owner, user_2, user_3, user_4), start=1)
        ]
        assert (await _cut(client, tournament_id, event_id)).status_code == 201
        await _set_status(db_session, tournament_id, TournamentStatus.published)
        assert (await _go_live(client, tournament_id)).status_code == 201
        entry_ids = [entry.id for entry in entries]
        clients = dict(
            zip(entry_ids, [client, client_2, client_3, client_4], strict=True)
        )

        await db_session.execute(
            update(TournamentEntry)
            .where(TournamentEntry.id == entry_ids[3])
            .values(status=TournamentEntryStatus.withdrawn)
        )
        await db_session.commit()

        async def play(round_number: int, winner_index: int) -> None:
            """Call and win the one fixture of ``round_number`` that carries a pairing.

            Round 1 has two, and both are played by the same walk — the round is only
            decided once every pairing in it is, whoever has since left the event."""
            db_session.expire_all()
            rows = [
                f
                for f in await _fixtures(db_session, event_id)
                if f.round == round_number and f.entry_a_id is not None
            ]
            await _call_fixtures(db_session, tournament_id, rows)
            for row in rows:
                winner = (
                    entry_ids[winner_index]
                    if entry_ids[winner_index] in (row.entry_a_id, row.entry_b_id)
                    else row.entry_a_id
                )
                assert winner is not None
                await _win_fixture_match(
                    row,
                    clients_by_entry=clients,
                    winner_entry_id=winner,
                    rated=False,
                )

        # Round 1 as the cut dealt it, seed 4 included: seed 1 beats 3, and 2 beats 4.
        await play(1, winner_index=0)

        db_session.expire_all()
        round_two = [f for f in await _fixtures(db_session, event_id) if f.round == 2]
        paired = [f for f in round_two if f.entry_a_id is not None]
        assert len(round_two) == 2, "the cut's second row is still there"
        assert [{f.entry_a_id, f.entry_b_id} for f in paired] == [
            {entry_ids[0], entry_ids[2]}
        ], "three survivors make one pairing, and seed 2 sits round 2 out"

        await play(2, winner_index=0)

        db_session.expire_all()
        round_three = [f for f in await _fixtures(db_session, event_id) if f.round == 3]
        paired = [f for f in round_three if f.entry_a_id is not None]
        assert [{f.entry_a_id, f.entry_b_id} for f in paired] == [
            {entry_ids[0], entry_ids[1]}
        ], (
            "round 3 is paired off round 2's table — the round whose unpairable row "
            "stalled the walk for good, leaving the event unplayable from here"
        )

        await play(3, winner_index=0)

        db_session.expire_all()
        results = (await _event_read(client, tournament_id))["results"]

        assert results["complete"] is True, (
            "every fixture that could ever be paired has been played, so the event is "
            "over — the rows the cut wrote for a field that left are not results owed"
        )
        assert results["champion"] == str(entry_ids[0])
        departed = {row["entry_id"]: row for row in results["rows"]}[str(entry_ids[3])]
        assert (departed["played"], departed["wins"], departed["losses"]) == (
            1,
            0,
            1,
        ), (
            "the entrant who left is still listed — they played a real match — with "
            "the record they actually have, not a bye win for every round since"
        )


async def test_advancing_a_swiss_event_costs_three_statements(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    engine: AsyncEngine,
) -> None:
    """``materialize_event`` runs on the **completion seam** — every result submission
    re-runs it, inside the score-accept transaction, under the match row lock — so what
    the swiss advance costs there is not a micro-optimization.

    Swiss is the draw type that loads the most: the fixtures, the fixtures' **game
    counts** (it pairs down the standings) and the event's **entrants** (a bye is the
    absence of a row, so the seated set is not the field). Three, and **three is the
    whole of it** — one statement each, all of them batched over the event. Nothing in
    the resulting fixtures shows the difference between that and a load moved inside the
    round loop, or a field projected per fixture: both pair the identical round, and
    both turn one round trip into one per round or one per pairing on a seam that runs
    on every score. The round-robin twin of this pin
    (``tests/test_tournaments.py``) is the other half of the same claim — that the three
    draw types which read neither counts nor field still pay for neither.

    Each of the three is asserted **by name** as well as by the count, so a load that
    moved to a different table (or folded into the fixture statement) reds too rather
    than quietly keeping the total at three.

    Run against a round that is **partially** decided — one of round 1's two matches
    completed, the other still on — which is exactly what the seam sees on the first of
    a round's results. Nothing is pairable and nothing is newly ready, so the whole call
    *is* the three loads. The completed match is load-bearing rather than scene-setting:
    ``game_counts_by_match`` returns without a statement when no match has completed
    (``if not counts``), so without it the game-count third of this pin would be
    vacuous.
    """
    client, _ = authed_client
    tournament_id, event_id, _ = await _field(client, db_session, 4)
    assert (await _cut(client, tournament_id, event_id)).status_code == 201
    await _set_status(db_session, tournament_id, TournamentStatus.published)
    assert (await _go_live(client, tournament_id)).status_code == 201
    # One of round 1's two matches completed, the other untouched: the round is not
    # decided, so no round is pairable and no fixture is newly ready.
    played, _still_on = [
        f for f in await _fixtures(db_session, event_id) if f.round == 1
    ]
    assert played.match_id is not None
    match = await db_session.get(Match, played.match_id)
    assert match is not None
    match.status = MatchStatus.completed
    await db_session.commit()

    async with counted_statements(engine) as (session, statements):
        tournament = (
            await session.execute(
                select(Tournament).where(Tournament.id == uuid.UUID(tournament_id))
            )
        ).scalar_one()
        event_row = (
            await session.execute(
                select(TournamentEvent).where(TournamentEvent.id == uuid.UUID(event_id))
            )
        ).scalar_one()
        # Only the seam's own statements are counted, not the two loads that stand in
        # for the caller already holding these rows.
        statements.clear()
        await materialize_event(session, tournament, event_row)

    assert len(statements) == 3, statements
    assert [s for s in statements if "tournament_fixtures" in s], (
        "the fixtures, with their matches' statuses riding along on the same join"
    )
    assert [s for s in statements if "match_game_scores" in s], (
        "the game counts, batched over the event — swiss pairs down the standings"
    )
    assert [s for s in statements if "tournament_entries" in s], (
        "and the field, which the fixtures cannot yield: a byed entrant is in no row"
    )


# ----- the two layers' spellings of "a pairing is decided" ---------------------------


#: What "decided" means, as a function of the linked match's **live status** — ``None``
#: being a fixture that has not materialized into a match at all.
#:
#: Written out as a literal mapping rather than derived from either layer, so the test
#: below pins the answer itself. Asserting only that the two layers agree would pass
#: vacuously the day both of them start returning ``False`` for everything.
_DECIDED_BY_MATCH_STATUS: dict[MatchStatus | None, bool] = {
    None: False,
    MatchStatus.pending: False,
    MatchStatus.in_progress: False,
    MatchStatus.completed: True,
    MatchStatus.voided: True,
}


def test_the_draw_layer_and_the_read_layer_decide_a_pairing_alike() -> None:
    """**One rule, two row shapes, and nothing but this test holding them together.**

    ``app.draws`` reads a pairing's decidedness off a
    :class:`~app.draws.FixtureState` (a live score, or a void that means there will
    never be one); ``app.tournament_serialization`` reads it off a
    ``TournamentFixtureRead`` (the match's terminal status). Both fill the same
    :attr:`~app.draws.SeatedPairing.decided`, which is what gates a **bye** being
    scored — so the two disagreeing means a bye credited in the director's standings
    but not in the pairing of the next round, or the reverse.

    They are deliberately **not** one shared predicate: the two hold genuinely
    different rows, one an ORM projection and one a wire model, and forcing a common
    shape on them would be a worse coupling than this. What is shared is the *answer*,
    and this is where that is asserted — over the whole status domain, so a third
    condition (a forfeit status, say) added on one side alone reds here rather than in
    a live event.

    Both inputs are built from **one** status literal per case, through the same gates
    the two production loaders apply — game counts are keyed only for a completed match
    (``app.tournament_queries.game_counts_by_match``), a match id is in the voided set
    only for a voided one — so the case cannot be set up as agreeing.
    """
    assert set(_DECIDED_BY_MATCH_STATUS) == {None, *MatchStatus}, (
        "every match status is named, so a new one has to be answered here rather "
        "than falling through to whatever the two layers happen to do with it"
    )
    entry_a_id, entry_b_id = uuid.uuid4(), uuid.uuid4()

    for match_status, decided in _DECIDED_BY_MATCH_STATUS.items():
        match_id = uuid.uuid4() if match_status is not None else None
        # The read layer's row, exactly as ``fixtures_by_event`` composes it: the status
        # comes off an outer join on this same ``match_id``.
        (from_the_read,) = _seated_pairings(
            [
                TournamentFixtureRead(
                    id=uuid.uuid4(),
                    stage_id=uuid.uuid4(),
                    # A swiss stage's sole group (#1484) — no group-related claim is
                    # under test here, so a fresh literal stands in.
                    group_id=uuid.uuid4(),
                    round=1,
                    position=1,
                    entry_a_id=entry_a_id,
                    entry_b_id=entry_b_id,
                    winner_entry_id=None,
                    match_id=match_id,
                    match_status=match_status,
                    table_id=None,
                    scheduled_start=None,
                    table_off_reservation=None,
                    start_outside_reservation_window=None,
                    pinned_at=None,
                    call_notified_count=0,
                    completed_at=None,
                )
            ]
        )
        # The draw layer's row, through the same bridge the completion seam projects
        # with — and through the same two gates that seam loads its inputs behind.
        (from_the_row,) = _swiss_seated_pairings(
            [
                fixture_state(
                    TournamentFixture(
                        id=uuid.uuid4(),
                        stage_id=uuid.uuid4(),
                        # A swiss stage's sole group (#1484) — no group-related claim
                        # is under test here, so a fresh literal stands in.
                        group_id=uuid.uuid4(),
                        round=1,
                        position=1,
                        entry_a_id=entry_a_id,
                        entry_b_id=entry_b_id,
                        match_id=match_id,
                    ),
                    {match_id: (3, 1)}
                    if match_id is not None and match_status is MatchStatus.completed
                    else {},
                    frozenset({match_id})
                    if match_id is not None and match_status is MatchStatus.voided
                    else frozenset(),
                    None,
                )
            ]
        )

        assert (from_the_read.decided, from_the_row.decided) == (decided, decided), (
            f"the read layer and the draw layer must both call a {match_status} "
            f"pairing {'decided' if decided else 'undecided'}"
        )


# ----- a field that shrinks after the cut, as the read layer sees it -----------------


def _entry(number: int) -> uuid.UUID:
    """The entry id of the ``number``-th seed, as a readable literal."""
    return uuid.UUID(int=number)


def _entrant(number: int) -> TournamentEntrantRead:
    """One **active** entrant, in the shape ``active_entrants_by_event`` returns."""
    return TournamentEntrantRead(
        id=_entry(number),
        user_id=uuid.UUID(int=100 + number),
        username=f"seed{number}",
        seed=number,
        rating=None,
    )


def _row(
    *,
    round_number: int,
    position: int,
    pairing: tuple[int, int] | None = None,
    winner: int | None = None,
    voided: bool = False,
) -> TournamentFixtureRead:
    """One fixture row: unpaired (both sides ``None``) when ``pairing`` is omitted,
    carrying a **completed** match when ``winner`` is given, and a **voided** one — a
    pairing that happened and will never produce a result — when ``voided`` is set."""
    status = MatchStatus.completed if winner is not None else None
    if voided:
        status = MatchStatus.voided
    match_id = (
        uuid.UUID(int=1000 + round_number * 10 + position)
        if status is not None
        else None
    )
    return TournamentFixtureRead(
        id=uuid.UUID(int=2000 + round_number * 10 + position),
        # A swiss event has exactly one stage; every row this helper builds belongs to
        # it, so a fixed literal stands in for the real stage id.
        stage_id=uuid.UUID(int=1),
        # And its stage holds exactly one group (#1484's floor) — every row this
        # helper builds belongs to it too, so a fixed literal stands in here as well.
        group_id=uuid.UUID(int=2),
        round=round_number,
        position=position,
        entry_a_id=_entry(pairing[0]) if pairing else None,
        entry_b_id=_entry(pairing[1]) if pairing else None,
        winner_entry_id=_entry(winner) if winner is not None else None,
        match_id=match_id,
        match_status=status,
        table_id=None,
        scheduled_start=None,
        table_off_reservation=None,
        start_outside_reservation_window=None,
        pinned_at=None,
        call_notified_count=0,
        completed_at=None,
    )


def _counts(
    fixtures: Sequence[TournamentFixtureRead],
) -> dict[uuid.UUID, tuple[int, int]]:
    """The game counts of every **completed** match among ``fixtures``, 3–0 to
    ``entry_a`` — keyed as ``game_counts_by_match`` keys them, which is completed
    matches and nothing else, so a voided pairing has no entry here either."""
    return {
        f.match_id: (3, 0)
        for f in fixtures
        if f.match_id is not None and f.match_status is MatchStatus.completed
    }


#: A 4-entrant, 3-round swiss (two rows a round) whose field lost seed 4 **after** the
#: cut, played out to the last round. Seed 4's round-1 match still stands — that is why
#: the merge withdraws rather than deletes — and every round after it holds one pairing
#: for the three survivors plus one row nothing will ever seat.
_SHRUNK_FIXTURES = [
    _row(round_number=1, position=1, pairing=(1, 3), winner=1),
    _row(round_number=1, position=2, pairing=(2, 4), winner=2),
    _row(round_number=2, position=1, pairing=(1, 2), winner=1),
    _row(round_number=2, position=2),
    _row(round_number=3, position=1, pairing=(1, 3), winner=1),
    _row(round_number=3, position=2),
]

_SHRUNK_GAME_COUNTS = _counts(_SHRUNK_FIXTURES)

#: The three entrants still in the event. Seed 4 is absent —
#: ``active_entrants_by_event`` filters withdrawn entries out at the only place that
#: reads them.
_SURVIVORS = [_entrant(1), _entrant(2), _entrant(3)]


def test_a_shrunk_field_can_still_finish_its_event() -> None:
    """**The event has to be able to end.** Every round is cut with ⌊n/2⌋ rows from the
    field at the cut, so a field that shrinks leaves rows nothing will ever seat — and
    counting those as pairings still to come held the event one outcome short of
    ``complete`` forever: no champion, on a table where every match had been played.

    Four rows of the six here can ever carry a pairing (both of round 1's, and one each
    of rounds 2 and 3), and all four have a result. Count the six and the event reads
    live with two phantom matches outstanding."""
    field = _field_input(_SURVIVORS, _SHRUNK_FIXTURES, _SHRUNK_GAME_COUNTS)

    assert field.fixture_count == 4, (
        "the two rows the cut wrote for a field that no longer exists are not "
        "fixtures that can still yield a result"
    )

    standings = SwissResults().tabulate(field)

    assert standings.complete is True
    assert standings.champion == _entry(1)


def test_a_void_and_a_shrink_in_one_round_both_come_off_the_count() -> None:
    """The two ways a row stops being a result the event is waiting for, in the shape
    that produces both at once.

    An account merge that collides on a played event voids the guest-vs-survivor match
    *and* withdraws the guest — so in a four-entrant cut the same round 1 holds a voided
    pairing, while every round after it holds a row the shrunk field can never seat. The
    count subtracts a voided pairing from a round that is **full** (nothing left to pair
    there) and drops an unpairable row from rounds that are not, and the event still has
    to be able to end."""
    fixtures = [
        _row(round_number=1, position=1, pairing=(1, 3), winner=1),
        _row(round_number=1, position=2, pairing=(2, 4), voided=True),
        _row(round_number=2, position=1, pairing=(1, 2), winner=1),
        _row(round_number=2, position=2),
        _row(round_number=3, position=1, pairing=(1, 3), winner=1),
        _row(round_number=3, position=2),
    ]

    field = _field_input(_SURVIVORS, fixtures, _counts(fixtures))

    assert field.fixture_count == 3, (
        "round 1 owes one result rather than two — the voided pairing will never "
        "produce one — and rounds 2 and 3 owe one each rather than two"
    )
    assert SwissResults().tabulate(field).complete is True


def test_a_withdrawn_but_seated_entrant_is_not_given_a_bye_they_never_took() -> None:
    """**A bye is derived from the active field, not from who the rows happen to name.**

    Seed 4 left after round 1 and is in no round after it. Deriving the byes over the
    union of the active entrants and the seated ones asked "who is missing from this
    round?" and got seed 4 back every time — a win per remaining round, up to ``R − 1``
    of them, credited to somebody who had gone home. Nothing about the table looked
    wrong: the event still completed, with the wrong order in it.

    Seed 4 still has a **row**, and must: they played a real match, and dropping them
    would be a ``KeyError`` on the first outcome that names them. The row reads what
    they actually did — one match, one loss."""
    field = _field_input(_SURVIVORS, _SHRUNK_FIXTURES, _SHRUNK_GAME_COUNTS)

    assert field.byes == (_entry(3), _entry(2)), (
        "seed 3 sat round 2 out and seed 2 sat round 3 out — and nobody else did"
    )
    assert _entry(4) in field.entrants, "somebody who played is still in the table"

    rows = {row.entry_id: row for row in SwissResults().tabulate(field).rows}

    departed = rows[_entry(4)]
    assert (departed.played, departed.wins, departed.losses) == (1, 0, 1)


async def test_a_swiss_event_has_no_schedule_preview(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The preview covers the **group stage**, and swiss has no groups — so a director
    asking for one is told the format has no preview rather than shown an empty day
    (ADR). The pure refusal is asserted in ``test_schedule_preview_snapshot.py``; this
    is that refusal reaching the director as a 422 rather than a 500."""
    client, _ = authed_client
    tournament_id, _, _ = await _field(client, db_session, 8)

    response = await client.post(f"/v1/tournaments/{tournament_id}/schedule/preview")

    assert response.status_code == 422, response.text
    assert SWISS in response.text
