"""The solve-run service (``app.schedule_solves``): coalesced enqueue,
snapshot + fingerprint, whole-or-nothing apply (ADR "the schedule is solved;
the call is pinned").

Two queue set-ups, deliberately:

* The coalescing tests run under conftest's autouse **synchronous** fake
  queue. The job executes inline at enqueue time — before the requesting
  transaction commits — opens its own engine (pointed at the test database by
  the autouse ``_job_database`` fixture below), finds no committed ``queued``
  row, and exits as stale. That inline no-op is itself part of the contract
  being tested: a job that fires before its row commits must do nothing.
* The job-execution tests use ``solver_queue`` — an *async*, record-only
  queue — so the enqueue is recorded, the test commits, and then runs the
  recorded job exactly as a worker would (resolving the dotted path via
  ``job.func``), post-commit.

THE race test stages a committed mutation on the gap between the job's
snapshot and its apply, through the ``_solve`` module seam — a gatekeeper on
the exact window the fingerprint guard exists for — and carries its own
falsification (`test_without_the_guard...`): with the fingerprint neutered the
very same harness DOES land the stale placements, proving the guard is
load-bearing and the green above isn't scheduler luck.
"""

import asyncio
import threading
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta
from decimal import Decimal

import fakeredis
import pytest
from redis.exceptions import RedisError
from rq import Queue
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool
from sqlalchemy.sql import Executable

from app import queue as queue_module
from app import schedule_solves, scheduling
from app.leagues import get_default_league
from app.models import (
    DrawType,
    EventFormat,
    Match,
    MatchSettings,
    MatchStatus,
    ScheduleSolve,
    ScheduleSolveStatus,
    ScheduleSolveTrigger,
    SolverVerdict,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentFixture,
    TournamentStatus,
)
from app.schedule_solves import (
    JOB_TIMEOUT_MARGIN_S,
    RUN_SCHEDULE_SOLVE_JOB,
    SUPERSEDED_ERROR,
    TIME_CAP_ERROR,
    request_solve,
)
from app.scheduling import (
    REST_MIN,
    ScheduleSnapshot,
    SolveResult,
    SolveStats,
    Verdict,
)
from app.tournament_draws import cut_draw
from tests._helpers import make_user

DATE = "2030-01-01"
#: The tournament's minute-frame origin: the (single) pool window's start.
BASE = datetime(2030, 1, 1, 9, 0)


@pytest.fixture(autouse=True)
def _job_database(monkeypatch: pytest.MonkeyPatch, postgres_url: str) -> None:
    """The job opens its own engine from ``DATABASE_URL``; point it at the
    test database so both the inline no-op runs (sync fake queue) and the
    explicit post-commit runs read the same Postgres as the test."""
    monkeypatch.setenv("DATABASE_URL", postgres_url)


@pytest.fixture
def solver_queue(monkeypatch: pytest.MonkeyPatch) -> Queue:
    """An async (record-only) RQ queue on fakeredis, replacing conftest's
    synchronous one for the tests that must commit before the job runs."""
    connection = fakeredis.FakeStrictRedis()
    q = Queue(queue_module.SOLVER_QUEUE, connection=connection, is_async=True)
    monkeypatch.setattr(queue_module, "get_queue", lambda: q)
    return q


