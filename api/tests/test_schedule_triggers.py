"""Lifecycle triggers into the solve queue (ADR "the schedule is solved; the
call is pinned"): **go-live solves first, every completed tournament match
re-solves** — and a completed plain match never does.

Everything here drives the REAL seams: go-live through the transitions route
(the solve is requested in the same transaction as the status write and the
materialization), completions through the real score endpoints into the
``finalize_match`` → ``on_match_completed`` funnel. Under conftest's autouse
*synchronous* fake solver queue the enqueued job runs inline — before the
requesting transaction commits — finds no committed ``queued`` row, and exits
as a stale no-op, so the committed ledger row is exactly what these tests read.

Coalescing under a burst of finishes builds nothing new — ``request_solve``
already coalesces — so the burst tests *prove it from this path*: a second
finalization is absorbed by the queued row the first one left, and a
finalization landing while a solve runs sets the running row's rerun flag
instead of stacking a new one.
"""

import uuid
from collections.abc import AsyncIterator, Sequence
from datetime import datetime
from decimal import Decimal
from typing import Any

import pytest
import pytest_asyncio
from httpx import AsyncClient
from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import match_calls
from app import queue as queue_module
from app.leagues import get_default_league
from app.models import (
    DrawType,
    EventFormat,
    ScheduleSolve,
    ScheduleSolveStatus,
    ScheduleSolveTrigger,
    Tournament,
    TournamentEntry,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentEventReservation,
    TournamentFixture,
    TournamentStatus,
    User,
    VenueTable,
)
from app.tournament_draws import cut_draw
from app.tournament_event_stages import mint_stages
from app.tournament_queries import stage_ids_for_events
from app.tournaments import TOURNAMENT_CREATE, TOURNAMENT_VIEW
from tests._helpers import (
    event_groups,
    grant_permissions,
    make_user,
    opponent_session,
    start_session,
    venue_tables,
)

DATE = "2030-01-01"


@pytest_asyncio.fixture
async def authed_client(
    api_client: AsyncClient, db_session: AsyncSession
) -> AsyncIterator[tuple[AsyncClient, User]]:
    """The primary ``api_client`` with a real session whose user holds
    ``tournament.view`` + ``tournament.create`` — the tournaments-router
    convention (the transitions route itself is owner-gated)."""
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, (TOURNAMENT_VIEW, TOURNAMENT_CREATE))
    yield api_client, user


async def _make_tournament(
    db: AsyncSession,
    owner: User,
    *,
    tables: tuple[str, ...] = ("t1", "t2"),
) -> tuple[uuid.UUID, TournamentEvent]:
    """A published tournament owned by ``owner`` (the authed client's user, so
    the transitions route accepts them) with a table catalogue and one grouped
    unrated round-robin event — unrated so a completion needs only the one
    proposing participant, no acceptance verb. Entrants and the cut are the
    test's business: which humans enter decides which *clients* can finish the
    matches."""
    league = await get_default_league(db)
    assert league is not None, "the autouse default_league fixture seeds this"
    catalogue = venue_tables(*((table.upper(), "Main") for table in tables))
    tournament = Tournament(
        name="Trigger Open",
        status=TournamentStatus.published,
        address={
            "venue": "Berkeley TT Club",
            "street": "1 Shattuck Ave",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94704",
            "country": "USA",
            "latitude": 37.8703,
            "longitude": -122.2731,
        },
        tables=catalogue,
        league_id=league.id,
        created_by_user_id=owner.id,
    )
    db.add(tournament)
    await db.flush()
    stages = mint_stages(DrawType.round_robin)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.round_robin),
        max_players=None,
        entry_fee=Decimal("0.00"),
        timezone="America/Chicago",
        slot={"date": DATE, "start": "09:00", "end": "17:00"},
        match_settings={"rated": False, "length_games": 3},
        stages=stages,
    )
    stages[0].groups = event_groups(
        [
            {
                "name": "Reservation A",
                "slot": {"date": DATE, "start": "09:00", "end": "17:00"},
                "table_ids": [str(row.id) for row in catalogue],
            }
        ],
        event=event,
        tournament=tournament,
    )
    db.add(event)
    await db.flush()
    return tournament.id, event


