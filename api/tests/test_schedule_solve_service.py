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
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import fakeredis
import pytest
from redis.exceptions import RedisError
from rq import Queue
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
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
    Notification,
    ScheduleSolve,
    ScheduleSolveStatus,
    ScheduleSolveTrigger,
    SolverVerdict,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.schedule_solves import (
    JOB_TIMEOUT_MARGIN_S,
    RUN_SCHEDULE_SOLVE_JOB,
    SUPERSEDED_ERROR,
    TIME_CAP_ERROR,
    latest_solve,
    request_solve,
)
from app.scheduling import (
    REST_MIN,
    PlacedFixture,
    PlayerId,
    PlayerOverSubscribed,
    PoolHasNoTables,
    PoolId,
    PoolOverCapacity,
    ScheduleSnapshot,
    SolveResult,
    SolveStats,
    Verdict,
)
from app.schemas.notification import NotificationJob
from app.schemas.schedule_solve import (
    PastWindowReasonRead,
    PlayerConflictRead,
    PlayerOverSubscribedRead,
    PoolHasNoTablesRead,
    PoolOverCapacityRead,
    TableConflictRead,
    parse_infeasibility_reasons,
    parse_placement_conflicts,
)
from app.schemas.tournament import ScheduleSolveRead
from app.tournament_draws import cut_draw
from tests._helpers import (
    event_pools,
    hijack_solve,
    make_user,
    table_ids_of,
    venue_tables,
)

DATE = "2030-01-01"
#: The event's venue timezone — the IANA zone anchoring its wall-clock windows
#: to real instants (ADR "tournament times are timezone-aware instants").
VENUE_TZ = ZoneInfo("America/Chicago")
#: The tournament's minute-frame origin: the (single) pool window's start, as a
#: timezone-aware instant in the venue frame (``09:00`` local on ``DATE``).
BASE = datetime(2030, 1, 1, 9, 0, tzinfo=VENUE_TZ)


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
    status: TournamentStatus = TournamentStatus.published,
    entrants: int = 4,
    tables: tuple[str, ...] = ("t1", "t2"),
    window: tuple[str, str] = ("09:00", "17:00"),
    length_games: int = 3,
    slot_date: str = DATE,
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

    catalogue = venue_tables(*((table.upper(), "Main") for table in tables))
    tournament = Tournament(
        name="Scheduled Open",
        status=status,
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

    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.round_robin),
        max_players=None,
        entry_fee=Decimal("0.00"),
        timezone="America/Chicago",
        slot={"date": slot_date, "start": window[0], "end": window[1]},
        match_settings={"rated": False, "length_games": length_games},
        pools=event_pools(
            [
                {
                    "id": "pool-a",
                    "name": "Pool A",
                    "slot": {"date": slot_date, "start": window[0], "end": window[1]},
                    "table_ids": [str(row.id) for row in catalogue],
                }
            ]
        ),
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


async def _make_running_solve(
    db: AsyncSession,
    tournament_id: uuid.UUID,
    *,
    started_at: datetime,
    rerun_requested: bool = False,
) -> uuid.UUID:
    """A ``running`` schedule-solve row backdated to ``started_at`` — the shape
    every stale-reap test starts from, varying only how far past the lease it
    is. Returns the id (the `_make_tournament` convention: tests read it back
    through `_solve_rows`/`latest_solve` rather than off an expired instance)."""
    running = ScheduleSolve(
        tournament_id=tournament_id,
        trigger=ScheduleSolveTrigger.go_live,
        status=ScheduleSolveStatus.running,
        started_at=started_at,
        rerun_requested=rerun_requested,
    )
    db.add(running)
    await db.commit()
    return running.id


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


async def _entry_username(db: AsyncSession, entry_id: uuid.UUID) -> str:
    """The display username behind a tournament entry — what a placement
    conflict resolves a player/matchup id to."""
    user_id = (
        await db.execute(
            select(TournamentEntry.user_id).where(TournamentEntry.id == entry_id)
        )
    ).scalar_one()
    return (
        await db.execute(select(User.username).where(User.id == user_id))
    ).scalar_one()


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


async def _pin_fixture(
    db: AsyncSession,
    fixture: TournamentFixture,
    *,
    table_id: str,
    start: datetime,
    pinned_at: datetime,
    notified: int = 1,
) -> None:
    """Stage an already-called fixture directly on the row — table, promised
    start, ``pinned_at`` and the told-count — the pre-state the slide/echo
    apply paths read."""
    fixture.table_id = table_id
    fixture.scheduled_start = start
    fixture.pinned_at = pinned_at
    fixture.call_notified_count = notified
    await db.commit()


