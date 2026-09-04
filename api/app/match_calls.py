"""The call service: call-ahead pinning and the pin tick (ADR "the schedule is
solved; the call is pinned").

A solve's output is an *estimate* board; a **call** is the promise. A fixture
is called when the schedule says its start is within :data:`CALL_AHEAD_MIN`
minutes of now (or already due — a table that freed with no warning): calling
sets ``pinned_at``, increments ``call_notified_count``, and tells both
entrants, and from then on the placement is a hard constraint in every later
solve.

The call pass owns two transitions, keyed on the fixture's pin state (the
same was-told principle the manual path dispatches on):

=====================  ========================================================
due fixture state      transition
=====================  ========================================================
``pinned_at IS NULL``  **the call**: ``pinned_at = now``, *match_called* to
                       both entrants, count 0 → 1
``pinned_at IS NOT     **notify-without-re-pin**: a silent pin (made pre-live,
NULL AND count = 0``   its players never told) whose start is now imminent on
                       a live tournament — *match_called* to both entrants,
                       count 0 → 1, ``pinned_at`` and the placement columns
                       untouched (the promise already exists; it just was
                       never delivered)
pinned, count ≥ 1      not due — the players already know; only a broken-pin
                       correction (:func:`notify_pin_repairs`) or the manual
                       path may re-notify
=====================  ========================================================

Three paths write pins, and **only** these three (the ADR's invariant:
every pin writer works under the same tournament row lock, so "pinned" and
"notified" cannot drift apart):

* the guarded apply (``app.schedule_solves._apply_result``) — right after it
  writes a solve's placements, in the same transaction, under the same
  tournament + fixture row locks;
* the pin tick (:func:`run_pin_tick`) — a per-tournament RQ job enqueued
  every ~:data:`PIN_TICK_INTERVAL_S` seconds for each **live** tournament by
  an API-lifespan background task. The tick runs **no solve**; it only
  pins+notifies what the current schedule already says is imminent (the
  schedule ages into the call-ahead window between solves);
* the manual placement route (``app.tournaments.place_fixture`` →
  :func:`apply_manual_placement`) — the director's hand (ADR: "a manual
  placement is a pin"). Unlike the two solver-side paths it pins regardless
  of imminence — the call-ahead window prices the *solver's* promises, not
  the director's — and, being a deliberate human re-decision, it is exempt
  from the ``pinned_at IS NULL`` exactly-once guard below: re-placing a
  called fixture is not a double call, it is a *moved* correction.

**Atomicity of pin + notify.** The repo's established notification pattern is
commit-then-enqueue (``app.matches._notify_result_posted``): the worker's
``notify`` persists the in-app row *and* fans out. That would let "pinned" and
"told" drift apart across a crash between commit and enqueue — and the ADR
says they may not. So the call splits the channels: the **in-app
``Notification`` rows are persisted inside the pin transaction** (respecting
each recipient's (match_calls, in_app) preference via the same resolution
machinery the worker uses — ``app.notifications.service``, batch-resolved per
recipient batch since the locks are held while resolving), and only the
best-effort external channels (push, email) are fanned out
post-commit via a ``NotificationJob`` restricted to those channels. A crash
before commit leaves no pin and no notification; a crash after commit leaves
the pin *with* its durable in-app record — the fan-out is best-effort by the
same contract every other push/email in the repo has. The same post-commit
fan-out (:func:`enqueue_call_fanout`) also pushes each recipient a
``dashboard.changed`` realtime hint, so a called player's dashboard shows their
table without waiting for a navigation — see that function for why this is the
one write site that publishes directly rather than staging on the session.

**Exactly-once.** Both call paths re-check the due predicate — ``pinned_at IS
NULL`` for the call, ``call_notified_count = 0`` for the notify-without-re-pin
transition — while holding the fixture's row lock (``FOR UPDATE OF
tournament_fixtures``, ordered by id, behind the tournament row lock — the
exact lock order of the guarded apply, ``app.schedule_solves``' module
docstring). ``OF tournament_fixtures`` on purpose: ``tournament_event_stages``
rides along on every fixture query as the eagerly-joined
``TournamentFixture.stage`` (``lazy="joined"``, ``innerjoin=True``), and stages
are deliberately **not** locked here — nothing on this path writes one. A
concurrent tick and apply therefore serialize: whichever transaction
commits first sets ``pinned_at`` (or, for a silent pin, bumps the count), and
the other re-reads under the lock and skips. The count re-check is the *only*
guard for the silent-pin transition — the solve fingerprint deliberately
excludes ``call_notified_count``, so a mid-solve tick that merely notified is
not drift; the Python re-check under the row locks is authoritative. Multiple
API replicas double-enqueueing ticks is likewise harmless — the second tick
finds ``pinned_at`` set with a nonzero count and is a no-op.
``call_notified_count`` increments on the real transition (0 → told = 1,
whether that is a fresh call or a silent pin's late delivery) and once per
**cancelled correction** sent by :func:`notify_pin_repairs` — the count is
"how many times the players were told", so silent (pre-live) repairs do not
touch it. (A *moved* correction is the manual placement path's own, sent
directly by :func:`apply_manual_placement` — see below — never through
:func:`notify_pin_repairs`, which as of ADR "A called match holds its time,
and a clashing call is refused" only ever cancels.)

**Broken-pin corrections.** A pin is inviolable against optimization, not
against physics (ADR): when a pinned fixture's entrant withdraws, the *solve
pipeline* detects it in its snapshot and repairs it in its guarded apply
(``app.schedule_solves``), then calls :func:`notify_pin_repairs` here — same
transaction, same locks, same atomic-in-app + post-commit-fan-out split as the
call itself. A called match's table and start are otherwise a constant the
solver never rewrites (``app.scheduling``), so withdrawal is the only physics
left that can still break a pin.

Calls fire only while the tournament is **live**: pre-live placements are
silent estimates ("free rearranging while planning" — ADR), so a pre-live
feasibility solve that happens to place fixtures near ``now`` notifies no one.
The lifespan tick loop selects live tournaments for the same reason, and
:func:`notify_pin_repairs` is live-gated identically — a pre-live repair
rewrites columns and tells nobody.
"""