async def _enter_and_cut(
    db: AsyncSession, event: TournamentEvent, users: list[User]
) -> None:
    """Enter ``users`` and cut the draw, straight to the database — the entry
    and draw routes are not what these tests are about."""
    for user in users:
        db.add(TournamentEntry(event_id=event.id, user_id=user.id))
    await db.flush()
    # ``TournamentEvent.groups`` is a VIEWONLY association through the event's stage now
    # (ADR 20260815) — populated on QUERY, not on construction. ``cut_draw`` below
    # reads ``event.groups`` synchronously, so this needs an explicit refresh first.
    await db.refresh(event, attribute_names=["groups"])
    await cut_draw(db, event)
    await db.commit()


async def _go_live(client: AsyncClient, tournament_id: uuid.UUID) -> Any:
    return await client.post(
        f"/v1/tournaments/{tournament_id}/transitions", json={"to": "live"}
    )


async def _fixtures_of(
    db: AsyncSession, event_id: uuid.UUID
) -> list[TournamentFixture]:
    return list(
        (
            await db.execute(
                select(TournamentFixture)
                .where(TournamentFixture.stage_id.in_(stage_ids_for_events([event_id])))
                .order_by(TournamentFixture.id)
            )
        )
        .scalars()
        .all()
    )


async def _solve_rows(
    db: AsyncSession, tournament_id: uuid.UUID
) -> list[ScheduleSolve]:
    return list(
        (
            await db.execute(
                select(ScheduleSolve)
                .where(ScheduleSolve.tournament_id == tournament_id)
                .order_by(ScheduleSolve.requested_at, ScheduleSolve.id)
            )
        )
        .scalars()
        .all()
    )


async def _call_fixture(
    db: AsyncSession, tournament_id: uuid.UUID, fixture: TournamentFixture
) -> None:
    """Route a materialized fixture through the *real call* — a live manual
    placement — so its scheduled ``pending`` match flips to ``in_progress`` and
    becomes scorable (#1073). A tournament match is born ``pending`` and cannot
    be played until the schedule calls it to a table, so the completion helper
    must call before it scores. The director enters ``scheduled_start`` as venue
    wall-clock; the write path anchors it to the event timezone."""
    tournament = await db.get(Tournament, tournament_id)
    assert tournament is not None
    await match_calls.apply_manual_placement(
        db,
        tournament,
        fixture,
        # The catalogue's first row, by its server-minted id: ``table_id`` is a
        # foreign key now (ADR 20260801).
        table_id=str(tournament.tables[0].id),
        scheduled_start=datetime(2030, 1, 1, 10, 0),
        event_timezone="America/Chicago",
    )
    await db.commit()


async def _complete_fixture_match(
    client: AsyncClient,
    db: AsyncSession,
    tournament_id: uuid.UUID,
    fixture: TournamentFixture,
) -> None:
    """Finish a materialized fixture's match through the real score endpoint,
    as ``client`` (which must belong to one of its two players). The event is
    unrated, so the decided board self-accepts on the proposal — the post IS
    the completion, running the real ``finalize_match`` funnel.

    The match is born ``pending``; it is *called* first (play follows a call,
    #1073) so the score endpoint accepts it."""
    match_id = fixture.match_id
    assert match_id is not None, "the fixture materialized at go-live"
    await _call_fixture(db, tournament_id, fixture)
    response = await client.post(
        f"/v1/matches/{match_id}/results",
        json={
            "games": [
                {"game_number": n, "side_1_points": 11, "side_2_points": 5}
                for n in (1, 2)
            ]
        },
    )
    assert response.status_code == 201, response.text


