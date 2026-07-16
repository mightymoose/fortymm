"""The call service (``app.match_calls``): call-ahead pinning inside the
guarded apply, the pin tick, and the exactly-once invariants (ADR "the
schedule is solved; the call is pinned").

Clock control: both call paths read a module-level ``_wall_now`` seam
(``schedule_solves._wall_now`` for the apply, ``match_calls._wall_now`` for
the tick), monkeypatched here to a fixed 2030 wall clock so "imminent" is a
deterministic fact about the fixtures, never about when CI runs.

THE race test stages a pin tick in the gap between a solve's snapshot and its
guarded apply (the ``_solve`` seam — the same gatekeeper harness as
``test_schedule_solve_service``), so tick and apply genuinely contend for the
same imminent fixture. Its falsifications prove both guards are load-bearing:
neutering the fingerprint alone still yields exactly one call (the row-locked
``pinned_at IS NULL`` re-check holds the line), and bypassing *that* re-check
produces the double-notify the guard exists to prevent.
"""

import uuid
from collections.abc import Callable, Sequence
from datetime import datetime, timedelta
from decimal import Decimal

import fakeredis
import pytest
from rq import Queue
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import match_calls, schedule_solves, scheduling
from app import queue as queue_module
from app.leagues import get_default_league
from app.match_calls import (
    RUN_PIN_TICK_JOB,
    enqueue_pin_ticks,
    run_pin_tick,
)
from app.models import (
    DrawType,
    EventFormat,
    Notification,
    NotificationPreference,
    ScheduleSolve,
    ScheduleSolveStatus,
    ScheduleSolveTrigger,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.schedule_solves import RUN_SCHEDULE_SOLVE_JOB, SUPERSEDED_ERROR, request_solve
from app.scheduling import ScheduleSnapshot, SolveResult
from app.schemas.notification import NotificationJob
from app.tournament_draws import cut_draw
from tests._helpers import make_user

DATE = "2030-01-01"
#: The pool window's start — the tournament's minute-frame origin.
BASE = datetime(2030, 1, 1, 9, 0)


@pytest.fixture(autouse=True)
def _job_database(monkeypatch: pytest.MonkeyPatch, postgres_url: str) -> None:
    """The solve job and the pin tick open their own engines from
    ``DATABASE_URL``; point them at the test database."""
    monkeypatch.setenv("DATABASE_URL", postgres_url)


@pytest.fixture
def solver_queue(monkeypatch: pytest.MonkeyPatch) -> Queue:
    """An async (record-only) RQ queue on fakeredis, replacing conftest's
    synchronous one for tests that must commit before a job runs."""
    connection = fakeredis.FakeStrictRedis()
    q = Queue(queue_module.SOLVER_QUEUE, connection=connection, is_async=True)
    monkeypatch.setattr(queue_module, "get_queue", lambda: q)
    return q


async def _make_tournament(
    db: AsyncSession,
    *,
    status: TournamentStatus = TournamentStatus.live,
    entrants: int = 2,
    tables: tuple[str, ...] = ("t1",),
    window: tuple[str, str] = ("09:00", "17:00"),
) -> tuple[uuid.UUID, uuid.UUID]:
    """A tournament with a cut single-pool round-robin draw, defaulting to the
    smallest deterministic shape: 2 entrants on 1 table → exactly one fixture,
    which an optimal solve must place at the window's start."""
    owner = await make_user(db, f"director-{uuid.uuid4().hex[:8]}")
    league = await get_default_league(db)
    assert league is not None, "the autouse default_league fixture seeds this"

    tournament = Tournament(
        name="Called Open",
        status=status,
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
        match_settings={"rated": False, "length_games": 3},
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


async def _the_fixture(db: AsyncSession, event_id: uuid.UUID) -> TournamentFixture:
    return (
        await db.execute(
            select(TournamentFixture)
            .where(TournamentFixture.event_id == event_id)
            .order_by(TournamentFixture.id)
        )
    ).scalar_one()


async def _entrant_user_ids(db: AsyncSession, event_id: uuid.UUID) -> set[uuid.UUID]:
    return set(
        (
            await db.execute(
                select(TournamentEntry.user_id).where(
                    TournamentEntry.event_id == event_id
                )
            )
        )
        .scalars()
        .all()
    )


async def _call_notifications(db: AsyncSession) -> Sequence[Notification]:
    return (
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


async def _place_fixture(
    db: AsyncSession,
    event_id: uuid.UUID,
    *,
    table_id: str,
    start: datetime,
) -> uuid.UUID:
    fixture = await _the_fixture(db, event_id)
    fixture.table_id = table_id
    fixture.scheduled_start = start
    await db.commit()
    return fixture.id


def _fanout_jobs(notifications_queue: Queue) -> list[NotificationJob]:
    return [
        NotificationJob.model_validate_json(job.args[0])
        for job in notifications_queue.jobs
    ]


def _freeze_clocks(monkeypatch: pytest.MonkeyPatch, now: datetime) -> None:
    monkeypatch.setattr(schedule_solves, "_wall_now", lambda: now)
    monkeypatch.setattr(match_calls, "_wall_now", lambda: now)


def _run_recorded_solve(queue: Queue, expected_solve_id: uuid.UUID) -> None:
    job = queue.jobs[0]
    assert job.func_name == RUN_SCHEDULE_SOLVE_JOB
    assert job.args == (str(expected_solve_id),)
    job.func(*job.args)


async def _request_and_run_solve(
    db: AsyncSession, solver_queue: Queue, tournament_id: uuid.UUID
) -> None:
    row = await request_solve(db, tournament_id, ScheduleSolveTrigger.manual)
    assert row is not None
    row_id = row.id
    await db.commit()
    _run_recorded_solve(solver_queue, row_id)
    db.expire_all()


def _hijack_solve(
    monkeypatch: pytest.MonkeyPatch, after_solve: Callable[[], None]
) -> None:
    """Interpose on the ``_solve`` seam: run the real solver, then
    ``after_solve`` — landing work exactly in the gap between the job's
    snapshot and its guarded apply."""
    real = scheduling.solve

    def wrapper(snapshot: ScheduleSnapshot, time_cap_s: float) -> SolveResult:
        result = real(snapshot, time_cap_s=time_cap_s)
        after_solve()
        return result

    monkeypatch.setattr(schedule_solves, "_solve", wrapper)


class TestApplyCallEvaluation:
    async def test_apply_calls_a_fixture_placed_inside_the_window(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A live tournament's solve places the lone fixture at the window
        start == now → the apply calls it in the same transaction: pinned,
        count 1, one persisted in-app notification per entrant with the table
        label + HH:MM in the copy, and a push/email fan-out job per entrant
        enqueued post-commit."""
        tournament_id, event_id = await _make_tournament(db_session)
        _freeze_clocks(monkeypatch, BASE)

        await _request_and_run_solve(db_session, solver_queue, tournament_id)

        fixture = await _the_fixture(db_session, event_id)
        assert fixture.table_id == "t1"
        assert fixture.scheduled_start == BASE
        assert fixture.pinned_at == BASE
        assert fixture.call_notified_count == 1

        entrants = await _entrant_user_ids(db_session, event_id)
        rows = await _call_notifications(db_session)
        assert {row.user_id for row in rows} == entrants
        assert len(rows) == 2
        for row in rows:
            assert row.title == "You're up soon — T1"
            assert "T1" in row.body
            assert "09:00" in row.body
            assert row.link == f"/tournaments/{tournament_id}"

        jobs = _fanout_jobs(fake_notifications_queue)
        assert {job.user_id for job in jobs} == entrants
        assert all(job.channels == ["push", "email"] for job in jobs)
        assert all(job.category == "match_calls" for job in jobs)

    async def test_a_placement_beyond_the_window_is_not_called(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Now is 08:00, the window opens 09:00: the solve places the fixture
        60 minutes out — an estimate, not a call."""
        tournament_id, event_id = await _make_tournament(db_session)
        _freeze_clocks(monkeypatch, BASE - timedelta(minutes=60))

        await _request_and_run_solve(db_session, solver_queue, tournament_id)

        fixture = await _the_fixture(db_session, event_id)
        assert fixture.scheduled_start == BASE  # placed…
        assert fixture.pinned_at is None  # …but not promised
        assert fixture.call_notified_count == 0
        assert await _call_notifications(db_session) == []
        assert fake_notifications_queue.jobs == []

    async def test_a_pre_live_solve_calls_nobody(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Pre-live placements are silent estimates (ADR: free rearranging
        while planning) — a feasibility solve run near the window start must
        not page the players."""
        tournament_id, event_id = await _make_tournament(
            db_session, status=TournamentStatus.published
        )
        _freeze_clocks(monkeypatch, BASE)

        await _request_and_run_solve(db_session, solver_queue, tournament_id)

        fixture = await _the_fixture(db_session, event_id)
        assert fixture.scheduled_start == BASE
        assert fixture.pinned_at is None
        assert fixture.call_notified_count == 0
        assert await _call_notifications(db_session) == []
        assert fake_notifications_queue.jobs == []

    async def test_a_later_solve_leaves_a_called_placement_untouched(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """End-to-end through the service: call a fixture via the tick (at a
        deliberately off-grid start, so any rewrite would be visible), then run
        a full solve — the promise survives byte for byte, the count stays 1,
        and no second notification is sent."""
        tournament_id, event_id = await _make_tournament(db_session)
        off_grid = BASE + timedelta(minutes=7)
        await _place_fixture(db_session, event_id, table_id="t1", start=off_grid)
        _freeze_clocks(monkeypatch, BASE)

        run_pin_tick(str(tournament_id))
        db_session.expire_all()
        called = await _the_fixture(db_session, event_id)
        assert called.pinned_at == BASE
        assert called.call_notified_count == 1
        assert len(await _call_notifications(db_session)) == 2

        await _request_and_run_solve(db_session, solver_queue, tournament_id)

        fixture = await _the_fixture(db_session, event_id)
        assert fixture.table_id == "t1"
        assert fixture.scheduled_start == off_grid
        assert fixture.pinned_at == BASE
        assert fixture.call_notified_count == 1
        assert len(await _call_notifications(db_session)) == 2
        assert len(fake_notifications_queue.jobs) == 2  # the tick's pair, no more

        ledger = (
            await db_session.execute(
                select(ScheduleSolve).where(
                    ScheduleSolve.tournament_id == tournament_id
                )
            )
        ).scalar_one()
        assert ledger.status is ScheduleSolveStatus.succeeded
        assert ledger.fixtures_placed == 0
        assert ledger.fixtures_pinned == 1


class TestPinTick:
    async def test_tick_calls_an_imminent_fixture_exactly_once(
        self,
        db_session: AsyncSession,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """An unpinned fixture 5 minutes out gets called; a second tick — the
        double a second API replica would produce — is a no-op under the
        row-locked ``pinned_at`` guard."""
        tournament_id, event_id = await _make_tournament(db_session)
        start = BASE + timedelta(minutes=5)
        await _place_fixture(db_session, event_id, table_id="t1", start=start)
        _freeze_clocks(monkeypatch, BASE)

        run_pin_tick(str(tournament_id))

        db_session.expire_all()
        fixture = await _the_fixture(db_session, event_id)
        assert fixture.pinned_at == BASE
        assert fixture.call_notified_count == 1
        entrants = await _entrant_user_ids(db_session, event_id)
        rows = await _call_notifications(db_session)
        assert {row.user_id for row in rows} == entrants
        assert len(rows) == 2
        assert all("09:05" in row.body and "T1" in row.body for row in rows)
        assert len(fake_notifications_queue.jobs) == 2

        run_pin_tick(str(tournament_id))

        db_session.expire_all()
        fixture = await _the_fixture(db_session, event_id)
        assert fixture.pinned_at == BASE
        assert fixture.call_notified_count == 1
        assert len(await _call_notifications(db_session)) == 2
        assert len(fake_notifications_queue.jobs) == 2

    async def test_tick_is_a_noop_for_a_non_live_tournament(
        self,
        db_session: AsyncSession,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        tournament_id, event_id = await _make_tournament(
            db_session, status=TournamentStatus.published
        )
        await _place_fixture(
            db_session, event_id, table_id="t1", start=BASE + timedelta(minutes=5)
        )
        _freeze_clocks(monkeypatch, BASE)

        run_pin_tick(str(tournament_id))

        db_session.expire_all()
        fixture = await _the_fixture(db_session, event_id)
        assert fixture.pinned_at is None
        assert fixture.call_notified_count == 0
        assert await _call_notifications(db_session) == []
        assert fake_notifications_queue.jobs == []

    async def test_tick_is_a_noop_with_nothing_imminent(
        self,
        db_session: AsyncSession,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        tournament_id, event_id = await _make_tournament(db_session)
        await _place_fixture(
            db_session, event_id, table_id="t1", start=BASE + timedelta(minutes=30)
        )
        _freeze_clocks(monkeypatch, BASE)

        run_pin_tick(str(tournament_id))

        db_session.expire_all()
        fixture = await _the_fixture(db_session, event_id)
        assert fixture.pinned_at is None
        assert fixture.call_notified_count == 0
        assert await _call_notifications(db_session) == []
        assert fake_notifications_queue.jobs == []

    async def test_tick_respects_a_recipients_in_app_mute(
        self,
        db_session: AsyncSession,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """match_calls is deliberately NOT a locked cell: a player who muted
        the in-app cell gets no persisted row — but the pin, the count, and
        the other entrant's notification are unaffected, and the push/email
        fan-out still goes to both (the worker resolves those prefs)."""
        tournament_id, event_id = await _make_tournament(db_session)
        await _place_fixture(
            db_session, event_id, table_id="t1", start=BASE + timedelta(minutes=5)
        )
        entrants = await _entrant_user_ids(db_session, event_id)
        muted, kept = sorted(entrants)
        db_session.add(
            NotificationPreference(
                user_id=muted, category="match_calls", channel="in_app", enabled=False
            )
        )
        await db_session.commit()
        _freeze_clocks(monkeypatch, BASE)

        run_pin_tick(str(tournament_id))

        db_session.expire_all()
        fixture = await _the_fixture(db_session, event_id)
        assert fixture.pinned_at == BASE
        assert fixture.call_notified_count == 1
        rows = await _call_notifications(db_session)
        assert [row.user_id for row in rows] == [kept]
        assert {job.user_id for job in _fanout_jobs(fake_notifications_queue)} == {
            muted,
            kept,
        }


class TestConcurrentTickAndApply:
    """THE race: a pin tick fires in the gap between a solve's snapshot and
    its guarded apply, both wanting to call the same imminent fixture."""

    async def _staged_race(
        self,
        db_session: AsyncSession,
        monkeypatch: pytest.MonkeyPatch,
    ) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
        """A live tournament whose lone fixture is already placed 5 minutes
        out; a solve is requested, and the tick is staged to run mid-solve.
        Returns without running the job."""
        tournament_id, event_id = await _make_tournament(db_session)
        await _place_fixture(
            db_session, event_id, table_id="t1", start=BASE + timedelta(minutes=5)
        )
        _freeze_clocks(monkeypatch, BASE)
        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()
        _hijack_solve(monkeypatch, after_solve=lambda: run_pin_tick(str(tournament_id)))
        return tournament_id, event_id, row_id

    async def test_concurrent_tick_and_apply_call_exactly_once(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The tick wins the gap and calls the fixture; the apply sees the pin
        set as input drift, discards its whole output, and re-queues — exactly
        one call, exactly one notification pair."""
        tournament_id, event_id, row_id = await self._staged_race(
            db_session, monkeypatch
        )

        _run_recorded_solve(solver_queue, row_id)

        db_session.expire_all()
        fixture = await _the_fixture(db_session, event_id)
        assert fixture.pinned_at == BASE
        assert fixture.call_notified_count == 1
        assert len(await _call_notifications(db_session)) == 2
        assert len(fake_notifications_queue.jobs) == 2

        rows = (
            (
                await db_session.execute(
                    select(ScheduleSolve)
                    .where(ScheduleSolve.tournament_id == tournament_id)
                    .order_by(ScheduleSolve.requested_at, ScheduleSolve.id)
                )
            )
            .scalars()
            .all()
        )
        assert [row.status for row in rows] == [
            ScheduleSolveStatus.failed,
            ScheduleSolveStatus.queued,
        ]
        assert rows[0].error == SUPERSEDED_ERROR

    async def test_the_row_locked_pin_recheck_holds_without_the_fingerprint(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Neuter the fingerprint so the apply proceeds despite the mid-solve
        pin: the second line of defense — re-checking ``pinned_at IS NULL``
        under the fixture's row lock — still yields exactly one call."""
        tournament_id, event_id, row_id = await self._staged_race(
            db_session, monkeypatch
        )
        monkeypatch.setattr(schedule_solves, "_fingerprint", lambda payload: "same")

        _run_recorded_solve(solver_queue, row_id)

        db_session.expire_all()
        fixture = await _the_fixture(db_session, event_id)
        assert fixture.call_notified_count == 1
        assert len(await _call_notifications(db_session)) == 2
        assert len(fake_notifications_queue.jobs) == 2
        ledger = (
            await db_session.execute(
                select(ScheduleSolve).where(ScheduleSolve.id == row_id)
            )
        ).scalar_one()
        assert ledger.status is ScheduleSolveStatus.succeeded

    async def test_falsification_bypassing_the_pin_recheck_double_notifies(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The falsification: with the fingerprint neutered AND the
        ``pinned_at IS NULL`` re-check bypassed, the very same staged race
        double-notifies — proving the green above is the guard's doing, not
        scheduler luck. If this test ever fails, the harness has stopped
        exercising the guard."""
        tournament_id, event_id, row_id = await self._staged_race(
            db_session, monkeypatch
        )
        monkeypatch.setattr(schedule_solves, "_fingerprint", lambda payload: "same")

        def no_pin_guard(fixture: TournamentFixture, now: datetime) -> bool:
            return (  # _due_for_call minus its pinned_at check
                fixture.table_id is not None
                and fixture.scheduled_start is not None
                and fixture.scheduled_start
                <= now + timedelta(minutes=match_calls.CALL_AHEAD_MIN)
                and fixture.entry_a_id is not None
                and fixture.entry_b_id is not None
                and fixture.winner_entry_id is None
            )

        monkeypatch.setattr(match_calls, "_due_for_call", no_pin_guard)

        _run_recorded_solve(solver_queue, row_id)

        db_session.expire_all()
        fixture = await _the_fixture(db_session, event_id)
        assert fixture.call_notified_count == 2  # the double the guard prevents
        assert len(await _call_notifications(db_session)) == 4
        assert len(fake_notifications_queue.jobs) == 4


async def _all_fixtures(
    db: AsyncSession, event_id: uuid.UUID
) -> Sequence[TournamentFixture]:
    return (
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


async def _pin_directly(
    db: AsyncSession,
    fixture: TournamentFixture,
    *,
    table_id: str,
    start: datetime,
    pinned_at: datetime,
    notified: int = 1,
) -> None:
    """Stage an already-called (or pre-live silently pinned) fixture directly
    on the row: the two real pin paths are exercised by the classes above;
    repair tests need exact pre-states."""
    fixture.table_id = table_id
    fixture.scheduled_start = start
    fixture.pinned_at = pinned_at
    fixture.call_notified_count = notified
    await db.commit()


async def _remove_table(
    db: AsyncSession,
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    table_id: str,
    *,
    from_catalogue: bool = True,
    from_pools: bool = True,
) -> None:
    """Simulate the director's settings writes that break a placement's table,
    directly on the models: drop it from the tournament's catalogue and/or
    from every pool's ``table_ids``."""
    if from_catalogue:
        tournament = (
            await db.execute(select(Tournament).where(Tournament.id == tournament_id))
        ).scalar_one()
        tournament.table_catalogue = [
            table for table in tournament.table_catalogue if table["id"] != table_id
        ]
    if from_pools:
        event = (
            await db.execute(
                select(TournamentEvent).where(TournamentEvent.id == event_id)
            )
        ).scalar_one()
        event.pools = [
            {
                **pool,
                "table_ids": [t for t in pool["table_ids"] if t != table_id],
            }
            for pool in event.pools
        ]
    await db.commit()


async def _users_for_entries(
    db: AsyncSession, entry_ids: Sequence[uuid.UUID | None]
) -> set[uuid.UUID]:
    return set(
        (
            await db.execute(
                select(TournamentEntry.user_id).where(
                    TournamentEntry.id.in_([e for e in entry_ids if e is not None])
                )
            )
        )
        .scalars()
        .all()
    )


async def _usernames(
    db: AsyncSession, user_ids: set[uuid.UUID]
) -> dict[uuid.UUID, str]:
    return {
        user.id: user.username
        for user in (await db.execute(select(User).where(User.id.in_(user_ids))))
        .scalars()
        .all()
    }


class TestBrokenPinRepair:
    """Chore 3c: pins are inviolable against optimization, not against
    physics. A pinned fixture whose table left the venue is re-placed by the
    next solve and STAYS a pin (renewed, moved-notified); a pinned fixture
    whose entrant withdrew is voided (placement cleared, the remaining
    entrant cancelled-notified). Planned fixtures re-plan silently; pre-live
    repairs are silent; untouched pins stay byte-identical."""

    async def test_a_removed_catalogue_table_moved_correction_and_untouched_control_pin(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The called match's table vanishes from the catalogue (and, as the
        settings flow does, from the pool) → the next solve re-places the
        fixture on a surviving table, still pinned with ``pinned_at``
        refreshed, count 1→2, exactly one moved notification per entrant
        carrying the NEW table label — while a healthy pinned control fixture
        in the very same solve does not move a byte and re-notifies nobody."""
        tournament_id, event_id = await _make_tournament(
            db_session, entrants=4, tables=("t1", "t2", "t3")
        )
        fixtures = await _all_fixtures(db_session, event_id)
        target = fixtures[0]
        control = next(
            f
            for f in fixtures
            if not (
                {f.entry_a_id, f.entry_b_id} & {target.entry_a_id, target.entry_b_id}
            )
        )
        original_pin_time = BASE - timedelta(minutes=15)
        await _pin_directly(
            db_session,
            target,
            table_id="t1",
            start=BASE,
            pinned_at=original_pin_time,
        )
        await _pin_directly(
            db_session,
            control,
            table_id="t2",
            start=BASE,
            pinned_at=original_pin_time,
        )
        await _remove_table(db_session, tournament_id, event_id, "t1")
        now = BASE - timedelta(minutes=60)
        _freeze_clocks(monkeypatch, now)

        await _request_and_run_solve(db_session, solver_queue, tournament_id)

        await db_session.refresh(target)
        await db_session.refresh(control)
        assert target.table_id in {"t2", "t3"}  # re-placed on a survivor
        assert target.scheduled_start is not None
        assert target.scheduled_start >= BASE
        assert target.pinned_at == now  # the promise is renewed, not demoted
        assert target.call_notified_count == 2

        # The untouched pin: byte-identical, no re-notification.
        assert control.table_id == "t2"
        assert control.scheduled_start == BASE
        assert control.pinned_at == original_pin_time
        assert control.call_notified_count == 1

        target_users = await _users_for_entries(
            db_session, [target.entry_a_id, target.entry_b_id]
        )
        rows = await _call_notifications(db_session)
        assert len(rows) == 2  # target's pair and nothing else
        assert {row.user_id for row in rows} == target_users
        new_label = target.table_id.upper()
        for row in rows:
            assert row.title == f"Your match moved to {new_label}"
            assert new_label in row.body
            assert target.scheduled_start.strftime("%H:%M") in row.body
        jobs = _fanout_jobs(fake_notifications_queue)
        assert {job.user_id for job in jobs} == target_users
        assert all(job.collapse_id == f"match-call:{target.id}" for job in jobs)

        ledger = (
            await db_session.execute(
                select(ScheduleSolve).where(
                    ScheduleSolve.tournament_id == tournament_id
                )
            )
        ).scalar_one()
        assert ledger.status is ScheduleSolveStatus.succeeded
        assert ledger.fixtures_placed == 5  # 4 plans + the repaired pin
        assert ledger.fixtures_pinned == 1  # the control's verbatim echo

    async def test_a_table_dropped_from_the_pool_gets_the_same_moved_correction(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The other flavor of a broken table: still in the venue catalogue,
        no longer in the fixture's pool's ``table_ids`` — same repair path."""
        tournament_id, event_id = await _make_tournament(
            db_session, tables=("t1", "t2")
        )
        fixture = await _the_fixture(db_session, event_id)
        await _pin_directly(
            db_session,
            fixture,
            table_id="t1",
            start=BASE + timedelta(minutes=5),
            pinned_at=BASE - timedelta(minutes=5),
        )
        await _remove_table(
            db_session, tournament_id, event_id, "t1", from_catalogue=False
        )
        _freeze_clocks(monkeypatch, BASE)

        await _request_and_run_solve(db_session, solver_queue, tournament_id)

        await db_session.refresh(fixture)
        assert fixture.table_id == "t2"
        assert fixture.scheduled_start == BASE
        assert fixture.pinned_at == BASE
        assert fixture.call_notified_count == 2
        rows = await _call_notifications(db_session)
        assert len(rows) == 2
        assert all(row.title == "Your match moved to T2" for row in rows)
        assert len(_fanout_jobs(fake_notifications_queue)) == 2

    async def test_the_moved_correction_copy_renders_the_new_table_label_and_time(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The moved sentence names the NEW table and HH:MM — asserted whole,
        per recipient, with the opponent's name."""
        tournament_id, event_id = await _make_tournament(
            db_session, tables=("t1", "t2")
        )
        fixture = await _the_fixture(db_session, event_id)
        await _pin_directly(
            db_session,
            fixture,
            table_id="t1",
            start=BASE + timedelta(minutes=5),
            pinned_at=BASE - timedelta(minutes=5),
        )
        await _remove_table(db_session, tournament_id, event_id, "t1")
        _freeze_clocks(monkeypatch, BASE)

        await _request_and_run_solve(db_session, solver_queue, tournament_id)

        await db_session.refresh(fixture)
        assert fixture.table_id == "t2"
        assert fixture.scheduled_start == BASE  # 09:00 on the survivor
        entrants = await _entrant_user_ids(db_session, event_id)
        usernames = await _usernames(db_session, entrants)
        rows = await _call_notifications(db_session)
        assert len(rows) == 2
        for row in rows:
            (opponent_id,) = entrants - {row.user_id}
            assert row.title == "Your match moved to T2"
            assert row.body == (
                "Your Called Open · Open Singles · Pool A match against "
                f"{usernames[opponent_id]} now starts around 09:00 on T2."
            )

    async def test_a_withdrawal_sends_cancelled_to_the_remaining_entrant_only(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """An entrant of a called match withdraws → the next solve voids the
        promise: placement and pin cleared, one cancelled notification to the
        REMAINING entrant only (the withdrawn player asked to leave — their
        own flow was their feedback), naming the opponent who withdrew."""
        tournament_id, event_id = await _make_tournament(db_session)
        fixture = await _the_fixture(db_session, event_id)
        await _pin_directly(
            db_session,
            fixture,
            table_id="t1",
            start=BASE + timedelta(minutes=5),
            pinned_at=BASE - timedelta(minutes=5),
        )
        assert fixture.entry_a_id is not None and fixture.entry_b_id is not None
        (withdrawn_user,) = await _users_for_entries(db_session, [fixture.entry_a_id])
        (remaining_user,) = await _users_for_entries(db_session, [fixture.entry_b_id])
        withdrawn_entry = (
            await db_session.execute(
                select(TournamentEntry).where(TournamentEntry.id == fixture.entry_a_id)
            )
        ).scalar_one()
        withdrawn_entry.status = TournamentEntryStatus.withdrawn
        await db_session.commit()
        _freeze_clocks(monkeypatch, BASE)

        await _request_and_run_solve(db_session, solver_queue, tournament_id)

        await db_session.refresh(fixture)
        assert fixture.table_id is None
        assert fixture.scheduled_start is None
        assert fixture.pinned_at is None
        assert fixture.call_notified_count == 2  # the call, then the correction
        rows = await _call_notifications(db_session)
        assert [row.user_id for row in rows] == [remaining_user]
        usernames = await _usernames(db_session, {withdrawn_user})
        assert rows[0].title == "Your match was cancelled"
        assert "your opponent withdrew" in rows[0].body
        assert usernames[withdrawn_user] in rows[0].body
        jobs = _fanout_jobs(fake_notifications_queue)
        assert [job.user_id for job in jobs] == [remaining_user]

        ledger = (
            await db_session.execute(
                select(ScheduleSolve).where(
                    ScheduleSolve.tournament_id == tournament_id
                )
            )
        ).scalar_one()
        assert ledger.status is ScheduleSolveStatus.succeeded
        assert ledger.fixtures_placed == 0
        assert ledger.fixtures_pinned == 0

    async def test_a_planned_fixture_on_a_removed_table_gets_no_moved_or_cancelled(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Repairs are for promises. A merely *planned* (unpinned) fixture on
        a removed table is silently re-placed — it was never promised, so
        nobody is told anything."""
        tournament_id, event_id = await _make_tournament(
            db_session, tables=("t1", "t2")
        )
        await _place_fixture(
            db_session, event_id, table_id="t2", start=BASE + timedelta(minutes=60)
        )
        await _remove_table(db_session, tournament_id, event_id, "t2")
        _freeze_clocks(monkeypatch, BASE - timedelta(minutes=60))

        await _request_and_run_solve(db_session, solver_queue, tournament_id)

        fixture = await _the_fixture(db_session, event_id)
        assert fixture.table_id == "t1"
        assert fixture.scheduled_start == BASE
        assert fixture.pinned_at is None
        assert fixture.call_notified_count == 0
        assert await _call_notifications(db_session) == []
        assert fake_notifications_queue.jobs == []

    async def test_a_pre_live_broken_pin_is_repaired_but_no_moved_correction_is_sent(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Pre-live pins are silent (free rearranging while planning — ADR),
        so their repairs are too: the placement is rewritten and the pin
        renewed, but the count stays untouched and nobody is notified."""
        tournament_id, event_id = await _make_tournament(
            db_session, status=TournamentStatus.published, tables=("t1", "t2")
        )
        fixture = await _the_fixture(db_session, event_id)
        await _pin_directly(
            db_session,
            fixture,
            table_id="t1",
            start=BASE + timedelta(minutes=5),
            pinned_at=BASE - timedelta(minutes=15),
            notified=0,  # a silent pre-live pin was never announced
        )
        await _remove_table(db_session, tournament_id, event_id, "t1")
        _freeze_clocks(monkeypatch, BASE)

        await _request_and_run_solve(db_session, solver_queue, tournament_id)

        await db_session.refresh(fixture)
        assert fixture.table_id == "t2"
        assert fixture.scheduled_start == BASE
        assert fixture.pinned_at == BASE  # repaired and renewed…
        assert fixture.call_notified_count == 0  # …but nobody was told
        assert await _call_notifications(db_session) == []
        assert fake_notifications_queue.jobs == []


class TestTickEnqueueSelection:
    async def test_enqueues_one_tick_per_live_tournament(
        self, db_session: AsyncSession, solver_queue: Queue
    ) -> None:
        """The lifespan loop's testable core: live tournaments each get a
        ``run_pin_tick`` job on the solver queue; draft/published/archived get
        nothing."""
        live_id, _ = await _make_tournament(db_session)
        await _make_tournament(db_session, status=TournamentStatus.published)
        await _make_tournament(db_session, status=TournamentStatus.draft)

        enqueued = await enqueue_pin_ticks(db_session)

        assert enqueued == [live_id]
        assert [job.func_name for job in solver_queue.jobs] == [RUN_PIN_TICK_JOB]
        assert solver_queue.jobs[0].args == (str(live_id),)