async def _make_tournament(
    db: AsyncSession,
    *,
    entrants: int = 4,
    tables: tuple[str, ...] = ("t1", "t2"),
    window: tuple[str, str] = ("09:00", "17:00"),
    length_games: int = 3,
) -> tuple[uuid.UUID, uuid.UUID]:
    """A published tournament with a table catalogue, one pooled round-robin
    event whose single pool spans every table, ``entrants`` entered players,
    and a cut draw. Written straight to the database — nothing here is about
    the create routes. Returns ``(tournament_id, event_id)`` as plain ids: the
    tests expire the session after the job runs, and an expired ORM instance's
    attribute access would try a sync lazy-load (``MissingGreenlet``)."""
    owner = await make_user(db, f"director-{uuid.uuid4().hex[:8]}")
    league = await get_default_league(db)
    assert league is not None, "the autouse default_league fixture seeds this"

    tournament = Tournament(
        name="Scheduled Open",
        status=TournamentStatus.published,
        address={
            "venue": "Berkeley TT Club",
            "street": "1 Shattuck Ave",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94704",
            "country": "USA",
        },
        table_catalogue=[
            {"id": table, "label": table.upper(), "court": "Main"} for table in tables
        ],
        league_id=league.id,
        created_by_user_id=owner.id,
    )
    db.add(tournament)
    await db.flush()

    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_type=DrawType.round_robin,
        max_players=None,
        entry_fee=Decimal("0.00"),
        slot={"date": DATE, "start": window[0], "end": window[1]},
        match_settings={"rated": False, "length_games": length_games},
        pools=[
            {
                "id": "pool-a",
                "name": "Pool A",
                "slot": {"date": DATE, "start": window[0], "end": window[1]},
                "table_ids": list(tables),
            }
        ],
    )
    db.add(event)
    await db.flush()

    for _ in range(entrants):
        player = await make_user(db, f"player-{uuid.uuid4().hex[:8]}")
        db.add(TournamentEntry(event_id=event.id, user_id=player.id))
    await db.flush()

    await cut_draw(db, event)
    await db.commit()
    return tournament.id, event.id