class _DeadQueue:
    def enqueue(self, *args: object, **kwargs: object) -> None:
        raise RedisError("redis is down")


# ----- go-live -----------------------------------------------------------------


async def test_go_live_queues_exactly_one_solve_with_the_go_live_trigger(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Going live requests the day's first solve — one queued ledger row,
    trigger ``go_live``, committed with the transition itself — and the
    transition still does everything it did before: 201, status ``live``,
    every fixture materialized into a real match."""
    client, owner = authed_client
    tournament_id, event = await _make_tournament(db_session, owner)
    entrants = [await make_user(db_session, f"gl-{i}") for i in range(3)]
    await _enter_and_cut(db_session, event, entrants)

    response = await _go_live(client, tournament_id)

    assert response.status_code == 201, response.text
    assert response.json()["status"] == "live"
    fixtures = await _fixtures_of(db_session, event.id)
    assert len(fixtures) == 3
    assert all(f.match_id is not None for f in fixtures), (
        "materialization is untouched by the trigger"
    )
    (row,) = await _solve_rows(db_session, tournament_id)
    assert row.trigger is ScheduleSolveTrigger.go_live
    assert row.status is ScheduleSolveStatus.queued


async def test_go_live_survives_a_dead_scheduling_queue(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Redis down at the go-live moment costs the solve, never the transition:
    the tournament still goes live with its matches materialized, and no
    zombie ``queued`` row is left to absorb every later trigger — the pin tick
    or the Run-scheduler button recover the missing solve."""
    client, owner = authed_client
    tournament_id, event = await _make_tournament(db_session, owner)
    entrants = [await make_user(db_session, f"dead-{i}") for i in range(3)]
    await _enter_and_cut(db_session, event, entrants)
    monkeypatch.setattr(queue_module, "get_queue", lambda: _DeadQueue())

    response = await _go_live(client, tournament_id)

    assert response.status_code == 201, response.text
    assert response.json()["status"] == "live"
    fixtures = await _fixtures_of(db_session, event.id)
    assert all(f.match_id is not None for f in fixtures)
    assert await _solve_rows(db_session, tournament_id) == [], (
        "the enqueue failed, so no row may survive — a zombie would absorb "
        "every later trigger while no job ever runs"
    )


# ----- completion --------------------------------------------------------------


async def test_a_tournament_match_completion_enqueues_a_solve_for_its_tournament(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Finishing a tournament match through the real finalize funnel requests a
    ``match_completed`` solve — for THAT fixture's tournament only. A second
    live tournament sits alongside as the control: its ledger stays empty."""
    client, owner = authed_client
    async with opponent_session(db_session, "completion-rival") as (_opp_client, opp):
        tournament_id, event = await _make_tournament(db_session, owner)
        control_id, control_event = await _make_tournament(db_session, owner)
        await _enter_and_cut(db_session, event, [owner, opp])
        await _enter_and_cut(db_session, control_event, [owner, opp])
        assert (await _go_live(client, tournament_id)).status_code == 201
        assert (await _go_live(client, control_id)).status_code == 201
        # The go-live solves "ran": clear both ledgers so the row asserted on
        # below can only have come from the completion.
        for tid in (tournament_id, control_id):
            for row in await _solve_rows(db_session, tid):
                await db_session.delete(row)
        await db_session.commit()

        (fixture,) = await _fixtures_of(db_session, event.id)
        await _complete_fixture_match(client, db_session, tournament_id, fixture)

    (row,) = await _solve_rows(db_session, tournament_id)
    assert row.trigger is ScheduleSolveTrigger.match_completed
    assert row.status is ScheduleSolveStatus.queued
    assert await _solve_rows(db_session, control_id) == [], (
        "the trigger names the completed fixture's tournament, not every one"
    )
    (decided,) = await _fixtures_of(db_session, event.id)
    assert decided.winner_entry_id is not None, "the seam still records the winner"


async def test_a_plain_match_completion_enqueues_no_solve(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A completed NON-tournament match goes through the same finalize funnel
    and enqueues nothing: the advancement seam early-returns on the fixture
    miss before any scheduling is asked for."""
    client, _owner = authed_client
    rival = await make_user(db_session, "plain-rival")
    created = await client.post(
        "/v1/matches",
        json={"opponent_user_id": str(rival.id), "best_of": 3, "rated": False},
    )
    assert created.status_code == 201, created.text
    match_id = created.json()["id"]

    posted = await client.post(
        f"/v1/matches/{match_id}/results",
        json={
            "games": [
                {"game_number": n, "side_1_points": 11, "side_2_points": 5}
                for n in (1, 2)
            ]
        },
    )
    assert posted.status_code == 201, posted.text
    details = (await client.get(f"/v1/matches/{match_id}")).json()
    assert details["status"] == "completed", (
        "unrated self-accepts on the proposal — the funnel really ran"
    )

    assert (
        await db_session.execute(select(ScheduleSolve))
    ).scalars().first() is None, "no tournament, no solve — ever"


async def test_burst_completions_coalesce_onto_one_queued_solve(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Two finalizations in one tournament, back to back: the first leaves a
    ``queued`` row, the second is absorbed by it — same row, same id, still
    carrying the trigger that caused it, and the ledger never grows a second
    row. No stacking under a burst of finishes."""
    client, owner = authed_client
    async with (
        opponent_session(db_session, "burst-second") as (second_client, second),
        opponent_session(db_session, "burst-third") as (third_client, third),
    ):
        tournament_id, event = await _make_tournament(db_session, owner)
        await _enter_and_cut(db_session, event, [owner, second, third])
        assert (await _go_live(client, tournament_id)).status_code == 201
        for row in await _solve_rows(db_session, tournament_id):
            await db_session.delete(row)
        await db_session.commit()

        clients_by_user = {
            owner.id: client,
            second.id: second_client,
            third.id: third_client,
        }
        entry_user = {
            entry.id: entry.user_id
            for entry in (
                await db_session.execute(
                    select(TournamentEntry).where(TournamentEntry.event_id == event.id)
                )
            )
            .scalars()
            .all()
        }
        fixtures = await _fixtures_of(db_session, event.id)
        assert len(fixtures) == 3, "a three-player group is three fixtures"

        def proposer_for(fixture: TournamentFixture) -> AsyncClient:
            assert fixture.entry_a_id is not None
            return clients_by_user[entry_user[fixture.entry_a_id]]

        await _complete_fixture_match(
            proposer_for(fixtures[0]), db_session, tournament_id, fixtures[0]
        )
        (first,) = await _solve_rows(db_session, tournament_id)
        assert first.trigger is ScheduleSolveTrigger.match_completed
        assert first.status is ScheduleSolveStatus.queued

        await _complete_fixture_match(
            proposer_for(fixtures[1]), db_session, tournament_id, fixtures[1]
        )

        (absorbed,) = await _solve_rows(db_session, tournament_id)
        assert absorbed.id == first.id, (
            "the second completion is absorbed by the queued row, not stacked"
        )
        assert absorbed.status is ScheduleSolveStatus.queued
        assert absorbed.rerun_requested is False


async def test_a_completion_during_a_running_solve_sets_the_rerun_flag(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A match finishing while a solve is mid-flight cannot be absorbed — the
    running job snapshotted the world before this result existed — so the
    running row gets ``rerun_requested`` and the job re-queues at finish.
    Still exactly one row: no stacking here either."""
    client, owner = authed_client
    async with opponent_session(db_session, "rerun-rival") as (_opp_client, opp):
        tournament_id, event = await _make_tournament(db_session, owner)
        await _enter_and_cut(db_session, event, [owner, opp])
        assert (await _go_live(client, tournament_id)).status_code == 201
        # The go-live solve is mid-flight when the match finishes.
        (go_live_row,) = await _solve_rows(db_session, tournament_id)
        go_live_row.status = ScheduleSolveStatus.running
        await db_session.commit()

        (fixture,) = await _fixtures_of(db_session, event.id)
        await _complete_fixture_match(client, db_session, tournament_id, fixture)

    (row,) = await _solve_rows(db_session, tournament_id)
    assert row.id == go_live_row.id
    assert row.status is ScheduleSolveStatus.running
    assert row.rerun_requested is True, (
        "a completion during a run flags a rerun instead of stacking a row"
    )


# ----- input mutations (settings_changed) ----------------------------------------
#
# Every test here drives the REAL owner routes — the tournament PATCH, the event
# PATCH, the entry DELETE, the draw POST/DELETE — and reads the committed ledger.
# The rule under test: a write requests a ``settings_changed`` solve when — and
# only when — it changes something the solver reads, and only while there is a
# cut draw to place.


def _catalogue(*labels: str, keeping: Sequence[str] = ()) -> list[dict[str, str]]:
    """A table-catalogue PATCH payload: one entry per label, the first
    ``len(keeping)`` of them citing the table ids in ``keeping``.

    The catalogue is an id-keyed diff (ADR 20260801), so which entries carry an id is
    the whole content of the payload: a cited table is KEPT (re-worded at most, which is
    not a solver-input change), and an entry with no id ADDS a table (which is). Passing
    no ``keeping`` therefore says "remove every table this tournament has and add these
    instead" — occasionally what a test means, never what "re-send the catalogue you
    already had" means."""
    return [
        (
            {"label": label, "court": "Main", "id": keeping[index]}
            if index < len(keeping)
            else {"label": label, "court": "Main"}
        )
        for index, label in enumerate(labels)
    ]


async def _catalogue_ids(db: AsyncSession, tournament_id: uuid.UUID) -> list[str]:
    """The tournament's venue-table ids, in catalogue order — what a reservation's
    ``table_ids`` must name now that they are server-minted UUIDs."""
    return [
        str(table_id)
        for table_id in (
            await db.execute(
                select(VenueTable.id)
                .where(VenueTable.tournament_id == tournament_id)
                .order_by(VenueTable.position)
            )
        )
        .scalars()
        .all()
    ]


async def _reservation_id(db: AsyncSession, event_id: uuid.UUID) -> str:
    """The id of the event's one **reservation** — server-minted (ADR 20260801), so a
    payload that means to KEEP that reservation has to look it up and cite it. The wire
    diffs on the reservation's own id (``TournamentEventReservation.id``), not the
    group's — a reservation is 1:1 with its group for a freshly-cut event, so this is
    unambiguous here."""
    return str(
        (
            await db.execute(
                select(TournamentEventReservation.id).where(
                    TournamentEventReservation.event_id == event_id
                )
            )
        ).scalar_one()
    )


def _reservations_payload(
    *, reservation_id: str, end: str, table_ids: Sequence[str]
) -> list[dict[str, Any]]:
    """The event's one reservation, re-sent **citing its id** (the group-set freeze
    demands it) with whatever window/tables the test is moving."""
    return [
        {
            "id": reservation_id,
            "name": "Reservation A",
            "slot": {"date": DATE, "start": "09:00", "end": end},
            "table_ids": list(table_ids),
        }
    ]


async def _entry_of(
    db: AsyncSession, event_id: uuid.UUID, user_id: uuid.UUID
) -> TournamentEntry:
    return (
        await db.execute(
            select(TournamentEntry).where(
                TournamentEntry.event_id == event_id,
                TournamentEntry.user_id == user_id,
            )
        )
    ).scalar_one()


async def _assert_one_settings_row(db: AsyncSession, tournament_id: uuid.UUID) -> None:
    (row,) = await _solve_rows(db, tournament_id)
    assert row.trigger is ScheduleSolveTrigger.settings_changed
    assert row.status is ScheduleSolveStatus.queued


async def test_a_table_catalogue_edit_on_a_drawn_tournament_requests_a_settings_solve(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Adding a table to the catalogue of a tournament with a cut draw is a
    solver-input change: exactly one ``settings_changed`` row appears, in the
    same transaction as the 200."""
    client, owner = authed_client
    tournament_id, event = await _make_tournament(db_session, owner)
    entrants = [await make_user(db_session, f"cat-{i}") for i in range(3)]
    await _enter_and_cut(db_session, event, entrants)
    kept = await _catalogue_ids(db_session, tournament_id)

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}",
        json={"table_catalogue": _catalogue("T1", "T2", "T3", keeping=kept)},
    )

    assert response.status_code == 200, response.text
    await _assert_one_settings_row(db_session, tournament_id)


async def test_a_rename_only_tournament_patch_requests_no_settings_solve(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A name/address-only PATCH touches nothing the solver reads — the ledger
    stays empty even on a drawn tournament. Re-sending the catalogue the
    tournament already holds is likewise not a change."""
    client, owner = authed_client
    tournament_id, event = await _make_tournament(db_session, owner)
    entrants = [await make_user(db_session, f"rn-{i}") for i in range(3)]
    await _enter_and_cut(db_session, event, entrants)
    kept = await _catalogue_ids(db_session, tournament_id)

    renamed = await client.patch(
        f"/v1/tournaments/{tournament_id}", json={"name": "Renamed Open"}
    )
    resent = await client.patch(
        f"/v1/tournaments/{tournament_id}",
        json={"table_catalogue": _catalogue("T1", "T2", keeping=kept)},
    )

    assert renamed.status_code == 200, renamed.text
    assert resent.status_code == 200, resent.text
    assert await _solve_rows(db_session, tournament_id) == []


async def test_a_table_catalogue_edit_with_no_drawn_event_requests_no_settings_solve(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """With nothing cut there is nothing to place: the drawn-event gate keeps
    the ledger free of no-op rows while the venue is still being configured."""
    client, owner = authed_client
    tournament_id, _event = await _make_tournament(db_session, owner)
    kept = await _catalogue_ids(db_session, tournament_id)

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}",
        json={"table_catalogue": _catalogue("T1", "T2", "T3", keeping=kept)},
    )

    assert response.status_code == 200, response.text
    assert await _solve_rows(db_session, tournament_id) == []


async def test_a_reservation_window_edit_requests_a_settings_solve(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Moving a reservation's slot window (same reservation id, so the group-set
    freeze allows it) changes where fixtures may be placed — one ``settings_changed``
    row."""
    client, owner = authed_client
    tournament_id, event = await _make_tournament(db_session, owner)
    entrants = [await make_user(db_session, f"win-{i}") for i in range(3)]
    await _enter_and_cut(db_session, event, entrants)
    table_ids = await _catalogue_ids(db_session, tournament_id)

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event.id}",
        json={
            "reservations": _reservations_payload(
                reservation_id=await _reservation_id(db_session, event.id),
                end="18:00",
                table_ids=table_ids,
            )
        },
    )

    assert response.status_code == 200, response.text
    await _assert_one_settings_row(db_session, tournament_id)


async def test_a_name_only_event_patch_requests_no_settings_solve(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """An event rename reads as display everywhere the solver looks; so does
    re-sending the reservations exactly as the event holds them. No rows."""
    client, owner = authed_client
    tournament_id, event = await _make_tournament(db_session, owner)
    entrants = [await make_user(db_session, f"nm-{i}") for i in range(3)]
    await _enter_and_cut(db_session, event, entrants)
    table_ids = await _catalogue_ids(db_session, tournament_id)

    renamed = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event.id}",
        json={"name": "Renamed Singles"},
    )
    resent = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event.id}",
        json={
            "reservations": _reservations_payload(
                reservation_id=await _reservation_id(db_session, event.id),
                end="17:00",
                table_ids=table_ids,
            )
        },
    )

    assert renamed.status_code == 200, renamed.text
    assert resent.status_code == 200, resent.text
    assert await _solve_rows(db_session, tournament_id) == []


async def test_a_length_games_change_requests_a_settings_solve(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """``length_games`` is the solver's duration input: best-of-3 → best-of-5
    on a drawn event owes a re-solve."""
    client, owner = authed_client
    tournament_id, event = await _make_tournament(db_session, owner)
    entrants = [await make_user(db_session, f"lg-{i}") for i in range(3)]
    await _enter_and_cut(db_session, event, entrants)

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event.id}",
        json={"match_settings": {"rated": False, "length_games": 5}},
    )

    assert response.status_code == 200, response.text
    await _assert_one_settings_row(db_session, tournament_id)


async def test_withdrawing_a_seated_entrant_requests_a_settings_solve(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The owner withdrawing an entrant who is seated in a cut draw changes the
    model (the next solve's snapshot voids/re-places around them) — one
    ``settings_changed`` row alongside the 204."""
    client, owner = authed_client
    tournament_id, event = await _make_tournament(db_session, owner)
    entrants = [await make_user(db_session, f"wd-{i}") for i in range(3)]
    await _enter_and_cut(db_session, event, entrants)
    entry = await _entry_of(db_session, event.id, entrants[0].id)

    response = await client.delete(
        f"/v1/tournaments/{tournament_id}/events/{event.id}/entries/{entry.id}"
    )

    assert response.status_code == 204, response.text
    await _assert_one_settings_row(db_session, tournament_id)


async def test_withdrawing_from_an_undrawn_tournament_requests_no_settings_solve(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Entries reach the solver only through fixtures: an entrant seated in no
    fixture (nothing is cut) is invisible to it, so their withdrawal owes
    nothing — the eventual cut triggers on its own."""
    client, owner = authed_client
    tournament_id, event = await _make_tournament(db_session, owner)
    entrant = await make_user(db_session, "undrawn-wd")
    db_session.add(TournamentEntry(event_id=event.id, user_id=entrant.id))
    await db_session.commit()
    entry = await _entry_of(db_session, event.id, entrant.id)

    response = await client.delete(
        f"/v1/tournaments/{tournament_id}/events/{event.id}/entries/{entry.id}"
    )

    assert response.status_code == 204, response.text
    assert await _solve_rows(db_session, tournament_id) == []


async def test_cutting_a_draw_requests_a_settings_solve(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The first cut, through the real draw route, mints the day's inputs
    wholesale — one ``settings_changed`` row with the 201."""
    client, owner = authed_client
    tournament_id, event = await _make_tournament(db_session, owner)
    for i in range(3):
        entrant = await make_user(db_session, f"cut-{i}")
        db_session.add(TournamentEntry(event_id=event.id, user_id=entrant.id))
    await db_session.commit()

    response = await client.post(
        f"/v1/tournaments/{tournament_id}/events/{event.id}/draw"
    )

    assert response.status_code == 201, response.text
    await _assert_one_settings_row(db_session, tournament_id)


async def test_a_recut_clears_prior_pins_and_requests_a_settings_solve(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A re-cut replaces the fixtures wholesale, so the prior draw's placements
    and pins die with the deleted rows — by construction, not by repair: the
    fresh fixtures are born with no ``table_id``, no ``scheduled_start`` and no
    ``pinned_at``. And the re-cut itself is an input mutation: one
    ``settings_changed`` row."""
    client, owner = authed_client
    tournament_id, event = await _make_tournament(db_session, owner)
    entrants = [await make_user(db_session, f"rc-{i}") for i in range(3)]
    await _enter_and_cut(db_session, event, entrants)
    old_fixtures = await _fixtures_of(db_session, event.id)
    assert len(old_fixtures) == 3
    (the_table, *_) = await _catalogue_ids(db_session, tournament_id)
    for fixture in old_fixtures:
        fixture.table_id = the_table
        fixture.scheduled_start = datetime(2030, 1, 1, 9, 30)
        fixture.pinned_at = datetime(2030, 1, 1, 9, 20)
    await db_session.commit()
    old_ids = {fixture.id for fixture in old_fixtures}

    response = await client.post(
        f"/v1/tournaments/{tournament_id}/events/{event.id}/draw"
    )

    assert response.status_code == 201, response.text
    fresh = await _fixtures_of(db_session, event.id)
    assert len(fresh) == 3
    assert {fixture.id for fixture in fresh}.isdisjoint(old_ids), (
        "a re-cut replaces wholesale — the old rows (and their pins) are gone"
    )
    assert all(
        fixture.pinned_at is None
        and fixture.table_id is None
        and fixture.scheduled_start is None
        for fixture in fresh
    ), "no pin survives a re-cut: the promise died with the fixture it was made on"
    await _assert_one_settings_row(db_session, tournament_id)


async def test_uncutting_the_only_drawn_event_requests_no_settings_solve(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Un-cutting the only draw leaves nothing to place, so no solve is owed —
    and the idempotent re-DELETE of a draw that no longer exists owes nothing
    either."""
    client, owner = authed_client
    tournament_id, event = await _make_tournament(db_session, owner)
    entrants = [await make_user(db_session, f"uc-{i}") for i in range(3)]
    await _enter_and_cut(db_session, event, entrants)

    first = await client.delete(
        f"/v1/tournaments/{tournament_id}/events/{event.id}/draw"
    )
    second = await client.delete(
        f"/v1/tournaments/{tournament_id}/events/{event.id}/draw"
    )

    assert first.status_code == 204, first.text
    assert second.status_code == 204, second.text
    assert await _fixtures_of(db_session, event.id) == []
    assert await _solve_rows(db_session, tournament_id) == []


async def test_uncutting_one_of_two_drawn_events_requests_a_settings_solve(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Un-cutting one event while a sibling stays drawn frees its tables and
    windows for the survivor — that IS a solver-input change: one row."""
    client, owner = authed_client
    tournament_id, event = await _make_tournament(db_session, owner)
    # The tournament itself, not just its id: the second event's reservation reserves
    # the same two tables, and a reservation is a row keyed on the catalogue it names.
    tournament = await db_session.get(Tournament, tournament_id)
    assert tournament is not None
    second_stages = mint_stages(DrawType.round_robin)
    second_event = TournamentEvent(
        tournament_id=tournament_id,
        name="Second Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.round_robin),
        max_players=None,
        entry_fee=Decimal("0.00"),
        timezone="America/Chicago",
        slot={"date": DATE, "start": "09:00", "end": "17:00"},
        match_settings={"rated": False, "length_games": 3},
        stages=second_stages,
    )
    second_stages[0].groups = event_groups(
        [
            {
                "name": "Reservation B",
                "slot": {"date": DATE, "start": "09:00", "end": "17:00"},
                "table_ids": ["t1", "t2"],
            }
        ],
        event=second_event,
        tournament=tournament,
    )
    db_session.add(second_event)
    await db_session.flush()
    entrants = [await make_user(db_session, f"two-{i}") for i in range(3)]
    await _enter_and_cut(db_session, event, entrants)
    await _enter_and_cut(db_session, second_event, entrants)

    response = await client.delete(
        f"/v1/tournaments/{tournament_id}/events/{second_event.id}/draw"
    )

    assert response.status_code == 204, response.text
    assert await _fixtures_of(db_session, second_event.id) == []
    assert len(await _fixtures_of(db_session, event.id)) == 3, (
        "the sibling's draw survives"
    )
    await _assert_one_settings_row(db_session, tournament_id)
