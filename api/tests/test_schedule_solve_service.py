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
from collections import defaultdict
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from itertools import combinations
from typing import Any
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
from sqlalchemy.orm import selectinload
from sqlalchemy.pool import NullPool
from sqlalchemy.sql import Executable

from app import queue as queue_module
from app import schedule_solves, scheduling
from app.draws import seats_both_sides_at_cut
from app.leagues import get_default_league
from app.models import (
    DrawType,
    EventFormat,
    Match,
    MatchGame,
    MatchGameScore,
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
    TournamentEventGroupReservation,
    TournamentEventReservation,
    TournamentEventReservationTable,
    TournamentEventStageGroup,
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
    InfeasibilityReason,
    PastWindow,
    PlacedFixture,
    PlayerId,
    PlayerOverSubscribed,
    ReservationHasNoTables,
    ReservationId,
    ReservationOverCapacity,
    ScheduleSnapshot,
    SolveResult,
    SolveStats,
    Verdict,
    Window,
    WindowTooShortForMatch,
)
from app.schemas.notification import NotificationJob
from app.schemas.schedule_solve import (
    NoSingleCauseRead,
    PastWindowReasonRead,
    PlayerConflictRead,
    PlayerOverSubscribedRead,
    ReservationHasNoTablesRead,
    ReservationOverCapacityRead,
    TableConflictRead,
    parse_infeasibility_reasons,
    parse_placement_conflicts,
)
from app.schemas.tournament import ScheduleSolveRead
from app.tournament_advancement import on_match_completed
from app.tournament_draws import cut_draw
from app.tournament_event_stages import mint_stages
from app.tournament_materialization import materialize_event
from app.tournament_queries import stage_ids_for_events
from tests._helpers import (
    event_draw_settings,
    event_groups,
    hijack_solve,
    joined_to_reservation,
    make_user,
    table_ids_of,
    venue_tables,
)

DATE = "2030-01-01"
#: The event's venue timezone — the IANA zone anchoring its wall-clock windows
#: to real instants (ADR "tournament times are timezone-aware instants").
VENUE_TZ = ZoneInfo("America/Chicago")
#: The tournament's minute-frame origin: the (single) reservation window's
#: start, as a timezone-aware instant in the venue frame (``09:00`` local on
#: ``DATE``).
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
    draw_type: DrawType = DrawType.round_robin,
    qualifiers_per_group: int | None = None,
    rounds: int | None = None,
    reservations: Sequence[Mapping[str, Any]] | None = None,
    materialize: bool = False,
) -> tuple[uuid.UUID, uuid.UUID]:
    """A published tournament with a table catalogue, one event of ``draw_type``,
    ``entrants`` entered players, and a cut draw. Written straight to the
    database — nothing here is about the create routes. Returns
    ``(tournament_id, event_id)`` as plain ids: the tests expire the session
    after the job runs, and an expired ORM instance's attribute access would try
    a sync lazy-load (``MissingGreenlet``).

    ``reservations`` is the event's reservations in the ``{name, slot, table_ids}``
    dict shape ``tests._helpers.event_groups`` speaks, naming tables by the positional
    aliases (``"t1"``, ``"t2"``, …) of this tournament's own catalogue. Left out,
    the event gets one reservation spanning every table for the whole event window,
    which is what most of this module's tests want.

    ``qualifiers_per_group`` is the one setting ``rr-then-ko`` carries — how many
    of each group's finishers reach the bracket — and ``rounds`` is the one
    ``swiss`` carries. Both go through the same parse the request boundary uses
    (``tests._helpers.event_draw_settings``), so a setting named for a draw type
    that has none reds here instead of writing a row the app could not have made.

    ``materialize`` runs the cut draw's ready fixtures into matches, as go-live
    does. A test wants it when what it is about happens *after* a result: a
    fixture with no match can never complete, and a draw seeded from results
    (``rr-then-ko``) can never advance past its first stage without one.

    Passing ``reservations=[]`` is the event the event-wide reservation exists for
    (ADR "a reservation restricts scheduling, it does not enable it"): its stage(s)
    still hold their groups (#1483's floor, #1484's per-stage widening), each mapped
    to NO reservation, so every one of its fixtures falls to the event-wide
    reservation rather than a booked one. It is spelled that way at the call site,
    rather than hidden behind a named variant helper, because in those tests the
    absent reservation is the whole subject — an explicit empty list says so louder
    than a helper name does.
    """
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

    reservation_specs: Sequence[Mapping[str, Any]] = (
        [
            {
                "name": "Reservation A",
                "slot": {"date": slot_date, "start": window[0], "end": window[1]},
                "table_ids": [str(row.id) for row in catalogue],
            }
        ]
        if reservations is None
        else reservations
    )
    stages = mint_stages(draw_type)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_settings=event_draw_settings(
            draw_type, qualifiers_per_group=qualifiers_per_group, rounds=rounds
        ),
        max_players=None,
        entry_fee=Decimal("0.00"),
        timezone="America/Chicago",
        slot={"date": slot_date, "start": window[0], "end": window[1]},
        match_settings={"rated": False, "length_games": length_games},
        stages=stages,
    )
    pool_groups = event_groups(
        reservation_specs,
        event=event,
        tournament=tournament,
        # This module's tests seed a group per reservation, whatever the draw type —
        # a raw ORM state #1484's floor no longer produces through any real route,
        # but the one several tests here (this file's own confinement regression
        # bed among them) still want directly. ``max(..., 1)`` mirrors
        # ``event_groups``'s own pre-#1484 default AND #1483's floor: an empty
        # ``reservations=[]`` still gets its one group, mapped to none, rather than
        # the un-grouped state ``group_id`` no longer represents.
        group_count=max(len(reservation_specs), 1),
    )
    stages[0].groups = pool_groups
    if draw_type is DrawType.rr_then_ko:
        # The knockout stage's own group (#1484) — always exactly one, mapped onto
        # the SAME reservation the pool's own position-0 group is (``position %
        # reservation count`` puts both at ``0 % N``). Built from the pool groups'
        # already-constructed reservation rows rather than a second
        # ``event_groups`` call, which would mint a second, duplicate set of
        # reservations instead of sharing these.
        pool_reservations = [
            group.reservation_link.reservation
            for group in pool_groups
            if group.reservation_link is not None
        ]
        target = pool_reservations[0] if pool_reservations else None
        stages[1].groups = [
            TournamentEventStageGroup(
                position=0,
                reservation_link=(
                    TournamentEventGroupReservation(reservation=target)
                    if target is not None
                    else None
                ),
            )
        ]
    db.add(event)
    await db.flush()
    # ``TournamentEvent.groups`` is a VIEWONLY association through the event's stage now
    # (ADR 20260815), populated automatically whenever an event is *queried* (its
    # declared ``lazy="selectin"`` fires as part of any SELECT that returns
    # ``TournamentEvent`` rows) but NOT by construction the way the old direct
    # relationship was. ``cut_draw`` below reads ``event.groups`` synchronously
    # (``app.tournament_draws.event_groups``/``draw_config``), so this object — built
    # and flushed, never queried — needs an explicit refresh or that read is an async
    # lazy load and raises ``MissingGreenlet``. A production caller never hits this:
    # every route loads its event through a query first. ``reservations`` too: with
    # ``reservations=[]`` nothing set the backref, and the cut's ``rr-then-ko``
    # materialisation (#1387) reads ``event.reservations`` to map the groups.
    await db.refresh(event, attribute_names=["groups", "reservations"])

    for _ in range(entrants):
        player = await make_user(db, f"player-{uuid.uuid4().hex[:8]}")
        db.add(TournamentEntry(event_id=event.id, user_id=player.id))
    await db.flush()

    await cut_draw(db, event)
    if materialize:
        await materialize_event(db, tournament, event)
    await db.commit()
    return tournament.id, event.id


