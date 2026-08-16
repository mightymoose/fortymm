"""The call service (``app.match_calls``): call-ahead pinning inside the
guarded apply, the pin tick, and the exactly-once invariants (ADR "the
schedule is solved; the call is pinned").

Clock control: both call paths read a module-level ``_wall_now`` seam
(``schedule_solves._wall_now`` for the apply, ``match_calls._wall_now`` for
the tick), monkeypatched here to a fixed 2030 wall clock so "imminent" is a
deterministic fact about the fixtures, never about when CI runs.

THE race tests stage a pin tick in the gap between a solve's snapshot and its
guarded apply (the ``_solve`` seam — the same gatekeeper harness as
``test_schedule_solve_service``), so tick and apply genuinely contend for the
same imminent fixture. The falsifications prove the guards are load-bearing:
neutering the fingerprint alone still yields exactly one call (the row-locked
``pinned_at IS NULL`` re-check holds the line), and bypassing *that* re-check
produces the double-notify the guard exists to prevent. The silent-pin race
runs the same play for the notify-without-re-pin transition (a pre-live
silent pin delivered late), where the row-locked ``call_notified_count == 0``
re-check is the ONLY guard — the fingerprint deliberately excludes the count.
"""

import uuid
from collections.abc import Sequence
from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

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
    Match,
    MatchGame,
    MatchGameScore,
    MatchResult,
    MatchSettings,
    MatchStatus,
    Notification,
    NotificationPreference,
    ScheduleSolve,
    ScheduleSolveStatus,
    ScheduleSolveTrigger,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentFixture,
    TournamentStatus,
    User,
    VenueTable,
)
from app.schedule_solves import RUN_SCHEDULE_SOLVE_JOB, SUPERSEDED_ERROR, request_solve
from app.schemas.notification import NotificationJob
from app.tournament_draws import cut_draw
from app.tournament_event_stages import mint_stages
from app.tournament_queries import stage_ids_for_events, stage_ids_for_tournament
from tests._helpers import (
    event_pools,
    hijack_solve,
    make_user,
    venue_tables,
)

DATE = "2030-01-01"
#: The event's venue timezone — the IANA zone that anchors its wall-clock pool
#: windows (and manual placements) to real instants (ADR "tournament times are
#: timezone-aware instants"). Every clock in this module is aware in this frame.
VENUE_TZ = ZoneInfo("America/Chicago")
#: The pool window's start — the tournament's minute-frame origin — as a
#: timezone-aware instant in the venue frame (``09:00`` local on ``DATE``).
BASE = datetime(2030, 1, 1, 9, 0, tzinfo=VENUE_TZ)


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

    catalogue = venue_tables(*((table.upper(), "Main") for table in tables))
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
        slot={"date": DATE, "start": window[0], "end": window[1]},
        match_settings={"rated": False, "length_games": 3},
        stages=stages,
    )
    stages[0].groups = event_pools(
        [
            {
                "name": "Pool A",
                "slot": {"date": DATE, "start": window[0], "end": window[1]},
                "table_ids": [str(row.id) for row in catalogue],
            }
        ],
        event=event,
        tournament=tournament,
    )
    db.add(event)
    await db.flush()
    # ``TournamentEvent.pools`` is a VIEWONLY association through the event's stage now
    # (ADR 20260815) — populated on QUERY, not on construction. ``cut_draw`` below
    # reads ``event.groups`` synchronously, so this freshly built (never re-queried)
    # object needs an explicit refresh first, or that read is an async lazy load.
    await db.refresh(event, attribute_names=["groups"])

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
            .where(TournamentFixture.stage_id.in_(stage_ids_for_events([event_id])))
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


async def _table(db: AsyncSession, event_id: uuid.UUID, alias: str) -> str:
    """``"t1"`` → the id of the FIRST table in this event's tournament's catalogue.

    A table's id is a server-minted UUID now (ADR 20260801), so a placement cannot
    spell one as a literal. These tests are about which *table* a fixture sits on, so
    they keep naming it positionally and resolve here — 1-based, in catalogue order,
    matching the ``tables=("t1", "t2")`` argument ``_make_tournament`` labels them
    from."""
    ids = (
        (
            await db.execute(
                select(VenueTable.id)
                .join(
                    TournamentEvent,
                    TournamentEvent.tournament_id == VenueTable.tournament_id,
                )
                .where(TournamentEvent.id == event_id)
                .order_by(VenueTable.position)
            )
        )
        .scalars()
        .all()
    )
    return str(ids[int(alias.removeprefix("t")) - 1])


