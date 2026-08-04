"""Persistence tests for the solve ledger and the pin facts (ADR "the schedule
is solved, the call is pinned").

Two claims are load-bearing here. First, a ``schedule_solves`` row — the ledger
the admin page reads verbatim — round-trips through the model with its three
enums (trigger / status / verdict) stored as *values* and refused as anything
else, at both boundaries: the database rejects an unknown string at flush, and
``ScheduleSolveRead`` rejects it at validation. Second, a fixture's pin facts
behave as declared: ``pinned_at`` defaults to NULL (unpinned) and round-trips as
a NAIVE wall-clock timestamp (the deliberate ADR-0790 exemption it shares with
``scheduled_start``), and ``call_notified_count`` server-defaults to 0.

These exercise the schema the **models** declare (the suite builds via
``Base.metadata.create_all``); that the **migration** (0013) declares the same
schema is covered by running ``alembic upgrade head`` against a fresh database.
"""

import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import StatementError
from sqlalchemy.ext.asyncio import AsyncSession

from app.leagues import get_default_league
from app.models import (
    DrawType,
    EventFormat,
    ScheduleSolve,
    ScheduleSolveStatus,
    ScheduleSolveTrigger,
    SolverVerdict,
    Tournament,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentFixture,
    TournamentStatus,
    VenueTable,
)
from app.schemas.tournament import ScheduleSolveRead
from tests._helpers import event_pools, make_user, venue_tables


async def _make_tournament(db_session: AsyncSession) -> Tournament:
    """A published tournament owned by a throwaway director, written straight to
    the database — nothing here is about who may create one, and the solver
    routes don't exist yet."""
    owner = await make_user(db_session, f"director-{uuid.uuid4().hex[:8]}")
    league = await get_default_league(db_session)
    assert league is not None, "the autouse default_league fixture seeds this"

    tournament = Tournament(
        name="Autumn Open",
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
        league_id=league.id,
        created_by_user_id=owner.id,
        # One catalogue row, so a pinned fixture below has a real table to sit at:
        # ``table_id`` is a foreign key since ADR 20260801.
        tables=venue_tables(("Table 3", "A")),
    )
    db_session.add(tournament)
    await db_session.commit()
    await db_session.refresh(tournament)
    return tournament


async def _make_event(db_session: AsyncSession) -> TournamentEvent:
    tournament = await _make_tournament(db_session)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.round_robin),
        max_players=64,
        entry_fee=Decimal("20.00"),
        timezone="America/Chicago",
        slot={"date": "2026-08-01", "start": "09:00", "end": "17:00"},
        match_settings={"rated": True, "length_games": 5},
        pools=event_pools([{"name": "Pool A", "slot": {}, "table_ids": []}]),
    )
    db_session.add(event)
    await db_session.commit()
    await db_session.refresh(event)
    return event


# ----- the schedule_solves ledger --------------------------------------------


async def test_a_queued_schedule_solve_row_takes_its_defaults(
    db_session: AsyncSession,
) -> None:
    """A freshly enqueued run is a row of exactly two facts — whose tournament,
    what triggered it — and everything else is a default or a stage not yet
    reached: status ``queued`` (server default), ``requested_at`` stamped by the
    database (timezone-aware), every other column NULL."""
    tournament = await _make_tournament(db_session)
    solve = ScheduleSolve(
        tournament_id=tournament.id, trigger=ScheduleSolveTrigger.go_live
    )
    db_session.add(solve)
    await db_session.commit()
    await db_session.refresh(solve)

    assert solve.id is not None
    assert solve.status is ScheduleSolveStatus.queued
    assert solve.requested_at.tzinfo is not None
    assert solve.verdict is None
    assert solve.started_at is None
    assert solve.finished_at is None
    assert solve.wall_time_ms is None
    assert solve.fixtures_placed is None
    assert solve.fixtures_pinned is None
    assert solve.input_fingerprint is None
    assert solve.error is None


async def test_a_finished_schedule_solve_round_trips_through_the_model(
    db_session: AsyncSession,
) -> None:
    """A completed run's full ledger line — enums, timings, counts, fingerprint —
    comes back exactly as written, as enum *members*, and validates into the
    ``ScheduleSolveRead`` the admin page will read."""
    tournament = await _make_tournament(db_session)
    started = datetime(2026, 8, 1, 16, 0, 12, tzinfo=UTC)
    finished = datetime(2026, 8, 1, 16, 0, 19, tzinfo=UTC)
    solve = ScheduleSolve(
        tournament_id=tournament.id,
        trigger=ScheduleSolveTrigger.match_completed,
        status=ScheduleSolveStatus.succeeded,
        verdict=SolverVerdict.feasible,
        started_at=started,
        finished_at=finished,
        wall_time_ms=6812,
        fixtures_placed=24,
        fixtures_pinned=3,
        input_fingerprint="sha256:deadbeef",
    )
    db_session.add(solve)
    await db_session.commit()
    solve_id = solve.id
    db_session.expunge_all()

    fresh = (
        await db_session.execute(
            select(ScheduleSolve).where(ScheduleSolve.id == solve_id)
        )
    ).scalar_one()
    assert fresh.trigger is ScheduleSolveTrigger.match_completed
    assert fresh.status is ScheduleSolveStatus.succeeded
    assert fresh.verdict is SolverVerdict.feasible
    assert fresh.started_at == started
    assert fresh.finished_at == finished
    assert fresh.wall_time_ms == 6812
    assert fresh.fixtures_placed == 24
    assert fresh.fixtures_pinned == 3
    assert fresh.input_fingerprint == "sha256:deadbeef"
    assert fresh.error is None

    read = ScheduleSolveRead.model_validate(fresh)
    assert read.trigger is ScheduleSolveTrigger.match_completed
    assert read.status is ScheduleSolveStatus.succeeded
    assert read.verdict is SolverVerdict.feasible
    assert read.wall_time_ms == 6812