async def _solver_reservation_id(
    db: AsyncSession, event_id: uuid.UUID
) -> ReservationId:
    """The solver's namespaced ``{event}:{reservation}`` key for the event's one
    reservation.

    The suffix is the **RESERVATION's** id, not the group's. The solver constrains a
    fixture to a set of tables inside a window, which is exactly what a reservation is,
    so that is what it keys on — a group only decides *which* reservation applies. The
    wire type is unchanged (it was always an opaque namespaced string), and under the
    1:1 the two id spaces are in exact correspondence; what moved is which row the
    suffix names.

    Looked up rather than spelled, because both ids are server-minted uuids (ADR
    20260801). The namespacing itself is unchanged — see
    ``app.schedule_solves.reservation_key`` for why it stayed."""
    reservation_id = (
        await db.execute(
            select(TournamentEventReservation.id).where(
                TournamentEventReservation.event_id == event_id
            )
        )
    ).scalar_one()
    return ReservationId(f"{event_id}:{reservation_id}")


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


def _is_knockout(fixture: TournamentFixture) -> bool:
    """Whether ``fixture`` belongs to a stage that does NOT seat both sides at the
    cut — a bracket or a swiss round, never a round-robin group stage (#1484:
    every stage now names a real group of its own, so ``group_id is None`` no
    longer tells the two apart)."""
    return not seats_both_sides_at_cut(fixture.stage.draw_type)


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