async def _place_fixture(
    db: AsyncSession,
    event_id: uuid.UUID,
    *,
    table_id: str,
    start: datetime,
) -> uuid.UUID:
    """``table_id`` is a positional alias (``"t1"``), resolved by :func:`_table`."""
    fixture = await _the_fixture(db, event_id)
    fixture.table_id = await _table(db, event_id, table_id)
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
        assert fixture.table_id == await _table(db_session, event_id, "t1")
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

    async def test_apply_notifies_a_silent_pin_without_re_pinning(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The notify-without-re-pin transition through the guarded apply: the
        solve echoes the silent pin verbatim (``fixtures_pinned``, not
        placed), and the apply's call evaluation delivers the owed
        *match_called* — count 0 → 1 — with ``pinned_at`` and the off-grid
        placement byte-identical."""
        tournament_id, event_id = await _make_tournament(db_session)
        fixture = await _the_fixture(db_session, event_id)
        silent_pin_time = BASE - timedelta(minutes=45)
        start = BASE + timedelta(minutes=7)  # off-grid: a rewrite would show
        await _pin_directly(
            db_session,
            fixture,
            table_id="t1",
            start=start,
            pinned_at=silent_pin_time,
            notified=0,  # a silent pre-live pin was never announced
        )
        _freeze_clocks(monkeypatch, BASE)

        await _request_and_run_solve(db_session, solver_queue, tournament_id)

        fixture = await _the_fixture(db_session, event_id)
        assert fixture.table_id == await _table(db_session, event_id, "t1")
        assert fixture.scheduled_start == start
        assert fixture.pinned_at == silent_pin_time  # the promise, untouched
        assert fixture.call_notified_count == 1  # …finally delivered
        entrants = await _entrant_user_ids(db_session, event_id)
        rows = await _call_notifications(db_session)
        assert {row.user_id for row in rows} == entrants
        assert len(rows) == 2
        assert all(row.title == "You're up soon — T1" for row in rows)
        assert {job.user_id for job in _fanout_jobs(fake_notifications_queue)} == (
            entrants
        )

        ledger = (
            await db_session.execute(
                select(ScheduleSolve).where(
                    ScheduleSolve.tournament_id == tournament_id
                )
            )
        ).scalar_one()
        assert ledger.status is ScheduleSolveStatus.succeeded
        assert ledger.fixtures_placed == 0
        assert ledger.fixtures_pinned == 1  # echoed verbatim, never rewritten

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
        assert fixture.table_id == await _table(db_session, event_id, "t1")
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

    async def test_tick_notifies_a_silent_pin_without_re_pinning(
        self,
        db_session: AsyncSession,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The notify-without-re-pin transition: a silent pin (pinned
        pre-live, players never told, count 0) whose start enters the window
        on a live tournament gets the *match_called* it was owed — count
        0 → 1, one notification per entrant — while ``pinned_at`` and the
        (deliberately off-grid) placement stay byte-identical. A second tick
        is a no-op under the row-locked count re-check."""
        tournament_id, event_id = await _make_tournament(db_session)
        fixture = await _the_fixture(db_session, event_id)
        silent_pin_time = BASE - timedelta(minutes=45)
        start = BASE + timedelta(minutes=7)  # off-grid: a rewrite would show
        await _pin_directly(
            db_session,
            fixture,
            table_id="t1",
            start=start,
            pinned_at=silent_pin_time,
            notified=0,  # a silent pre-live pin was never announced
        )
        _freeze_clocks(monkeypatch, BASE)

        run_pin_tick(str(tournament_id))

        db_session.expire_all()
        fixture = await _the_fixture(db_session, event_id)
        assert fixture.table_id == await _table(db_session, event_id, "t1")
        assert fixture.scheduled_start == start  # the placement is untouched…
        assert fixture.pinned_at == silent_pin_time  # …and so is the pin
        assert fixture.call_notified_count == 1
        entrants = await _entrant_user_ids(db_session, event_id)
        rows = await _call_notifications(db_session)
        assert {row.user_id for row in rows} == entrants
        assert len(rows) == 2
        assert all(
            row.title == "You're up soon — T1" and "09:07" in row.body for row in rows
        )
        assert len(fake_notifications_queue.jobs) == 2

        run_pin_tick(str(tournament_id))

        db_session.expire_all()
        fixture = await _the_fixture(db_session, event_id)
        assert fixture.pinned_at == silent_pin_time
        assert fixture.call_notified_count == 1
        assert len(await _call_notifications(db_session)) == 2
        assert len(fake_notifications_queue.jobs) == 2

    async def test_tick_does_not_renotify_a_told_pin(
        self,
        db_session: AsyncSession,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A pinned fixture whose players WERE told (count > 0) is not the
        call pass's business, however imminent: only a broken-pin correction
        or the director's hand may re-notify it."""
        tournament_id, event_id = await _make_tournament(db_session)
        fixture = await _the_fixture(db_session, event_id)
        await _pin_directly(
            db_session,
            fixture,
            table_id="t1",
            start=BASE + timedelta(minutes=5),
            pinned_at=BASE - timedelta(minutes=5),
            notified=1,
        )
        _freeze_clocks(monkeypatch, BASE)

        run_pin_tick(str(tournament_id))

        db_session.expire_all()
        fixture = await _the_fixture(db_session, event_id)
        assert fixture.pinned_at == BASE - timedelta(minutes=5)
        assert fixture.call_notified_count == 1
        assert await _call_notifications(db_session) == []
        assert fake_notifications_queue.jobs == []

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


class TestResourceFreedomGate:
    """The #1106 gate (ADR "a tournament match is called only when its table
    and players are free"): the caller never starts a match onto a table or a
    human already held by an unfinished ``in_progress`` match — two started
    matches on one resource are two overlapping fixed intervals that wedge the
    next solve ``infeasible``. Players are held at the **user** level, across
    events. Within one pass at most one fixture is called per table and per
    user, the earliest predicted start winning a contested resource."""

    async def test_a_due_fixture_on_a_held_table_is_not_called(
        self,
        db_session: AsyncSession,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A fixture placed imminently on a table an ``in_progress`` match
        already occupies is NOT called — even though its own players are free
        (disjoint from the running match's)."""
        tournament_id, event_id = await _make_tournament(
            db_session, entrants=4, tables=("t1", "t2")
        )
        fixtures = await _all_fixtures(db_session, event_id)
        held = fixtures[0]
        due = next(
            f
            for f in fixtures
            if not ({f.entry_a_id, f.entry_b_id} & {held.entry_a_id, held.entry_b_id})
        )
        # The running match: called (told), live, occupying t1.
        await _pin_directly(
            db_session,
            held,
            table_id="t1",
            start=BASE - timedelta(minutes=5),
            pinned_at=BASE - timedelta(minutes=10),
            notified=1,
        )
        await _link_match(
            db_session, tournament_id, held, status=MatchStatus.in_progress
        )
        # The successor: same table, imminent, untold → due, but t1 is held.
        due.table_id = await _table(db_session, event_id, "t1")
        due.scheduled_start = BASE + timedelta(minutes=5)
        due_id = due.id
        await db_session.commit()
        _freeze_clocks(monkeypatch, BASE)

        run_pin_tick(str(tournament_id))

        db_session.expire_all()
        blocked = await db_session.get(TournamentFixture, due_id)
        assert blocked is not None
        assert blocked.pinned_at is None  # the table was busy — not called
        assert blocked.call_notified_count == 0
        assert await _call_notifications(db_session) == []
        assert fake_notifications_queue.jobs == []

    async def test_a_due_fixture_whose_player_is_live_in_another_event_is_not_called(
        self,
        db_session: AsyncSession,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A player is one human across events (user-level, like the solver's
        no-double-booking): a fixture whose entrant is already in an
        ``in_progress`` match in a *different* event of the same tournament —
        a different entry, same user — is NOT called, though its own table is
        free."""
        tournament_id, event_id = await _make_tournament(
            db_session, tables=("t1", "t2")
        )
        fixture = await _the_fixture(db_session, event_id)
        fixture.table_id = await _table(db_session, event_id, "t1")
        fixture.scheduled_start = BASE + timedelta(minutes=5)  # imminent, untold
        fixture_id = fixture.id
        await db_session.commit()
        (shared_user,) = await _users_for_entries(db_session, [fixture.entry_a_id])

        # A second event of the SAME tournament, with an in_progress match on a
        # different table (t2) whose entrant is the same human.
        await _hold_user_in_second_event(
            db_session,
            tournament_id,
            held_user=shared_user,
            table_id=await _table(db_session, event_id, "t2"),
        )
        _freeze_clocks(monkeypatch, BASE)

        run_pin_tick(str(tournament_id))

        db_session.expire_all()
        blocked = await db_session.get(TournamentFixture, fixture_id)
        assert blocked is not None
        assert blocked.pinned_at is None  # the human is mid-match elsewhere
        assert blocked.call_notified_count == 0
        assert await _call_notifications(db_session) == []
        assert fake_notifications_queue.jobs == []

    async def test_a_fixture_with_a_free_table_and_free_players_is_still_called(
        self,
        db_session: AsyncSession,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """No over-blocking: even with another match running (a different
        table, different humans), a fixture whose own table AND both players
        are free is called normally."""
        tournament_id, event_id = await _make_tournament(
            db_session, entrants=4, tables=("t1", "t2")
        )
        fixtures = await _all_fixtures(db_session, event_id)
        held = fixtures[0]
        free = next(
            f
            for f in fixtures
            if not ({f.entry_a_id, f.entry_b_id} & {held.entry_a_id, held.entry_b_id})
        )
        # A running match on t1 with its own (disjoint) players.
        await _pin_directly(
            db_session,
            held,
            table_id="t1",
            start=BASE - timedelta(minutes=5),
            pinned_at=BASE - timedelta(minutes=10),
            notified=1,
        )
        await _link_match(
            db_session, tournament_id, held, status=MatchStatus.in_progress
        )
        # The free fixture: t2, imminent, untold, players free.
        free.table_id = await _table(db_session, event_id, "t2")
        free.scheduled_start = BASE + timedelta(minutes=5)
        free_id = free.id
        free_users = await _users_for_entries(
            db_session, [free.entry_a_id, free.entry_b_id]
        )
        await db_session.commit()
        _freeze_clocks(monkeypatch, BASE)

        run_pin_tick(str(tournament_id))

        db_session.expire_all()
        called = await db_session.get(TournamentFixture, free_id)
        assert called is not None
        assert called.pinned_at == BASE  # free of the running match → called
        assert called.call_notified_count == 1
        rows = await _call_notifications(db_session)
        assert {row.user_id for row in rows} == free_users
        assert len(rows) == 2

    async def test_two_due_fixtures_for_one_player_call_only_the_earlier(
        self,
        db_session: AsyncSession,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Two fixtures come due in one pass for a resource (here a shared
        human) that started the pass free: only the earlier predicted start is
        called; the later defers to a later pass. Guards the degenerate case
        the cross-batch occupancy read can't see."""
        tournament_id, event_id = await _make_tournament(
            db_session, entrants=4, tables=("t1", "t2")
        )
        fixtures = await _all_fixtures(db_session, event_id)
        earlier = fixtures[0]
        shared = {earlier.entry_a_id, earlier.entry_b_id}
        # A second fixture sharing exactly one entrant (one human) with the first.
        later = next(
            f for f in fixtures if len({f.entry_a_id, f.entry_b_id} & shared) == 1
        )
        earlier.table_id = await _table(db_session, event_id, "t1")
        earlier.scheduled_start = BASE  # the earlier predicted start
        later.table_id = await _table(db_session, event_id, "t2")
        later.scheduled_start = BASE + timedelta(minutes=2)
        earlier_id, later_id = earlier.id, later.id
        await db_session.commit()
        _freeze_clocks(monkeypatch, BASE)

        run_pin_tick(str(tournament_id))

        db_session.expire_all()
        won = await db_session.get(TournamentFixture, earlier_id)
        deferred = await db_session.get(TournamentFixture, later_id)
        assert won is not None and deferred is not None
        assert won.pinned_at == BASE  # earliest start wins the shared human
        assert won.call_notified_count == 1
        assert deferred.pinned_at is None  # the later one defers
        assert deferred.call_notified_count == 0
        # Exactly the earlier fixture's pair was told.
        assert len(await _call_notifications(db_session)) == 2

    async def test_a_full_disjoint_round_is_all_called_in_one_pass(
        self,
        db_session: AsyncSession,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A normal simultaneous round — several due fixtures that are mutually
        disjoint (distinct tables AND distinct players, nothing yet
        ``in_progress``) — is called in FULL in one pass: the greedy claim loop
        admits every fixture, none starved. Guards against a regression where
        the loop over-claims a free round and under-calls it."""
        tournament_id, event_id = await _make_tournament(
            db_session, entrants=6, tables=("t1", "t2", "t3")
        )
        fixtures = await _all_fixtures(db_session, event_id)
        # A perfect matching over the six players: three fixtures whose entrants
        # are pairwise disjoint (round-robin always yields one).
        chosen: list[TournamentFixture] = []
        claimed_entries: set[uuid.UUID | None] = set()
        for fixture in fixtures:
            pair = {fixture.entry_a_id, fixture.entry_b_id}
            if pair & claimed_entries:
                continue
            chosen.append(fixture)
            claimed_entries |= pair
            if len(chosen) == 3:
                break
        assert len(chosen) == 3, "round-robin over 6 players has a disjoint triple"
        # Each on its own table, all imminent, all untold → a full due round.
        chosen_ids: list[uuid.UUID] = []
        for offset, (fixture, table) in enumerate(
            zip(chosen, ("t1", "t2", "t3"), strict=True)
        ):
            fixture.table_id = await _table(db_session, event_id, table)
            fixture.scheduled_start = BASE + timedelta(minutes=offset)
            chosen_ids.append(fixture.id)
        expected_users = await _users_for_entries(
            db_session,
            [
                entry_id
                for fixture in chosen
                for entry_id in (fixture.entry_a_id, fixture.entry_b_id)
            ],
        )
        await db_session.commit()
        _freeze_clocks(monkeypatch, BASE)

        run_pin_tick(str(tournament_id))

        db_session.expire_all()
        for fixture_id in chosen_ids:
            called = await db_session.get(TournamentFixture, fixture_id)
            assert called is not None
            assert called.pinned_at == BASE  # every disjoint fixture called
            assert called.call_notified_count == 1
        rows = await _call_notifications(db_session)
        assert len(rows) == 6  # two entrants per fixture, all three called
        assert {row.user_id for row in rows} == expected_users


async def _hold_user_in_second_event(
    db: AsyncSession,
    tournament_id: uuid.UUID,
    *,
    held_user: uuid.UUID,
    table_id: str,
) -> uuid.UUID:
    """Add a second event to the tournament whose ``in_progress`` match holds
    ``held_user`` (a different entry, same human) on ``table_id`` — the
    cross-event occupancy the user-level gate must see. Returns the fixture id."""
    tournament = await db.get(Tournament, tournament_id)
    assert tournament is not None
    stages = mint_stages(DrawType.round_robin)
    event = TournamentEvent(
        tournament_id=tournament_id,
        name="Consolation Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.round_robin),
        max_players=None,
        entry_fee=Decimal("0.00"),
        timezone="America/Chicago",
        slot={"date": DATE, "start": "09:00", "end": "17:00"},
        match_settings={"rated": False, "length_games": 3},
        stages=stages,
    )
    stages[0].groups = event_pools(
        [
            {
                "name": "Pool B",
                "slot": {"date": DATE, "start": "09:00", "end": "17:00"},
                "table_ids": [table_id],
            }
        ],
        event=event,
        tournament=tournament,
    )
    db.add(event)
    await db.flush()
    other = await make_user(db, f"other-{uuid.uuid4().hex[:8]}")
    entry_held = TournamentEntry(event_id=event.id, user_id=held_user)
    entry_other = TournamentEntry(event_id=event.id, user_id=other.id)
    db.add_all([entry_held, entry_other])
    await db.flush()
    match = Match(
        match_settings=MatchSettings(team_size=1, best_of=3, affects_rating=False),
        league_id=tournament.league_id,
        created_by_user_id=tournament.created_by_user_id,
        status=MatchStatus.in_progress,
    )
    db.add(match)
    await db.flush()
    fixture = TournamentFixture(
        stage_id=stages[0].id,
        round=1,
        position=1,
        entry_a_id=entry_held.id,
        entry_b_id=entry_other.id,
        table_id=table_id,
        scheduled_start=BASE - timedelta(minutes=5),
        pinned_at=BASE - timedelta(minutes=10),
        call_notified_count=1,
        match_id=match.id,
    )
    db.add(fixture)
    await db.commit()
    return fixture.id


async def _in_progress_count_by_user(
    db: AsyncSession, tournament_id: uuid.UUID
) -> dict[uuid.UUID, int]:
    """How many ``in_progress`` matches each human currently holds across the
    tournament's events — the double-booking the #1106 gate exists to prevent.
    Counts by **user** (the entry→user resolution the gate and the solver both
    use), so the same human in two events counts twice."""
    rows = (
        await db.execute(
            select(TournamentFixture.entry_a_id, TournamentFixture.entry_b_id)
            .join(Match, Match.id == TournamentFixture.match_id)
            .where(
                TournamentFixture.stage_id.in_(stage_ids_for_tournament(tournament_id)),
                Match.status == MatchStatus.in_progress,
            )
        )
    ).all()
    entry_ids = {e for a, b in rows for e in (a, b) if e is not None}
    entry_user = {
        entry_id: user_id
        for entry_id, user_id in (
            await db.execute(
                select(TournamentEntry.id, TournamentEntry.user_id).where(
                    TournamentEntry.id.in_(entry_ids)
                )
            )
        ).all()
    }
    counts: dict[uuid.UUID, int] = {}
    for entry_a_id, entry_b_id in rows:
        for entry_id in (entry_a_id, entry_b_id):
            if entry_id is not None:
                user_id = entry_user[entry_id]
                counts[user_id] = counts.get(user_id, 0) + 1
    return counts


async def _complete_linked_match(
    db: AsyncSession,
    match_id: uuid.UUID,
    fixture_id: uuid.UUID,
    *,
    winner_entry_id: uuid.UUID,
    completed_at: datetime,
) -> None:
    """Finish a called (``in_progress``) match: flip its status to
    ``completed`` and record the winner + completion stamp — the real
    match-completion boundary, which frees the table and both humans for the
    next call pass (``_held_resources`` reads only ``in_progress``)."""
    match = await db.get(Match, match_id)
    assert match is not None
    match.status = MatchStatus.completed
    match.completed_at = completed_at
    fixture = await db.get(TournamentFixture, fixture_id)
    assert fixture is not None
    fixture.winner_entry_id = winner_entry_id
    await db.commit()


class TestIdleTournamentWedgeIsGone:
    """Acceptance test for the #1106 UAT report (ADR "a tournament match is
    called only when its table and players are free"): a live tournament whose
    round-1 matches were called but never scored must NOT wedge when round-2
    fixtures age into the call window. Pre-1a, the caller called a round-2
    fixture onto a human already ``in_progress`` in round 1 → two overlapping
    fixed intervals for that human → the next solve returned ``infeasible`` and
    the tournament sat idle forever. Driven end-to-end through the real caller
    (``run_pin_tick``), the guarded pin write, and a real snapshot+solve."""

    async def test_the_1106_idle_tournament_wedge_cannot_recur(
        self,
        db_session: AsyncSession,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # A live round-robin (5 humans, 3 tables) — enough that a human has a
        # round-1 match AND a distinct round-2 match, the shape the UAT report
        # hit.
        tournament_id, event_id = await _make_tournament(
            db_session, entrants=5, tables=("t1", "t2", "t3")
        )
        fixtures = await _all_fixtures(db_session, event_id)

        # Two disjoint round-1 fixtures, and a round-2 fixture that shares
        # exactly ONE human with round-1 (the double-booked player) and pairs
        # them with the fifth, otherwise-idle human.
        r1a = fixtures[0]
        r1a_entries = {r1a.entry_a_id, r1a.entry_b_id}
        r1b = next(
            f for f in fixtures if not ({f.entry_a_id, f.entry_b_id} & r1a_entries)
        )
        r1b_entries = {r1b.entry_a_id, r1b.entry_b_id}
        all_entries = {e for f in fixtures for e in (f.entry_a_id, f.entry_b_id)}
        (fifth_entry,) = all_entries - r1a_entries - r1b_entries
        r2 = next(
            f
            for f in fixtures
            if fifth_entry in {f.entry_a_id, f.entry_b_id}
            and len({f.entry_a_id, f.entry_b_id} & r1a_entries) == 1
        )
        (shared_entry,) = {r2.entry_a_id, r2.entry_b_id} & r1a_entries
        (shared_user,) = await _users_for_entries(db_session, [shared_entry])

        # Every one of the three carries a materialized match, born pending —
        # so the caller's go-live flip has something to move to in_progress.
        r1a_match = await _link_match(
            db_session, tournament_id, r1a, status=MatchStatus.pending
        )
        r1b_match = await _link_match(
            db_session, tournament_id, r1b, status=MatchStatus.pending
        )
        await _link_match(db_session, tournament_id, r2, status=MatchStatus.pending)
        # Round 1 is due immediately (09:00); round 2 is predicted 20 min out,
        # beyond the 10-min call-ahead window — not yet due at 09:00.
        r1a.table_id, r1a.scheduled_start = (
            await _table(db_session, event_id, "t1"),
            BASE,
        )
        r1b.table_id, r1b.scheduled_start = (
            await _table(db_session, event_id, "t2"),
            BASE,
        )
        r2.table_id = await _table(db_session, event_id, "t3")
        r2.scheduled_start = BASE + timedelta(minutes=20)
        r1a_id, r1b_id, r2_id = r1a.id, r1b.id, r2.id
        r1a_winner = r1a.entry_a_id
        assert r1a_winner is not None
        await db_session.commit()

        # --- Round 1 is CALLED through the real caller (no hand-set status). --
        _freeze_clocks(monkeypatch, BASE)
        run_pin_tick(str(tournament_id))

        db_session.expire_all()
        called_r1a = await db_session.get(TournamentFixture, r1a_id)
        called_r1b = await db_session.get(TournamentFixture, r1b_id)
        stalled_r2 = await db_session.get(TournamentFixture, r2_id)
        assert called_r1a is not None and called_r1b is not None
        assert stalled_r2 is not None
        assert called_r1a.pinned_at == BASE  # round 1 called…
        assert called_r1b.pinned_at == BASE
        assert stalled_r2.pinned_at is None  # …round 2 not yet due
        assert await _match_status(db_session, r1a_match) is MatchStatus.in_progress
        assert await _match_status(db_session, r1b_match) is MatchStatus.in_progress

        # --- No scores entered; the wall clock advances so round 2 comes due. -
        now2 = BASE + timedelta(minutes=25)
        _freeze_clocks(monkeypatch, now2)
        run_pin_tick(str(tournament_id))

        db_session.expire_all()
        # 1) The double-booked human is in exactly one in_progress match; nobody
        #    holds two. Pre-1a the tick would have called round 2 onto the
        #    shared human → count 2 → this assertion reds.
        counts = await _in_progress_count_by_user(db_session, tournament_id)
        assert counts.get(shared_user) == 1
        assert all(count <= 1 for count in counts.values())

        # 2) The busy round-2 fixture stalled — not called (pre-1a it was).
        stalled_r2 = await db_session.get(TournamentFixture, r2_id)
        assert stalled_r2 is not None
        assert stalled_r2.pinned_at is None
        assert stalled_r2.call_notified_count == 0

        # 3) A solve over exactly this DB state is FEASIBLE, not infeasible.
        #    The gate kept round 2 out of the occupancy set (only the two real
        #    round-1 matches are in_progress), so the solver has one fixed
        #    interval per human — not the two overlapping ones that wedged it
        #    infeasible pre-1a.
        inputs = await schedule_solves._load_solver_inputs(
            db_session, tournament_id, now=now2, lock=False
        )
        assert inputs is not None
        assert len(inputs.snapshot.in_progress) == 2
        in_progress_ids = {m.fixture_id for m in inputs.snapshot.in_progress}
        assert str(r2_id) not in in_progress_ids  # round 2 is not occupancy
        result = scheduling.solve(inputs.snapshot)
        assert result.verdict is not scheduling.Verdict.infeasible
        assert result.verdict in (
            scheduling.Verdict.optimal,
            scheduling.Verdict.feasible,
        )

        # --- Complete ONE round-1 match; its successor becomes callable. ------
        await _complete_linked_match(
            db_session,
            r1a_match,
            r1a_id,
            winner_entry_id=r1a_winner,
            completed_at=(BASE + timedelta(minutes=5)).astimezone(),
        )
        _freeze_clocks(monkeypatch, now2)
        run_pin_tick(str(tournament_id))

        db_session.expire_all()
        freed_r2 = await db_session.get(TournamentFixture, r2_id)
        assert freed_r2 is not None
        assert freed_r2.pinned_at == now2  # table + both humans free → called
        assert freed_r2.call_notified_count == 1
        assert freed_r2.match_id is not None
        assert (
            await _match_status(db_session, freed_r2.match_id)
            is MatchStatus.in_progress
        )


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
        hijack_solve(monkeypatch, after_solve=lambda: run_pin_tick(str(tournament_id)))
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

    # -- the same race, for the notify-without-re-pin transition ------------

    async def _staged_silent_pin_race(
        self,
        db_session: AsyncSession,
        monkeypatch: pytest.MonkeyPatch,
    ) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
        """Like :meth:`_staged_race`, but the fixture is already silently
        pinned (count 0): tick and apply now contend for the
        notify-without-re-pin transition rather than for the pin itself."""
        tournament_id, event_id = await _make_tournament(db_session)
        fixture = await _the_fixture(db_session, event_id)
        await _pin_directly(
            db_session,
            fixture,
            table_id="t1",
            start=BASE + timedelta(minutes=5),
            pinned_at=BASE - timedelta(minutes=30),
            notified=0,
        )
        _freeze_clocks(monkeypatch, BASE)
        row = await request_solve(
            db_session, tournament_id, ScheduleSolveTrigger.manual
        )
        assert row is not None
        row_id = row.id
        await db_session.commit()
        hijack_solve(monkeypatch, after_solve=lambda: run_pin_tick(str(tournament_id)))
        return tournament_id, event_id, row_id

    async def test_concurrent_tick_and_apply_notify_a_silent_pin_exactly_once(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The tick wins the gap and delivers the silent pin's *match_called*
        (count 0 → 1, ``pinned_at`` untouched). The count is deliberately NOT
        fingerprinted — a mid-solve delivery is not input drift — so the
        apply proceeds, and the row-locked ``call_notified_count == 0``
        re-check is the ONLY line of defense. It holds: exactly one
        notification pair, and the ledger row succeeds (no superseding
        re-run, unlike the unpinned race where the tick's pin write IS
        drift)."""
        tournament_id, event_id, row_id = await self._staged_silent_pin_race(
            db_session, monkeypatch
        )

        _run_recorded_solve(solver_queue, row_id)

        db_session.expire_all()
        fixture = await _the_fixture(db_session, event_id)
        assert fixture.pinned_at == BASE - timedelta(minutes=30)
        assert fixture.call_notified_count == 1
        assert len(await _call_notifications(db_session)) == 2
        assert len(fake_notifications_queue.jobs) == 2

        ledger = (
            await db_session.execute(
                select(ScheduleSolve).where(ScheduleSolve.id == row_id)
            )
        ).scalar_one()
        assert ledger.status is ScheduleSolveStatus.succeeded
        assert ledger.fixtures_pinned == 1

    async def test_falsification_bypassing_the_count_recheck_double_notifies(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The falsification: with the untold re-check bypassed (a
        ``_due_for_call`` that ignores pin state and count), the very same
        staged silent-pin race double-notifies — count 2, two notification
        pairs — proving the green above is the row-locked count re-check's
        doing, not scheduler luck. No fingerprint neutering is needed: the
        count was never fingerprinted, which is exactly why the re-check is
        load-bearing."""
        tournament_id, event_id, row_id = await self._staged_silent_pin_race(
            db_session, monkeypatch
        )

        def no_untold_guard(fixture: TournamentFixture, now: datetime) -> bool:
            return (  # _due_for_call minus its pinned_at / count check
                fixture.table_id is not None
                and fixture.scheduled_start is not None
                and fixture.scheduled_start
                <= now + timedelta(minutes=match_calls.CALL_AHEAD_MIN)
                and fixture.entry_a_id is not None
                and fixture.entry_b_id is not None
                and fixture.winner_entry_id is None
            )

        monkeypatch.setattr(match_calls, "_due_for_call", no_untold_guard)

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
                .where(TournamentFixture.stage_id.in_(stage_ids_for_events([event_id])))
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
    repair tests need exact pre-states. ``table_id`` is a positional alias
    (``"t1"``), resolved by :func:`_table`."""
    fixture.table_id = await _table(db, fixture.event_id, table_id)
    fixture.scheduled_start = start
    fixture.pinned_at = pinned_at
    fixture.call_notified_count = notified
    await db.commit()


async def _link_match(
    db: AsyncSession,
    tournament_id: uuid.UUID,
    fixture: TournamentFixture,
    *,
    status: MatchStatus = MatchStatus.pending,
) -> uuid.UUID:
    """Link a materialized match to ``fixture`` in the given born status,
    mirroring go-live materialization's ``fixture.match_id`` wiring without its
    full side machinery — the call flip is keyed on ``fixture.match_id`` and
    ``Match.status``, which is all these tests read."""
    tournament = await db.get(Tournament, tournament_id)
    assert tournament is not None
    match = Match(
        match_settings=MatchSettings(team_size=1, best_of=3, affects_rating=False),
        league_id=tournament.league_id,
        created_by_user_id=tournament.created_by_user_id,
        status=status,
    )
    db.add(match)
    await db.flush()
    fixture.match_id = match.id
    await db.commit()
    return match.id


async def _match_status(db: AsyncSession, match_id: uuid.UUID) -> MatchStatus:
    db.expire_all()
    match = await db.get(Match, match_id)
    assert match is not None
    return match.status


async def _drop_table_from_pools(
    db: AsyncSession,
    event_id: uuid.UUID,
    table_id: str,
) -> None:
    """Take a table out of every pool's ``table_ids``, leaving it in the tournament's
    venue catalogue — the pre-state the "pool membership is a preference, not physics"
    tests below react to. ``table_id`` is a positional alias (``"t1"``), resolved by
    :func:`_table`.

    There used to be a ``from_catalogue`` arm here too, constructing "the placement's
    table is not in this tournament's catalogue" by **re-parenting the table row onto a
    throwaway tournament** — the one way ADR 20260801's ``ON DELETE RESTRICT`` foreign
    key still allowed the state to be built. It is gone with the ``broken_pin_moves``
    repair it fed (chore 2c). That repair defended a state no production path could
    produce: the tournament PATCH's diff either refuses to remove a table matches are
    placed at (the named 409) or unplaces them first, and nothing in ``app/`` ever moves
    a ``VenueTable`` between tournaments. A helper whose whole job is to manufacture an
    unreachable state is not a test fixture, it is a second implementation of a bug.
    """
    table_id = await _table(db, event_id, table_id)
    event = (
        await db.execute(select(TournamentEvent).where(TournamentEvent.id == event_id))
    ).scalar_one()
    # Dropping the table ROW (ADR 20260801) rather than filtering a JSONB list: a
    # reservation's tables are their own rows, and taking one out of the collection is
    # what ``delete-orphan`` turns into the DELETE. They hang off the RESERVATION, not
    # the group — that is the half of the old pool row which carries the venue. The
    # groups themselves are untouched, and must be: rebuilding one would delete and
    # re-insert the very row this event's fixtures foreign-key.
    for group in event.groups:
        reservation = group.reservation
        reservation.tables = [
            row for row in reservation.tables if row.table_id != table_id
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
    physics. A pinned fixture whose entrant withdrew is voided (placement
    cleared, the remaining entrant cancelled-notified). Pool membership is a
    preference, not physics: an off-group pin on a table still in the catalogue
    is the director's legitimate hand and is honored byte-identical.

    The catalogue-departure repair this class also covered is gone (chore 2c):
    under ADR 20260801 a placement's table cannot leave the catalogue — the
    tournament PATCH's diff refuses the removal or unplaces the fixtures first
    — so the only way its tests could reach the state was to re-parent a table
    row onto a throwaway tournament, which no production path performs."""

    async def test_a_table_dropped_from_the_pool_keeps_the_pin(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Pool membership is a preference, not physics: a called pin whose
        table left the pool's ``table_ids`` but is STILL in the venue
        catalogue is the director's legitimate off-group hand (the manual
        PATCH allows off-group soft placements, ADR-0790) — the next solve
        honors it byte-identical: no repair, no moved correction, no
        re-notification."""
        tournament_id, event_id = await _make_tournament(
            db_session, tables=("t1", "t2")
        )
        fixture = await _the_fixture(db_session, event_id)
        pin_time = BASE - timedelta(minutes=5)
        start = BASE + timedelta(minutes=7)  # off-grid: a rewrite would show
        await _pin_directly(
            db_session,
            fixture,
            table_id="t1",
            start=start,
            pinned_at=pin_time,
        )
        await _drop_table_from_pools(db_session, event_id, "t1")
        _freeze_clocks(monkeypatch, BASE)

        await _request_and_run_solve(db_session, solver_queue, tournament_id)

        await db_session.refresh(fixture)
        assert fixture.table_id == await _table(db_session, event_id, "t1")
        # ^ the off-group pin, honored
        assert fixture.scheduled_start == start
        assert fixture.pinned_at == pin_time  # not refreshed: nothing repaired
        assert fixture.call_notified_count == 1  # told once, never re-told
        assert await _call_notifications(db_session) == []
        assert fake_notifications_queue.jobs == []

        ledger = (
            await db_session.execute(
                select(ScheduleSolve).where(
                    ScheduleSolve.tournament_id == tournament_id
                )
            )
        ).scalar_one()
        assert ledger.status is ScheduleSolveStatus.succeeded
        assert ledger.fixtures_placed == 0
        assert ledger.fixtures_pinned == 1  # echoed verbatim

    async def test_an_off_group_catalogue_pin_is_honored_and_auto_called(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A pre-live SILENT pin (count 0) on a spare catalogue table outside
        the pool survives the live solve byte-identical — and, being imminent
        and untold, the same apply delivers its *match_called*
        (notify-without-re-pin): the two fixes composed."""
        tournament_id, event_id = await _make_tournament(
            db_session, tables=("t1", "t2")
        )
        fixture = await _the_fixture(db_session, event_id)
        silent_pin_time = BASE - timedelta(minutes=45)
        start = BASE + timedelta(minutes=7)  # off-grid: a rewrite would show
        await _pin_directly(
            db_session,
            fixture,
            table_id="t2",
            start=start,
            pinned_at=silent_pin_time,
            notified=0,  # placed silently while planning; never announced
        )
        await _drop_table_from_pools(db_session, event_id, "t2")
        _freeze_clocks(monkeypatch, BASE)

        await _request_and_run_solve(db_session, solver_queue, tournament_id)

        await db_session.refresh(fixture)
        assert fixture.table_id == await _table(db_session, event_id, "t2")
        # ^ the off-group pin, honored…
        assert fixture.scheduled_start == start
        assert fixture.pinned_at == silent_pin_time  # …and not re-pinned
        assert fixture.call_notified_count == 1  # …but finally delivered
        rows = await _call_notifications(db_session)
        assert len(rows) == 2
        assert all(
            row.title == "You're up soon — T2" and "09:07" in row.body for row in rows
        )
        assert len(_fanout_jobs(fake_notifications_queue)) == 2

        ledger = (
            await db_session.execute(
                select(ScheduleSolve).where(
                    ScheduleSolve.tournament_id == tournament_id
                )
            )
        ).scalar_one()
        assert ledger.status is ScheduleSolveStatus.succeeded
        assert ledger.fixtures_placed == 0
        assert ledger.fixtures_pinned == 1  # echoed verbatim

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


class TestCallFlipsMatchLive:
    """The forward transition (ADR "born scheduled, live when called"): a
    scheduled (``pending``) match flips to ``in_progress`` the moment its
    entrants are told to play — the *match_called* signal — and never on a
    silent pre-live pin, nor twice."""

    async def test_calling_a_fixture_flips_its_match_pending_to_in_progress(
        self,
        db_session: AsyncSession,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The tick calls an imminent, unpinned fixture (players notified) →
        its born-``pending`` linked match goes ``in_progress``."""
        tournament_id, event_id = await _make_tournament(db_session)
        await _place_fixture(
            db_session, event_id, table_id="t1", start=BASE + timedelta(minutes=5)
        )
        fixture = await _the_fixture(db_session, event_id)
        match_id = await _link_match(db_session, tournament_id, fixture)
        _freeze_clocks(monkeypatch, BASE)

        run_pin_tick(str(tournament_id))

        db_session.expire_all()
        fixture = await _the_fixture(db_session, event_id)
        assert fixture.call_notified_count == 1  # the players were told…
        assert await _match_status(db_session, match_id) is MatchStatus.in_progress

    async def test_notify_without_re_pin_of_a_silent_pin_flips_the_match(
        self,
        db_session: AsyncSession,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A silent pin gone imminent on a live tournament: the tick delivers
        the owed *match_called* without re-pinning (count 0 → 1) → the match
        flips ``pending → in_progress`` on that late delivery, not on the
        earlier silent pin."""
        tournament_id, event_id = await _make_tournament(db_session)
        fixture = await _the_fixture(db_session, event_id)
        await _pin_directly(
            db_session,
            fixture,
            table_id="t1",
            start=BASE + timedelta(minutes=7),
            pinned_at=BASE - timedelta(minutes=45),
            notified=0,  # silently pinned pre-live, never announced
        )
        match_id = await _link_match(db_session, tournament_id, fixture)
        _freeze_clocks(monkeypatch, BASE)

        run_pin_tick(str(tournament_id))

        db_session.expire_all()
        fixture = await _the_fixture(db_session, event_id)
        assert fixture.call_notified_count == 1  # finally delivered
        assert await _match_status(db_session, match_id) is MatchStatus.in_progress

    async def test_a_live_manual_placement_call_flips_the_match(
        self,
        db_session: AsyncSession,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The director's hand: a live full manual placement of a never-told
        fixture *is* a call (*match_called*) → its ``pending`` match flips
        live."""
        tournament_id, event_id = await _make_tournament(db_session)
        _freeze_clocks(monkeypatch, BASE)
        fixture = await _the_fixture(db_session, event_id)
        match_id = await _link_match(db_session, tournament_id, fixture)
        tournament = await db_session.get(Tournament, tournament_id)
        assert tournament is not None

        fanout = await match_calls.apply_manual_placement(
            db_session,
            tournament,
            fixture,
            table_id=await _table(db_session, event_id, "t1"),
            scheduled_start=BASE + timedelta(minutes=5),
            event_timezone="America/Chicago",
        )
        await db_session.commit()

        assert fanout  # players were told
        assert fixture.call_notified_count == 1
        assert await _match_status(db_session, match_id) is MatchStatus.in_progress

    async def test_a_silent_pre_live_pin_leaves_the_match_pending(
        self,
        db_session: AsyncSession,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A pin with nobody told (here: pinned but its start is beyond the
        call-ahead window on a live tournament, so no notify fires) leaves the
        match ``pending`` — the flip is keyed on the notification, not raw
        ``pinned_at``."""
        tournament_id, event_id = await _make_tournament(db_session)
        fixture = await _the_fixture(db_session, event_id)
        await _pin_directly(
            db_session,
            fixture,
            table_id="t1",
            start=BASE + timedelta(minutes=60),  # beyond the window: not due
            pinned_at=BASE - timedelta(minutes=45),
            notified=0,  # silently pinned, nobody told
        )
        match_id = await _link_match(db_session, tournament_id, fixture)
        _freeze_clocks(monkeypatch, BASE)

        run_pin_tick(str(tournament_id))

        db_session.expire_all()
        fixture = await _the_fixture(db_session, event_id)
        assert fixture.call_notified_count == 0  # nobody was told
        assert await _call_notifications(db_session) == []
        assert await _match_status(db_session, match_id) is MatchStatus.pending

    async def test_a_moved_correction_on_a_live_match_is_an_idempotent_noop(
        self,
        db_session: AsyncSession,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A *moved* correction (a re-placement of an already-called fixture)
        lands on an already-``in_progress`` match: no error, and the status is
        not re-flipped or demoted — the flip is guarded ``pending →
        in_progress`` only."""
        tournament_id, event_id = await _make_tournament(db_session)
        fixture = await _the_fixture(db_session, event_id)
        await _pin_directly(
            db_session,
            fixture,
            table_id="t1",
            start=BASE + timedelta(minutes=5),
            pinned_at=BASE - timedelta(minutes=5),
            notified=1,  # already told → a re-place is a *moved* correction
        )
        match_id = await _link_match(
            db_session, tournament_id, fixture, status=MatchStatus.in_progress
        )
        _freeze_clocks(monkeypatch, BASE)
        tournament = await db_session.get(Tournament, tournament_id)
        assert tournament is not None

        fanout = await match_calls.apply_manual_placement(
            db_session,
            tournament,
            fixture,
            table_id=await _table(db_session, event_id, "t1"),
            scheduled_start=BASE + timedelta(minutes=20),  # a move
            event_timezone="America/Chicago",
        )
        await db_session.commit()

        assert fanout  # a moved correction was sent
        assert await _match_status(db_session, match_id) is MatchStatus.in_progress


class TestClearRevertsMatchToPending:
    """The reverse transition (ADR "the reverse transition is a pristine
    un-call"): a director un-places a called (``in_progress``) match, lifting
    the pin and sending *match_call_cancelled*; the match reverts to ``pending``
    — but only if pristine (no game scores, no results). Any play keeps it
    ``in_progress`` — the play is real and the players still owe a score."""

    async def test_clearing_a_pristine_called_match_reverts_it_to_pending(
        self,
        db_session: AsyncSession,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Call a match (``in_progress``) → clear its placement while it is
        pristine → it is ``pending`` again, folding out of the actionable
        attention bucket (which gates on ``in_progress``)."""
        tournament_id, event_id = await _make_tournament(db_session)
        _freeze_clocks(monkeypatch, BASE)
        fixture = await _the_fixture(db_session, event_id)
        # Pre-state: a called, live match (pinned, told).
        await _pin_directly(
            db_session,
            fixture,
            table_id="t1",
            start=BASE + timedelta(minutes=5),
            pinned_at=BASE - timedelta(minutes=5),
            notified=1,
        )
        match_id = await _link_match(
            db_session, tournament_id, fixture, status=MatchStatus.in_progress
        )
        tournament = await db_session.get(Tournament, tournament_id)
        assert tournament is not None

        fanout = await match_calls.apply_manual_placement(
            db_session,
            tournament,
            fixture,
            table_id=None,
            scheduled_start=None,
            event_timezone="America/Chicago",
        )
        await db_session.commit()

        assert fanout  # both entrants were told the call was cancelled
        assert fixture.pinned_at is None  # the pin was lifted
        assert await _match_status(db_session, match_id) is MatchStatus.pending

    async def test_clearing_a_match_with_a_scored_game_stays_in_progress(
        self,
        db_session: AsyncSession,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Call a match → score at least one game → clear its placement → the
        match stays ``in_progress`` (NOT reverted): the play is real."""
        tournament_id, event_id = await _make_tournament(db_session)
        _freeze_clocks(monkeypatch, BASE)
        fixture = await _the_fixture(db_session, event_id)
        await _pin_directly(
            db_session,
            fixture,
            table_id="t1",
            start=BASE + timedelta(minutes=5),
            pinned_at=BASE - timedelta(minutes=5),
            notified=1,
        )
        match_id = await _link_match(
            db_session, tournament_id, fixture, status=MatchStatus.in_progress
        )
        # A game was scored — play has begun.
        db_session.add(
            MatchGame(
                match_id=match_id,
                game_number=1,
                score=MatchGameScore(side_1_points=11, side_2_points=7),
            )
        )
        await db_session.commit()
        tournament = await db_session.get(Tournament, tournament_id)
        assert tournament is not None

        await match_calls.apply_manual_placement(
            db_session,
            tournament,
            fixture,
            table_id=None,
            scheduled_start=None,
            event_timezone="America/Chicago",
        )
        await db_session.commit()

        assert fixture.pinned_at is None  # the pin is still lifted…
        # …but the match stays live: the play is real.
        assert await _match_status(db_session, match_id) is MatchStatus.in_progress

    async def test_clearing_a_match_with_a_posted_result_stays_in_progress(
        self,
        db_session: AsyncSession,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A clear on a match carrying a posted result also stays
        ``in_progress`` — a result is play too."""
        tournament_id, event_id = await _make_tournament(db_session)
        _freeze_clocks(monkeypatch, BASE)
        fixture = await _the_fixture(db_session, event_id)
        await _pin_directly(
            db_session,
            fixture,
            table_id="t1",
            start=BASE + timedelta(minutes=5),
            pinned_at=BASE - timedelta(minutes=5),
            notified=1,
        )
        match_id = await _link_match(
            db_session, tournament_id, fixture, status=MatchStatus.in_progress
        )
        tournament = await db_session.get(Tournament, tournament_id)
        assert tournament is not None
        db_session.add(
            MatchResult(
                match_id=match_id,
                submitted_by_user_id=tournament.created_by_user_id,
                games=[{"game_number": 1, "side_1_points": 11, "side_2_points": 7}],
            )
        )
        await db_session.commit()

        await match_calls.apply_manual_placement(
            db_session,
            tournament,
            fixture,
            table_id=None,
            scheduled_start=None,
            event_timezone="America/Chicago",
        )
        await db_session.commit()

        assert await _match_status(db_session, match_id) is MatchStatus.in_progress


class TestManualPlacementPin:
    async def test_the_next_solve_schedules_around_a_manual_placement_pin(
        self,
        db_session: AsyncSession,
        solver_queue: Queue,
        fake_notifications_queue: Queue,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A manual placement is a pin the solver schedules around, not a
        suggestion it may undo (ADR): the director drops one of three fixtures
        mid-window pre-live — a silent pin — and the next solve leaves that
        placement byte-for-byte (columns, ``pinned_at``, count) while packing
        the other two fixtures into slots that don't overlap it."""
        tournament_id, event_id = await _make_tournament(
            db_session, status=TournamentStatus.published, entrants=3
        )
        _freeze_clocks(monkeypatch, BASE)
        tournament = await db_session.get(Tournament, tournament_id)
        assert tournament is not None
        fixtures = (
            (
                await db_session.execute(
                    select(TournamentFixture)
                    .where(
                        TournamentFixture.stage_id.in_(stage_ids_for_events([event_id]))
                    )
                    .order_by(TournamentFixture.id)
                )
            )
            .scalars()
            .all()
        )
        target = fixtures[0]
        target_id = target.id
        the_table = await _table(db_session, event_id, "t1")
        # Late on the shared table, after the other two pack in: a called
        # match's start is a floor, not a constant (ADR "a called match holds
        # its table and slides later"), so an uncontended pin is the one the
        # solver leaves byte-for-byte — the "does not undo it" point here.
        pin_start = BASE + timedelta(minutes=200)
        fanout = await match_calls.apply_manual_placement(
            db_session,
            tournament,
            target,
            table_id=the_table,
            scheduled_start=pin_start,
            event_timezone="America/Chicago",
        )
        assert fanout == []  # pre-live: a silent pin, nobody paged
        await db_session.commit()

        await _request_and_run_solve(db_session, solver_queue, tournament_id)

        rows = (
            (
                await db_session.execute(
                    select(TournamentFixture)
                    .where(
                        TournamentFixture.stage_id.in_(stage_ids_for_events([event_id]))
                    )
                    .order_by(TournamentFixture.id)
                )
            )
            .scalars()
            .all()
        )
        pinned_row = next(row for row in rows if row.id == target_id)
        assert pinned_row.table_id == the_table
        assert pinned_row.scheduled_start == pin_start
        assert pinned_row.pinned_at == BASE  # the director's pin, untouched
        assert pinned_row.call_notified_count == 0

        # Every fixture is placed on the one table, and no interval overlaps
        # the pin's — the solver planned AROUND the director's hand.
        duration = timedelta(minutes=scheduling.match_minutes(3))
        intervals: list[tuple[datetime, datetime]] = []
        for row in rows:
            assert row.table_id == the_table
            assert row.scheduled_start is not None
            intervals.append((row.scheduled_start, row.scheduled_start + duration))
        intervals.sort()
        for (_, end_before), (start_after, _) in zip(
            intervals, intervals[1:], strict=False
        ):
            assert end_before <= start_after

        # Still pre-live: neither the manual pin nor the solve told anyone.
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
