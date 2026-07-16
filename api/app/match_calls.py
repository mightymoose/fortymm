"""The call service: call-ahead pinning and the pin tick (ADR "the schedule is
solved; the call is pinned").

A solve's output is an *estimate* board; a **call** is the promise. A fixture
is called when the schedule says its start is within :data:`CALL_AHEAD_MIN`
minutes of now (or already due — a table that freed with no warning): calling
sets ``pinned_at``, increments ``call_notified_count``, and tells both
entrants, and from then on the placement is a hard constraint in every later
solve. Two paths call fixtures, and **only** these two (the ADR's invariant:
pins are written only inside the guarded apply or by the pin tick, under the
same locks):

* the guarded apply (``app.schedule_solves._apply_result``) — right after it
  writes a solve's placements, in the same transaction, under the same
  tournament + fixture row locks;
* the pin tick (:func:`run_pin_tick`) — a per-tournament RQ job enqueued
  every ~:data:`PIN_TICK_INTERVAL_S` seconds for each **live** tournament by
  an API-lifespan background task. The tick runs **no solve**; it only
  pins+notifies what the current schedule already says is imminent (the
  schedule ages into the call-ahead window between solves).

**Atomicity of pin + notify.** The repo's established notification pattern is
commit-then-enqueue (``app.matches._notify_result_posted``): the worker's
``notify`` persists the in-app row *and* fans out. That would let "pinned" and
"told" drift apart across a crash between commit and enqueue — and the ADR
says they may not. So the call splits the channels: the **in-app
``Notification`` rows are persisted inside the pin transaction** (respecting
each recipient's (match_calls, in_app) preference via the same resolution
machinery the worker uses — ``app.notifications.service.effective_channels``),
and only the best-effort external channels (push, email) are fanned out
post-commit via a ``NotificationJob`` restricted to those channels. A crash
before commit leaves no pin and no notification; a crash after commit leaves
the pin *with* its durable in-app record — the fan-out is best-effort by the
same contract every other push/email in the repo has.

**Exactly-once.** Both call paths re-check ``pinned_at IS NULL`` while holding
the fixture's row lock (``FOR UPDATE``, ordered by id, behind the tournament
row lock — the exact lock order of the guarded apply). A concurrent tick and
apply therefore serialize: whichever transaction commits first sets
``pinned_at``, and the other re-reads under the lock and skips. Multiple API
replicas double-enqueueing ticks is likewise harmless — the second tick finds
``pinned_at`` set and is a no-op. ``call_notified_count`` increments on the
real transition (0 → called = 1) and once per **moved/cancelled correction**
sent by :func:`notify_pin_repairs` — the count is "how many times the players
were told", so silent (pre-live) repairs do not touch it.

**Broken-pin corrections.** A pin is inviolable against optimization, not
against physics (ADR): when a pinned fixture's table leaves the venue or an
entrant withdraws, the *solve pipeline* detects it in its snapshot and repairs
it in its guarded apply (``app.schedule_solves``), then calls
:func:`notify_pin_repairs` here — same transaction, same locks, same
atomic-in-app + post-commit-fan-out split as the call itself.

Calls fire only while the tournament is **live**: pre-live placements are
silent estimates ("free rearranging while planning" — ADR), so a pre-live
feasibility solve that happens to place fixtures near ``now`` notifies no one.
The lifespan tick loop selects live tournaments for the same reason, and
:func:`notify_pin_repairs` is live-gated identically — a pre-live repair
rewrites columns and tells nobody.
"""

import asyncio
import logging
import threading
import uuid
from collections.abc import Sequence
from collections.abc import Set as AbstractSet
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