def _run_recorded_job(
    queue: Queue, expected_solve_id: uuid.UUID, *, index: int = 0
) -> None:
    """Run a recorded job the way a worker would: resolve the dotted path
    (``job.func`` imports it) and call it with the enqueued args.

    ``index`` is which recorded job to run, oldest first — ``0`` (the default)
    for the single-solve tests, and later indices for a test that solves, moves
    the tournament on, and solves again."""
    job = queue.jobs[index]
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
    start, ``pinned_at`` and the told-count — the pre-state the hold/echo
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
    table — a placement ``app.scheduling.solve`` itself can no longer produce
    (ADR "A called match holds its time, and a clashing call is refused": a
    pin is a constant in both dimensions), staged here so
    ``TestCalledMatchHolds`` can prove the apply's OWN defense holds even
    against a hostile/buggy solve output, not just the real solver's."""
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
    alignment (deploy/fortymm/templates/worker.yaml) has nothing to actually set."""

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
        job → every fixture placed on a reservation table inside the window on
        the 5-minute grid, and the ledger row tells the whole story."""
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
        """The solver always echoes a called match's placement verbatim (ADR
        "A called match holds its time, and a clashing call is refused") — the
        apply must not rewrite the promise's columns even with identical
        values, so a deliberately off-grid pin survives byte for byte. See
        ``TestCalledMatchHolds`` for the apply's OWN defense of this even
        against a hostile/buggy solve output."""
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
        # tight one. The reservation spans two tables over a full 09:00–17:00
        # day, so it is comfortably *large enough* — only its date makes it
        # infeasible.
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
        # tight-window / over-capacity arms for the same reservation, so it is
        # the only resolved reason, carrying the offending venue-local date.
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
        reservation's DISPLAY NAME (not the namespaced solver id) and, for the
        capacity arm, the ``HH:MM`` window and the integer minutes verbatim."""
        tournament_id, event_id = await _make_tournament(
            db_session, window=("09:00", "17:00")
        )
        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()

        reservation_key = await _solver_reservation_id(db_session, event_id)

        def infeasible(
            snapshot: ScheduleSnapshot, time_cap_s: float, num_search_workers: int
        ) -> SolveResult:
            return SolveResult(
                verdict=Verdict.infeasible,
                placements=(),
                stats=SolveStats(wall_time_ms=77, objective=None),
                reasons=(
                    ReservationHasNoTables(reservation_id=reservation_key),
                    ReservationOverCapacity(
                        reservation_id=reservation_key,
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
        assert isinstance(no_tables, ReservationHasNoTablesRead)
        # The DISPLAY name, never the namespaced ``{event_id}:reservation-a`` id.
        assert no_tables.reservation_name == "Reservation A"
        # Blamed reservation: a real, booked one, so a remedy may name a table
        # control ("add a table to Reservation A"). It survives the JSONB
        # round-trip.
        assert no_tables.reservation == "booked"

        assert isinstance(over_capacity, ReservationOverCapacityRead)
        assert over_capacity.reservation_name == "Reservation A"
        assert over_capacity.reservation == "booked"
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
        user-id string the solver speaks), alongside the reservation's name and
        clock."""
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

        reservation_key = await _solver_reservation_id(db_session, event_id)

        def infeasible(
            snapshot: ScheduleSnapshot, time_cap_s: float, num_search_workers: int
        ) -> SolveResult:
            return SolveResult(
                verdict=Verdict.infeasible,
                placements=(),
                stats=SolveStats(wall_time_ms=42, objective=None),
                reasons=(
                    PlayerOverSubscribed(
                        reservation_id=reservation_key,
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
        assert reason.reservation_name == "Reservation A"
        assert reason.window_start == "09:00"
        assert reason.window_end == "17:00"
        assert reason.match_count == 3
        assert reason.required_min == 95
        assert reason.window_span_min == 60
        assert reason.reservation == "booked"

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


class TestCalledMatchHolds:
    """ADR "A called match holds its time, and a clashing call is refused"
    (superseding "a called match holds its table and slides later", #1141):
    the guarded apply never rewrites a pinned fixture's placement, whatever
    ``app.scheduling.solve`` returns for it — the apply's own gate is
    ``fixture.pinned_at is not None``, checked BEFORE it ever looks at the
    placement's start, so even a (now-impossible in production, since
    ``app.scheduling`` itself never slides a pin) hostile/buggy solve output
    that tries to move a pin is silently ignored. That defends the ADR's
    promise at the layer a player's trust actually depends on: not "the
    solver behaves", but "the apply never writes over a promise"."""

    async def test_a_pinned_fixture_holds_even_if_solve_returns_a_moved_placement(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Defense in depth: force ``_solve`` (the seam ``_slide_pin_later``
        interposes on) to hand back the called match 20 minutes later on the
        same table — the shape the superseded ADR's solver used to produce
        under contention. The apply must still leave the fixture byte-
        identical to its promise and notify nobody: it never inspects the
        placement's start for an already-pinned fixture at all."""
        tournament_id, event_id = await _make_tournament(
            db_session, status=TournamentStatus.live, entrants=2, tables=("t1",)
        )
        fixture = (await _fixtures_of(db_session, event_id))[0]
        fixture_id = fixture.id
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
        held = (await _fixtures_of(db_session, event_id))[0]
        assert held.table_id == table_1
        assert held.scheduled_start == BASE  # NOT the fake solve's slid start
        assert held.pinned_at == original_pin_time  # not refreshed
        assert held.call_notified_count == 1  # never re-told

        assert await _match_call_notifications(db_session) == []
        assert fake_notifications_queue.jobs == []

        (ledger,) = await _solve_rows(db_session, tournament_id)
        assert ledger.status is ScheduleSolveStatus.succeeded
        assert ledger.fixtures_placed == 0
        assert ledger.fixtures_pinned == 1  # counted as pinned, never placed

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


async def _make_two_group_tournament(
    db: AsyncSession,
) -> tuple[uuid.UUID, uuid.UUID]:
    """A round-robin event with **two reservations that genuinely restrict**:
    Reservation A on table 1 in the morning, Reservation B on table 2 in the
    afternoon, inside an event window that spans both. The regression bed for
    "a group still confines its fixtures" — an event whose single reservation
    spans every table and the whole day (``_make_tournament``'s default
    reservation) could not tell a confined solve from an unconfined one.

    The event window is left at the default whole day deliberately: an event-wide
    reservation — if one wrongly claimed these fixtures — would look feasible on
    any table at any hour. That is what makes the group assertions able to fail.

    Kept as its own name rather than inlined into the one test that seeds it: the
    test reads its expectations back out of the group/reservation ROWS, so a
    literal sitting beside those reads would look like a round-trip worth
    deleting."""
    return await _make_tournament(
        db,
        entrants=6,
        reservations=[
            {
                "name": "Reservation A",
                "slot": {"date": DATE, "start": "09:00", "end": "12:00"},
                "table_ids": ["t1"],
            },
            {
                "name": "Reservation B",
                "slot": {"date": DATE, "start": "13:00", "end": "17:00"},
                "table_ids": ["t2"],
            },
        ],
    )


class TestBracketConfinement:
    """A single-elim or swiss event's fixtures are placed on **its reservation's
    tables inside its reservation's window** (#1483), not across the tournament's
    whole catalogue for the whole day.

    The confinement arrives with no change to the solver at all: a fixture reaches
    its reservation through its group (``restricting_reservation_key``, #1436), and
    #1483 is what gives these draw types a group to reach through. The lookup's
    INPUT changed; the lookup did not.
    """

    async def test_a_single_elim_bracket_is_confined_to_its_reservations_tables(
        self, db_session: AsyncSession
    ) -> None:
        """The headline. A 4-entrant bracket at a two-table venue, whose event window
        is the whole day but whose one reservation books **table 1 in the morning
        only**. Both semifinals land on table 1, before noon.

        Every assertion here can fail, which is the point of the seed's shape: the
        event's own window spans the whole day over both tables, so a bracket that
        fell through to the synthetic event-wide reservation — which is exactly what
        it did before this ticket — would be placed feasibly on either table at any
        hour and the run would still be ``optimal``. The table and the window are the
        two things only the group hop can restrict.
        """
        tournament_id, event_id = await _make_tournament(
            db_session,
            draw_type=DrawType.single_elim,
            entrants=4,
            tables=("t1", "t2"),
            reservations=[
                {
                    "name": "Reservation A",
                    "slot": {"date": DATE, "start": "09:00", "end": "12:00"},
                    "table_ids": ["t1"],
                }
            ],
        )
        catalogue = await table_ids_of(db_session, tournament_id)
        assert len(catalogue) == 2, "the venue must hold a table the reservation omits"

        fixtures = await _fixtures_of(db_session, event_id)
        round_one = [f for f in fixtures if f.round == 1]
        assert len(round_one) == 2
        assert all(f.group_id is not None for f in fixtures), (
            "every bracket fixture is dealt into the stage's group — the hop the "
            "confinement is made of"
        )

        inputs = await schedule_solves._load_solver_inputs(
            db_session, tournament_id, now=BASE, lock=False
        )
        assert inputs is not None
        result = scheduling.solve(inputs.snapshot)

        assert result.verdict in (Verdict.optimal, Verdict.feasible)
        assert {p.fixture_id for p in result.placements} == {
            str(f.id) for f in round_one
        }
        reserved_end = datetime(2030, 1, 1, 12, 0, tzinfo=VENUE_TZ)
        placed_tables = {p.table_id for p in result.placements}
        assert len(placed_tables) == 1, (
            f"the whole bracket sits on the one table the reservation booked — "
            f"got {placed_tables!r}"
        )
        assert placed_tables < set(catalogue), (
            "and it is a strict subset of the catalogue, so the reservation really "
            "restricted something"
        )
        for placement in result.placements:
            end = inputs.base + timedelta(minutes=placement.end_min)
            assert end <= reserved_end, (
                "and inside the reservation's window, not the event's whole day"
            )

    async def test_a_swiss_round_is_confined_to_its_reservations_tables(
        self, db_session: AsyncSession
    ) -> None:
        """The same claim for swiss, whose rounds reach their reservation through the
        same one group."""
        tournament_id, event_id = await _make_tournament(
            db_session,
            draw_type=DrawType.swiss,
            rounds=2,
            entrants=4,
            tables=("t1", "t2"),
            reservations=[
                {
                    "name": "Reservation A",
                    "slot": {"date": DATE, "start": "09:00", "end": "12:00"},
                    "table_ids": ["t1"],
                }
            ],
        )
        catalogue = await table_ids_of(db_session, tournament_id)
        fixtures = await _fixtures_of(db_session, event_id)
        assert all(f.group_id is not None for f in fixtures)

        inputs = await schedule_solves._load_solver_inputs(
            db_session, tournament_id, now=BASE, lock=False
        )
        assert inputs is not None
        result = scheduling.solve(inputs.snapshot)

        assert result.verdict in (Verdict.optimal, Verdict.feasible)
        assert result.placements, "round one is seeded, so it is placeable"
        reserved_end = datetime(2030, 1, 1, 12, 0, tzinfo=VENUE_TZ)
        assert {p.table_id for p in result.placements} < set(catalogue)
        for placement in result.placements:
            assert inputs.base + timedelta(minutes=placement.end_min) <= reserved_end


class TestEventWideReservation:
    """A fixture with no group is placed over its event's whole timeline (ADR "a
    reservation restricts scheduling, it does not enable it"): the event's own
    ``slot`` for a window, every table in the tournament for tables. The snapshot
    builder synthesizes one such reservation per event that has un-grouped
    fixtures — nothing is written, no group row exists, and ``app.scheduling`` is
    untouched.

    These probe ``_load_solver_inputs`` and run the real solver over what it
    built, because the claim is about the snapshot the pure module receives."""

    async def test_a_bracket_is_placed_on_the_tournaments_tables_in_its_window(
        self, db_session: AsyncSession
    ) -> None:
        """The headline: a single-elim event's first round gets a table and a
        time, where before this it got nothing at all. Every placement lands on
        a table of the tournament's own catalogue, inside the event's window,
        and two matches never share a table at the same moment."""
        tournament_id, event_id = await _make_tournament(
            db_session, draw_type=DrawType.single_elim, reservations=[]
        )
        catalogue = await table_ids_of(db_session, tournament_id)

        inputs = await schedule_solves._load_solver_inputs(
            db_session, tournament_id, now=BASE, lock=False
        )
        assert inputs is not None
        result = scheduling.solve(inputs.snapshot)

        assert result.verdict in (Verdict.optimal, Verdict.feasible)
        # Both round-1 fixtures of a 4-entrant bracket, placed.
        fixtures = await _fixtures_of(db_session, event_id)
        round_one = {str(f.id) for f in fixtures if f.round == 1}
        assert len(round_one) == 2
        assert {p.fixture_id for p in result.placements} == round_one

        window_start = datetime(2030, 1, 1, 9, 0, tzinfo=VENUE_TZ)
        window_end = datetime(2030, 1, 1, 17, 0, tzinfo=VENUE_TZ)
        for placement in result.placements:
            assert placement.table_id in catalogue
            start = inputs.base + timedelta(minutes=placement.start_min)
            end = inputs.base + timedelta(minutes=placement.end_min)
            assert window_start <= start
            assert end <= window_end
        # "A table at a time": two matches on one table never overlap.
        for first, second in combinations(result.placements, 2):
            if first.table_id != second.table_id:
                continue
            assert (
                first.end_min <= second.start_min or second.end_min <= first.start_min
            )

    async def test_a_group_still_confines_its_fixtures_to_its_tables_and_window(
        self, db_session: AsyncSession
    ) -> None:
        """THE regression the design rests on: a grouped fixture is placed on its
        **own group's** tables inside its **own group's** window — never on the
        event-wide reservation's, which here spans both tables and the whole day.

        The expectations come from the group/reservation ROWS, not from the
        snapshot's own fixture→reservation link: a builder that handed these
        fixtures the event-wide reservation would still satisfy "placed inside
        the reservation it was given", so that assertion would pass while the
        confinement was gone."""
        tournament_id, event_id = await _make_two_group_tournament(db_session)

        group_rows = (
            await db_session.execute(
                joined_to_reservation(
                    select(
                        TournamentEventStageGroup.id,
                        TournamentEventReservation.slot_start,
                        TournamentEventReservation.slot_end,
                    )
                ).where(
                    TournamentEventStageGroup.stage_id.in_(
                        stage_ids_for_events([event_id])
                    )
                )
            )
        ).all()
        assert len(group_rows) == 2
        reservation_windows = {
            group_id: (
                datetime.combine(date.fromisoformat(DATE), start, tzinfo=VENUE_TZ),
                datetime.combine(date.fromisoformat(DATE), end, tzinfo=VENUE_TZ),
            )
            for group_id, start, end in group_rows
        }
        reservation_tables: defaultdict[uuid.UUID, set[str]] = defaultdict(set)
        for group_id, table_id in (
            await db_session.execute(
                select(
                    TournamentEventGroupReservation.group_id,
                    TournamentEventReservationTable.table_id,
                )
                .join(
                    TournamentEventReservationTable,
                    TournamentEventReservationTable.reservation_id
                    == TournamentEventGroupReservation.reservation_id,
                )
                .where(TournamentEventReservationTable.event_id == event_id)
            )
        ).all():
            reservation_tables[group_id].add(str(table_id))
        assert [len(tables) for tables in reservation_tables.values()] == [1, 1]

        fixture_reservation = {
            str(fixture.id): fixture.group_id
            for fixture in await _fixtures_of(db_session, event_id)
        }
        assert all(group_id is not None for group_id in fixture_reservation.values())

        inputs = await schedule_solves._load_solver_inputs(
            db_session, tournament_id, now=BASE, lock=False
        )
        assert inputs is not None
        result = scheduling.solve(inputs.snapshot)

        assert result.verdict in (Verdict.optimal, Verdict.feasible)
        assert len(result.placements) == len(fixture_reservation)
        for placement in result.placements:
            group_id = fixture_reservation[placement.fixture_id]
            assert group_id is not None
            assert placement.table_id in reservation_tables[group_id]
            window_start, window_end = reservation_windows[group_id]
            assert window_start <= inputs.base + timedelta(minutes=placement.start_min)
            assert inputs.base + timedelta(minutes=placement.end_min) <= window_end

    async def test_a_tournament_with_no_tables_blames_the_reservation_by_name(
        self, db_session: AsyncSession
    ) -> None:
        """A bracket at a venue with no tables is infeasible for the reason it
        always was — ``ReservationHasNoTables`` — now fired against the event-wide
        reservation, and resolved to something a director can read rather than
        to the namespaced solver id."""
        tournament_id, _event_id = await _make_tournament(
            db_session, draw_type=DrawType.single_elim, reservations=[], tables=()
        )

        inputs = await schedule_solves._load_solver_inputs(
            db_session, tournament_id, now=BASE, lock=False
        )
        assert inputs is not None
        result = scheduling.solve(inputs.snapshot)

        assert result.verdict is Verdict.infeasible
        (reason,) = [r for r in result.reasons if isinstance(r, ReservationHasNoTables)]
        resolved = schedule_solves._resolve_reason(reason, inputs)
        assert isinstance(resolved, ReservationHasNoTablesRead)
        # The event a director knows, plus what is actually reserved. Not the
        # namespaced id, and not the bare event name (which would send them
        # looking for a table control an event does not have).
        assert resolved.reservation_name == "Open Singles (whole venue)"
        assert str(reason.reservation_id) not in resolved.reservation_name

    async def test_a_past_event_window_resolves_to_its_venue_local_date(
        self, db_session: AsyncSession
    ) -> None:
        """``reservation_dates`` carries the event-wide reservation too: a pre-live
        bracket dated in the past is named by the DAY to move (ADR "a past day is
        named"), which is a ``KeyError`` at exactly the wrong moment if the
        synthesized reservation is missing from that map."""
        tournament_id, _event_id = await _make_tournament(
            db_session,
            draw_type=DrawType.single_elim,
            reservations=[],
            slot_date="2020-01-01",
        )

        inputs = await schedule_solves._load_solver_inputs(
            db_session,
            tournament_id,
            now=datetime(2020, 1, 2, 9, 0, tzinfo=VENUE_TZ),
            lock=False,
        )
        assert inputs is not None
        result = scheduling.solve(inputs.snapshot)

        assert result.verdict is Verdict.infeasible
        (reason,) = [r for r in result.reasons if isinstance(r, PastWindow)]
        resolved = schedule_solves._resolve_reason(reason, inputs)
        assert isinstance(resolved, PastWindowReasonRead)
        assert resolved.date == date(2020, 1, 1)

    async def test_a_reason_says_which_kind_of_reservation_it_blames(
        self, db_session: AsyncSession
    ) -> None:
        """Every reason that names a reservation says whether that reservation is
        a real, **booked** one or the **event-wide** one, so a client can offer a
        remedy that names a control the director actually has.

        Without it the booked-reservation copy is offered against a reservation
        that is not a real one: "add a table to Open Singles (whole venue)",
        which already holds every table there is, or "give P fewer matches in
        Open Singles (whole venue) — a smaller reservation", which names a
        reservation the event does not have. The name alone cannot carry that
        distinction, and bending the name to fit the sentence is what produced
        the problem.

        All four named arms are checked against the event-wide reservation
        (:class:`~app.scheduling.NoSingleCause` names none, and
        :class:`~app.scheduling.PastWindow` names only a date). The reasons are
        built by hand: their *resolution* is what is under test, and a real solve
        can only be made to prove one arm at a time."""
        tournament_id, event_id = await _make_tournament(
            db_session, draw_type=DrawType.single_elim, reservations=[]
        )
        inputs = await schedule_solves._load_solver_inputs(
            db_session, tournament_id, now=BASE, lock=False
        )
        assert inputs is not None
        key = schedule_solves.event_wide_reservation_key(event_id)
        fixture = inputs.snapshot.fixtures[0]
        reasons: tuple[InfeasibilityReason, ...] = (
            ReservationHasNoTables(reservation_id=key),
            WindowTooShortForMatch(
                reservation_id=key,
                fixture_id=fixture.id,
                needed_min=25,
                window_span_min=10,
            ),
            ReservationOverCapacity(
                reservation_id=key, required_min=600, capacity_min=480, table_count=2
            ),
            PlayerOverSubscribed(
                reservation_id=key,
                player_id=fixture.player_a_id,
                match_count=3,
                required_min=95,
                window_span_min=60,
            ),
        )

        for reason in reasons:
            resolved = schedule_solves._resolve_reason(reason, inputs)
            # The two arms that name no reservation are not in this tuple.
            assert not isinstance(
                resolved, (NoSingleCauseRead, PastWindowReasonRead)
            ), resolved
            assert resolved.reservation == "event"
            assert resolved.reservation_name == "Open Singles (whole venue)"

    async def test_a_fixture_with_a_side_still_unknown_stays_unplaced(
        self, db_session: AsyncSession
    ) -> None:
        """The TBD guard is what lets a knockout fill in round by round: a
        4-entrant bracket's final has no sides yet, so it is left out of the
        snapshot — while its two feeders, which do have sides, are in it. (A
        test that only asserted the final's absence would pass against a build
        that skipped the whole event, which is the state before this slice.)"""
        tournament_id, event_id = await _make_tournament(
            db_session, draw_type=DrawType.single_elim, reservations=[]
        )
        fixtures = await _fixtures_of(db_session, event_id)
        final = next(f for f in fixtures if f.round == 2)
        assert final.entry_a_id is None and final.entry_b_id is None
        round_one = {str(f.id) for f in fixtures if f.round == 1}

        inputs = await schedule_solves._load_solver_inputs(
            db_session, tournament_id, now=BASE, lock=False
        )

        assert inputs is not None
        snapshot_ids = {fixture.id for fixture in inputs.snapshot.fixtures}
        assert str(final.id) not in snapshot_ids
        assert round_one <= snapshot_ids


async def _make_swiss_tournament(db: AsyncSession) -> tuple[uuid.UUID, uuid.UUID]:
    """A tournament whose one event is a **swiss** event with **no groups** — the
    other un-grouped shape (ADR "a reservation restricts scheduling, it does not
    enable it"), and the only one that is un-grouped in every round it will ever
    play. Four entrants over two tables, in the ``09:00``-``17:00`` window
    ``BASE`` anchors.

    **Two rounds**, deliberately: swiss cuts every round up front, so a second
    round exists from the cut with both sides ``None``, which is what makes
    "exactly round one is placed" a statement the seed can actually falsify.
    Returns ``(tournament_id, event_id)`` as plain ids, for the reason
    ``_make_tournament`` does.
    """
    return await _make_tournament(
        db, draw_type=DrawType.swiss, reservations=[], rounds=2
    )


async def _make_groups_then_knockout_tournament(
    db: AsyncSession,
) -> tuple[uuid.UUID, uuid.UUID]:
    """A tournament whose one event is **round-robin-then-knockout**: two groups
    of three that genuinely restrict — Reservation A on table 1 in the morning,
    Reservation B on table 1 in the afternoon — and a knockout stage of four
    qualifiers (two semis and a final) with its own group, position 0 of its own
    stage.

    #1484's mapping is derived, ``position % reservation_count``: the knockout
    stage's sole group is also position 0, so it shares **Reservation A** with the
    pool's own group 1 — ``0 % 2 == 0`` both times. That is the headline behavior
    under test (#1348): the knockout is now genuinely confined to the reservation
    its group maps to, on table 1, morning only — not left to float over the
    event-wide window the way an un-grouped fixture used to.

    **Table 2 is reserved by no group**, since both groups share table 1 — kept so
    a build that regressed back to the event-wide reservation (whole catalogue,
    whole day) would be distinguishable from one confined to Reservation A.

    Its group fixtures are **materialized into matches** before the return, as
    go-live does, because the knockout is seeded from *results*: a group's
    qualifiers are seated when its matches complete with scores, and a fixture
    with no match can never complete. Nothing is played here — that is the test's
    own second act.
    """
    return await _make_tournament(
        db,
        entrants=6,
        # Spelled out rather than left to the default, because the docstring's
        # geometry is about *this* catalogue: "table 2 is reserved by no group"
        # stops being a local fact if the default ever grows a third table.
        tables=("t1", "t2"),
        window=("08:00", "19:00"),
        draw_type=DrawType.rr_then_ko,
        qualifiers_per_group=2,
        reservations=[
            {
                "name": "Reservation A",
                "slot": {"date": DATE, "start": "09:00", "end": "13:00"},
                "table_ids": ["t1"],
            },
            {
                "name": "Reservation B",
                "slot": {"date": DATE, "start": "14:00", "end": "18:00"},
                "table_ids": ["t1"],
            },
        ],
        materialize=True,
    )


async def _group_reservation_windows(
    db: AsyncSession, event_id: uuid.UUID
) -> dict[uuid.UUID, tuple[datetime, datetime, set[str]]]:
    """What each of the event's groups reserves — ``(window start, window end,
    table ids)`` per group id, windows as instants in the venue frame.

    Read from the group/reservation ROWS, never from the snapshot's own
    fixture→reservation link: a builder that handed a grouped fixture the
    event-wide reservation would still satisfy "placed inside the reservation
    it was given"."""
    windows = {
        group_id: (
            datetime.combine(date.fromisoformat(DATE), start, tzinfo=VENUE_TZ),
            datetime.combine(date.fromisoformat(DATE), end, tzinfo=VENUE_TZ),
        )
        for group_id, start, end in (
            await db.execute(
                joined_to_reservation(
                    select(
                        TournamentEventStageGroup.id,
                        TournamentEventReservation.slot_start,
                        TournamentEventReservation.slot_end,
                    )
                ).where(
                    TournamentEventStageGroup.stage_id.in_(
                        stage_ids_for_events([event_id])
                    )
                )
            )
        ).all()
    }
    tables: defaultdict[uuid.UUID, set[str]] = defaultdict(set)
    for group_id, table_id in (
        await db.execute(
            select(
                TournamentEventGroupReservation.group_id,
                TournamentEventReservationTable.table_id,
            )
            .join(
                TournamentEventReservationTable,
                TournamentEventReservationTable.reservation_id
                == TournamentEventGroupReservation.reservation_id,
            )
            .where(TournamentEventReservationTable.event_id == event_id)
        )
    ).all():
        tables[group_id].add(str(table_id))
    return {
        group_id: (start, end, tables[group_id])
        for group_id, (start, end) in windows.items()
    }


def _assert_confined_to_its_group(
    fixture: TournamentFixture,
    reservations: dict[uuid.UUID, tuple[datetime, datetime, set[str]]],
) -> None:
    """A grouped fixture is placed on its **own group's** tables inside its
    **own group's** window — not on the event-wide reservation's, which spans
    every table and a longer day."""
    assert fixture.group_id is not None
    window_start, window_end, tables = reservations[fixture.group_id]
    assert fixture.table_id in tables
    assert fixture.scheduled_start is not None
    assert window_start <= fixture.scheduled_start
    assert (
        fixture.scheduled_start + timedelta(minutes=scheduling.match_minutes(3))
        <= window_end
    )


async def _score_and_complete(
    db: AsyncSession, fixture: TournamentFixture, *, winner_entry_id: uuid.UUID
) -> None:
    """Play ``fixture``'s match out 2-0 for ``winner_entry_id`` and run it through
    the completion seam a real result acceptance runs
    (:func:`app.tournament_advancement.on_match_completed`) — which writes the
    winner back, advances the draw, materializes whatever the result made ready,
    and requests the re-solve this test is about.

    The board is real games with real scores, not a bare ``winner_entry_id``: a
    groups-then-knockout draw seats its qualifiers from the **games** each side
    won (ADR 20260727's tiebreak chain), so a scoreless completion would leave
    the group unfinished — or refused outright.

    ``completed_at`` stays ``None`` on purpose. A stamped completion casts a
    ``REST_MIN`` shadow on both players, and these seeds are dated 2030 while the
    suite runs today, so every shadow would still be open and would push the
    knockout around for reasons that have nothing to do with the reservation
    under test.
    """
    assert fixture.match_id is not None
    match = (
        await db.execute(
            select(Match)
            .options(selectinload(Match.sides))
            .where(Match.id == fixture.match_id)
        )
    ).scalar_one()
    side_1_wins = winner_entry_id == fixture.entry_a_id
    for number in (1, 2):
        game = MatchGame(match_id=match.id, game_number=number)
        db.add(game)
        await db.flush()
        db.add(
            MatchGameScore(
                match_game_id=game.id,
                side_1_points=11 if side_1_wins else 5,
                side_2_points=5 if side_1_wins else 11,
            )
        )
    for side in match.sides:
        side.won = (side.side_number == 1) == side_1_wins
    match.status = MatchStatus.completed
    await db.flush()
    await on_match_completed(db, match)


async def _play_out_the_groups(db: AsyncSession, event_id: uuid.UUID) -> None:
    """Decide every **group** fixture of a groups-then-knockout event, leaving
    the knockout untouched.

    Each group gets a strict finishing order rather than a three-way tie: the
    first fixture's ``entry_a`` wins both of the matches it plays, and the
    group's remaining pairing goes to its own ``entry_a``. So the group comes
    out 2-0, 1-1, 0-2 and its top two are named by the wins alone — this test
    is about scheduling, and a tiebreak deciding who qualifies would make it
    about something else.
    """
    by_group: defaultdict[uuid.UUID, list[TournamentFixture]] = defaultdict(list)
    for fixture in await _fixtures_of(db, event_id):
        if not _is_knockout(fixture):
            by_group[fixture.group_id].append(fixture)
    for group_fixtures in by_group.values():
        top = group_fixtures[0].entry_a_id
        for fixture in group_fixtures:
            entry_a_id, entry_b_id = fixture.entry_a_id, fixture.entry_b_id
            assert entry_a_id is not None and entry_b_id is not None
            winner = top if top in (entry_a_id, entry_b_id) else entry_a_id
            assert winner is not None
            await _score_and_complete(db, fixture, winner_entry_id=winner)
    await db.commit()


class TestFixturesKeyOnTheReservation:
    """The solver keys on the **reservation**, not the group (#1389): a fixture resolves
    to exactly one reservation through its group, two groups that share a reservation
    resolve to one key and one spec, and a group with no reservation resolves to the
    event-wide one exactly as an ungrouped fixture does.

    Every case here is an ``rr-then-ko`` case. The cut materialises that draw type's
    groups from the registered field (#1387, five to a group) and maps them round-robin
    onto the reservations, so eight entrants over one reservation give two groups
    sharing it, and eight entrants over none give two groups with none. No other draw
    type reaches either state."""

    async def test_two_groups_sharing_a_reservation_resolve_to_one_key_and_one_spec(
        self, db_session: AsyncSession
    ) -> None:
        """Two groups over one reservation compete for one set of tables. Keyed on
        the group, the solver would build two table pools over the same tables and
        double-book them.

        The **spec count** is asserted, not only the key: the resolution maps are
        dictionaries and dedupe a duplicate silently, but the spec list does not,
        and two ``ScheduleReservation`` rows carrying one id double-count that
        reservation's table-minutes, so an infeasible reservation solves as
        feasible. Nothing errors. A key assertion alone stays green against it.

        With one booked reservation, the knockout stage's own group maps to it too
        (#1484: ``position % reservation_count`` gives every stage's position-0
        group ``reservations[0]``) — so this event has no event-wide reservation
        left at all; three groups, one key."""
        tournament_id, event_id = await _make_tournament(
            db_session,
            entrants=8,
            draw_type=DrawType.rr_then_ko,
            qualifiers_per_group=2,
        )
        fixtures = await _fixtures_of(db_session, event_id)
        # The GROUP stage's own groups (#1484: the knockout stage now names its own
        # single group too, which shares this reservation rather than adding a
        # second one — see below).
        group_stage_ids = {str(f.id) for f in fixtures if not _is_knockout(f)}
        group_ids = {f.group_id for f in fixtures if not _is_knockout(f)}
        assert len(group_ids) == 2, "eight entrants derive two groups (#1386)"

        inputs = await schedule_solves._load_solver_inputs(
            db_session, tournament_id, now=BASE, lock=False
        )
        assert inputs is not None
        reservation_key = await _solver_reservation_id(db_session, event_id)

        # One spec, one reservation: the booked one. No event-wide reservation is
        # built at all, because every fixture — pool and knockout alike — resolves
        # to the booked key (#1484 removes the bracket's last event-wide caller for
        # a drawn, booked event).
        spec_ids = [r.id for r in inputs.snapshot.reservations]
        assert spec_ids == [reservation_key]

        # Every fixture of both pool groups resolves to the one booked key.
        group_stage = [f for f in inputs.snapshot.fixtures if f.id in group_stage_ids]
        assert group_stage, "the group stage reached the snapshot"
        assert {f.reservation_id for f in group_stage} == {reservation_key}
        assert len(group_stage) == 2 * len(list(combinations(range(4), 2)))
        # The knockout stage's semis are still TBD (nobody has qualified), so the
        # guard in test_a_fixture_with_a_side_still_unknown_stays_unplaced keeps
        # them out of the snapshot entirely — they contribute no fixture here, only
        # a group that maps to this same key (below).
        assert all(f.id in group_stage_ids for f in inputs.snapshot.fixtures)

        # The over-capacity reason names how many GROUP-STAGE groups share the
        # reservation — the two pool groups, not the knockout's own (#1535: the
        # knockout stage is never a "group" in this clause) — plus ``has_bracket``
        # naming that the bracket shares it too, the cause a director acts on by
        # adding a reservation.
        resolved = schedule_solves._resolve_reason(
            ReservationOverCapacity(
                reservation_id=reservation_key,
                required_min=600,
                capacity_min=480,
                table_count=2,
            ),
            inputs,
        )
        assert isinstance(resolved, ReservationOverCapacityRead)
        assert resolved.group_count == 2
        assert resolved.has_bracket is True
        assert resolved.reservation == "booked"

    async def test_a_group_with_no_reservation_takes_the_event_wide_reservation(
        self, db_session: AsyncSession
    ) -> None:
        """An rr-then-ko event with no reservation holds groups with none (#1387).
        Their fixtures name a group, so a site asking "does it name a group" took
        the group arm and asked for a key with no window. Asking "which reservation
        restricts it" gives the event-wide one, as for a group with no reservation —
        and the guard builds that reservation, so the lookup is total.

        The event holds both kinds of fixture at once: a group stage in groups with
        no reservation, and a knockout stage in its own group, also with no
        reservation (#1484). One event-wide reservation serves both, and the guard
        builds exactly one."""
        tournament_id, event_id = await _make_tournament(
            db_session,
            entrants=8,
            draw_type=DrawType.rr_then_ko,
            qualifiers_per_group=2,
            reservations=[],
        )
        fixtures = await _fixtures_of(db_session, event_id)
        assert any(not _is_knockout(f) for f in fixtures)
        assert any(_is_knockout(f) for f in fixtures)

        inputs = await schedule_solves._load_solver_inputs(
            db_session, tournament_id, now=BASE, lock=False
        )
        assert inputs is not None
        event_wide_key = schedule_solves.event_wide_reservation_key(event_id)

        # Exactly one reservation, the event-wide one, spanning the whole catalogue
        # inside the event's own window.
        (reservation,) = inputs.snapshot.reservations
        assert reservation.id == event_wide_key
        assert len(reservation.table_ids) == 2
        assert reservation.window == Window(start_min=0, end_min=8 * 60)

        # Every placeable fixture — the group stage, whose sides are known — takes it.
        assert inputs.snapshot.fixtures, "the group stage reached the snapshot"
        assert {f.reservation_id for f in inputs.snapshot.fixtures} == {event_wide_key}

        # It solves, over the tournament's tables: a reservation restricts
        # scheduling, it does not enable it.
        result = scheduling.solve(inputs.snapshot)
        assert result.verdict in (Verdict.feasible, Verdict.optimal)

        # The event-wide reservation counts the GROUP-STAGE groups with no
        # reservation — the group stage's two, not the knockout stage's own (#1535:
        # the knockout now names a real group too, mapped here to no reservation
        # same as the pool's, but it is the bracket, not a "group" this clause
        # counts) — and ``has_bracket`` names that the bracket shares it too.
        resolved = schedule_solves._resolve_reason(
            ReservationOverCapacity(
                reservation_id=event_wide_key,
                required_min=600,
                capacity_min=480,
                table_count=2,
            ),
            inputs,
        )
        assert isinstance(resolved, ReservationOverCapacityRead)
        assert resolved.group_count == 2
        assert resolved.has_bracket is True
        assert resolved.reservation == "event"

    # `test_an_event_wide_reservation_holding_only_a_knockout_counts_no_group` is
    # deleted, not fixed: it named a scenario — a booked rr-then-ko event whose
    # knockout stage belongs to no group, so it falls to the event-wide reservation
    # alone — that #1484 makes unreachable. The knockout stage now names its own
    # real group (`position % reservation_count`), and with a real reservation
    # booked that group resolves to it, same as the pool's; the event-wide
    # reservation is built only when an event has none at all
    # (`test_a_group_with_no_reservation_takes_the_event_wide_reservation`, above).
    # Per the ticket's own Non-Goals: "This ticket removes their [the event-wide
    # reservation's / `TournamentEvent.slot`'s] last caller for drawn events."


class TestGroupCountExcludesTheBracket:
    """#1535: the over-capacity clause's ``group_count`` counts only GROUP-STAGE
    groups, never the knockout stage's own (#1484's one missed surface), and
    ``has_bracket`` names that group separately so the client can say "and the
    bracket" without inferring a draw type."""

    async def test_one_pool_group_plus_the_bracket_reports_group_count_one(
        self, db_session: AsyncSession
    ) -> None:
        """Five or fewer entrants derive one pool group (``group_count_for``'s
        floor, at least one), which always shares reservation 0 with the knockout
        stage's own group (``position % reservation_count`` puts both at
        ``0 % 1``). The API reports the true facts — ``group_count=1``,
        ``has_bracket=True`` — even though the client renders no clause either way
        once ``group_count`` is at most one (the edge case the ticket names:
        "today it renders 'It holds 2 groups'; after the fix it renders no
        clause")."""
        tournament_id, event_id = await _make_tournament(
            db_session,
            entrants=5,
            draw_type=DrawType.rr_then_ko,
            qualifiers_per_group=2,
        )
        inputs = await schedule_solves._load_solver_inputs(
            db_session, tournament_id, now=BASE, lock=False
        )
        assert inputs is not None
        reservation_key = await _solver_reservation_id(db_session, event_id)

        resolved = schedule_solves._resolve_reason(
            ReservationOverCapacity(
                reservation_id=reservation_key,
                required_min=600,
                capacity_min=480,
                table_count=2,
            ),
            inputs,
        )
        assert isinstance(resolved, ReservationOverCapacityRead)
        assert resolved.group_count == 1
        assert resolved.has_bracket is True

    async def test_two_reservations_split_the_groups_and_only_one_carries_the_bracket(
        self, db_session: AsyncSession
    ) -> None:
        """Three pool groups over two reservations map ``position % 2``: groups 0
        and 2 to reservation A, group 1 to reservation B. The knockout's own group
        sits at position 0 too (``app.tournament_events`` :534), so it always lands
        with reservation A — the ticket's own "Multi-reservation events" edge case.
        Reservation A reports ``group_count=2, has_bracket=True``; reservation B,
        which never shares a position with the bracket, reports
        ``group_count=1, has_bracket=False``."""
        tournament_id, event_id = await _make_tournament(
            db_session,
            entrants=13,
            draw_type=DrawType.rr_then_ko,
            qualifiers_per_group=2,
            reservations=[
                {
                    "name": "Reservation A",
                    "slot": {"date": DATE, "start": "09:00", "end": "17:00"},
                    "table_ids": ["t1"],
                },
                {
                    "name": "Reservation B",
                    "slot": {"date": DATE, "start": "09:00", "end": "17:00"},
                    "table_ids": ["t2"],
                },
            ],
        )
        fixtures = await _fixtures_of(db_session, event_id)
        group_ids = {f.group_id for f in fixtures if not _is_knockout(f)}
        assert len(group_ids) == 3, "13 entrants derive three groups (ceil(13/5))"

        inputs = await schedule_solves._load_solver_inputs(
            db_session, tournament_id, now=BASE, lock=False
        )
        assert inputs is not None

        reservation_rows = (
            await db_session.execute(
                select(
                    TournamentEventReservation.name, TournamentEventReservation.id
                ).where(TournamentEventReservation.event_id == event_id)
            )
        ).all()
        by_name = {
            name: ReservationId(f"{event_id}:{rid}") for name, rid in reservation_rows
        }

        resolved_a = schedule_solves._resolve_reason(
            ReservationOverCapacity(
                reservation_id=by_name["Reservation A"],
                required_min=600,
                capacity_min=480,
                table_count=1,
            ),
            inputs,
        )
        assert isinstance(resolved_a, ReservationOverCapacityRead)
        assert resolved_a.group_count == 2
        assert resolved_a.has_bracket is True

        resolved_b = schedule_solves._resolve_reason(
            ReservationOverCapacity(
                reservation_id=by_name["Reservation B"],
                required_min=600,
                capacity_min=480,
                table_count=1,
            ),
            inputs,
        )
        assert isinstance(resolved_b, ReservationOverCapacityRead)
        assert resolved_b.group_count == 1
        assert resolved_b.has_bracket is False

    async def test_a_single_elim_events_sole_group_never_gates_the_clause(
        self, db_session: AsyncSession
    ) -> None:
        """A single-elim event's whole draw is one stage, one group
        (``GroupCountSource.one``), and — unlike an ``rr-then-ko`` event's own
        group stage — that stage does not seat both sides at the cut
        (``seats_both_sides_at_cut``), so it is not a group-stage stage either
        (:func:`~app.tournament_draws.group_stage_ids`). ``group_count`` is
        therefore ``0`` here, never ``1``: there is no *other* group-stage group
        for this one to be counted alongside. The clause's gate
        (``group_count > 1``) cannot open on a single-elim event regardless of
        ``has_bracket``, which is what Non-Goals means by "their sole group is
        already suppressed" — the API never names a bracket for a draw type that
        has no group stage to name it beside.

        ``has_bracket`` itself also resolves ``False`` here: with
        :func:`~app.tournament_draws.group_stage_ids` empty for a standalone
        single-elim event, there is no group stage for this sole group to be the
        *bracket* relative to, so
        :func:`~app.schedule_solves.group_counts_by_reservation` never classifies
        it as one (#1535 review — a non-group-stage group is only the bracket
        when the event actually has a group stage). Pinned alongside the gated
        ``group_count`` so the field stays honest even though the client-side
        gate never reads it."""
        tournament_id, event_id = await _make_tournament(
            db_session,
            draw_type=DrawType.single_elim,
            entrants=4,
        )
        inputs = await schedule_solves._load_solver_inputs(
            db_session, tournament_id, now=BASE, lock=False
        )
        assert inputs is not None
        reservation_key = await _solver_reservation_id(db_session, event_id)

        resolved = schedule_solves._resolve_reason(
            ReservationOverCapacity(
                reservation_id=reservation_key,
                required_min=600,
                capacity_min=480,
                table_count=2,
            ),
            inputs,
        )
        assert isinstance(resolved, ReservationOverCapacityRead)
        assert resolved.group_count == 0
        assert resolved.has_bracket is False

    async def test_a_swiss_events_sole_group_never_gates_the_clause(
        self, db_session: AsyncSession
    ) -> None:
        """The swiss twin of the single-elim case above: one stage, one group,
        not a group-stage stage (``seats_both_sides_at_cut(swiss)`` is ``False``
        too), so ``group_count`` is ``0`` and the clause's gate cannot open here
        either. ``has_bracket`` is ``False`` too, for the same reason as the
        single-elim case: no group stage exists for this sole group to be the
        bracket relative to."""
        tournament_id, event_id = await _make_tournament(
            db_session,
            draw_type=DrawType.swiss,
            entrants=4,
            rounds=2,
        )
        inputs = await schedule_solves._load_solver_inputs(
            db_session, tournament_id, now=BASE, lock=False
        )
        assert inputs is not None
        reservation_key = await _solver_reservation_id(db_session, event_id)

        resolved = schedule_solves._resolve_reason(
            ReservationOverCapacity(
                reservation_id=reservation_key,
                required_min=600,
                capacity_min=480,
                table_count=2,
            ),
            inputs,
        )
        assert isinstance(resolved, ReservationOverCapacityRead)
        assert resolved.group_count == 0
        assert resolved.has_bracket is False


class TestUnGroupedDrawShapes:
    """The two shapes whose fixtures ride the event-wide reservation by falling
    into a group with no reservation, not by naming no group at all — a swiss
    draw, whose sole floor group has no reservation booked, and a
    round-robin-then-knockout draw, whose own knockout-stage group likewise has
    none (#1483's floor, #1484's per-stage widening; ADR "a reservation
    restricts scheduling, it does not enable it").

    These run the whole job through the queue and read the fixture ROWS back,
    rather than reading a snapshot: the claim is that these events' matches now
    get a table and a time at all, which before this was only ever one a director
    typed in by hand."""

    async def test_a_swiss_round_is_placed_on_the_tournaments_tables(
        self, db_session: AsyncSession, solver_queue: Queue
    ) -> None:
        """A swiss event's first round is placed over the event's own window on
        the tournament's own tables. Its second round, cut at the same stroke with
        both sides still unknown, is left alone — so this cannot pass by placing
        everything the event holds."""
        tournament_id, event_id = await _make_swiss_tournament(db_session)
        fixtures = await _fixtures_of(db_session, event_id)
        # Swiss deals every fixture into its event's sole floor group (#1483) —
        # one group, shared by every fixture, mapped to no reservation.
        (group_id,) = {fixture.group_id for fixture in fixtures}
        assert group_id is not None
        round_one = [fixture.id for fixture in fixtures if fixture.round == 1]
        round_two = [fixture for fixture in fixtures if fixture.round == 2]
        assert len(round_one) == 2  # four entrants, two pairings
        assert len(round_two) == 2
        assert all(
            fixture.entry_a_id is None and fixture.entry_b_id is None
            for fixture in round_two
        ), "a later swiss round is paired on advance, not at the cut"

        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()

        _run_recorded_job(solver_queue, row_id)

        db_session.expire_all()
        catalogue = set(await table_ids_of(db_session, tournament_id))
        placed = {
            fixture.id: fixture for fixture in await _fixtures_of(db_session, event_id)
        }
        window_end = BASE + timedelta(hours=8)
        for fixture_id in round_one:
            fixture = placed[fixture_id]
            assert fixture.table_id in catalogue
            assert fixture.scheduled_start is not None
            assert BASE <= fixture.scheduled_start
            assert (
                fixture.scheduled_start + timedelta(minutes=scheduling.match_minutes(3))
                <= window_end
            )
        for fixture in round_two:
            assert placed[fixture.id].table_id is None
            assert placed[fixture.id].scheduled_start is None
        # Two matches, two tables or two times — never one table at one moment.
        starts = {
            (placed[fixture_id].table_id, placed[fixture_id].scheduled_start)
            for fixture_id in round_one
        }
        assert len(starts) == 2

        (ledger,) = await _solve_rows(db_session, tournament_id)
        assert ledger.status is ScheduleSolveStatus.succeeded
        assert ledger.fixtures_placed == 2

    async def test_a_knockout_stage_is_placed_once_its_groups_have_decided(
        self, db_session: AsyncSession, solver_queue: Queue
    ) -> None:
        """The sequence, which is the whole point: a knockout fixture whose sides
        are unknown is left **unplaced** — never invented a table or a time — and
        becomes placed by the re-solve a completed match already triggers, once
        the group fixtures that feed it are decided.

        A test that only looked at the end state could not tell "the knockout was
        placed once its feeders landed" from "the knockout was placed all along",
        so both states are asserted, on the persisted rows, either side of the
        completions.

        Where the semis land is the other claim, and it is the ticket's headline
        fix (#1348): the knockout stage now names its own group, which the derived
        ``position % reservation_count`` mapping puts on **Reservation A** — the
        same reservation the pool's own group 1 holds, since both are position 0.
        So the semis are genuinely confined to Reservation A's table and window,
        exactly as :func:`_assert_confined_to_its_group` already checks for a pool
        fixture — not left to float over the event-wide reservation the way an
        un-grouped fixture used to. Reservation A books only one table, so the two
        semis cannot run in parallel: that serialization is the solver's per-table
        no-overlap constraint doing its job once the group mapping has already
        confined both fixtures to it, which is the second half of the claim.
        """
        tournament_id, event_id = await _make_groups_then_knockout_tournament(
            db_session
        )
        reservations = await _group_reservation_windows(db_session, event_id)
        fixtures = await _fixtures_of(db_session, event_id)
        grouped = [fixture.id for fixture in fixtures if not _is_knockout(fixture)]
        knockout = [fixture for fixture in fixtures if _is_knockout(fixture)]
        semis = [fixture.id for fixture in knockout if fixture.round == 1]
        (final,) = [fixture.id for fixture in knockout if fixture.round == 2]
        assert len(grouped) == 6  # two groups of three, three pairings each
        assert len(semis) == 2  # four qualifiers: two semi-finals and a final
        assert all(
            fixture.entry_a_id is None and fixture.entry_b_id is None
            for fixture in knockout
        ), "nobody has qualified yet"

        first = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.go_live
        )
        assert first is not None
        first_id = first.id
        await db_session.commit()

        _run_recorded_job(solver_queue, first_id)

        db_session.expire_all()
        before = {
            fixture.id: fixture for fixture in await _fixtures_of(db_session, event_id)
        }
        for fixture_id in grouped:
            _assert_confined_to_its_group(before[fixture_id], reservations)
        for fixture_id in (*semis, final):
            assert before[fixture_id].table_id is None
            assert before[fixture_id].scheduled_start is None
        (ledger,) = await _solve_rows(db_session, tournament_id)
        assert ledger.status is ScheduleSolveStatus.succeeded
        assert ledger.fixtures_placed == 6, "the groups, and nothing else"
        group_placements = {
            fixture_id: (
                before[fixture_id].table_id,
                before[fixture_id].scheduled_start,
            )
            for fixture_id in grouped
        }

        await _play_out_the_groups(db_session, event_id)

        db_session.expire_all()
        seeded = {
            fixture.id: fixture for fixture in await _fixtures_of(db_session, event_id)
        }
        assert all(
            seeded[fixture_id].entry_a_id is not None
            and seeded[fixture_id].entry_b_id is not None
            for fixture_id in semis
        ), "both groups finished, so all four qualifiers are seated"
        rows = await _solve_rows(db_session, tournament_id)
        assert len(rows) == 2, "six completions coalesce onto one queued re-solve"
        second_id = rows[1].id

        _run_recorded_job(solver_queue, second_id, index=1)

        db_session.expire_all()
        after = {
            fixture.id: fixture for fixture in await _fixtures_of(db_session, event_id)
        }
        for fixture_id in semis:
            # The whole of the confinement claim: on Reservation A's table, inside
            # Reservation A's window — the same reservation group 1 holds, because
            # the knockout's own group is position 0 too.
            _assert_confined_to_its_group(after[fixture_id], reservations)
        # Both semis' group is the knockout stage's own — one group, so one
        # reservation, so (checked next) one table between the two of them.
        (knockout_group_id,) = {after[fixture_id].group_id for fixture_id in semis}
        _window_start, _window_end, knockout_tables = reservations[knockout_group_id]
        assert len(knockout_tables) == 1, (
            "Reservation A books exactly one table — the seed's premise for "
            "proving the semis serialize rather than run in parallel"
        )
        assert {after[fixture_id].table_id for fixture_id in semis} == knockout_tables
        # One table between them: the solver's per-table no-overlap is what
        # actually keeps the two semis apart, now that the group mapping alone
        # already confines both to it.
        windows = sorted(
            (
                after[fixture_id].scheduled_start,
                after[fixture_id].scheduled_start
                + timedelta(minutes=scheduling.match_minutes(3)),
            )
            for fixture_id in semis
            if after[fixture_id].scheduled_start is not None
        )
        assert len(windows) == 2
        assert windows[0][1] <= windows[1][0], (
            "one shared table forces the semis to run one after another"
        )
        # The final's feeders are the semis, which nobody has played: still TBD,
        # so still unplaced — in the very same solve that placed the semis.
        assert after[final].entry_a_id is None and after[final].entry_b_id is None
        assert after[final].table_id is None
        assert after[final].scheduled_start is None
        # The groups were decided, so they are out of the model — their
        # placements stand exactly as the first solve left them, inside their
        # own groups.
        for fixture_id in grouped:
            _assert_confined_to_its_group(after[fixture_id], reservations)
            assert (
                after[fixture_id].table_id,
                after[fixture_id].scheduled_start,
            ) == group_placements[fixture_id]
        _first, second = await _solve_rows(db_session, tournament_id)
        assert second.id == second_id
        assert second.status is ScheduleSolveStatus.succeeded
        assert second.fixtures_placed == 2, "the two semi-finals, and nothing else"