@pytest.mark.parametrize(
    "bad_column",
    [
        {"trigger": "cosmic_ray"},
        {"trigger": ScheduleSolveTrigger.manual, "status": "exploded"},
        {"trigger": ScheduleSolveTrigger.manual, "verdict": "shrug"},
    ],
    ids=["trigger", "status", "verdict"],
)
async def test_the_database_refuses_an_unknown_enum_value(
    db_session: AsyncSession, bad_column: dict[str, object]
) -> None:
    """The enums are closed sets at the *database* boundary too: a string that
    names no member is refused at flush, not stored to detonate on a later
    read."""
    tournament = await _make_tournament(db_session)
    db_session.add(ScheduleSolve(tournament_id=tournament.id, **bad_column))
    with pytest.raises(StatementError):
        await db_session.flush()
    await db_session.rollback()


@pytest.mark.parametrize(
    ("field", "value"),
    [("trigger", "cosmic_ray"), ("status", "exploded"), ("verdict", "shrug")],
)
async def test_schedule_solve_read_refuses_an_unknown_enum_value(
    field: str, value: str
) -> None:
    """``ScheduleSolveRead`` is the read boundary, and it is exactly as closed:
    an unknown trigger / status / verdict is a ``ValidationError``, never a
    stringly-typed pass-through."""
    payload: dict[str, object] = {
        "id": uuid.uuid4(),
        "trigger": "manual",
        "status": "queued",
        "verdict": None,
        "requested_at": datetime(2026, 8, 1, 16, 0, tzinfo=UTC),
        "started_at": None,
        "finished_at": None,
        "wall_time_ms": None,
        "fixtures_placed": None,
        "fixtures_pinned": None,
        "overrunning": False,
        "error": None,
        "infeasibility_reasons": [],
        "placement_conflicts": [],
    }
    assert ScheduleSolveRead.model_validate(payload).trigger is (
        ScheduleSolveTrigger.manual
    )
    payload[field] = value
    with pytest.raises(ValidationError):
        ScheduleSolveRead.model_validate(payload)


async def test_schedule_solve_rows_die_with_their_tournament(
    db_session: AsyncSession,
) -> None:
    """The ledger is *of* a tournament: deleting the tournament cascades to its
    solve rows (ondelete CASCADE), leaving no orphaned history."""
    tournament = await _make_tournament(db_session)
    db_session.add(
        ScheduleSolve(tournament_id=tournament.id, trigger=ScheduleSolveTrigger.manual)
    )
    await db_session.commit()

    await db_session.delete(tournament)
    await db_session.commit()

    remaining = (await db_session.execute(select(ScheduleSolve))).scalars().all()
    assert remaining == []


# ----- the pin facts on a fixture (schedule_solve chore 1a, same ADR) ---------


async def test_a_fresh_fixture_is_unpinned_and_never_notified(
    db_session: AsyncSession,
) -> None:
    """The defaults are the pre-solver world: ``pinned_at`` NULL (an estimate,
    not a promise) and ``call_notified_count`` 0 (nobody has been told
    anything) — without either being supplied at insert."""
    event = await _make_event(db_session)
    fixture = TournamentFixture(
        event_id=event.id, pool_id=event.pools[0].id, round=1, position=1
    )
    db_session.add(fixture)
    await db_session.commit()
    await db_session.refresh(fixture)

    assert fixture.pinned_at is None
    assert fixture.call_notified_count == 0


async def test_a_pinned_fixture_round_trips_its_pin_facts(
    db_session: AsyncSession,
) -> None:
    """A called fixture's ``pinned_at`` round-trips as the same timezone-aware
    **instant** it was written (both it and ``scheduled_start`` are now
    ``timestamptz`` — ADR "tournament times are timezone-aware instants",
    superseding ADR-0790's naive frame), and the notified count comes back
    exact."""
    event = await _make_event(db_session)
    # The catalogue's one table, by the id the server minted for it — ``table_id`` is a
    # foreign key now (ADR 20260801), so "table-3" is no longer a table.
    table_id = str(
        (
            await db_session.execute(
                select(VenueTable.id).where(
                    VenueTable.tournament_id == event.tournament_id
                )
            )
        ).scalar_one()
    )
    called_at = datetime(2026, 8, 1, 14, 30, tzinfo=UTC)
    fixture = TournamentFixture(
        event_id=event.id,
        pool_id=event.pools[0].id,
        round=1,
        position=1,
        table_id=table_id,
        scheduled_start=datetime(2026, 8, 1, 14, 40, tzinfo=UTC),
        pinned_at=called_at,
        call_notified_count=2,
    )
    db_session.add(fixture)
    await db_session.commit()
    fixture_id = fixture.id
    db_session.expunge_all()

    fresh = (
        await db_session.execute(
            select(TournamentFixture).where(TournamentFixture.id == fixture_id)
        )
    ).scalar_one()
    assert fresh.pinned_at == called_at
    assert fresh.pinned_at is not None and fresh.pinned_at.tzinfo is not None
    assert fresh.call_notified_count == 2