from app import db as db_module
from app import queue as queue_module
from app.db import get_database_url
from app.models import (
    Match,
    MatchStatus,
    Notification,
    Tournament,
    TournamentEntry,
    TournamentEvent,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.notifications.match_calls import (
    MATCH_CALLS_CATEGORY,
    MatchCallCancellationReason,
    MatchCallContext,
    MatchCallMessage,
    match_call_cancelled_message,
    match_call_moved_message,
    match_called_message,
)
from app.notifications.service import effective_channels
from app.notifications.taxonomy import NotificationChannel
from app.schemas.notification import NotificationJob
from app.schemas.tournament import Pool, TournamentTable

log = logging.getLogger(__name__)

#: The ADR's ~10-minute call-ahead window: a fixture whose scheduled start is
#: within this many minutes of now (or already past) is due to be called.
CALL_AHEAD_MIN = 10

#: The dotted path RQ resolves in the worker process. The tick rides the
#: **solver** queue: it is scheduling-domain work, and the solver worker is the
#: one whose presence the platform already guarantees (``/v1/health`` is a
#: round-trip through it) — a tick must not silently rot because a deployment
#: forgot a second queue name.
RUN_PIN_TICK_JOB = "app.match_calls.run_pin_tick"

#: How often the API lifespan enqueues a tick per live tournament (the ADR's
#: "1-minute pin tick while live").
PIN_TICK_INTERVAL_S = 60.0

#: The external channels the post-commit fan-out is restricted to — in-app was
#: already persisted inside the pin transaction (module docstring).
_FANOUT_CHANNELS = [NotificationChannel.PUSH, NotificationChannel.EMAIL]


def _wall_now() -> datetime:
    """Naive wall-clock now — the frame ``scheduled_start`` / ``pinned_at``
    live in (the deliberate ADR-0790 exemption from aware datetimes)."""
    return datetime.now()


def _due_for_call(fixture: TournamentFixture, now: datetime) -> bool:
    """Whether this fixture row, as read **under its row lock**, is due to be
    called: unpinned, fully placed, both entrants known, not decided by
    winner, and starting within the call-ahead window (or already due).

    The ``pinned_at IS NULL`` check here is the exactly-once guard: both call
    paths evaluate it while holding the fixture's ``FOR UPDATE`` lock, so a
    concurrent tick/apply pair cannot both see ``NULL``. (The race test's
    falsification bypasses exactly this predicate to prove it load-bearing.)
    """
    return (
        fixture.pinned_at is None
        and fixture.table_id is not None
        and fixture.scheduled_start is not None
        and fixture.scheduled_start <= now + timedelta(minutes=CALL_AHEAD_MIN)
        and fixture.entry_a_id is not None
        and fixture.entry_b_id is not None
        and fixture.winner_entry_id is None
    )


async def call_due_fixtures(
    db: AsyncSession,
    tournament: Tournament,
    fixtures: Sequence[TournamentFixture],
    *,
    now: datetime,
) -> list[NotificationJob]:
    """Call every due fixture among ``fixtures``: set ``pinned_at = now``,
    increment ``call_notified_count``, and persist one in-app ``Notification``
    per entrant (preferences permitting) — all on the caller's open
    transaction. Returns the push/email fan-out jobs the caller must enqueue
    **after** its commit (:func:`enqueue_call_fanout`); returns ``[]`` and
    writes nothing when the tournament isn't live.

    Contract: the caller holds the tournament row lock and has the fixture
    rows locked ``FOR UPDATE`` ordered by id (the guarded apply's exact lock
    order), and owns the commit. Does **not** commit.
    """
    if tournament.status is not TournamentStatus.live:
        return []

    due = [fixture for fixture in fixtures if _due_for_call(fixture, now)]
    if not due:
        return []

    # A materialized match that already finished (completed) or was voided is
    # decided/dead — never call players to it, whatever the winner column says.
    match_ids = [f.match_id for f in due if f.match_id is not None]
    settled: set[uuid.UUID] = set()
    if match_ids:
        rows = (
            await db.execute(
                select(Match.id, Match.status).where(Match.id.in_(match_ids))
            )
        ).all()
        settled = {
            match_id
            for match_id, status in rows
            if status in (MatchStatus.completed, MatchStatus.voided)
        }
    due = [f for f in due if f.match_id is None or f.match_id not in settled]
    if not due:
        return []

    ingredients = await _load_copy_ingredients(db, tournament, due)

    fanout: list[NotificationJob] = []
    for fixture in due:
        # Re-assured by _due_for_call above; narrow for the type checker.
        if (
            fixture.entry_a_id is None
            or fixture.entry_b_id is None
            or fixture.scheduled_start is None
            or fixture.table_id is None
        ):
            continue
        event = ingredients.events.get(fixture.event_id)
        user_a = ingredients.user_for_entry(fixture.entry_a_id)
        user_b = ingredients.user_for_entry(fixture.entry_b_id)
        if event is None or user_a is None or user_b is None:
            # A dangling ref (entry/event deleted under a stale placement) is
            # broken-pin territory — don't promise a match that can't run.
            continue

        # The call: the pin and its notification records commit together.
        fixture.pinned_at = now
        fixture.call_notified_count += 1

        context = _fixture_context(tournament, event, fixture.pool_id)
        # A removed table under a stale placement can't be labeled; fall back
        # to the raw id rather than dropping the call (the *next* solve's
        # snapshot detects the broken pin and repairs it).
        table_label = ingredients.table_labels.get(fixture.table_id, fixture.table_id)

        for recipient, opponent in ((user_a, user_b), (user_b, user_a)):
            if recipient.merged_into_user_id is not None:
                continue  # tombstoned ghost — same skip the worker's notify does
            message = match_called_message(
                table_label=table_label,
                estimated_start=fixture.scheduled_start,
                opponent_name=opponent.username,
                context=context,
            )
            fanout.append(
                await _record_message(
                    db,
                    recipient,
                    message,
                    tournament_id=tournament.id,
                    fixture_id=fixture.id,
                )
            )
    await db.flush()
    return fanout


def enqueue_call_fanout(jobs: Sequence[NotificationJob]) -> None:
    """Enqueue the post-commit push/email fan-out. Fire-and-forget: the pin and
    its in-app record are already committed, so a Redis hiccup must not fail
    the calling flow (mirrors ``NotificationService.enqueue_notification``)."""
    from app.notifications.jobs import DELIVER_NOTIFICATION_JOB

    for job in jobs:
        try:
            queue_module.get_notifications_queue().enqueue(
                DELIVER_NOTIFICATION_JOB,
                job.model_dump_json(),
                result_ttl=60,
                failure_ttl=300,
            )
        except Exception:  # noqa: BLE001 -- best-effort by contract, like every fan-out enqueue
            log.exception(
                "Failed to enqueue match-call fan-out for user %s", job.user_id
            )


# ----- broken-pin repair corrections -----------------------------------------


async def notify_pin_repairs(
    db: AsyncSession,
    tournament: Tournament,
    *,
    moved: Sequence[TournamentFixture],
    cancelled: Sequence[TournamentFixture],
    withdrawn_entry_ids: AbstractSet[uuid.UUID],
) -> list[NotificationJob]:
    """Send the corrections for pins the guarded apply just repaired: a
    *moved* message per entrant of each re-placed pin (``moved`` rows already
    carry their NEW ``table_id``/``scheduled_start`` and refreshed
    ``pinned_at``), and a *cancelled* message for each voided pin (``cancelled``
    rows already have their placement columns cleared).

    Same contract as :func:`call_due_fixtures`: the caller (only ever the
    guarded apply) holds the tournament and fixture row locks and owns the
    commit; in-app ``Notification`` rows persist on the caller's open
    transaction, and the returned jobs are the post-commit push/email fan-out.
    Does **not** commit.

    Decisions this function encodes (chore 3c):

    * **Live-gated, like the call itself.** Pre-live pins are silent estimates
      of a day still being planned, so a pre-live repair rewrites the columns
      and tells nobody — this returns ``[]`` and increments nothing.
    * **Cancellations go to the REMAINING entrant only.** The withdrawn player
      asked to leave; their withdrawal flow was their feedback, and paging
      them about the consequence of their own action would be noise. (A
      fixture whose entrants *both* withdrew therefore notifies no one.)
    * **``call_notified_count`` increments once per correction actually
      sent** — the column means "times the players were told" (its model
      docstring), so a repair that reached no recipient leaves it alone.
    """
    if tournament.status is not TournamentStatus.live:
        return []
    repaired = [*moved, *cancelled]
    if not repaired:
        return []
    ingredients = await _load_copy_ingredients(db, tournament, repaired)

    fanout: list[NotificationJob] = []
    for fixture in moved:
        event = ingredients.events.get(fixture.event_id)
        user_a = ingredients.user_for_entry(fixture.entry_a_id)
        user_b = ingredients.user_for_entry(fixture.entry_b_id)
        if (
            event is None
            or user_a is None
            or user_b is None
            or fixture.table_id is None
            or fixture.scheduled_start is None
        ):
            continue
        context = _fixture_context(tournament, event, fixture.pool_id)
        table_label = ingredients.table_labels.get(fixture.table_id, fixture.table_id)
        told = False
        for recipient, opponent in ((user_a, user_b), (user_b, user_a)):
            if recipient.merged_into_user_id is not None:
                continue
            message = match_call_moved_message(
                new_table_label=table_label,
                new_estimated_start=fixture.scheduled_start,
                opponent_name=opponent.username,
                context=context,
            )
            fanout.append(
                await _record_message(
                    db,
                    recipient,
                    message,
                    tournament_id=tournament.id,
                    fixture_id=fixture.id,
                )
            )
            told = True
        if told:
            fixture.call_notified_count += 1

    for fixture in cancelled:
        event = ingredients.events.get(fixture.event_id)
        if event is None:
            continue
        context = _fixture_context(tournament, event, fixture.pool_id)
        told = False
        for entry_id, opponent_entry_id in (
            (fixture.entry_a_id, fixture.entry_b_id),
            (fixture.entry_b_id, fixture.entry_a_id),
        ):
            if entry_id is None or entry_id in withdrawn_entry_ids:
                continue  # the withdrawn player asked to leave — no correction
            remaining = ingredients.user_for_entry(entry_id)
            withdrew = ingredients.user_for_entry(opponent_entry_id)
            if (
                remaining is None
                or withdrew is None
                or remaining.merged_into_user_id is not None
            ):
                continue
            message = match_call_cancelled_message(
                reason=MatchCallCancellationReason.OPPONENT_WITHDREW,
                opponent_name=withdrew.username,
                context=context,
            )
            fanout.append(
                await _record_message(
                    db,
                    remaining,
                    message,
                    tournament_id=tournament.id,
                    fixture_id=fixture.id,
                )
            )
            told = True
        if told:
            fixture.call_notified_count += 1

    await db.flush()
    return fanout


# ----- shared copy machinery --------------------------------------------------


@dataclass(frozen=True)
class _CopyIngredients:
    """The batch-loaded ingredients every match-call message is built from:
    entrant→user resolution, the events (names + pool labels), and the venue's
    table labels. Loaded once per batch, parsed with the same models the write
    boundary validated them with (parse, don't validate)."""

    entry_user: dict[uuid.UUID, uuid.UUID]
    users: dict[uuid.UUID, User]
    events: dict[uuid.UUID, TournamentEvent]
    table_labels: dict[str, str]

    def user_for_entry(self, entry_id: uuid.UUID | None) -> User | None:
        if entry_id is None:
            return None
        user_id = self.entry_user.get(entry_id)
        return self.users.get(user_id) if user_id is not None else None


async def _load_copy_ingredients(
    db: AsyncSession,
    tournament: Tournament,
    fixtures: Sequence[TournamentFixture],
) -> _CopyIngredients:
    entry_ids = {
        entry_id
        for fixture in fixtures
        for entry_id in (fixture.entry_a_id, fixture.entry_b_id)
        if entry_id is not None
    }
    entry_user: dict[uuid.UUID, uuid.UUID] = {
        entry_id: user_id
        for entry_id, user_id in (
            await db.execute(
                select(TournamentEntry.id, TournamentEntry.user_id).where(
                    TournamentEntry.id.in_(entry_ids)
                )
            )
        ).all()
    }
    users: dict[uuid.UUID, User] = {
        user.id: user
        for user in (
            await db.execute(select(User).where(User.id.in_(set(entry_user.values()))))
        )
        .scalars()
        .all()
    }
    events: dict[uuid.UUID, TournamentEvent] = {
        event.id: event
        for event in (
            await db.execute(
                select(TournamentEvent).where(
                    TournamentEvent.id.in_({f.event_id for f in fixtures})
                )
            )
        )
        .scalars()
        .all()
    }
    table_labels = {
        table.id: table.label
        for table in (
            TournamentTable.model_validate(raw) for raw in tournament.table_catalogue
        )
    }
    return _CopyIngredients(
        entry_user=entry_user,
        users=users,
        events=events,
        table_labels=table_labels,
    )


def _fixture_context(
    tournament: Tournament, event: TournamentEvent, pool_id: str | None
) -> MatchCallContext:
    """The fixture's whereabouts in the player's terms; the pool name resolves
    through the event's own ``pools`` JSONB (``pool_id`` is a string ref)."""
    pool_name: str | None = None
    if pool_id is not None:
        pool_name = next(
            (
                pool.name
                for pool in (Pool.model_validate(raw) for raw in event.pools)
                if pool.id == pool_id
            ),
            None,
        )
    return MatchCallContext(
        tournament_name=tournament.name,
        event_name=event.name,
        pool_name=pool_name,
    )


async def _record_message(
    db: AsyncSession,
    recipient: User,
    message: MatchCallMessage,
    *,
    tournament_id: uuid.UUID,
    fixture_id: uuid.UUID,
) -> NotificationJob:
    """Persist the recipient's in-app row on the caller's open transaction
    (respecting their (match_calls, in_app) preference) and return the
    push/email fan-out job the caller enqueues post-commit — the atomicity
    split the module docstring describes."""
    link = f"/tournaments/{tournament_id}"
    allowed = await effective_channels(
        db,
        recipient.id,
        MATCH_CALLS_CATEGORY,
        {NotificationChannel.IN_APP},
    )
    if NotificationChannel.IN_APP in allowed:
        db.add(
            Notification(
                user_id=recipient.id,
                category=MATCH_CALLS_CATEGORY.value,
                title=message.title,
                body=message.body,
                link=link,
            )
        )
    return NotificationJob(
        user_id=recipient.id,
        category=MATCH_CALLS_CATEGORY,
        title=message.title,
        body=message.body,
        link=link,
        push_category=message.kind.value,
        push_data={"tournament_id": str(tournament_id)},
        collapse_id=f"match-call:{fixture_id}",
        channels=_FANOUT_CHANNELS,
    )


# ----- the pin tick ---------------------------------------------------------


def run_pin_tick(tournament_id: str) -> None:
    """RQ entry point: pin+notify whatever the tournament's current schedule
    says is imminent. Idempotent — see the module docstring.

    A sync wrapper that owns its own engine, exactly like
    ``app.schedule_solves.run_schedule_solve`` (and for the same reasons: RQ
    workers are sync; under the tests' synchronous fake queue the job runs
    inline inside an async test, so a fresh thread hosts its own loop).
    """
    tid = uuid.UUID(tournament_id)
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(_run_pin_tick(tid))
        return

    errors: list[Exception] = []

    def _run_on_own_loop() -> None:
        try:
            asyncio.run(_run_pin_tick(tid))
        except Exception as exc:  # noqa: BLE001 -- re-raised on the caller's thread below
            errors.append(exc)

    thread = threading.Thread(target=_run_on_own_loop, name=f"pin-tick-{tid}")
    thread.start()
    thread.join()
    if errors:
        raise errors[0]


async def _run_pin_tick(tournament_id: uuid.UUID) -> None:
    engine = create_async_engine(get_database_url(), poolclass=NullPool)
    try:
        sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
        await execute_pin_tick(sessionmaker, tournament_id)
    finally:
        await engine.dispose()


async def execute_pin_tick(
    sessionmaker: async_sessionmaker[AsyncSession], tournament_id: uuid.UUID
) -> None:
    """The tick body, sessionmaker-injected so it is runnable anywhere a
    database is. Takes the guarded apply's locks in the guarded apply's order
    — tournament row, then fixture rows ``FOR UPDATE`` ordered by id — so a
    tick and an in-flight apply serialize instead of deadlocking, and the
    ``pinned_at IS NULL`` re-check under those locks makes whichever runs
    second a no-op (multiple API replicas double-enqueueing ticks are
    therefore harmless)."""
    async with sessionmaker() as db:
        tournament = (
            await db.execute(
                select(Tournament)
                .where(Tournament.id == tournament_id)
                .with_for_update()
            )
        ).scalar_one_or_none()
        if tournament is None or tournament.status is not TournamentStatus.live:
            return

        event_ids = (
            (
                await db.execute(
                    select(TournamentEvent.id).where(
                        TournamentEvent.tournament_id == tournament_id
                    )
                )
            )
            .scalars()
            .all()
        )
        fixtures: Sequence[TournamentFixture] = []
        if event_ids:
            fixtures = (
                (
                    await db.execute(
                        select(TournamentFixture)
                        .where(TournamentFixture.event_id.in_(event_ids))
                        .order_by(TournamentFixture.id)
                        .with_for_update()
                    )
                )
                .scalars()
                .all()
            )

        fanout = await call_due_fixtures(db, tournament, fixtures, now=_wall_now())
        await db.commit()
    # Post-commit, by design: the pin + in-app rows are durable; push/email
    # fan-out is best-effort (module docstring).
    enqueue_call_fanout(fanout)


# ----- the lifespan tick loop ------------------------------------------------


async def enqueue_pin_ticks(db: AsyncSession) -> list[uuid.UUID]:
    """One beat of the tick loop: enqueue :func:`run_pin_tick` for every live
    tournament. Returns the tournament ids enqueued (the testable selection —
    the sleep loop around this is deliberately trivial)."""
    live_ids = (
        (
            await db.execute(
                select(Tournament.id).where(Tournament.status == TournamentStatus.live)
            )
        )
        .scalars()
        .all()
    )
    enqueued: list[uuid.UUID] = []
    for tournament_id in live_ids:
        try:
            queue_module.get_queue().enqueue(RUN_PIN_TICK_JOB, str(tournament_id))
        except Exception:  # noqa: BLE001 -- one tournament's enqueue failing must not starve the rest
            log.exception("Failed to enqueue pin tick for tournament %s", tournament_id)
            continue
        enqueued.append(tournament_id)
    return enqueued


async def pin_tick_loop() -> None:
    """The API-lifespan background task: every :data:`PIN_TICK_INTERVAL_S`
    seconds, enqueue a pin tick per live tournament. Sleeps first (startup and
    offline tooling pay nothing), survives DB/Redis flaps by logging and
    trying again next beat, and shuts down via task cancellation
    (``CancelledError`` is not an ``Exception``, so it propagates cleanly
    through the guard). Replicas each running this loop merely double-enqueue
    ticks, which the pinned_at-under-row-lock guard makes no-ops."""
    while True:
        await asyncio.sleep(PIN_TICK_INTERVAL_S)
        try:
            sessionmaker = async_sessionmaker(
                db_module.get_engine(), expire_on_commit=False
            )
            async with sessionmaker() as db:
                await enqueue_pin_ticks(db)
        except Exception:  # noqa: BLE001 -- the loop's boundary: a flap costs one beat, never the loop
            log.exception("Pin-tick beat failed; retrying next interval")