import asyncio
import logging
import uuid
from collections.abc import Callable, Collection, Sequence
from collections.abc import Set as AbstractSet
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import ColumnElement, exists, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app import db as db_module
from app import queue as queue_module
from app.draws import group_label, seats_both_sides_at_cut
from app.models import (
    Match,
    MatchGame,
    MatchResult,
    MatchStatus,
    Notification,
    Tournament,
    TournamentEntry,
    TournamentEvent,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.models.draw_type import StageDrawType
from app.notifications.match_calls import (
    MATCH_CALLS_CATEGORY,
    MatchCallCancellationReason,
    MatchCallContext,
    MatchCallMessage,
    match_call_cancelled_message,
    match_call_moved_message,
    match_called_message,
)
from app.notifications.service import (
    effective_channels_for_users,
    enqueue_notification_job,
)
from app.notifications.taxonomy import NotificationChannel
from app.realtime import EventKind, publish_event
from app.rq_async import run_async_db_job
from app.schemas.notification import NotificationJob
from app.schemas.tournament import TournamentTable
from app.tournament_draws import event_groups
from app.tournament_queries import stage_ids_for_tournament
from app.venue_time import anchor_wallclock, venue_local

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
    """The call's ``now`` as a timezone-aware **instant** (UTC) — the real
    moment a pin is made or a fixture is judged due. Since the 2026-07-19 ADR
    "tournament times are timezone-aware instants" moved ``scheduled_start``,
    ``pinned_at`` and the composed reservation windows onto one instant axis, ``now``
    is a real instant too: an aware UTC ``now`` and the venue-anchored windows
    compare correctly whatever the venue's offset (the #1068 fix). One
    definition for both halves of the pipeline: ``app.schedule_solves`` imports
    this one, and each module's tests monkeypatch their own module's binding."""
    return datetime.now(UTC)


def _due_for_call(fixture: TournamentFixture, now: datetime) -> bool:
    """Whether this fixture row, as read **under its row lock**, is due for
    the call pass: fully placed, both entrants known, not decided by winner,
    starting within the call-ahead window (or already due), and its players
    not yet told — either unpinned (→ the call) or pinned with
    ``call_notified_count == 0`` (a silent pre-live pin → the
    notify-without-re-pin transition; module docstring's transition table).

    The ``pinned_at IS NULL`` / ``call_notified_count == 0`` check here is
    the exactly-once guard: both call paths evaluate it while holding the
    fixture's ``FOR UPDATE`` lock, so a concurrent tick/apply pair cannot
    both see an untold fixture. (The race tests' falsifications bypass
    exactly this predicate to prove it load-bearing.)
    """
    return (
        (fixture.pinned_at is None or fixture.call_notified_count == 0)
        and fixture.table_id is not None
        and fixture.scheduled_start is not None
        and fixture.scheduled_start <= now + timedelta(minutes=CALL_AHEAD_MIN)
        and fixture.entry_a_id is not None
        and fixture.entry_b_id is not None
        and fixture.winner_entry_id is None
    )


def _due_fixture_clauses(
    tournament_id: uuid.UUID, now: datetime
) -> tuple[ColumnElement[bool], ...]:
    """:func:`_due_for_call` as SQL, scoped to one tournament — the tick's
    narrowing predicate (both its lock-free EXISTS probe and its ``FOR
    UPDATE`` select use it, so they cannot drift apart). Deliberately a
    *narrowing* only: the settled-match filter lives on the joined match and
    stays in :func:`call_due_fixtures`, and the Python
    :func:`_due_for_call` re-check under the row lock remains the
    authoritative exactly-once guard."""
    return (
        TournamentFixture.stage_id.in_(stage_ids_for_tournament(tournament_id)),
        or_(
            TournamentFixture.pinned_at.is_(None),
            TournamentFixture.call_notified_count == 0,
        ),
        TournamentFixture.table_id.is_not(None),
        TournamentFixture.scheduled_start.is_not(None),
        TournamentFixture.scheduled_start <= now + timedelta(minutes=CALL_AHEAD_MIN),
        TournamentFixture.entry_a_id.is_not(None),
        TournamentFixture.entry_b_id.is_not(None),
        TournamentFixture.winner_entry_id.is_(None),
    )


async def _go_live_on_call(
    db: AsyncSession, match_ids: Collection[uuid.UUID | None]
) -> None:
    """Flip each linked match from ``pending`` (scheduled) to ``in_progress``
    (live) — the ADR's forward transition, fired at the *match_called* moment
    (the players were just told), keyed on the notification and **not** on raw
    ``pinned_at``: a silently pinned pre-live fixture stays ``pending`` until
    its owed call actually fires here.

    Guarded to ``pending → in_progress`` only, so it is idempotent and never
    demotes — a *moved* correction that lands on an already-live match, or a
    second replica's tick, is a harmless no-op. Rides the caller's open
    transaction (the same one persisting the in-app ``Notification`` rows, per
    the module's atomicity contract); does **not** commit. Fixtures with no
    materialized match (``match_id IS NULL``) contribute nothing.
    """
    ids = {match_id for match_id in match_ids if match_id is not None}
    if not ids:
        return
    await db.execute(
        update(Match)
        .where(Match.id.in_(ids), Match.status == MatchStatus.pending)
        .values(status=MatchStatus.in_progress)
    )


async def _un_call_pristine_match(db: AsyncSession, match_id: uuid.UUID | None) -> None:
    """Revert a linked match ``in_progress → pending`` — the ADR's reverse
    transition, fired when the director *un-places* a called fixture (the clear
    branch of :func:`apply_manual_placement`): the pin is lifted and the
    entrants get *match_call_cancelled*, so without this the match would sit
    ``in_progress`` with no pin — the exact ambiguous state the ADR eliminated,
    reached from the other side, and it would show as a phantom actionable row.

    Guarded twice, both in the same locked transaction as the clear/cancel:

    * **only ``in_progress → pending``** (``Match.status == in_progress`` in the
      WHERE), so a match that is already ``pending`` (a silent clear that never
      called anyone) or ``completed``/``voided`` is left alone;
    * **only when the match is pristine** — no ``MatchGame`` rows (a game row is
      born only when a score is written) and no ``MatchResult`` rows. A match
      with any play stays ``in_progress``: the play is real and the players
      still owe a score. The two ``NOT EXISTS`` correlate on ``Match.id`` and
      ride the single ``UPDATE``, so the pristine check and the flip are atomic.

    Rides the caller's open transaction; does **not** commit. A fixture with no
    materialized match (``match_id IS NULL``) is a no-op.
    """
    if match_id is None:
        return
    has_game = select(MatchGame.id).where(MatchGame.match_id == Match.id).exists()
    has_result = select(MatchResult.id).where(MatchResult.match_id == Match.id).exists()
    await db.execute(
        update(Match)
        .where(
            Match.id == match_id,
            Match.status == MatchStatus.in_progress,
            ~has_game,
            ~has_result,
        )
        .values(status=MatchStatus.pending)
    )


@dataclass(frozen=True)
class HeldResources:
    """The unfinished (``in_progress``) tournament fixtures currently holding a
    table or a player, keyed by what they hold — so a caller can name *which*
    match holds a clashing resource, not just that something does (the live
    placement clash refusal, ADR "A called match holds its time, and a
    clashing call is refused"; :func:`call_due_fixtures`'s automatic gate
    only ever needed the sets, so it reads ``.tables``/``.users`` as sets).

    ``tables`` maps a table id to the ``in_progress`` fixture holding it.
    ``users`` maps a user id to the fixture holding them, at the same
    **user**-level granularity :func:`_held_resources`'s docstring already
    describes — the same human across two events is one person. Two
    ``in_progress`` fixtures reporting the same table or player is
    contradictory data the solver already tolerates-and-reports elsewhere
    (ADR "overlapping in-progress matches are tolerated and reported"); this
    reader keeps whichever one it saw last — a caller here only needs someone
    to name, not an adjudication of which is "real"."""

    tables: dict[str, TournamentFixture]
    users: dict[uuid.UUID, TournamentFixture]


async def _held_resources(
    db: AsyncSession,
    tournament_id: uuid.UUID,
    *,
    exclude_match_id: uuid.UUID | None = None,
) -> HeldResources:
    """The tables and **users** an unfinished (``in_progress``) match in this
    tournament currently holds — the resource-freedom gate's occupancy read
    (ADR "a tournament match is called only when its table and players are
    free", #1106). A started match is a fixed interval the solver pins at its
    *actual* occupancy; calling a second match onto the same table or the same
    human would hand the next solve two overlapping fixed intervals and wedge
    it ``infeasible`` — the exact bug this gate exists to prevent.

    "Held" reads *real* state: a ``Match`` with ``status == in_progress`` (not
    ``completed``/``voided``) whose fixture carries the ``table_id`` /
    entrants. Players are held at the **user** level, across events — the same
    human in two events is one person, as the solver's no-double-booking
    already treats them (``schedule_solves`` maps entrants → ``PlayerId`` via
    the user). Runs on the caller's already-locked transaction: one occupancy
    query, plus one entry→user resolution, per batch.

    ``exclude_match_id`` drops one match's own fixture from the read — the
    live placement clash check's own fixture, when it is itself already
    ``in_progress`` (a re-place is a *move*, not a clash against itself).
    :func:`call_due_fixtures`'s automatic gate passes none: a fixture it is
    evaluating is never itself already ``in_progress`` (:func:`_due_for_call`
    requires ``winner_entry_id IS NULL`` and an un-notified pin, neither of
    which an already-called, running match satisfies), so there is nothing of
    its own to exclude there.

    Returns a :class:`HeldResources` naming which fixture holds each
    resource; :func:`call_due_fixtures` reads ``set(.tables)``/``set(.users)``
    off it exactly as it always has.
    """
    stmt = (
        select(TournamentFixture)
        .join(Match, Match.id == TournamentFixture.match_id)
        .where(
            TournamentFixture.stage_id.in_(stage_ids_for_tournament(tournament_id)),
            Match.status == MatchStatus.in_progress,
        )
    )
    if exclude_match_id is not None:
        stmt = stmt.where(TournamentFixture.match_id != exclude_match_id)
    fixtures = (await db.execute(stmt)).scalars().all()

    held_tables: dict[str, TournamentFixture] = {}
    held_entry_ids: set[uuid.UUID] = set()
    for fixture in fixtures:
        if fixture.table_id is not None:
            held_tables[fixture.table_id] = fixture
        for entry_id in (fixture.entry_a_id, fixture.entry_b_id):
            if entry_id is not None:
                held_entry_ids.add(entry_id)

    held_users: dict[uuid.UUID, TournamentFixture] = {}
    if held_entry_ids:
        entry_user: dict[uuid.UUID, uuid.UUID] = {
            entry_id: user_id
            for entry_id, user_id in (
                await db.execute(
                    select(TournamentEntry.id, TournamentEntry.user_id).where(
                        TournamentEntry.id.in_(held_entry_ids)
                    )
                )
            ).all()
        }
        for fixture in fixtures:
            for entry_id in (fixture.entry_a_id, fixture.entry_b_id):
                if entry_id is None:
                    continue
                user_id = entry_user.get(entry_id)
                if user_id is not None:
                    held_users[user_id] = fixture
    return HeldResources(tables=held_tables, users=held_users)


async def call_due_fixtures(
    db: AsyncSession,
    tournament: Tournament,
    fixtures: Sequence[TournamentFixture],
    *,
    now: datetime,
    ingredients: "CopyIngredients | None" = None,
) -> list[NotificationJob]:
    """Call every due fixture among ``fixtures``: set ``pinned_at = now``
    (unless the fixture is already pinned — a silent pre-live pin keeps its
    ``pinned_at`` and placement and only gets the *match_called* it was
    owed; the module docstring's notify-without-re-pin transition), increment
    ``call_notified_count``, and persist one in-app ``Notification`` per
    entrant (preferences permitting) — all on the caller's open transaction.
    Returns the push/email fan-out jobs the caller must enqueue **after** its
    commit (:func:`enqueue_call_fanout`); returns ``[]`` and writes nothing
    when the tournament isn't live.

    Contract: the caller holds the tournament row lock and has the fixture
    rows locked ``FOR UPDATE`` ordered by id (the guarded apply's exact lock
    order), and owns the commit. Does **not** commit. A caller that already
    batch-loaded :class:`CopyIngredients` covering ``fixtures`` (the guarded
    apply, which shares one batch with :func:`notify_pin_repairs`) passes it
    as ``ingredients``; otherwise they are loaded here.
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

    if ingredients is None:
        ingredients = await load_copy_ingredients(db, tournament, due)

    # Resource-freedom gate (ADR "…called only when its table and players are
    # free", #1106). A fixture is *due* by its predicted start, but calling it
    # onto a table or a human already held by an unfinished in_progress match
    # would produce two overlapping fixed intervals and wedge the next solve
    # infeasible. _due_for_call is a per-row predicate blind to cross-row
    # occupancy, so the gate lives here — one occupancy read under the locks
    # already held (the authoritative gate, per the ADR). Two due fixtures
    # contending for the same freshly-free resource within one pass are settled
    # by earliest predicted start; the loser defers to a later pass.
    # Seed the running claim from real held state, then admit due fixtures into
    # it; the loop mutates these in place (freshly-built sets off the held
    # resources' own keys — this pass only needs "is it held", not "by whom").
    held = await _held_resources(db, tournament.id)
    claimed_tables: set[str] = set(held.tables)
    claimed_users: set[uuid.UUID] = set(held.users)
    free: list[TournamentFixture] = []
    for fixture in sorted(due, key=lambda f: (f.scheduled_start, f.id)):
        user_ids = {
            user.id
            for user in (
                ingredients.user_for_entry(fixture.entry_a_id),
                ingredients.user_for_entry(fixture.entry_b_id),
            )
            if user is not None
        }
        if fixture.table_id is not None and fixture.table_id in claimed_tables:
            continue
        if user_ids & claimed_users:
            continue
        if fixture.table_id is not None:
            claimed_tables.add(fixture.table_id)
        claimed_users |= user_ids
        free.append(fixture)
    due = free
    if not due:
        return []

    # First pass resolves each due fixture's people, so the whole batch's
    # in-app preferences resolve in one round (the locks are already held).
    calls: list[tuple[TournamentFixture, User, User, _OpponentCopy]] = []
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
        context = ingredients.context_for(tournament, event, fixture)
        # A removed table under a stale placement can't be labeled; fall back
        # to the raw id rather than dropping the call (the *next* solve's
        # snapshot detects the broken pin and repairs it).
        table_label = ingredients.table_labels.get(fixture.table_id, fixture.table_id)
        build = _called_copy(
            table_label,
            venue_local(fixture.scheduled_start, event.timezone),
            context,
        )
        calls.append((fixture, user_a, user_b, build))

    in_app_ids = await _in_app_allowed(
        db, [user for _, user_a, user_b, _ in calls for user in (user_a, user_b)]
    )

    fanout: list[NotificationJob] = []
    for fixture, user_a, user_b, build in calls:
        # The call: the pin and its notification records commit together. A
        # silent pin keeps its pinned_at — the promise already exists, this
        # pass only delivers it (notify-without-re-pin).
        if fixture.pinned_at is None:
            fixture.pinned_at = now
        _tell_pair(
            db,
            fixture,
            user_a,
            user_b,
            build=build,
            tournament_id=tournament.id,
            in_app_ids=in_app_ids,
            increment_always=True,
            fanout=fanout,
        )
    # The players were just told → the scheduled match goes live, in this same
    # transaction as the notification (ADR "born scheduled, live when called").
    await _go_live_on_call(db, [fixture.match_id for fixture, *_ in calls])
    await db.flush()
    return fanout


def enqueue_call_fanout(jobs: Sequence[NotificationJob]) -> None:
    """Enqueue the post-commit push/email fan-out **and** hint each recipient's
    dashboard. Fire-and-forget in both directions: the pin and its in-app record
    are already committed, so a Redis hiccup must not fail the calling flow
    (``enqueue_notification_job``'s own contract, and ``publish_event``'s).

    **Why this site publishes directly instead of staging.** Every other write
    path reaches the publisher through ``app.realtime.stage_event``, because it
    runs *inside* the writing transaction and a hint published before that
    commit would make the client re-read pre-commit state. This one is the
    exception the outbox docstring names: all three callers invoke it strictly
    **after** ``await db.commit()`` (each carrying its own "Post-commit, by
    design" comment) and hand it a plain list of jobs — there is no session here
    to stage on, and the commit has already happened, so a direct
    :func:`~app.realtime.publish_event` is both possible and correct.

    **The audience is the fan-out's own recipient list**, not a re-derived
    query: :func:`_record_message` produces exactly one job per entrant it told,
    so ``job.user_id`` already *is* "the players named in this call" — including
    the entrants whose push/email preferences are off (a job is built for them
    too; only delivery is filtered downstream), which is right, because a
    dashboard hint is not a notification channel. Deduped, since a batch may
    tell the same person about two fixtures and a second hint would buy nothing.
    """
    for job in jobs:
        enqueue_notification_job(job)
    for user_id in dict.fromkeys(job.user_id for job in jobs):
        publish_event(user_id, EventKind.dashboard_changed)


# ----- broken-pin repair corrections -----------------------------------------


async def notify_pin_repairs(
    db: AsyncSession,
    tournament: Tournament,
    *,
    cancelled: Sequence[TournamentFixture],
    withdrawn_entry_ids: AbstractSet[uuid.UUID],
    ingredients: "CopyIngredients | None" = None,
) -> list[NotificationJob]:
    """Send a *cancelled* message for each voided pin (``cancelled`` rows
    already have their placement columns cleared) — the physics-broke-the-
    promise correction (ADR "A called match holds its time, and a clashing
    call is refused"'s "broken pins" carve-out): an entrant withdrew, so the
    promised match cannot happen.

    There is no *moved* correction here any more. A called match's table AND
    start are both a constant the solver never rewrites (module docstring of
    ``app.scheduling``), so a re-solve can never hand the guarded apply a
    changed pin to correct — only ``app.tournament_placement``'s director-hand
    re-place still moves a called match, and that path sends its own "moved"
    message directly (``_moved_to``, ``apply_manual_placement``), never
    through here.

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

    A caller that already batch-loaded :class:`CopyIngredients` covering the
    repaired fixtures (the guarded apply, which shares one batch with
    :func:`call_due_fixtures`) passes it as ``ingredients``.
    """
    if tournament.status is not TournamentStatus.live:
        return []
    if not cancelled:
        return []
    if ingredients is None:
        ingredients = await load_copy_ingredients(db, tournament, cancelled)

    # Cancellations go to the REMAINING entrant only (docstring above).
    cancellations: list[
        tuple[TournamentFixture, MatchCallContext, list[tuple[User, User]]]
    ] = []
    for fixture in cancelled:
        event = ingredients.events.get(fixture.event_id)
        if event is None:
            continue
        context = ingredients.context_for(tournament, event, fixture)
        recipients: list[tuple[User, User]] = []
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
            recipients.append((remaining, withdrew))
        cancellations.append((fixture, context, recipients))

    in_app_ids = await _in_app_allowed(
        db,
        [
            remaining
            for _, _, recipients in cancellations
            for remaining, _ in recipients
        ],
    )

    fanout: list[NotificationJob] = []
    for fixture, context, recipients in cancellations:
        told = False
        for remaining, withdrew in recipients:
            message = match_call_cancelled_message(
                reason=MatchCallCancellationReason.OPPONENT_WITHDREW,
                opponent_name=withdrew.username,
                context=context,
            )
            fanout.append(
                _record_message(
                    db,
                    remaining,
                    message,
                    tournament_id=tournament.id,
                    fixture_id=fixture.id,
                    in_app=remaining.id in in_app_ids,
                )
            )
            told = True
        if told:
            fixture.call_notified_count += 1

    await db.flush()
    return fanout


# ----- manual placement pins (the director's hand) ---------------------------


async def apply_manual_placement(
    db: AsyncSession,
    tournament: Tournament,
    fixture: TournamentFixture,
    *,
    table_id: str | None,
    scheduled_start: datetime | None,
    event_timezone: str,
) -> list[NotificationJob]:
    """Write a manual placement **and its pin consequences** — "a manual
    placement is a pin" (ADR): the director's hand is a human commitment the
    solver schedules around, not a suggestion it may undo.

    The whole state transition lives here so the pin and its notification
    records commit together (the module's atomicity contract). The caller —
    only ever ``app.tournaments.place_fixture`` — holds the tournament row
    lock (the lock every pin writer takes first, so this write serializes
    with a concurrent tick or guarded apply), owns the commit, and enqueues
    the returned push/email jobs after it (:func:`enqueue_call_fanout`).
    Does **not** commit.

    The transition, exhaustively:

    * **Full placement** (both halves set), both entrants known → **the
      pin**: ``pinned_at = now``, set or refreshed. While the tournament is
      live, placing *is* calling — a fixture whose players were never told
      gets *match_called* to both entrants; re-placing one they **were** told
      about sends the *match_call_moved* correction carrying the NEW table
      and time. Pre-live placements are silent pins (free rearranging while
      planning) — and a pin made silently pre-live earns a *match_called*,
      not a "moved", the first time it is re-placed live, because "moved"
      corrects a promise the players never received.
    * **Full placement, a TBD side** → the columns save (the write is soft,
      ADR-0790) but nothing pins and nobody is told: a promise to nobody is
      not a promise, and the solver keeps treating the fixture as an
      unpinned placement it may move.
    * **Anything less than a full placement** → **a clear**: the pin (if
      any) is lifted with the columns — a half-placement cannot be a fixed
      interval, so it cannot stay promised. If the players had been called,
      both entrants get the *match_call_cancelled* correction (reason: the
      schedule changed) — they were told to go to a table that no longer
      expects them. Pre-live or never-told clears are silent. A cleared match
      that was called (``in_progress``) and is still **pristine** — no game
      scores, no results — reverts ``in_progress → pending``
      (:func:`_un_call_pristine_match`); one with any play stays ``in_progress``.

    ``call_notified_count`` keeps its one invariant — "how many times the
    players were told" — incrementing once per correction batch actually
    recorded for at least one entrant (call, moved, or cancelled alike) and
    never on a silent transition; a clear does not reset it.
    """
    was_told = fixture.pinned_at is not None and fixture.call_notified_count > 0
    live = tournament.status is TournamentStatus.live

    fixture.table_id = table_id
    # The director enters ``scheduled_start`` as venue-local wall-clock; anchor it
    # to a real instant with the event's timezone before it hits the timestamptz
    # column, so it shares the solver's one instant axis (ADR "tournament times are
    # timezone-aware instants"). The naive ``scheduled_start`` local is kept below
    # for the venue-local notification copy and the placement's control flow.
    fixture.scheduled_start = (
        anchor_wallclock(scheduled_start, event_timezone)
        if scheduled_start is not None
        else None
    )

    if table_id is None or scheduled_start is None:
        # The clear: whatever these columns now say, they are not a full
        # placement, so they are not a promise — unpin.
        fixture.pinned_at = None
        fanout: list[NotificationJob] = []
        if live and was_told:
            fanout = await _tell_both_entrants(
                db, tournament, fixture, build=_cancelled_by_schedule_change
            )
        # Un-call: a called match with the pin now lifted would otherwise sit
        # in_progress with no pin — the ambiguous state the ADR eliminated.
        # Revert it to pending, but only if pristine (no play). Guarded to
        # in_progress → pending inside the helper, in this same transaction.
        await _un_call_pristine_match(db, fixture.match_id)
        await db.flush()
        return fanout

    if fixture.entry_a_id is None or fixture.entry_b_id is None:
        # TBD side: store the placement (soft write, ADR-0790), pin nothing,
        # tell nobody.
        await db.flush()
        return []

    # The pin. Set — or refreshed on a re-place: the promise is renewed,
    # re-dated to the moment the director made it, never demoted.
    fixture.pinned_at = _wall_now()
    fanout = []
    if live:
        builder = (
            _moved_to(table_id, scheduled_start)
            if was_told
            else _called_to(table_id, scheduled_start)
        )
        fanout = await _tell_both_entrants(db, tournament, fixture, build=builder)
        # A live placement of a never-told fixture *is* a call → its scheduled
        # match goes live. A *moved* correction lands on an already-live match;
        # :func:`_go_live_on_call` is guarded (``WHERE status == pending``) so it
        # no-ops that case — call unconditionally rather than re-guard here, the
        # same "let the idempotent helper decide" shape as the un-call clear.
        await _go_live_on_call(db, [fixture.match_id])
    await db.flush()
    return fanout


#: How a manual transition renders one recipient's message: given the
#: opponent, the fixture's context, and the venue's table labels, produce the
#: copy. A closure per transition kind keeps :func:`_tell_both_entrants`'s
#: recipient loop (tombstone skip, count increment) written once.
_ManualMessageBuilder = Callable[
    [User, MatchCallContext, dict[str, str]], MatchCallMessage
]


def _called_to(table_id: str, scheduled_start: datetime) -> _ManualMessageBuilder:
    def build(
        opponent: User, context: MatchCallContext, table_labels: dict[str, str]
    ) -> MatchCallMessage:
        return match_called_message(
            table_label=table_labels.get(table_id, table_id),
            estimated_start=scheduled_start,
            opponent_name=opponent.username,
            context=context,
        )

    return build


def _moved_to(table_id: str, scheduled_start: datetime) -> _ManualMessageBuilder:
    def build(
        opponent: User, context: MatchCallContext, table_labels: dict[str, str]
    ) -> MatchCallMessage:
        return match_call_moved_message(
            new_table_label=table_labels.get(table_id, table_id),
            new_estimated_start=scheduled_start,
            opponent_name=opponent.username,
            context=context,
        )

    return build


def _cancelled_by_schedule_change(
    opponent: User,
    context: MatchCallContext,
    table_labels: dict[str, str],  # noqa: ARG001 -- uniform builder shape; a cancellation names no table
) -> MatchCallMessage:
    return match_call_cancelled_message(
        reason=MatchCallCancellationReason.SCHEDULE_CHANGE,
        opponent_name=opponent.username,
        context=context,
    )


async def _tell_both_entrants(
    db: AsyncSession,
    tournament: Tournament,
    fixture: TournamentFixture,
    *,
    build: _ManualMessageBuilder,
) -> list[NotificationJob]:
    """Record one manual-transition message per entrant (via the shared
    :func:`_tell_pair` loop — tombstone skip, told-gated count increment). A
    dangling ref (entry/event deleted under a stale placement) records
    nothing — the state columns still change; the solve pipeline's broken-pin
    detection owns that territory."""
    ingredients = await load_copy_ingredients(db, tournament, [fixture])
    event = ingredients.events.get(fixture.event_id)
    user_a = ingredients.user_for_entry(fixture.entry_a_id)
    user_b = ingredients.user_for_entry(fixture.entry_b_id)
    if event is None or user_a is None or user_b is None:
        return []
    context = ingredients.context_for(tournament, event, fixture)
    in_app_ids = await _in_app_allowed(db, (user_a, user_b))
    fanout: list[NotificationJob] = []
    _tell_pair(
        db,
        fixture,
        user_a,
        user_b,
        build=lambda opponent: build(opponent, context, ingredients.table_labels),
        tournament_id=tournament.id,
        in_app_ids=in_app_ids,
        increment_always=False,
        fanout=fanout,
    )
    return fanout


# ----- the shared both-entrants loop ------------------------------------------


#: A message with everything but the opponent bound: how each two-entrant
#: sender hands :func:`_tell_pair` its copy.
_OpponentCopy = Callable[[User], MatchCallMessage]


def _called_copy(
    table_label: str, estimated_start: datetime, context: MatchCallContext
) -> _OpponentCopy:
    """Bind a *match_called* message to everything but the opponent."""

    def build(opponent: User) -> MatchCallMessage:
        return match_called_message(
            table_label=table_label,
            estimated_start=estimated_start,
            opponent_name=opponent.username,
            context=context,
        )

    return build


def _tell_pair(
    db: AsyncSession,
    fixture: TournamentFixture,
    user_a: User,
    user_b: User,
    *,
    build: _OpponentCopy,
    tournament_id: uuid.UUID,
    in_app_ids: AbstractSet[uuid.UUID],
    increment_always: bool,
    fanout: list[NotificationJob],
) -> None:
    """The both-ways (recipient, opponent) loop every two-entrant sender
    shares: record one message per non-tombstoned entrant (appended to the
    caller's ``fanout``) and settle ``call_notified_count``.

    ``increment_always`` is the senders' one deliberate divergence: a *call*
    (:func:`call_due_fixtures`) counts once per due fixture regardless of
    whether any entrant could be told — the pin happened, and the count's
    pairing with it is the exactly-once invariant — while the corrections
    (moved repairs, the manual transitions) count only when at least one
    entrant was actually told, because the column means "times the players
    were told" and a correction that reached nobody told nobody.
    """
    told = False
    for recipient, opponent in ((user_a, user_b), (user_b, user_a)):
        if recipient.merged_into_user_id is not None:
            continue  # tombstoned ghost — same skip the worker's notify does
        fanout.append(
            _record_message(
                db,
                recipient,
                build(opponent),
                tournament_id=tournament_id,
                fixture_id=fixture.id,
                in_app=recipient.id in in_app_ids,
            )
        )
        told = True
    if increment_always or told:
        fixture.call_notified_count += 1


# ----- shared copy machinery --------------------------------------------------


@dataclass(frozen=True)
class CopyIngredients:
    """The batch-loaded ingredients every match-call message is built from:
    entrant→user resolution, the events (names + group labels, the latter
    parsed once per event into ``group_labels``), and the venue's table labels.
    Loaded once per batch, parsed with the same models the write boundary
    validated them with (parse, don't validate)."""

    entry_user: dict[uuid.UUID, uuid.UUID]
    users: dict[uuid.UUID, User]
    events: dict[uuid.UUID, TournamentEvent]
    table_labels: dict[str, str]
    #: Per event, its groups' id → display label — ``group_label(position)``, derived,
    #: never a stored name (ADR 20260808: a group renders as "Group A" everywhere the
    #: app used to print a stored reservation name). Both keys are uuids: the outer
    #: one is the event's, the inner one the group's own
    #: ``tournament_event_stage_groups`` primary key (ADR 20260801), which is exactly
    #: what a fixture's ``group_id`` holds.
    group_labels: dict[uuid.UUID, dict[uuid.UUID, str]]
    #: Stage id → that stage's own draw type, flat across every event in the batch (a
    #: stage id is globally unique), read off each event's eager ``stages`` collection.
    #: What :meth:`context_for` asks :func:`~app.draws.seats_both_sides_at_cut` about,
    #: so a call for a bracket fixture is not labelled with a group.
    stage_draw_types: dict[uuid.UUID, StageDrawType]

    def user_for_entry(self, entry_id: uuid.UUID | None) -> User | None:
        if entry_id is None:
            return None
        user_id = self.entry_user.get(entry_id)
        return self.users.get(user_id) if user_id is not None else None

    def context_for(
        self,
        tournament: Tournament,
        event: TournamentEvent,
        fixture: TournamentFixture,
    ) -> MatchCallContext:
        """The fixture's whereabouts in the player's terms.

        A ``group_label`` is emitted only when the fixture's **stage seats both sides
        at the cut** (:func:`~app.draws.seats_both_sides_at_cut`) — i.e. when the
        group is a group *stage*'s group, the thing a player calls "Group A" and can
        find a standings table for. Since #1483 a single-elim or swiss fixture names
        its stage's group too, and telling a bracket player they are in Group A would
        name a table that does not exist and a field they are not in. Their call still
        carries the tournament and the event, which is all a bracket has to say about
        where a match sits.

        Takes the whole fixture rather than its ``group_id``, because the question is
        about the fixture's stage now and one argument that is the fixture cannot be
        passed half of.
        """
        label: str | None = None
        group_id = fixture.group_id
        stage_draw_type = self.stage_draw_types.get(fixture.stage_id)
        if (
            group_id is not None
            and stage_draw_type is not None
            and seats_both_sides_at_cut(stage_draw_type)
        ):
            label = self.group_labels.get(event.id, {}).get(group_id)
        return MatchCallContext(
            tournament_name=tournament.name,
            event_name=event.name,
            group_label=label,
        )


async def load_copy_ingredients(
    db: AsyncSession,
    tournament: Tournament,
    fixtures: Sequence[TournamentFixture],
) -> CopyIngredients:
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
    # The catalogue is rows now (ADR 20260801), eagerly loaded on the tournament. The
    # fixture's ``table_id`` is still carried as a string ref, so the lookup is keyed by
    # the table id's text.
    table_labels = {
        str(table.id): table.label
        for table in (TournamentTable.model_validate(row) for row in tournament.tables)
    }
    group_labels = {
        event.id: {
            group.id: group_label(group.position) for group in event_groups(event)
        }
        for event in events.values()
    }
    # Flat by stage id, which is globally unique — the same shape
    # ``app.dashboard_tournaments`` builds for the same question. Read off the events'
    # eager (``lazy="selectin"``) ``stages`` collection, so this costs no statement.
    stage_draw_types = {
        stage.id: stage.draw_type for event in events.values() for stage in event.stages
    }
    return CopyIngredients(
        entry_user=entry_user,
        users=users,
        events=events,
        table_labels=table_labels,
        group_labels=group_labels,
        stage_draw_types=stage_draw_types,
    )


async def _in_app_allowed(
    db: AsyncSession, recipients: Collection[User]
) -> set[uuid.UUID]:
    """Which of ``recipients`` allow the (match_calls, in_app) cell — resolved
    with the same machinery the worker's ``notify`` uses
    (``app.notifications.service``), but batched: this runs inside the pin
    transaction while the tournament + fixture locks are held, so the
    availability read happens once and the per-user overrides arrive in
    ``IN``-queries instead of a query fan per recipient."""
    allowed = await effective_channels_for_users(
        db,
        {recipient.id for recipient in recipients},
        MATCH_CALLS_CATEGORY,
        {NotificationChannel.IN_APP},
    )
    return {
        user_id
        for user_id, channels in allowed.items()
        if NotificationChannel.IN_APP in channels
    }


def _record_message(
    db: AsyncSession,
    recipient: User,
    message: MatchCallMessage,
    *,
    tournament_id: uuid.UUID,
    fixture_id: uuid.UUID,
    in_app: bool,
) -> NotificationJob:
    """Persist the recipient's in-app row on the caller's open transaction
    (``in_app`` is their batch-resolved (match_calls, in_app) preference —
    :func:`_in_app_allowed`) and return the push/email fan-out job the caller
    enqueues post-commit — the atomicity split the module docstring
    describes."""
    link = f"/tournaments/{tournament_id}"
    if in_app:
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
    says is imminent. Idempotent — see the module docstring. A thin wrapper
    over :func:`app.rq_async.run_async_db_job`, which owns the sync-entry
    loop-hosting and the per-run ``NullPool`` engine."""
    tid = uuid.UUID(tournament_id)
    run_async_db_job(
        f"pin-tick-{tid}",
        lambda sessionmaker: execute_pin_tick(sessionmaker, tid),
    )


async def execute_pin_tick(
    sessionmaker: async_sessionmaker[AsyncSession], tournament_id: uuid.UUID
) -> None:
    """The tick body, sessionmaker-injected so it is runnable anywhere a
    database is.

    Starts with a **lock-free EXISTS probe** for a due fixture
    (:func:`_due_fixture_clauses`): the overwhelmingly common tick finds
    nothing imminent, and it must not take the tournament row lock — the lock
    every tournament writer queues on — just to discover that. Only when the
    probe finds something does the tick take the guarded apply's locks in the
    guarded apply's order — tournament row, then fixture rows ``FOR UPDATE``
    ordered by id (the id-ordered *subset* keeps the deadlock-free order) —
    and the Python untold re-check under those locks — ``pinned_at IS NULL``
    or, for a silent pin, ``call_notified_count == 0``
    (:func:`_due_for_call`, inside :func:`call_due_fixtures`) — remains the
    authoritative exactly-once guard, so whichever of a tick/apply pair runs
    second is a no-op and multiple API replicas double-enqueueing ticks are
    harmless. The probe racing a concurrent writer costs nothing: a
    false positive is caught by the re-check, and a fixture becoming due
    right after a ``False`` probe is the next tick's work."""
    async with sessionmaker() as db:
        now = _wall_now()
        due_clauses = _due_fixture_clauses(tournament_id, now)
        has_due = (
            await db.execute(
                select(exists(select(TournamentFixture.id).where(*due_clauses)))
            )
        ).scalar_one()
        if not has_due:
            return

        tournament = (
            await db.execute(
                select(Tournament)
                .where(Tournament.id == tournament_id)
                .with_for_update()
            )
        ).scalar_one_or_none()
        if tournament is None or tournament.status is not TournamentStatus.live:
            return

        fixtures: Sequence[TournamentFixture] = (
            (
                await db.execute(
                    select(TournamentFixture)
                    .where(*due_clauses)
                    .order_by(TournamentFixture.id)
                    # ``of=TournamentFixture``: a bare ``FOR UPDATE`` would also lock
                    # ``tournament_event_stages``, which rides along on every fixture
                    # query as the eagerly-joined ``TournamentFixture.stage``
                    # (``lazy="joined"``, ``innerjoin=True``). Stages are deliberately
                    # NOT part of this lock — nothing here writes one, and no writer of
                    # a stage row takes a fixture lock first, so locking it would only
                    # widen the row set contended for no benefit.
                    .with_for_update(of=TournamentFixture)
                )
            )
            .scalars()
            .all()
        )

        fanout = await call_due_fixtures(db, tournament, fixtures, now=now)
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