async def _match_call_notifications(db: AsyncSession) -> list[Notification]:
    return list(
        (
            await db.execute(
                select(Notification)
                .where(Notification.category == "match_calls")
                .order_by(Notification.created_at, Notification.id)
            )
        )
        .scalars()
        .all()
    )


def _fanout_jobs(notifications_queue: Queue) -> list[NotificationJob]:
    return [
        NotificationJob.model_validate_json(job.args[0])
        for job in notifications_queue.jobs
    ]


def _slide_pin_later(
    target_fixture_id: uuid.UUID, extra_min: int
) -> Callable[[ScheduleSnapshot, float, int], SolveResult]:
    """Interpose on the ``_solve`` seam: run the real solver, then push only
    the target pin's placement ``extra_min`` minutes later on its (unchanged)
    table — exactly the "predecessor overran" outcome 1a's solver produces
    under contention, staged deterministically so the apply path is what's
    under test."""
    real = scheduling.solve
    target_id = str(target_fixture_id)

    def wrapper(
        snapshot: ScheduleSnapshot, time_cap_s: float, num_search_workers: int
    ) -> SolveResult:
        result = real(
            snapshot, time_cap_s=time_cap_s, num_search_workers=num_search_workers
        )
        placements = tuple(
            PlacedFixture(
                fixture_id=placement.fixture_id,
                table_id=placement.table_id,
                start_min=placement.start_min + bump,
                end_min=placement.end_min + bump,
            )
            for placement in result.placements
            for bump in (extra_min if placement.fixture_id == target_id else 0,)
        )
        return SolveResult(
            verdict=result.verdict, placements=placements, stats=result.stats
        )

    return wrapper


class TestSolveNumWorkers:
    """``SOLVE_NUM_WORKERS`` (#1115): must stay operator-configurable via env,
    not baked in at import time, or the chart's per-environment CPU-limit
    alignment (deploy/uat/templates/worker.yaml) has nothing to actually set."""

    def test_defaults_to_one_when_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("SOLVE_NUM_WORKERS", raising=False)
        assert schedule_solves._solve_num_workers() == 1

    def test_reads_the_env_var_live(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("SOLVE_NUM_WORKERS", "16")
        assert schedule_solves._solve_num_workers() == 16


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

    async def test_two_completions_within_rest_coalesce_to_one_shadow(
        self, db_session: AsyncSession
    ) -> None:
        """One entry per human, not per match (#1145): a human who completes
        two matches within REST_MIN accumulates a shadow per completion in the
        raw scan — coalesced to exactly ONE, anchored at the LATER completion
        (rest = time since your last match), so the solver never receives two
        mutually unsatisfiable fixed rest intervals for one player."""
        tournament_id, event_id = await _make_tournament(db_session)
        fixtures = await _fixtures_of(db_session, event_id)
        # Two fixtures sharing a human: in a 4-player round robin every player
        # appears in 3 fixtures, so a shared entry always exists.
        first = fixtures[0]
        shared_entry = first.entry_a_id
        second = next(
            f for f in fixtures[1:] if shared_entry in (f.entry_a_id, f.entry_b_id)
        )
        # Complete both 2 minutes apart, both within REST_MIN of ``now`` so
        # neither window has closed and both would otherwise cast a shadow.
        early_wall = BASE + timedelta(minutes=30)
        late_wall = BASE + timedelta(minutes=32)
        users_first = await _mark_completed(
            db_session, first, completed_at=early_wall.astimezone()
        )
        shared_user = users_first[0]  # entry_a's user == the shared human
        await _mark_completed(db_session, second, completed_at=late_wall.astimezone())
        now = BASE + timedelta(minutes=35)

        inputs = await schedule_solves._load_solver_inputs(
            db_session, tournament_id, now=now, lock=False
        )

        assert inputs is not None
        shared_shadows = [
            shadow
            for shadow in inputs.snapshot.rest_shadows
            if shadow.player_id == shared_user
        ]
        assert len(shared_shadows) == 1
        # Anchored at the later completion (offset 32), not the earlier (30).
        assert shared_shadows[0].completed_at_min == 32


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

    async def test_running_past_lease_is_reaped_and_a_fresh_row_is_queued(
        self, db_session: AsyncSession
    ) -> None:
        """A ``running`` row whose worker died mid-run (OOM/SIGKILL) without
        ever writing a terminal status must not wedge the tournament forever
        (#1102): once its lease expires, a new trigger reaps it to ``failed``
        and gets a genuinely new row rather than being absorbed as a
        ``rerun_requested`` flag on a job that will never run."""
        tournament_id, _event_id = await _make_tournament(db_session)
        stale_started_at = datetime.now(UTC) - timedelta(
            seconds=schedule_solves._stale_running_lease_s() + 1
        )
        running_id = await _make_running_solve(
            db_session, tournament_id, started_at=stale_started_at
        )

        result = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.settings_changed
        )
        await db_session.commit()

        assert result is not None
        assert result.id != running_id
        assert result.status is ScheduleSolveStatus.queued
        assert result.trigger is ScheduleSolveTrigger.settings_changed

        rows = {row.id: row for row in await _solve_rows(db_session, tournament_id)}
        assert len(rows) == 2
        reaped = rows[running_id]
        assert reaped.status is ScheduleSolveStatus.failed
        assert reaped.error == schedule_solves.STALE_RUNNING_ERROR
        assert reaped.finished_at is not None
        assert reaped.wall_time_ms is None

    async def test_running_within_lease_keeps_todays_behavior(
        self, db_session: AsyncSession
    ) -> None:
        """A ``running`` row that is merely slow — not yet past its lease —
        must be unaffected by the reaper: the existing coalescing behavior
        (set ``rerun_requested``, return the same row, enqueue nothing new)
        stands."""
        tournament_id, _event_id = await _make_tournament(db_session)
        fresh_started_at = datetime.now(UTC) - timedelta(
            seconds=schedule_solves._stale_running_lease_s() - 1
        )
        running_id = await _make_running_solve(
            db_session, tournament_id, started_at=fresh_started_at
        )

        result = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.settings_changed
        )

        assert result is not None
        assert result.id == running_id
        assert result.status is ScheduleSolveStatus.running
        assert result.rerun_requested is True
        assert result.error is None
        assert result.finished_at is None
        rows = await _solve_rows(db_session, tournament_id)
        assert len(rows) == 1

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