async def _fixtures_of(
    db: AsyncSession, event_id: uuid.UUID
) -> list[TournamentFixture]:
    return list(
        (
            await db.execute(
                select(TournamentFixture)
                .where(TournamentFixture.event_id == event_id)
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


def _run_recorded_job(queue: Queue, expected_solve_id: uuid.UUID) -> None:
    """Run the oldest recorded job the way a worker would: resolve the dotted
    path (``job.func`` imports it) and call it with the enqueued args."""
    job = queue.jobs[0]
    assert job.func_name == RUN_SCHEDULE_SOLVE_JOB
    assert job.args == (str(expected_solve_id),)
    job.func(*job.args)


def _commit_concurrently(database_url: str, statement: Executable) -> None:
    """Commit ``statement`` through a separate engine on its own loop + thread
    — a genuinely concurrent writer, independent of every session the test or
    the job holds."""

    async def _go() -> None:
        engine = create_async_engine(database_url, poolclass=NullPool)
        try:
            maker = async_sessionmaker(engine, expire_on_commit=False)
            async with maker() as db:
                await db.execute(statement)
                await db.commit()
        finally:
            await engine.dispose()

    def _runner() -> None:
        asyncio.run(_go())

    thread = threading.Thread(target=_runner)
    thread.start()
    thread.join()


def _hijack_solve(
    monkeypatch: pytest.MonkeyPatch, after_solve: Callable[[], None]
) -> None:
    """Interpose on the ``_solve`` seam: run the real solver, then run
    ``after_solve`` — landing a committed mutation exactly in the gap between
    the job's snapshot and its guarded apply (the drift window)."""
    real = scheduling.solve

    def wrapper(snapshot: ScheduleSnapshot, time_cap_s: float) -> SolveResult:
        result = real(snapshot, time_cap_s=time_cap_s)
        after_solve()
        return result

    monkeypatch.setattr(schedule_solves, "_solve", wrapper)


async def _fixture_user_ids(
    db: AsyncSession, entry_a_id: uuid.UUID, entry_b_id: uuid.UUID
) -> tuple[str, str]:
    """The two entries' user-level ids (as the solver stringifies them) — what
    a fixture's rest shadows are keyed on (rest holds on humans, across
    events)."""
    rows = (
        await db.execute(
            select(TournamentEntry.id, TournamentEntry.user_id).where(
                TournamentEntry.id.in_([entry_a_id, entry_b_id])
            )
        )
    ).all()
    by_entry = {entry_id: str(user_id) for entry_id, user_id in rows}
    return by_entry[entry_a_id], by_entry[entry_b_id]


async def _link_match(
    db: AsyncSession,
    fixture: TournamentFixture,
    *,
    status: MatchStatus,
    completed_at: datetime | None = None,
) -> None:
    """Attach a fresh ``Match`` (with a minted scorer) to ``fixture`` — the
    shared boilerplate behind completing or running a fixture. Flushes so
    ``fixture.match_id`` is set; leaves committing to the caller."""
    league = await get_default_league(db)
    assert league is not None
    scorer = await make_user(db, f"scorer-{uuid.uuid4().hex[:8]}")
    match = Match(
        match_settings=MatchSettings(team_size=1, best_of=3, affects_rating=False),
        league=league,
        created_by_user_id=scorer.id,
        status=status,
        completed_at=completed_at,
    )
    db.add(match)
    await db.flush()
    fixture.match_id = match.id


async def _mark_completed(
    db: AsyncSession,
    fixture: TournamentFixture,
    *,
    completed_at: datetime | None,
    with_match: bool = True,
) -> tuple[str, str]:
    """Complete ``fixture`` and return its two humans' user ids.

    ``with_match=True`` links a completed ``Match`` carrying ``completed_at``
    (the rest-shadow anchor); ``with_match=False`` completes it via
    ``winner_entry_id`` alone — no match, no stamp — the "completed but
    unanchorable" case that must cast no shadow."""
    entry_a_id, entry_b_id = fixture.entry_a_id, fixture.entry_b_id
    assert entry_a_id is not None and entry_b_id is not None
    if with_match:
        await _link_match(
            db, fixture, status=MatchStatus.completed, completed_at=completed_at
        )
    fixture.winner_entry_id = entry_a_id
    await db.commit()
    return await _fixture_user_ids(db, entry_a_id, entry_b_id)


class TestRestShadows:
    """The snapshot builder feeds ``app.scheduling``'s rest floor across the
    completion boundary: a just-finished human casts a per-human rest shadow so
    the freed table is not re-called into zero rest (issue #1075). These probe
    ``_load_solver_inputs`` directly and assert on the built snapshot."""

    async def test_recent_completion_casts_a_shadow_per_human(
        self, db_session: AsyncSession
    ) -> None:
        tournament_id, event_id = await _make_tournament(db_session)
        target = (await _fixtures_of(db_session, event_id))[0]
        # 30m20s past the 09:00 base: the anchor ceils to 31 where the shared
        # (flooring) ``to_min`` would give 30 — so the assertion is only green
        # if the builder used its dedicated ceil.
        completed_wall = BASE + timedelta(minutes=30, seconds=20)
        user_a, user_b = await _mark_completed(
            db_session, target, completed_at=completed_wall.astimezone()
        )
        # now_min = 35; the window [31, 31+REST_MIN=41) is still open past it.
        now = BASE + timedelta(minutes=35)

        inputs = await schedule_solves._load_solver_inputs(
            db_session, tournament_id, now=now, lock=False
        )

        assert inputs is not None
        assert inputs.base == BASE
        shadows = inputs.snapshot.rest_shadows
        assert len(shadows) == 2
        assert {shadow.player_id for shadow in shadows} == {user_a, user_b}
        assert all(shadow.completed_at_min == 31 for shadow in shadows)

    async def test_completion_without_a_stamp_casts_no_shadow(
        self, db_session: AsyncSession
    ) -> None:
        tournament_id, event_id = await _make_tournament(db_session)
        target = (await _fixtures_of(db_session, event_id))[0]
        target_id = target.id
        # Completed via winner alone (no match, so completed_at is NULL): there
        # is no timestamp to anchor rest on, so no shadow — even though the
        # fixture is genuinely completed.
        await _mark_completed(db_session, target, completed_at=None, with_match=False)
        now = BASE + timedelta(minutes=5)

        inputs = await schedule_solves._load_solver_inputs(
            db_session, tournament_id, now=now, lock=False
        )

        assert inputs is not None
        completed = {
            fixture.id: fixture.completed for fixture in inputs.snapshot.fixtures
        }
        assert completed[str(target_id)] is True  # the completed path was taken
        assert inputs.snapshot.rest_shadows == ()

    async def test_closed_rest_window_casts_no_shadow(
        self, db_session: AsyncSession
    ) -> None:
        tournament_id, event_id = await _make_tournament(db_session)
        target = (await _fixtures_of(db_session, event_id))[0]
        # Anchor at offset 5; its window closes at 5 + REST_MIN. Set now right
        # at that edge — completed_at_min + REST_MIN <= now_min — so the shadow
        # is pure waste and is skipped.
        completed_wall = BASE + timedelta(minutes=5)
        await _mark_completed(
            db_session, target, completed_at=completed_wall.astimezone()
        )
        now = BASE + timedelta(minutes=5 + REST_MIN)

        inputs = await schedule_solves._load_solver_inputs(
            db_session, tournament_id, now=now, lock=False
        )

        assert inputs is not None
        assert inputs.snapshot.rest_shadows == ()

    async def test_in_progress_fixture_casts_no_shadow(
        self, db_session: AsyncSession
    ) -> None:
        tournament_id, event_id = await _make_tournament(db_session)
        target = (await _fixtures_of(db_session, event_id))[0]
        await _link_match(db_session, target, status=MatchStatus.in_progress)
        await db_session.commit()
        now = BASE + timedelta(minutes=5)

        inputs = await schedule_solves._load_solver_inputs(
            db_session, tournament_id, now=now, lock=False
        )

        assert inputs is not None
        assert inputs.snapshot.rest_shadows == ()


class TestRequestSolveCoalescing:
    async def test_two_requests_coalesce_into_one_queued_row(
        self, db_session: AsyncSession
    ) -> None:
        """A queued solve absorbs every later trigger: the second request
        returns the first row (still carrying the trigger that caused it) and
        enqueues nothing new."""
        tournament_id, _event_id = await _make_tournament(db_session)

        first = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        second = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.match_completed
        )

        assert first is not None
        assert second is not None
        assert second.id == first.id
        assert second.trigger is ScheduleSolveTrigger.manual
        assert second.status is ScheduleSolveStatus.queued
        rows = await _solve_rows(db_session, tournament_id)
        assert len(rows) == 1

    async def test_request_while_running_sets_the_rerun_flag(
        self, db_session: AsyncSession
    ) -> None:
        tournament_id, _event_id = await _make_tournament(db_session)
        running = ScheduleSolve(
            tournament_id=tournament_id,
            trigger=ScheduleSolveTrigger.go_live,
            status=ScheduleSolveStatus.running,
        )
        db_session.add(running)
        await db_session.commit()

        result = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.settings_changed
        )

        assert result is not None
        assert result.id == running.id
        assert result.rerun_requested is True
        rows = await _solve_rows(db_session, tournament_id)
        assert len(rows) == 1

    async def test_distinct_tournaments_do_not_coalesce(
        self, db_session: AsyncSession
    ) -> None:
        tournament_a_id, _ = await _make_tournament(db_session)
        tournament_b_id, _ = await _make_tournament(db_session)

        row_a = await request_solve(
            db_session, tournament_a_id, ScheduleSolveTrigger.manual
        )
        row_b = await request_solve(
            db_session, tournament_b_id, ScheduleSolveTrigger.manual
        )

        assert row_a is not None
        assert row_b is not None
        assert row_a.id != row_b.id
        assert len(await _solve_rows(db_session, tournament_a_id)) == 1
        assert len(await _solve_rows(db_session, tournament_b_id)) == 1

    @pytest.mark.parametrize(
        "env_value, expected_time_cap_s",
        [
            (None, 10.0),
            # No upper clamp on the solver's own cap (per the issue) — the RQ
            # job_timeout must track it with margin, not silently stay at
            # RQ's 180s default and kill the job before the solver's cap.
            ("1200", 1200.0),
        ],
    )
    async def test_enqueue_passes_a_job_timeout_above_the_time_cap(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
        env_value: str | None,
        expected_time_cap_s: float,
    ) -> None:
        """The RQ job_timeout must never be tighter than the CP-SAT cap it is
        timing, or raising ``SOLVER_TIME_CAP_S`` above RQ's ~180s default
        does nothing — RQ's watchdog kills the job before the solver's own
        (now-configurable) cap is ever reached."""
        if env_value is None:
            monkeypatch.delenv("SOLVER_TIME_CAP_S", raising=False)
        else:
            monkeypatch.setenv("SOLVER_TIME_CAP_S", env_value)
        tournament_id, _event_id = await _make_tournament(db_session)

        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )

        assert row is not None
        (job,) = solver_queue.jobs
        assert job.func_name == RUN_SCHEDULE_SOLVE_JOB
        assert job.timeout == int(expected_time_cap_s) + JOB_TIMEOUT_MARGIN_S
        assert job.timeout > expected_time_cap_s

    async def test_enqueue_failure_takes_the_row_back_out(
        self, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A row whose job never made it onto the queue would be a zombie —
        absorbing every later trigger while nothing ever runs — so it is
        removed and ``None`` returned."""
        tournament_id, _event_id = await _make_tournament(db_session)

        class _DeadQueue:
            def enqueue(self, *args: object, **kwargs: object) -> None:
                raise RedisError("redis is down")

        monkeypatch.setattr(queue_module, "get_queue", lambda: _DeadQueue())

        result = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )

        assert result is None
        assert await _solve_rows(db_session, tournament_id) == []


class TestSolveJob:
    async def test_solve_places_every_fixture_and_records_the_ledger(
        self, db_session: AsyncSession, solver_queue: Queue
    ) -> None:
        """End-to-end through the queue: request → commit → run the recorded
        job → every fixture placed on a pool table inside the window on the
        5-minute grid, and the ledger row tells the whole story."""
        tournament_id, event_id = await _make_tournament(db_session)
        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()

        _run_recorded_job(solver_queue, row_id)

        db_session.expire_all()
        fixtures = await _fixtures_of(db_session, event_id)
        assert len(fixtures) == 6  # round-robin over 4 entrants
        window_end = BASE + timedelta(hours=8)
        for fixture in fixtures:
            assert fixture.table_id in {"t1", "t2"}
            assert fixture.scheduled_start is not None
            assert BASE <= fixture.scheduled_start
            assert fixture.scheduled_start + timedelta(minutes=25) <= window_end
            offset = (fixture.scheduled_start - BASE).total_seconds() / 60
            assert offset % scheduling.BUCKET_MIN == 0
            assert fixture.pinned_at is None

        (ledger,) = await _solve_rows(db_session, tournament_id)
        assert ledger.status is ScheduleSolveStatus.succeeded
        assert ledger.verdict in (SolverVerdict.optimal, SolverVerdict.feasible)
        assert ledger.fixtures_placed == 6
        assert ledger.fixtures_pinned == 0
        assert ledger.wall_time_ms is not None and ledger.wall_time_ms >= 0
        assert ledger.input_fingerprint
        assert ledger.started_at is not None
        assert ledger.finished_at is not None
        assert ledger.error is None
        assert ledger.rerun_requested is False

        # Re-running the same job is a no-op: the row is terminal, so the
        # stale-guard exits before touching anything.
        placements = {f.id: (f.table_id, f.scheduled_start) for f in fixtures}
        solver_queue.jobs[0].func(str(row_id))
        db_session.expire_all()
        again = await _fixtures_of(db_session, event_id)
        assert {f.id: (f.table_id, f.scheduled_start) for f in again} == placements
        assert len(await _solve_rows(db_session, tournament_id)) == 1

    @pytest.mark.parametrize(
        "env_value, expected",
        [
            (None, 10.0),
            # No upper clamp — a large one-off value (per the issue) must
            # pass through untouched.
            ("1200", 1200.0),
        ],
    )
    async def test_solve_uses_the_configured_time_cap(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
        env_value: str | None,
        expected: float,
    ) -> None:
        """``get_settings().solver_time_cap_s`` — default or env-overridden —
        is what actually reaches ``app.scheduling.solve``."""
        if env_value is None:
            monkeypatch.delenv("SOLVER_TIME_CAP_S", raising=False)
        else:
            monkeypatch.setenv("SOLVER_TIME_CAP_S", env_value)
        seen: list[float] = []
        real = schedule_solves._solve

        def wrapper(snapshot: ScheduleSnapshot, time_cap_s: float) -> SolveResult:
            seen.append(time_cap_s)
            # Don't actually run the real solver for the full budget — the
            # cap value reaching the seam is what's under test.
            return real(snapshot, time_cap_s=1.0)

        monkeypatch.setattr(schedule_solves, "_solve", wrapper)

        tournament_id, _event_id = await _make_tournament(db_session)
        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()

        _run_recorded_job(solver_queue, row_id)

        assert seen == [expected]

    async def test_pinned_fixture_columns_are_untouched_by_apply(
        self, db_session: AsyncSession, solver_queue: Queue
    ) -> None:
        """The solver echoes pins verbatim; the apply must not rewrite a
        promise's columns even with identical values — so a deliberately
        off-grid pin survives byte for byte."""
        tournament_id, event_id = await _make_tournament(db_session)
        fixtures = await _fixtures_of(db_session, event_id)
        pinned = fixtures[0]
        pinned_id = pinned.id
        pinned_start = BASE + timedelta(minutes=62)  # off the 5-minute grid
        pinned_at = BASE - timedelta(minutes=30)
        pinned.table_id = "t1"
        pinned.scheduled_start = pinned_start
        pinned.pinned_at = pinned_at
        await db_session.commit()

        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()
        _run_recorded_job(solver_queue, row_id)

        db_session.expire_all()
        refreshed = {f.id: f for f in await _fixtures_of(db_session, event_id)}
        survivor = refreshed[pinned_id]
        assert survivor.table_id == "t1"
        assert survivor.scheduled_start == pinned_start
        assert survivor.pinned_at == pinned_at
        for fixture in refreshed.values():
            if fixture.id == pinned_id:
                continue
            assert fixture.table_id in {"t1", "t2"}
            assert fixture.scheduled_start is not None
            assert (fixture.scheduled_start - BASE).total_seconds() / 60 % 5 == 0

        (ledger,) = await _solve_rows(db_session, tournament_id)
        assert ledger.status is ScheduleSolveStatus.succeeded
        assert ledger.fixtures_placed == 5
        assert ledger.fixtures_pinned == 1

    async def test_infeasible_day_marks_the_row_and_clobbers_nothing(
        self, db_session: AsyncSession, solver_queue: Queue
    ) -> None:
        """A 20-minute window cannot hold a 25-minute match: the row finishes
        ``infeasible`` (a designed outcome, no error), nothing is written, and
        the placements of the last accepted plan stand."""
        tournament_id, event_id = await _make_tournament(
            db_session, window=("09:00", "09:20")
        )
        fixtures = await _fixtures_of(db_session, event_id)
        pre_placed = fixtures[0]
        pre_placed_id = pre_placed.id
        pre_start = BASE + timedelta(minutes=5)
        pre_placed.table_id = "t2"
        pre_placed.scheduled_start = pre_start
        await db_session.commit()

        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()
        _run_recorded_job(solver_queue, row_id)

        db_session.expire_all()
        refreshed = {f.id: f for f in await _fixtures_of(db_session, event_id)}
        assert refreshed[pre_placed_id].table_id == "t2"
        assert refreshed[pre_placed_id].scheduled_start == pre_start
        for fixture in refreshed.values():
            if fixture.id == pre_placed_id:
                continue
            assert fixture.table_id is None
            assert fixture.scheduled_start is None

        (ledger,) = await _solve_rows(db_session, tournament_id)
        assert ledger.status is ScheduleSolveStatus.infeasible
        assert ledger.verdict is SolverVerdict.infeasible
        assert ledger.error is None
        assert ledger.fixtures_placed is None
        assert ledger.fixtures_pinned is None
        assert ledger.finished_at is not None

    async def test_unknown_verdict_is_failed_with_the_time_cap_error(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """``unknown`` means the cap ran out before *any* answer — the DB
        verdict enum has no such member, so the row fails with the dedicated
        error and no verdict."""
        tournament_id, event_id = await _make_tournament(db_session)
        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()

        def exhausted(snapshot: ScheduleSnapshot, time_cap_s: float) -> SolveResult:
            return SolveResult(
                verdict=Verdict.unknown,
                placements=(),
                stats=SolveStats(wall_time_ms=123, objective=None),
            )

        monkeypatch.setattr(schedule_solves, "_solve", exhausted)
        _run_recorded_job(solver_queue, row_id)

        db_session.expire_all()
        (ledger,) = await _solve_rows(db_session, tournament_id)
        assert ledger.status is ScheduleSolveStatus.failed
        assert ledger.error == TIME_CAP_ERROR
        assert ledger.verdict is None
        assert ledger.wall_time_ms == 123
        for fixture in await _fixtures_of(db_session, event_id):
            assert fixture.table_id is None

    async def test_a_crash_never_leaves_a_row_running(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        tournament_id, _event_id = await _make_tournament(db_session)
        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()

        def broken(snapshot: ScheduleSnapshot, time_cap_s: float) -> SolveResult:
            raise RuntimeError("the solver caught fire")

        monkeypatch.setattr(schedule_solves, "_solve", broken)
        _run_recorded_job(solver_queue, row_id)

        db_session.expire_all()
        (ledger,) = await _solve_rows(db_session, tournament_id)
        assert ledger.status is ScheduleSolveStatus.failed
        assert ledger.error == "the solver caught fire"
        assert ledger.finished_at is not None

    async def test_rerun_requested_while_running_requeues_at_finish(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
        postgres_url: str,
    ) -> None:
        """A trigger that lands mid-solve sets the flag; the job clears it and
        requests a ``rerun`` in the same transaction as its final status."""
        tournament_id, _event_id = await _make_tournament(db_session)
        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()

        _hijack_solve(
            monkeypatch,
            after_solve=lambda: _commit_concurrently(
                postgres_url,
                update(ScheduleSolve)
                .where(ScheduleSolve.id == row_id)
                .values(rerun_requested=True),
            ),
        )
        _run_recorded_job(solver_queue, row_id)

        db_session.expire_all()
        rows = await _solve_rows(db_session, tournament_id)
        assert len(rows) == 2
        finished, rerun = rows
        assert finished.id == row_id
        assert finished.status is ScheduleSolveStatus.succeeded
        assert finished.rerun_requested is False
        assert rerun.status is ScheduleSolveStatus.queued
        assert rerun.trigger is ScheduleSolveTrigger.rerun
        assert len(solver_queue.jobs) == 2


class TestDriftGuard:
    """THE race test: a committed mutation lands between the job's snapshot
    and its apply, staged through the ``_solve`` seam so it falls exactly in
    the guarded window — plus the falsification that proves the guard (not
    luck) is what keeps the stale output out."""

    async def _staged_drift(
        self,
        db_session: AsyncSession,
        monkeypatch: pytest.MonkeyPatch,
        solver_queue: Queue,
        postgres_url: str,
    ) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
        """Request a solve, commit, and arrange for one entrant's withdrawal
        to commit mid-solve. Returns without running the job."""
        tournament_id, event_id = await _make_tournament(db_session)
        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()

        an_entry_id = (
            await db_session.execute(
                select(TournamentEntry.id)
                .where(TournamentEntry.event_id == event_id)
                .order_by(TournamentEntry.id)
                .limit(1)
            )
        ).scalar_one()
        _hijack_solve(
            monkeypatch,
            after_solve=lambda: _commit_concurrently(
                postgres_url,
                update(TournamentEntry)
                .where(TournamentEntry.id == an_entry_id)
                .values(status=TournamentEntryStatus.withdrawn),
            ),
        )
        return tournament_id, event_id, row_id

    async def test_mid_solve_drift_discards_the_whole_output_and_requeues(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
        postgres_url: str,
    ) -> None:
        tournament_id, event_id, row_id = await self._staged_drift(
            db_session, monkeypatch, solver_queue, postgres_url
        )

        _run_recorded_job(solver_queue, row_id)

        db_session.expire_all()
        rows = await _solve_rows(db_session, tournament_id)
        assert len(rows) == 2
        superseded, rerun = rows
        assert superseded.id == row_id
        assert superseded.status is ScheduleSolveStatus.failed
        assert superseded.error == SUPERSEDED_ERROR
        assert superseded.verdict is None
        assert rerun.status is ScheduleSolveStatus.queued
        assert rerun.trigger is ScheduleSolveTrigger.rerun
        assert len(solver_queue.jobs) == 2

        # The load-bearing assertion: NOT ONE placement from the stale solve
        # was written. The falsification below proves this is the guard's
        # doing, not the harness failing to produce writes.
        for fixture in await _fixtures_of(db_session, event_id):
            assert fixture.table_id is None
            assert fixture.scheduled_start is None

    async def test_without_the_guard_the_stale_solve_lands(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
        postgres_url: str,
    ) -> None:
        """The falsification: neuter the fingerprint (every snapshot hashes
        alike — exactly what "no guard" means) and the *same* staged race
        writes every stale placement. If this test ever fails, the harness
        above has stopped exercising the guard."""
        tournament_id, event_id, row_id = await self._staged_drift(
            db_session, monkeypatch, solver_queue, postgres_url
        )
        monkeypatch.setattr(schedule_solves, "_fingerprint", lambda payload: "same")

        _run_recorded_job(solver_queue, row_id)

        db_session.expire_all()
        (ledger,) = await _solve_rows(db_session, tournament_id)
        assert ledger.status is ScheduleSolveStatus.succeeded
        placed = [
            fixture
            for fixture in await _fixtures_of(db_session, event_id)
            if fixture.table_id is not None
        ]
        assert len(placed) == 6