class TestLatestSolve:
    """``latest_solve`` feeds the tournament detail BFF's solve strip and, per
    the "stale running solve" ADR, is one of the two places (the other is
    :func:`request_solve`'s coalescer) that reaps a stranded ``running`` row
    whose worker was hard-killed mid-solve (#1102) — the read path a pre-live
    tournament actually depends on, since nothing else calls ``request_solve``
    again until the director acts, and the button that would let them is
    gated on this exact query."""

    async def test_returns_none_when_no_solve_ever_requested(
        self, db_session: AsyncSession
    ) -> None:
        tournament_id, _event_id = await _make_tournament(db_session)

        assert await latest_solve(db_session, tournament_id) is None

    async def test_returns_a_non_stale_terminal_row_unchanged(
        self, db_session: AsyncSession
    ) -> None:
        tournament_id, _event_id = await _make_tournament(db_session)
        succeeded = ScheduleSolve(
            tournament_id=tournament_id,
            trigger=ScheduleSolveTrigger.manual,
            status=ScheduleSolveStatus.succeeded,
            verdict=SolverVerdict.optimal,
            finished_at=datetime.now(UTC),
        )
        db_session.add(succeeded)
        await db_session.commit()

        result = await latest_solve(db_session, tournament_id)

        assert result is not None
        assert result.id == succeeded.id
        assert result.status is ScheduleSolveStatus.succeeded

    async def test_running_within_lease_is_unchanged_and_writes_nothing(
        self, db_session: AsyncSession, engine: AsyncEngine
    ) -> None:
        """A ``running`` row that is merely slow — not yet past its lease —
        must come back untouched, and no write may have happened at all: a
        fresh, independent session reading the same row confirms it."""
        tournament_id, _event_id = await _make_tournament(db_session)
        fresh_started_at = datetime.now(UTC) - timedelta(
            seconds=schedule_solves._stale_running_lease_s() - 1
        )
        running_id = await _make_running_solve(
            db_session, tournament_id, started_at=fresh_started_at
        )

        result = await latest_solve(db_session, tournament_id)

        assert result is not None
        assert result.id == running_id
        assert result.status is ScheduleSolveStatus.running
        assert result.finished_at is None
        assert result.error is None

        sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
        async with sessionmaker() as fresh_db:
            fresh = (
                await fresh_db.execute(
                    select(ScheduleSolve).where(ScheduleSolve.id == running_id)
                )
            ).scalar_one()
            assert fresh.status is ScheduleSolveStatus.running
            assert fresh.finished_at is None

    async def test_running_past_lease_is_reaped_and_durably_committed(
        self, db_session: AsyncSession, engine: AsyncEngine
    ) -> None:
        """The stranded-``running`` row (#1102) is reaped by the very next GET
        of the tournament detail page. Critically, the write must be durably
        committed, not just patched onto the in-memory row this call returns:
        a second, independent session reading the same row afterwards (a
        stand-in for "someone else reads it next") must also see ``failed``."""
        tournament_id, _event_id = await _make_tournament(db_session)
        stale_started_at = datetime.now(UTC) - timedelta(
            seconds=schedule_solves._stale_running_lease_s() + 1
        )
        running_id = await _make_running_solve(
            db_session,
            tournament_id,
            started_at=stale_started_at,
            rerun_requested=True,
        )

        result = await latest_solve(db_session, tournament_id)

        assert result is not None
        assert result.id == running_id
        assert result.status is ScheduleSolveStatus.failed
        assert result.error == schedule_solves.STALE_RUNNING_ERROR
        assert result.finished_at is not None
        assert result.wall_time_ms is None
        # Mirrors _finish_failed_best_effort: an ordinary crash already drops
        # rerun_requested silently, and the reaper does not special-case it.
        assert result.rerun_requested is True

        sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
        async with sessionmaker() as fresh_db:
            fresh = (
                await fresh_db.execute(
                    select(ScheduleSolve).where(ScheduleSolve.id == running_id)
                )
            ).scalar_one()
            assert fresh.status is ScheduleSolveStatus.failed
            assert fresh.error == schedule_solves.STALE_RUNNING_ERROR
            assert fresh.finished_at is not None


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
        catalogue = set(await table_ids_of(db_session, tournament_id))
        for fixture in fixtures:
            assert fixture.table_id in catalogue
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

    async def test_evening_venue_window_is_placeable_when_now_is_past_midnight_utc(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """#1068: a venue-evening window is schedulable when ``now`` falls inside
        it, even though that instant is already past midnight in UTC.

        The event is ``America/Chicago`` (CST = UTC-6) with a window of
        ``18:00``-``23:00`` on ``2030-01-01`` — i.e. ``00:00``-``05:00`` UTC on
        ``2030-01-02``. ``now`` is set to ``02:00`` UTC on ``2030-01-02``, which
        is ``20:00`` **in the venue** — squarely inside the window, but a
        *different calendar day* in UTC.

        Under the old naive frame the window (naive ``18:00``) and ``now`` (a UTC
        wall-clock) landed on the same axis at different positions, so ``now``
        read as hours past the window's end and the only fixture was instantly
        unschedulable. Anchored to one instant axis, ``now`` sits mid-window and
        the fixture is placed. The assertions below fail on any frame where
        ``now`` and the windows are not venue-anchored onto one instant axis.
        """
        # 20:00 America/Chicago (CST) == 02:00 UTC the next calendar day.
        now = datetime(2030, 1, 2, 2, 0, tzinfo=UTC)
        window_start = datetime(2030, 1, 1, 18, 0, tzinfo=VENUE_TZ)
        window_end = datetime(2030, 1, 1, 23, 0, tzinfo=VENUE_TZ)
        assert window_start < now < window_end  # mid-window, guarding the setup
        monkeypatch.setattr(schedule_solves, "_wall_now", lambda: now)

        tournament_id, event_id = await _make_tournament(
            db_session, entrants=2, tables=("t1",), window=("18:00", "23:00")
        )
        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()

        _run_recorded_job(solver_queue, row_id)

        db_session.expire_all()
        (ledger,) = await _solve_rows(db_session, tournament_id)
        # Placeable, not "the day doesn't fit": a real verdict, the fixture down.
        assert ledger.status is ScheduleSolveStatus.succeeded
        assert ledger.verdict in (SolverVerdict.optimal, SolverVerdict.feasible)
        assert ledger.fixtures_placed == 1

        (fixture,) = await _fixtures_of(db_session, event_id)
        (only_table,) = await table_ids_of(db_session, tournament_id)
        assert fixture.table_id == only_table
        assert fixture.scheduled_start is not None
        # Placed at/after ``now`` and finishing inside the venue window — the
        # instant axis the whole epic hinges on. Aware/aware comparisons across
        # frames compare real instants, so these are frame-agnostic and true
        # only when now and the window share one axis.
        assert now <= fixture.scheduled_start
        assert fixture.scheduled_start < window_end

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

        def wrapper(
            snapshot: ScheduleSnapshot, time_cap_s: float, num_search_workers: int
        ) -> SolveResult:
            seen.append(time_cap_s)
            # Don't actually run the real solver for the full budget — the
            # cap value reaching the seam is what's under test.
            return real(snapshot, time_cap_s=1.0, num_search_workers=num_search_workers)

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
        """When the solver returns a called match UNCHANGED (its start is a
        floor with nothing competing for that slot — 1a's no-drift guarantee),
        the apply must not rewrite the promise's columns even with identical
        values, so a deliberately off-grid pin survives byte for byte. The pin
        sits late enough that no other fixture wants its slot, so the floor is
        the minimum and it never slides (contrast the slide path below)."""
        tournament_id, event_id = await _make_tournament(db_session)
        fixtures = await _fixtures_of(db_session, event_id)
        pinned = fixtures[0]
        pinned_id = pinned.id
        # Late + off the 5-minute grid: every other fixture packs earlier, so
        # this pin is uncontended and the solver leaves it exactly here.
        pinned_start = BASE + timedelta(minutes=302)
        pinned_at = BASE - timedelta(minutes=30)
        table_1, table_2 = await table_ids_of(db_session, tournament_id)
        pinned.table_id = table_1
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
        assert survivor.table_id == table_1
        assert survivor.scheduled_start == pinned_start
        assert survivor.pinned_at == pinned_at
        for fixture in refreshed.values():
            if fixture.id == pinned_id:
                continue
            assert fixture.table_id in {table_1, table_2}
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
        _table_1, table_2 = await table_ids_of(db_session, tournament_id)
        pre_placed.table_id = table_2
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
        assert refreshed[pre_placed_id].table_id == table_2
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
        # A current-but-too-tight window is a *generic* capacity infeasibility —
        # it carries a structural reason, but never the ``past_window`` one
        # (contrast the past-window case below).
        reasons = parse_infeasibility_reasons(ledger.infeasibility_reasons)
        assert not any(reason.kind == "past_window" for reason in reasons)

    async def test_past_dated_window_names_the_past_window_reason_with_its_date(
        self, db_session: AsyncSession, solver_queue: Queue
    ) -> None:
        """A window dated wholly in the past (the director left a stale date) is
        infeasible with the specific, machine-readable ``past_window`` reason
        carrying the offending venue-local date — distinct from a capacity
        shortfall (ADR "a past day is named, not disguised"). The reason surfaces
        on the ``ScheduleSolveRead`` the client consumes."""
        # Dated years before ``now`` in the event's venue frame: every grid start
        # must be >= now, so the whole window is unreachable — a past day, not a
        # tight one. The pool spans two tables over a full 09:00–17:00 day, so it
        # is comfortably *large enough* — only its date makes it infeasible.
        tournament_id, event_id = await _make_tournament(
            db_session, slot_date="2020-03-14"
        )

        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()
        _run_recorded_job(solver_queue, row_id)

        db_session.expire_all()
        (ledger,) = await _solve_rows(db_session, tournament_id)
        assert ledger.status is ScheduleSolveStatus.infeasible
        assert ledger.verdict is SolverVerdict.infeasible
        # Past window is the most specific pre-live cause and suppresses the
        # tight-window / over-capacity arms for the same pool, so it is the only
        # resolved reason, carrying the offending venue-local date.
        reasons = parse_infeasibility_reasons(ledger.infeasibility_reasons)
        assert reasons == [PastWindowReasonRead(date=date(2020, 3, 14))]
        # And it rides onto the client-facing read as a structured reason.
        read = ScheduleSolveRead.model_validate(ledger)
        assert read.infeasibility_reasons == [
            PastWindowReasonRead(date=date(2020, 3, 14))
        ]

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

        def exhausted(
            snapshot: ScheduleSnapshot, time_cap_s: float, num_search_workers: int
        ) -> SolveResult:
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

        def broken(
            snapshot: ScheduleSnapshot, time_cap_s: float, num_search_workers: int
        ) -> SolveResult:
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

        hijack_solve(
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

    async def test_infeasible_reasons_are_resolved_to_names_and_clock(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """An infeasible verdict's structured, id-and-minute reasons are
        humanized at apply: the persisted ``infeasibility_reasons`` carry the
        pool's DISPLAY NAME (not the namespaced solver id) and, for the capacity
        arm, the ``HH:MM`` window and the integer minutes verbatim."""
        tournament_id, event_id = await _make_tournament(
            db_session, window=("09:00", "17:00")
        )
        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()

        pool_id = PoolId(f"{event_id}:pool-a")

        def infeasible(
            snapshot: ScheduleSnapshot, time_cap_s: float, num_search_workers: int
        ) -> SolveResult:
            return SolveResult(
                verdict=Verdict.infeasible,
                placements=(),
                stats=SolveStats(wall_time_ms=77, objective=None),
                reasons=(
                    PoolHasNoTables(pool_id=pool_id),
                    PoolOverCapacity(
                        pool_id=pool_id,
                        required_min=600,
                        capacity_min=480,
                        table_count=2,
                    ),
                ),
            )

        monkeypatch.setattr(schedule_solves, "_solve", infeasible)
        _run_recorded_job(solver_queue, row_id)

        db_session.expire_all()
        (ledger,) = await _solve_rows(db_session, tournament_id)
        assert ledger.status is ScheduleSolveStatus.infeasible
        assert ledger.verdict is SolverVerdict.infeasible

        reasons = parse_infeasibility_reasons(ledger.infeasibility_reasons)
        no_tables, over_capacity = reasons
        assert isinstance(no_tables, PoolHasNoTablesRead)
        # The DISPLAY name, never the namespaced ``{event_id}:pool-a`` id.
        assert no_tables.pool_name == "Pool A"

        assert isinstance(over_capacity, PoolOverCapacityRead)
        assert over_capacity.pool_name == "Pool A"
        assert over_capacity.window_start == "09:00"
        assert over_capacity.window_end == "17:00"
        assert over_capacity.required_min == 600
        assert over_capacity.capacity_min == 480
        assert over_capacity.table_count == 2

    async def test_over_subscribed_player_resolves_to_their_display_name(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The one reason arm that names a *human* is humanized at apply through
        the same ``player_names`` map the player-conflict arm already uses — the
        persisted reason carries the entrant's display username (never the raw
        user-id string the solver speaks), alongside the pool's name and clock."""
        tournament_id, event_id = await _make_tournament(
            db_session, window=("09:00", "17:00")
        )
        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()

        # Any entrant of the drawn event: ``player_names`` is built from all of
        # them, so a pre-check can blame any one.
        user_id, username = (
            await db_session.execute(
                select(User.id, User.username)
                .join(TournamentEntry, TournamentEntry.user_id == User.id)
                .where(TournamentEntry.event_id == event_id)
                .order_by(User.username)
                .limit(1)
            )
        ).one()

        def infeasible(
            snapshot: ScheduleSnapshot, time_cap_s: float, num_search_workers: int
        ) -> SolveResult:
            return SolveResult(
                verdict=Verdict.infeasible,
                placements=(),
                stats=SolveStats(wall_time_ms=42, objective=None),
                reasons=(
                    PlayerOverSubscribed(
                        pool_id=PoolId(f"{event_id}:pool-a"),
                        player_id=PlayerId(str(user_id)),
                        match_count=3,
                        required_min=95,
                        window_span_min=60,
                    ),
                ),
            )

        monkeypatch.setattr(schedule_solves, "_solve", infeasible)
        _run_recorded_job(solver_queue, row_id)

        db_session.expire_all()
        (ledger,) = await _solve_rows(db_session, tournament_id)
        assert ledger.status is ScheduleSolveStatus.infeasible

        (reason,) = parse_infeasibility_reasons(ledger.infeasibility_reasons)
        assert isinstance(reason, PlayerOverSubscribedRead)
        assert reason.player_name == username
        assert reason.pool_name == "Pool A"
        assert reason.window_start == "09:00"
        assert reason.window_end == "17:00"
        assert reason.match_count == 3
        assert reason.required_min == 95
        assert reason.window_span_min == 60

    async def test_succeeded_apply_leaves_infeasibility_reasons_null(
        self, db_session: AsyncSession, solver_queue: Queue
    ) -> None:
        """Only the infeasible branch writes ``infeasibility_reasons``; a real
        (optimal/feasible) solve leaves the column NULL."""
        tournament_id, _event_id = await _make_tournament(db_session)
        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()
        _run_recorded_job(solver_queue, row_id)

        db_session.expire_all()
        (ledger,) = await _solve_rows(db_session, tournament_id)
        assert ledger.status is ScheduleSolveStatus.succeeded
        assert ledger.infeasibility_reasons is None
        assert parse_infeasibility_reasons(ledger.infeasibility_reasons) == []

    async def test_failed_apply_leaves_infeasibility_reasons_null(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """An ``unknown`` verdict fails the row (cap exhausted) and never
        touches ``infeasibility_reasons`` — it stays NULL."""
        tournament_id, _event_id = await _make_tournament(db_session)
        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()

        def exhausted(
            snapshot: ScheduleSnapshot, time_cap_s: float, num_search_workers: int
        ) -> SolveResult:
            return SolveResult(
                verdict=Verdict.unknown,
                placements=(),
                stats=SolveStats(wall_time_ms=5, objective=None),
            )

        monkeypatch.setattr(schedule_solves, "_solve", exhausted)
        _run_recorded_job(solver_queue, row_id)

        db_session.expire_all()
        (ledger,) = await _solve_rows(db_session, tournament_id)
        assert ledger.status is ScheduleSolveStatus.failed
        assert ledger.infeasibility_reasons is None

    async def test_placement_conflicts_are_resolved_and_persisted_on_placed_board(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Two in-progress matches recorded on one table AND sharing a player
        are contradictory data the solver tolerates (it merges the occupancy so
        the board still places) yet REPORTS. At apply the id-and-minute
        conflicts are humanized — table label, player name, each colliding
        fixture named by its matchup — and persisted to ``placement_conflicts``
        on the (optimal/feasible) verdict, NOT gated on infeasible."""
        tournament_id, event_id = await _make_tournament(db_session)
        fixtures = await _fixtures_of(db_session, event_id)
        first_fixture = fixtures[0]
        partner: TournamentFixture | None = None
        shared_entry_id: uuid.UUID | None = None
        for candidate in fixtures[1:]:
            common = {first_fixture.entry_a_id, first_fixture.entry_b_id} & {
                candidate.entry_a_id,
                candidate.entry_b_id,
            }
            if common:
                shared_entry_id = next(iter(common))
                partner = candidate
                break
        assert partner is not None and shared_entry_id is not None

        # Stage both as physically underway on the SAME table at the SAME start
        # (a soft double-book): pinned, live, promised start already arrived.
        colliding = (first_fixture, partner)
        table_1, _table_2 = await table_ids_of(db_session, tournament_id)
        for fixture in colliding:
            await _link_match(db_session, fixture, status=MatchStatus.in_progress)
            fixture.table_id = table_1
            fixture.scheduled_start = BASE
            fixture.pinned_at = BASE - timedelta(minutes=5)
        await db_session.commit()

        # Capture ids/entries before the session is expired below (an expired
        # ORM instance would sync-lazy-load — MissingGreenlet).
        fixture_entries: dict[uuid.UUID, tuple[uuid.UUID, uuid.UUID]] = {}
        for fixture in colliding:
            assert fixture.entry_a_id is not None and fixture.entry_b_id is not None
            fixture_entries[fixture.id] = (fixture.entry_a_id, fixture.entry_b_id)
        colliding_ids = set(fixture_entries)

        # The frame is 2030 and the job's wall-clock ``now`` is years off, so
        # compute the genuine solve at a moment INSIDE the in-progress window
        # (where the pins read as underway) and replay it through the ``_solve``
        # seam — the same deterministic-staging trick ``_slide_pin_later`` uses.
        # The conflicts on this result are the pure module's own, from the real
        # overlapping in-progress data.
        controlled_now = BASE + timedelta(minutes=30)
        inputs = await schedule_solves._load_solver_inputs(
            db_session, tournament_id, now=controlled_now, lock=False
        )
        assert inputs is not None
        genuine = scheduling.solve(inputs.snapshot)
        assert genuine.verdict in (Verdict.optimal, Verdict.feasible)
        assert {conflict.kind for conflict in genuine.conflicts} == {
            "table_conflict",
            "player_conflict",
        }

        monkeypatch.setattr(
            schedule_solves,
            "_solve",
            lambda snapshot, time_cap_s, num_search_workers: genuine,
        )

        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()
        _run_recorded_job(solver_queue, row_id)

        db_session.expire_all()
        (ledger,) = await _solve_rows(db_session, tournament_id)
        assert ledger.status is ScheduleSolveStatus.succeeded

        conflicts = parse_placement_conflicts(ledger.placement_conflicts)
        (table_conflict,) = [c for c in conflicts if isinstance(c, TableConflictRead)]
        (player_conflict,) = [c for c in conflicts if isinstance(c, PlayerConflictRead)]

        # The catalogue LABEL, never the raw ``t1`` value-object id.
        assert table_conflict.table_label == "T1"
        # Both colliding matches, each named by its matchup (the two players).
        assert {f.fixture_id for f in table_conflict.fixtures} == {
            str(fixture_id) for fixture_id in colliding_ids
        }

        # The shared human, resolved to their display name; same two fixtures.
        shared_username = await _entry_username(db_session, shared_entry_id)
        assert player_conflict.player_name == shared_username
        assert {f.fixture_id for f in player_conflict.fixtures} == {
            str(fixture_id) for fixture_id in colliding_ids
        }

        # Each colliding fixture is named by BOTH its players' usernames, in
        # (entry_a, entry_b) order — the id→name resolution is correct.
        for fixture_id, (entry_a, entry_b) in fixture_entries.items():
            named = next(
                f for f in table_conflict.fixtures if f.fixture_id == str(fixture_id)
            )
            assert named.player_a == await _entry_username(db_session, entry_a)
            assert named.player_b == await _entry_username(db_session, entry_b)

    async def test_clean_solve_persists_empty_placement_conflicts(
        self, db_session: AsyncSession, solver_queue: Queue
    ) -> None:
        """A solve with no overlapping in-progress data still writes
        ``placement_conflicts`` — an empty list, never NULL — on the applied
        verdict, so the read boundary parses a placed board that simply has
        nothing to report the same way it parses one that does."""
        tournament_id, _event_id = await _make_tournament(db_session)
        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()
        _run_recorded_job(solver_queue, row_id)

        db_session.expire_all()
        (ledger,) = await _solve_rows(db_session, tournament_id)
        assert ledger.status is ScheduleSolveStatus.succeeded
        assert ledger.placement_conflicts == []
        assert parse_placement_conflicts(ledger.placement_conflicts) == []


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
        hijack_solve(
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


class TestCalledMatchSlides:
    """Chore 2a (ADR "a called match holds its table and slides later"): the
    guarded apply persists a called match the solver pushed LATER on its
    (unchanged) table and fires the same "moved" correction a broken-pin move
    does — while a pin the solver echoes unchanged is still byte-stable and
    tells no one."""

    async def test_a_slid_called_match_is_persisted_and_moved_notified(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A predecessor overran: the solver returns the called match 20
        minutes later on the SAME table. The apply persists the slid start,
        refreshes ``pinned_at``, and sends exactly one *moved* correction per
        entrant — the pin counts as placed, not pinned."""
        tournament_id, event_id = await _make_tournament(
            db_session, status=TournamentStatus.live, entrants=2, tables=("t1",)
        )
        fixture = (await _fixtures_of(db_session, event_id))[0]
        fixture_id = fixture.id
        entry_a_id, entry_b_id = fixture.entry_a_id, fixture.entry_b_id
        assert entry_a_id is not None and entry_b_id is not None
        original_pin_time = BASE - timedelta(minutes=15)
        (table_1,) = await table_ids_of(db_session, tournament_id)
        await _pin_fixture(
            db_session,
            fixture,
            table_id=table_1,
            start=BASE,
            pinned_at=original_pin_time,
            notified=1,
        )
        user_a, user_b = await _fixture_user_ids(db_session, entry_a_id, entry_b_id)

        apply_now = BASE - timedelta(minutes=60)
        monkeypatch.setattr(schedule_solves, "_wall_now", lambda: apply_now)
        monkeypatch.setattr(
            schedule_solves, "_solve", _slide_pin_later(fixture_id, extra_min=20)
        )

        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()
        _run_recorded_job(solver_queue, row_id)

        db_session.expire_all()
        slid = (await _fixtures_of(db_session, event_id))[0]
        assert slid.table_id == table_1  # the table is invariant
        assert slid.scheduled_start == BASE + timedelta(minutes=20)  # slid later
        assert slid.pinned_at == apply_now  # the promise is renewed, not demoted
        assert slid.call_notified_count == 2  # the call, then the moved correction

        rows = await _match_call_notifications(db_session)
        assert len(rows) == 2  # exactly one per entrant, nobody else
        assert {str(row.user_id) for row in rows} == {user_a, user_b}
        for notification in rows:
            assert notification.title == "Your match moved to T1"
            assert "09:20" in notification.body  # BASE + 20 minutes
        jobs = _fanout_jobs(fake_notifications_queue)
        assert {str(job.user_id) for job in jobs} == {user_a, user_b}
        assert all(job.collapse_id == f"match-call:{fixture_id}" for job in jobs)

        (ledger,) = await _solve_rows(db_session, tournament_id)
        assert ledger.status is ScheduleSolveStatus.succeeded
        assert ledger.fixtures_placed == 1  # the slid pin moved → placed
        assert ledger.fixtures_pinned == 0

    async def test_an_unchanged_called_match_is_echoed_verbatim_and_silent(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """No contention: the real solver returns the (off-grid) pin exactly at
        its promised start. The apply rewrites not a byte and notifies no one —
        the pin counts as pinned, not placed."""
        tournament_id, event_id = await _make_tournament(
            db_session, status=TournamentStatus.live, entrants=2, tables=("t1",)
        )
        fixture = (await _fixtures_of(db_session, event_id))[0]
        fixture_id = fixture.id
        original_pin_time = BASE - timedelta(minutes=15)
        pinned_start = BASE + timedelta(minutes=7)  # off the 5-minute grid
        (table_1,) = await table_ids_of(db_session, tournament_id)
        await _pin_fixture(
            db_session,
            fixture,
            table_id=table_1,
            start=pinned_start,
            pinned_at=original_pin_time,
            notified=1,
        )

        apply_now = BASE - timedelta(minutes=60)
        monkeypatch.setattr(schedule_solves, "_wall_now", lambda: apply_now)

        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()
        _run_recorded_job(solver_queue, row_id)

        db_session.expire_all()
        survivor = (await _fixtures_of(db_session, event_id))[0]
        assert survivor.id == fixture_id
        assert survivor.table_id == table_1
        assert survivor.scheduled_start == pinned_start  # byte-identical
        assert survivor.pinned_at == original_pin_time  # not refreshed
        assert survivor.call_notified_count == 1  # never re-told

        assert await _match_call_notifications(db_session) == []
        assert fake_notifications_queue.jobs == []

        (ledger,) = await _solve_rows(db_session, tournament_id)
        assert ledger.status is ScheduleSolveStatus.succeeded
        assert ledger.fixtures_placed == 0  # nothing moved
        assert ledger.fixtures_pinned == 1  # the verbatim echo
