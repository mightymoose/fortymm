"""The solve-run service: coalesced enqueue, snapshot + fingerprint, and the
whole-or-nothing apply (ADR "the schedule is solved; the call is pinned").

``app.scheduling`` is the *pure* half — a frozen :class:`ScheduleSnapshot` of
minute offsets in, a verdict and placements out, no session anywhere. This
module is the half that touches the database and the queue, and it is
deliberately *orchestration only*: it decides nothing about placement, it only
moves the solver's inputs and outputs across the boundary honestly.

**One solve in flight per tournament.** Every trigger funnels into
:func:`request_solve`: a ``queued`` row absorbs the trigger (it is returned,
nothing new is enqueued); a ``running`` row gets ``rerun_requested`` set (the
job re-queues at finish); only when neither exists is a row inserted and the RQ
job enqueued. The ledger row *is* the coalescing state — there is no separate
lock or Redis key to drift from it.

**The job is three phases, and the transaction boundaries are the design.**

(a) *Snapshot*: mark the row ``running``, read every solver input for the
    tournament, compute the input fingerprint, commit. Times become minute
    offsets from a per-tournament base — the earliest reservation window start —
    because the pure module speaks only ``int`` minutes in one shared frame.
    Every time is first put on **one real-instant axis**: reservation ``Slot``
    date+HH:MM components are anchored to instants by the event's venue
    ``timezone``, ``scheduled_start``/``pinned_at`` are ``timestamptz``
    instants, and ``now`` is an aware UTC instant — so ``now`` and the windows
    finally share an axis (ADR "tournament times are timezone-aware instants",
    the #1068 fix).
(b) *Solve*: call ``app.scheduling.solve`` **outside any transaction**. A
    CP-SAT run can take seconds; holding row locks (or even an idle-in-
    transaction connection) across it would block every writer at the venue.
(c) *Apply*: re-open a transaction, take the tournament row lock (the same
    lock every tournament writer takes), re-read the inputs with the fixtures
    row-locked ``FOR UPDATE`` ordered by id, and recompute the fingerprint. On
    **any** drift the whole output is discarded — the row finishes ``failed``
    with ``error='inputs changed during solve; superseded by re-run'`` and a
    ``rerun`` solve is requested in the same transaction. That is honest (this
    run produced nothing) and keeps the status enum closed. On a match, every
    returned placement for an *unpinned* fixture is written back as an instant
    (``base + minutes``, and ``base`` is an aware instant); a pinned fixture's
    **table** is never rewritten, and its start is left byte-identical when the
    solver echoes it unchanged (a promise is not rewritten even with its own
    bytes) — but a called match the solver slid **later** on its (unchanged)
    table has that later start persisted with ``pinned_at`` refreshed and fires
    the same "moved" correction as a broken-pin move (ADR "a called match holds
    its table and slides later"). (Physics moving a pin is the other exception —
    see the
    broken-pins section below.) No per-fixture merging, ever: the output is
    taken whole or not at all.

**Lock order: tournament → schedule_solves → tournament_fixtures.** Routes
take the tournament row lock before calling :func:`request_solve` (which takes
``FOR UPDATE`` on solve rows); phase (c) takes the same three in the same
order, so the job and the routes queue behind each other and no pair can
deadlock. Phase (a) takes only the solve-row lock — it never touches the
tournament row, so it participates in no cycle. **Three tables, deliberately,
not four**: every ``TournamentFixture`` lock here is taken ``with_for_update(of=
TournamentFixture)``, so ``tournament_event_stages`` — which rides along on
every fixture query as the eagerly-joined ``TournamentFixture.stage``
(``lazy="joined"``, ``innerjoin=True``) — is never locked. Nothing writes a
stage row on this path, so widening the lock to include it would only cost
contention for no correctness this order needs.

The **fingerprint** is a sha256 over a canonical JSON of exactly the inputs
the solver read, in their *wall-clock* form (never minute offsets, which
depend on ``now``): the table catalogue, each drawn event's ``length_games``,
reservations (id, window, tables) and *active entrant set*, and every fixture row's
identity, seating, winner, match status, placement and pin. ``now`` itself is
deliberately excluded — the clock advancing is not input drift. The entrant
set is included even though the solver never reads entry *status*, because a
mid-solve withdrawal means the draw is about to be re-cut and a plan computed
against the old field should not land.

**Broken pins: physics may move a pin, with a correction (ADR).** A pin is
inviolable against *optimization*, never against physics. The snapshot phase
detects pins physics broke, so they never reach the solver *as pins*:

* **entrant withdrew** — an entry of the fixture is ``withdrawn`` (and the
  match isn't already settled): the promised match cannot happen, so the
  fixture is **excluded** from the snapshot and carried in
  ``SolveInputs.broken_pin_voids``;
* a deleted fixture needs nothing — the pin died with its row.

Reservation membership does **not** break a pin: a director deliberately pinning a
fixture to a spare catalogue table outside its reservation's ``table_ids`` (the manual
PATCH allows off-group soft placements, ADR-0790) is a legitimate hand, and pins
are broken by physics, not preferences. Such a pin enters the snapshot as a pin
like any other — the pure module treats pins as constants and never checks a
pin's table against the reservation (or even the catalogue) — survives every solve
byte-identical, and is called by the ordinary call pass when imminent.

There **was** a third case here, "the pinned table is no longer in the venue
catalogue" (``SolveInputs.broken_pin_moves``): the fixture entered the snapshot
unpinned and was re-pinned + moved-notified at apply. It is gone, because the
state it repaired stopped being representable when ADR 20260801 landed in full.
``tournament_fixtures.table_id`` is a foreign key (so the row cannot vanish),
nothing anywhere re-parents a ``VenueTable`` onto another tournament, the
placement verb refuses a table outside *this* tournament's catalogue, and the one
route by which a table can leave a catalogue — the tournament PATCH's diff —
either refuses the removal (the named 409) or unplaces the fixtures first. Three
of the four writers of ``table_id`` in ``app/`` write a catalogue table of this
tournament and the fourth writes ``NULL``. The arm survived only because its
tests manufactured the state by re-parenting a table row onto a throwaway
tournament, which no production path performs — a guard whose only reachable
caller is its own test is not defence in depth, it is a claim that the invariant
above it is optional. The slide-later repair keeps the whole "moved" machinery
alive, so what went is the detection, not the correction.

A *planned* (unpinned) fixture needs no case at all and never did: it is
re-placed by the ordinary placement write, silently, because it was never
promised.

The *repair* is applied only by phase (c), in the same transaction and under
the same locks as every other placement write — and only on a successful
verdict (whole-or-nothing: an infeasible/failed run writes nothing, and the
still-broken pin is re-detected by every later snapshot until a solve lands).
A moved pin gets the solver's new placement with ``pinned_at`` **refreshed to
now** — the promise is renewed, not demoted to an estimate. A voided pin has
its placement columns (``table_id``, ``scheduled_start``, ``pinned_at``)
cleared — whether the draw layer later voids or deletes the fixture is its
business. Both corrections notify via ``app.match_calls.notify_pin_repairs``
(live tournaments only; moved → both entrants, cancelled → the remaining
entrant only), with the same in-app-atomic + post-commit-fan-out split as the
call. Repairs touch only fixtures that were actually **pinned**: a *planned*
fixture on a removed table is simply re-planned by the ordinary placement
write, silently — it was never promised. Because a repair rewrites the very
columns whose state triggered detection, it is self-extinguishing: the next
snapshot sees a healthy pin (or no pin) and detects nothing.

**In-progress occupancy is a proxy, documented as one.** A tournament match is
born ``pending`` and flips to ``in_progress`` when it is called (the 2026-07-17
ADR, amending ADR-0788) — but even ``in_progress`` does *not*
mean "physically on a table", and nothing records an actual start yet. The
proxy: a fixture that is pinned (called to a table), whose match is live, and
whose promised start has arrived is presumed underway from that promised
start; the pure module holds its table to ``max(estimated end, now + bucket)``
so an overrun keeps blocking. A real "match started" fact is a later drop-in
that replaces one condition here.

**Ungrouped fixtures (``reservation_id IS NULL``) ARE scheduled, over their event's own
reservation** (ADR "a reservation restricts scheduling, it does not enable it",
20260807). Until that ADR they were skipped outright — the solver's windows and
tables came from reservations, so a fixture naming none had nowhere to go — which is
why no single-elim match, no swiss match and no rr-then-ko knockout match was
ever placed. The skip is now a **branch**: a grouped fixture resolves its window
and its tables from its own reservation exactly as it always has, and an ungrouped one
resolves them from a synthetic **event-wide reservation**
(:func:`event_wide_reservation_key`) carrying the event's own ``slot``, read in the
event's zone, over the whole tournament catalogue. No reservation row is minted, and
:mod:`app.scheduling` is untouched: a fixture still binds to exactly one
reservation, and every reservation-keyed infeasibility reason reports against whichever
one it named.

**A TBD side is a separate rule, and it did not change.** A fixture missing
either entrant cannot be placed and is left out of the snapshot, grouped or not.
Ungrouped and TBD-sided fixtures alike still count toward the fingerprint, so
their arrival or resolution is drift like any other. That surviving rule is what
leaves a bracket placed only in part at first. A single-elim first round is
seeded, so its two sides are known and it is placed straight away; every round
above it, and every round of an rr-then-ko knockout stage — which waits on the
reservations feeding it — becomes placeable only as its sides resolve, at the very
re-solve a completed match already triggers.

**Swiss rides the same reservation, and for swiss that is the WHOLE event.**
An rr-then-ko draw carries *one* ungrouped stage, its knockout, while a
single-elim draw and a swiss draw are ungrouped end to end — so for those two
the event-wide reservation covers the whole event. Swiss is the case nothing
else in this module states (ADR "swiss pre-cuts every round and pairs each one
on advance"): **every** fixture of one takes its event's event-wide
reservation. Before the 20260807 ADR the only table and time a swiss fixture
ever got was one a director typed in; this module now plans one like any other,
round by round as each round is paired and its sides stop being TBD.
A manual placement (:func:`app.tournaments.place_fixture`) still pins whatever
it is given and never asks the fixture for a reservation, so a hand-placed swiss
fixture is pinned and called exactly as before — the difference is that the
solver now packs the free remainder around it rather than leaving it the only
placement the event will ever have.
"""

import hashlib
import json
import logging
import math
import os
import uuid
from collections import Counter, defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal, assert_never
from zoneinfo import ZoneInfo

from redis.exceptions import RedisError
from sqlalchemy import exists, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app import match_calls, scheduling
from app import queue as queue_module
from app.config import get_settings
from app.match_calls import _wall_now
from app.models import (
    Match,
    MatchStatus,
    ScheduleSolve,
    ScheduleSolveStatus,
    ScheduleSolveTrigger,
    SolverVerdict,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentEventStage,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.rq_async import run_async_db_job
from app.scheduling import (
    REST_MIN,
    EventId,
    EventSettings,
    FixtureId,
    InfeasibilityReason,
    InProgressMatch,
    NoSingleCause,
    PastWindow,
    Pin,
    PlacementConflict,
    PlayerConflict,
    PlayerId,
    PlayerOverSubscribed,
    PreviousPlacement,
    ReservationHasNoTables,
    ReservationId,
    ReservationOverCapacity,
    RestShadow,
    ScheduleFixture,
    ScheduleReservation,
    ScheduleSnapshot,
    SolveResult,
    TableConflict,
    TableId,
    Window,
    WindowTooShortForMatch,
    coalesce_rest_shadows,
)
from app.schemas.notification import NotificationJob
from app.schemas.schedule_solve import (
    ConflictFixtureRead,
    NoSingleCauseRead,
    PastWindowReasonRead,
    PlayerConflictRead,
    PlayerOverSubscribedRead,
    ReservationHasNoTablesRead,
    ReservationKind,
    ReservationOverCapacityRead,
    ResolvedConflict,
    ResolvedReason,
    TableConflictRead,
    WindowTooShortForMatchRead,
)
from app.schemas.tournament import MatchSettings as EventMatchSettings
from app.schemas.tournament import Reservation, Slot, TournamentTable
from app.tournament_draws import event_groups, event_reservations, group_stage_ids
from app.tournament_queries import stage_ids_for_events
from app.tournament_realtime import stage_event_entrant_hints

log = logging.getLogger(__name__)

#: The dotted path RQ resolves in the worker process — enqueued as a string,
#: like ``app.retirement_jobs.RUN_RETIREMENT_SWEEP_JOB``.
RUN_SCHEDULE_SOLVE_JOB = "app.schedule_solves.run_schedule_solve"

#: Slack, in seconds, added on top of ``get_settings().solver_time_cap_s`` to
#: get the RQ job's own ``job_timeout``. The job wraps the CP-SAT call with DB
#: work on both sides (phase (a)'s snapshot + fingerprint, phase (c)'s
#: row-locked re-read, fingerprint recompute, and fixture writes) — RQ's
#: watchdog must never be tighter than the solve it is timing, or raising
#: ``SOLVER_TIME_CAP_S`` to run a large one-off solve (the whole point of the
#: config) does nothing because RQ kills the job first.
JOB_TIMEOUT_MARGIN_S = 60

#: How many multiples of ``get_settings().solver_time_cap_s`` a ``running`` row
#: is allowed to go without a terminal write before it is presumed dead (worker
#: OOM-killed / SIGKILLed mid-run) rather than merely slow (ADR). A multiple of
#: the cap, not equal to it: the cap only bounds the solver's own call in phase
#: (b) — the lease must also cover phases (a) and (c)'s DB round-trips
#: (snapshot read, apply's locked re-read and writes, notification fan-out),
#: which run with no cap of their own. A generous multiple keeps a
#: merely-slow-but-alive run from being reaped out from under itself.
STALE_RUNNING_LEASE_MULTIPLE = 6


def _stale_running_lease_s() -> float:
    """The lease, in seconds — read lazily off the (possibly operator-raised)
    solver time cap, like ``_solve_num_workers`` and ``get_settings`` itself,
    so a large one-off solve's own raised ``SOLVER_TIME_CAP_S`` isn't reaped
    out from under itself by a lease still sized for the default."""
    return get_settings().solver_time_cap_s * STALE_RUNNING_LEASE_MULTIPLE


#: What a reaped row records — the honest fact that nothing finished it, not
#: a solver verdict.
STALE_RUNNING_ERROR = "the solve job stopped responding (worker crashed or was killed)"


def _solve_num_workers() -> int:
    """CP-SAT's search-worker portfolio size. Left unset, CP-SAT auto-sizes
    off the *node's* core count (``os.cpu_count()``), not the worker
    container's cgroup CPU limit, so under a k8s/compose CPU limit it
    oversubscribes and gets CFS-throttled (#1115). Defaulting to 1 keeps
    solves deterministic and never oversubscribed; deployments with a larger
    CPU limit raise this via env to match (the chart keeps the two in step —
    see deploy/fortymm/templates/worker.yaml). Note ``num_search_workers > 1``
    makes CP-SAT non-deterministic — the ``random_seed = 0`` in
    app.scheduling no longer pins the result once more than one worker is
    searching. Read lazily (like the rest of this module's env config) so
    tests can override it with ``monkeypatch.setenv``.
    """
    return int(os.environ.get("SOLVE_NUM_WORKERS", "1"))


#: What a drift-discarded run records. The run is ``failed`` because it is
#: honest — this run produced nothing — not because anything broke; the rerun
#: it requested is the run that will produce something.
SUPERSEDED_ERROR = "inputs changed during solve; superseded by re-run"

#: What an ``unknown`` verdict records: the time cap ran out before *any*
#: solution was found. The DB verdict enum deliberately has no ``unknown`` —
#: a run that proved nothing has no verdict at all.
TIME_CAP_ERROR = "time cap exhausted without a solution"

#: Module seam for the pure solver, so tests can interpose on the gap between
#: snapshot and apply (the drift-guard race window) without touching the DB
#: code paths around it.
_solve = scheduling.solve


def _is_stale_running(row: ScheduleSolve, *, now: datetime) -> bool:
    """Whether ``row`` has been ``running`` past its lease — presumed dead
    rather than merely slow (ADR). ``started_at`` is set in the same
    transaction the row flips to ``running``, so ``None`` here can only mean
    the row hasn't actually started running yet."""
    return (
        row.status is ScheduleSolveStatus.running
        and row.started_at is not None
        and now - row.started_at >= timedelta(seconds=_stale_running_lease_s())
    )


def _reap_stale_running(row: ScheduleSolve, *, now: datetime) -> None:
    """Mark an already-confirmed-stale, ``FOR UPDATE``-locked ``running`` row
    as failed (ADR) — the same terminal shape as an ordinary crash's
    best-effort write (:func:`_finish_failed_best_effort`), so a reaped row is
    indistinguishable from a normal one to every other reader.

    Callers must confirm :func:`_is_stale_running` themselves, under the lock,
    immediately before calling — both call sites already do, so this does not
    re-check (the job may have finished normally in the gap between an
    earlier, unlocked read and acquiring the lock; that recheck belongs to the
    caller, not duplicated here). Deliberately does not special-case
    ``rerun_requested`` — it is left exactly as the row already carries it,
    mirroring :func:`_finish_failed_best_effort`, which already silently drops
    it on an ordinary crash (ADR)."""
    row.status = ScheduleSolveStatus.failed
    row.error = STALE_RUNNING_ERROR
    row.finished_at = now


async def request_solve(
    db: AsyncSession,
    tournament_id: uuid.UUID,
    trigger: ScheduleSolveTrigger,
) -> ScheduleSolve | None:
    """Request a schedule solve for ``tournament_id`` — the one coalesced
    enqueue every trigger funnels into (ADR).

    * A ``queued`` row exists → return it: the pending run will already see
      whatever state motivated this trigger. The trigger is absorbed — the
      row keeps the trigger that *caused* it.
    * A ``running`` row exists and is still within its lease
      (``_stale_running_lease_s()``) → set ``rerun_requested`` on it and return
      it: the job re-queues (trigger ``rerun``) at finish, in the same
      transaction as its final status.
    * A ``running`` row exists but has out-lived its lease → its owning
      worker is presumed dead (OOM/SIGKILL mid-run, ADR): reap it to
      ``failed``/``STALE_RUNNING_ERROR`` and fall through to the "neither"
      branch below, so this trigger gets a fresh row rather than being
      absorbed by a job that will never finish.
    * Neither → insert a ``queued`` row and enqueue the RQ job with its id.
      Returns ``None`` only when the enqueue itself fails (Redis down): the
      row is taken back out rather than left as a zombie that would absorb
      every later trigger while no job ever runs.

    Does **not** commit — the caller owns the transaction, and callers that
    also mutate scheduling inputs must hold the tournament row lock first
    (lock order: tournament → schedule_solves; see the module docstring).
    Both selects take ``FOR UPDATE`` so a concurrent job transition
    (queued→running, running→terminal) serializes with the branch decision.
    """
    queued = (
        (
            await db.execute(
                select(ScheduleSolve)
                .where(
                    ScheduleSolve.tournament_id == tournament_id,
                    ScheduleSolve.status == ScheduleSolveStatus.queued,
                )
                .with_for_update()
            )
        )
        .scalars()
        .first()
    )
    if queued is not None:
        return queued

    running = (
        (
            await db.execute(
                select(ScheduleSolve)
                .where(
                    ScheduleSolve.tournament_id == tournament_id,
                    ScheduleSolve.status == ScheduleSolveStatus.running,
                )
                .with_for_update()
            )
        )
        .scalars()
        .first()
    )
    if running is not None:
        now = datetime.now(UTC)
        if _is_stale_running(running, now=now):
            # The row is locked (FOR UPDATE, above) and confirmed stale: the
            # worker that owned it is presumed dead (ADR). Reap it to a
            # terminal state and fall through to the "neither queued nor
            # running" branch below — this trigger gets a fresh row rather
            # than being absorbed by a job that will never run.
            # Not flushed here: the fall-through below adds a new row and
            # flushes once, carrying both this UPDATE and that INSERT.
            _reap_stale_running(running, now=now)
        else:
            running.rerun_requested = True
            await db.flush()
            return running

    row = ScheduleSolve(
        tournament_id=tournament_id,
        trigger=trigger,
        status=ScheduleSolveStatus.queued,
    )
    db.add(row)
    await db.flush()
    try:
        queue_module.get_queue().enqueue(
            RUN_SCHEDULE_SOLVE_JOB,
            str(row.id),
            job_timeout=int(get_settings().solver_time_cap_s) + JOB_TIMEOUT_MARGIN_S,
        )
    except RedisError:
        log.exception(
            "Failed to enqueue schedule solve for tournament %s", tournament_id
        )
        await db.delete(row)
        await db.flush()
        return None
    return row


async def tournament_has_drawn_event(
    db: AsyncSession, tournament_id: uuid.UUID
) -> bool:
    """Whether at least one event of this tournament has a **cut draw** — a fixture
    row under one of its events.

    The gate on the owner's Run-scheduler button: the solver places a draw's
    fixtures, so with nothing cut there is nothing to schedule and the route refuses
    (422) rather than queueing a run that would succeed at placing zero fixtures —
    a green ledger row that answers a question nobody asked. One EXISTS, not a
    count: the route needs the fact, not the number.
    """
    # ``event_id`` no longer lives on the fixture (ADR 20260815 decision 5); the event
    # is reachable through the stage.
    return (
        await db.execute(
            select(
                exists(
                    select(TournamentFixture.id)
                    .join(
                        TournamentEventStage,
                        TournamentEventStage.id == TournamentFixture.stage_id,
                    )
                    .join(
                        TournamentEvent,
                        TournamentEvent.id == TournamentEventStage.event_id,
                    )
                    .where(TournamentEvent.tournament_id == tournament_id)
                )
            )
        )
    ).scalar_one()


async def latest_solve(
    db: AsyncSession, tournament_id: uuid.UUID
) -> ScheduleSolve | None:
    """The newest row of this tournament's solve ledger, or ``None`` when no solve
    has ever been requested — what the detail BFF's solve strip renders, and what
    gates the "Run scheduler" button.

    Newest by ``requested_at``, which is what the composite index
    (``ix_schedule_solves_tournament_id_requested_at``) was built to answer; the id
    tie-break only makes the read deterministic for rows minted in the same
    transaction (a drift-discarded run and the rerun it requested share one
    ``now()``), it carries no chronology of its own.

    A row that looks stale-``running`` (ADR "a stale running solve is reaped by
    the next reader or request") is reaped in place before it is returned: a
    worker that was hard-killed mid-solve (OOM/SIGKILL) never gets to write a
    terminal status, and without this a pre-live tournament's "Run scheduler"
    button would stay disabled forever with the row wedged ``running`` and no
    trigger left that would ever call :func:`request_solve` again. The first,
    unlocked read only *suspects* staleness (this function commits nothing on
    its own path — see below); a second read re-fetches the same row by id
    ``FOR UPDATE`` and re-checks staleness under the lock, because the worker may
    have finished normally in the gap between the two reads. Only if it is
    *still* stale under the lock is it reaped and the write committed — this is
    the first GET-triggered commit in this codebase, and it is scoped tightly to
    exactly this one row's ``running`` → ``failed`` transition, not a general
    write path for this route. Otherwise (never stale, or no longer stale under
    the lock) nothing is written and the row — freshly re-read where re-read
    happened — is returned unchanged.
    """
    row = (
        await db.execute(
            select(ScheduleSolve)
            .where(ScheduleSolve.tournament_id == tournament_id)
            .order_by(ScheduleSolve.requested_at.desc(), ScheduleSolve.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if row is None or not _is_stale_running(row, now=datetime.now(UTC)):
        return row

    locked = (
        await db.execute(
            select(ScheduleSolve).where(ScheduleSolve.id == row.id).with_for_update()
        )
    ).scalar_one_or_none()
    if locked is None:
        # Cascaded away (tournament deleted) between the two reads: nothing
        # left to reap or return correctly — fall back to the stale read.
        return row

    now = datetime.now(UTC)
    if _is_stale_running(locked, now=now):
        _reap_stale_running(locked, now=now)
        await db.commit()
    return locked


#: The suffix that spells an event's **event-wide reservation** in the solver's
#: namespaced ``{event}:{reservation}`` id space (ADR "a reservation restricts
#: scheduling, it does not enable it"): the synthetic ``ScheduleReservation`` an
#: ungrouped fixture is placed in — the event's own ``slot`` for a window, the whole
#: tournament catalogue for tables.
#:
#: It cannot collide with a real reservation's key. A real key's suffix is the
#: text of a ``TournamentEventReservation.id`` — a server-minted ``uuid`` — so
#: every one of them is a UUID's canonical text, 32 hex digits and four hyphens
#: and nothing else. ``event-wide`` holds letters that are not hex digits, so no
#: UUID can ever spell it.
EVENT_WIDE_RESERVATION_SUFFIX = "event-wide"


def event_wide_reservation_key(event_id: uuid.UUID) -> ReservationId:
    """The solver ``ReservationId`` of ``event_id``'s event-wide reservation — the one
    spelling of it, so the snapshot's ``ScheduleReservation``, the fixtures that name
    it and the resolution maps keyed by it cannot drift apart."""
    return ReservationId(f"{event_id}:{EVENT_WIDE_RESERVATION_SUFFIX}")


def reservation_key(event_id: uuid.UUID, reservation_id: uuid.UUID) -> ReservationId:
    """The solver ``ReservationId`` of one **booked** reservation — the twin of
    :func:`event_wide_reservation_key`, and the one spelling of it.

    The ``ScheduleReservation`` the snapshot carries and the fixtures that name it must
    agree byte for byte, or ``app.scheduling`` refuses the snapshot as incoherent. It
    was written out as a raw f-string at both sites; one function means one edit.

    The suffix is a **reservation** id. The schedule preview
    (``app.schedule_preview``) keys its snapshot through this same function since
    #1389, so the live solve and the preview share one keyspace by construction, not
    by two f-strings that happen to agree.

    **The ``event:`` namespace is no longer needed for uniqueness, and is kept
    anyway.** It was minted when a reservation id was a per-event string and two
    events of one tournament could each hold a "reservation-a"; a reservation id is a
    globally unique uuid now (ADR 20260801), so the prefix disambiguates nothing. It
    stays because the key is a **wire value**, not an implementation detail: it is
    what a preview fixture's ``reservation_id`` carries, what a stored solve's plan is
    keyed by, and what an infeasibility reason names — dropping it would be a wire
    change with client follow-ups, and would leave every solve row already in a
    database keyed in a space nothing computes any more. It also earns its keep as a
    label: a solver reservation id that says which event it belongs to is one a human
    reading a plan or a reason can place.
    """
    return ReservationId(f"{event_id}:{reservation_id}")


def event_wide_reservation_name(event_name: str) -> str:
    """What a director reads when an infeasibility reason blames an event-wide
    reservation (ADR: "the event-wide reservation needs a name a director can
    read").

    The event's own name plus the ADR's own phrase for what it reserves. Not the
    bare event name: the no-tables copy reads "<name> has no tables assigned —
    assign at least one table to <name>", and there is no surface that assigns a
    table to an *event*, so a bare event name would send the director looking for
    a control that does not exist. Naming the venue points them at the
    tournament's table catalogue, which is the thing to fix."""
    return f"{event_name} (whole venue)"


@dataclass(frozen=True, slots=True)
class GroupReservation:
    """One group's reservation-relevant facts (#1535): the id of the reservation it
    plays in (``None`` for a group with no join row, #1387) and the id of its own
    stage. Carried as one value so :func:`group_counts_by_reservation` can test a
    group's stage against :func:`~app.tournament_draws.group_stage_ids` — the one
    predicate for "is this a group-stage group" — without a second walk of
    ``event.groups`` alongside :func:`group_reservation_ids`'s own."""

    reservation_id: uuid.UUID | None
    stage_id: uuid.UUID


def restricting_reservation_key(
    event_id: uuid.UUID,
    group_id: uuid.UUID | None,
    group_reservation_ids: Mapping[uuid.UUID, GroupReservation],
) -> ReservationId:
    """Which reservation restricts a fixture of ``event_id`` that names ``group_id``
    (ADR "a reservation restricts scheduling, it does not enable it") — the **one**
    rule every site that asks the question goes through (#1389).

    A fixture resolves to a reservation through its group: ``group_id`` names a
    **group**, and ``group_reservation_ids`` maps each group of the event to a
    :class:`GroupReservation` — its ``reservation_id`` (``None`` for a group that
    plays in none, #1387) plus its ``stage_id`` (#1535). Only ``reservation_id`` is
    read here; ``stage_id`` rides along for :func:`group_counts_by_reservation`,
    which shares this same map. The fixture takes that reservation's key
    (:func:`reservation_key`) when the hop lands on one, and the event-wide key
    (:func:`event_wide_reservation_key`) otherwise — because its group has no
    reservation (every group of an event with none booked, or a knockout stage's own
    group sharing the pool's un-mapped position, #1484).

    ``group_id`` itself stays ``uuid.UUID | None`` here for one caller only: the
    schedule *preview* walks ``app.draws.PlannedFixture``s, which are plain,
    un-persisted domain values and can still carry no group at all (see
    ``PlannedFixture.group_id``'s own docstring). Every **persisted**
    ``TournamentFixture`` names a real group (#1484's ``NOT NULL``), so the live
    solve never actually calls this with ``None`` — the ``None`` branch below
    exists so :func:`reservation_keys_by_group`'s map stays total over both
    callers, not because a stored fixture can still be groupless.

    Total: exactly one key per fixture, never a set. Two groups that share a
    reservation resolve to one key, which is what keeps the CP-SAT interval
    constraint a single interval rather than a disjunction, and what keeps the
    snapshot's reservation set one entry per reservation however many groups map to
    it. Every site asks through :func:`reservation_keys_by_group`, which is this
    rule tabulated once per event, so the solve's spec loop, its event-wide guard and
    its per-fixture lookup (and the preview's twins) agree by construction: the guard
    builds the event-wide reservation exactly when some fixture resolves to it, and
    the lookup stays total.

    The question is "which reservation", never "does it name a group". The second
    question was the defect: a fixture in a group with no reservation names a group,
    so a site asking it took the group arm and then asked for a key with no window.
    """
    booked = (
        group_reservation_ids[group_id].reservation_id if group_id is not None else None
    )
    if booked is None:
        return event_wide_reservation_key(event_id)
    return reservation_key(event_id, booked)


def group_reservation_ids(event: TournamentEvent) -> dict[uuid.UUID, GroupReservation]:
    """Group id → :class:`GroupReservation` — the id of the reservation that group
    plays in (``None`` for a group with no join row, #1387) and the id of its own
    stage (#1535) — the one place the scheduler crosses from the draw's vocabulary (a
    fixture names a **group**) into the venue's (the thing the solver constrains is a
    **reservation**). Total over the event's groups, so "no reservation" is a typed
    value a reader has to handle rather than a missing key.

    Read through the projection seam (:func:`~app.tournament_draws.event_groups`),
    not off the ORM: ``GroupRead`` carries both the mapped ``reservation_id`` and its
    own ``stage_id`` outright, so the hop has one spelling and #1370 has one place to
    change it. The live solve, the preview builder and the preview's reason resolver
    all take the map from here."""
    return {
        group.id: GroupReservation(
            reservation_id=group.reservation_id, stage_id=group.stage_id
        )
        for group in event_groups(event)
    }


def reservation_keys_by_group(
    event_id: uuid.UUID,
    group_reservation_ids: Mapping[uuid.UUID, GroupReservation],
) -> dict[uuid.UUID | None, ReservationId]:
    """Every answer :func:`restricting_reservation_key` can give for one event, keyed
    by the group a fixture names — one entry per group plus the ``None`` entry for a
    fixture that names no group — so a site walking hundreds of fixtures looks a key
    up rather than minting the same string per fixture.

    Built through the rule, not beside it, so the map cannot disagree with a direct
    call. Total over the event's fixtures: a fixture's group is in
    ``group_reservation_ids`` by its own composite foreign key, and ``None`` is here.
    The group and bracket facts behind an over-capacity reason
    (:func:`group_counts_by_reservation`) walk this same map's non-``None``
    entries."""
    keys: dict[uuid.UUID | None, ReservationId] = {
        group_id: restricting_reservation_key(event_id, group_id, group_reservation_ids)
        for group_id in group_reservation_ids
    }
    keys[None] = restricting_reservation_key(event_id, None, group_reservation_ids)
    return keys


@dataclass(frozen=True, slots=True)
class ReservationGroupCounts:
    """One reservation's group-facing facts behind the over-capacity clause (#1535):
    ``group_count``, how many **group-stage** groups' fixtures it holds, and
    ``has_bracket``, whether the knockout stage's own group (#1484) also shares it.
    Carried as one value rather than two parallel dicts, so a reader cannot read one
    without the other and have them drift out of step for the same reservation."""

    group_count: int
    has_bracket: bool


#: The answer for a reservation ``group_counts_by_reservation`` never mapped: no
#: group-stage group and no bracket. Shared so every ``.get(key, ...)`` read names
#: the same default rather than each call site re-spelling
#: ``ReservationGroupCounts(0, False)``.
NO_GROUPS_SHARE_THE_RESERVATION = ReservationGroupCounts(
    group_count=0, has_bracket=False
)


def group_counts_by_reservation(
    group_reservation_ids: Mapping[uuid.UUID, GroupReservation],
    keys_by_group: Mapping[uuid.UUID | None, ReservationId],
    stage_ids: frozenset[uuid.UUID],
) -> dict[ReservationId, ReservationGroupCounts]:
    """Each reservation's :class:`ReservationGroupCounts` (#1535): how many
    **group-stage** groups' fixtures it holds — the groups mapped to a booked
    reservation, or the groups with no reservation for the event-wide one — and
    whether the knockout stage's own group (#1484) also maps to it.

    ``stage_ids`` is :func:`~app.tournament_draws.group_stage_ids`'s answer for the
    event — the one predicate for "is this a group-stage stage", so this function
    does not ask the question a second way. A group whose stage falls outside it
    names the bracket, not a "group" the over-capacity clause should count: that was
    the defect (#1484 added the knockout stage's own group to every reader's group
    set, and this clause was the one surface that kept counting it as a plain
    group).

    A non-group-stage group is only ever the bracket when the event *has* a group
    stage to sit beside — ``stage_ids`` non-empty. A single-elim or swiss event's
    sole stage also fails ``group_stage_ids``' predicate (it does not seat both
    sides at the cut either), so with an empty ``stage_ids`` its sole group would
    match the same "outside ``stage_ids``" test as an rr-then-ko knockout's group
    does, with nothing to be the bracket relative to (Non-Goals: "Naming a bracket
    on a single_elim or swiss event"). Gating on ``stage_ids`` being non-empty is
    what tells the two cases apart, without asking ``group_stage_ids``' question a
    second way for "is this event's knockout stage" — a group whose stage sits
    outside an *empty* ``stage_ids`` is never counted either way, same as the
    ``None`` case below.

    The ``None`` entry of ``keys_by_group`` is a fixture naming no group, not a
    group, so it is not counted either way. A reservation neither dict ever maps —
    holding no group at all — is not a key of the result;
    :data:`NO_GROUPS_SHARE_THE_RESERVATION` is the reads' shared default for it. One
    rule for the live solve and the preview, so the "holds N groups[, and the
    bracket]" clause reads the same on both surfaces."""
    group_stage_counts: Counter[ReservationId] = Counter()
    bracket_keys: set[ReservationId] = set()
    for group_id, key in keys_by_group.items():
        if group_id is None:
            continue
        if group_reservation_ids[group_id].stage_id in stage_ids:
            group_stage_counts[key] += 1
        elif stage_ids:
            bracket_keys.add(key)
    return {
        key: ReservationGroupCounts(
            group_count=group_stage_counts.get(key, 0), has_bracket=key in bracket_keys
        )
        for key in {*group_stage_counts, *bracket_keys}
    }


def reservation_group_counts(
    group_counts: Mapping[ReservationId, ReservationGroupCounts], key: ReservationId
) -> ReservationGroupCounts:
    """One reservation's :class:`ReservationGroupCounts`, defaulting to
    :data:`NO_GROUPS_SHARE_THE_RESERVATION` for a reservation
    :func:`group_counts_by_reservation` never mapped. The one spelling for the four
    read sites this rides through (live solve + preview, booked + event-wide),
    instead of each repeating ``.get(key, NO_GROUPS_SHARE_THE_RESERVATION)``."""
    return group_counts.get(key, NO_GROUPS_SHARE_THE_RESERVATION)


@dataclass(frozen=True, slots=True)
class _ReservationResolution:
    """The DB-side facts an infeasibility reason needs to name a reservation a
    human can act on: its display ``name``, the ``HH:MM`` clock bounds of its
    window (already strings on the reservation's ``Slot`` — no minute→clock math), and
    which kind of ``reservation`` it is.

    ``reservation`` is what stops a remedy naming a control that does not exist
    (:data:`~app.schemas.schedule_solve.ReservationKind`): "add a table to" and
    "a smaller reservation" are reservation verbs, and an event-wide reservation already
    holds every table the tournament has. It is carried beside the name rather than
    inferred from it — a display name is copy, and bending copy to carry a fact
    is how the wrong remedy got rendered in the first place."""

    name: str
    window_start: str
    window_end: str
    reservation: ReservationKind = "booked"
    #: How many **group-stage** groups' fixtures this reservation holds (#1389,
    #: re-scoped by #1535): the group-stage groups mapped to a booked reservation, or
    #: the group-stage groups with no reservation for the event-wide one — 0 when
    #: only a knockout stage sits in it. Carried onto the over-capacity read, where a
    #: count above one points the director at "add a reservation".
    group_count: int = 0
    #: Whether the knockout stage's own group (#1484) also shares this reservation
    #: (#1535). Carried onto the over-capacity read so the client can name the
    #: bracket alongside the count without inferring it from a draw type.
    has_bracket: bool = False


@dataclass(frozen=True, slots=True)
class SolveInputs:
    """One transactional read of everything a solve consumes: the pure
    snapshot, its fingerprint, the wall-clock origin of the snapshot's minute
    frame, and the fixture rows themselves (keyed by id) so the apply that
    re-read them under lock writes to exactly the rows it fingerprinted.

    ``broken_pin_voids`` is the snapshot phase's broken-pin finding (module
    docstring): those fixtures were excluded from the snapshot and have their
    placement cleared at apply. ``withdrawn_entry_ids`` lets the cancelled
    correction pick the *remaining* entrant. Everything these sets derive from is
    fingerprinted, so a fingerprint match between snapshot and apply guarantees
    the fresh read's sets are the ones the solve was computed against. (There was
    a ``broken_pin_moves`` beside it, for a pin whose table left the venue
    catalogue; that state stopped being representable under ADR 20260801 and the
    field went with it — see the module docstring.)

    ``reservation_resolutions`` (keyed by the solver's namespaced ``ReservationId``
    string ``f"{event.id}:{reservation.id}"``) and ``fixture_best_of`` (keyed by
    ``str(fixture.id)``) are the resolution lookups the apply humanizes an
    *infeasible* solve's structured reasons through — reservation id → name+clock,
    fixture id → its event's ``length_games``. They derive from the same
    fingerprinted inputs, so the fresh read's maps match the ones the reasons
    were computed against.

    ``table_labels`` (solver ``TableId`` → the catalogue label),
    ``player_names`` (solver ``PlayerId`` — a user-id string — → display
    username), and ``fixture_matchups`` (``str(fixture.id)`` → the two players'
    usernames) are the sibling lookups the apply humanizes a solve's
    *placement conflicts* through (ADR "overlapping in-progress matches are
    tolerated and reported"). Same fingerprinted provenance, so the fresh read's
    maps resolve exactly the ids a conflict carries. ``player_names`` does
    double duty: it is also how the one *reason* that names a human
    (:class:`~app.scheduling.PlayerOverSubscribed`) is resolved — it is built
    from every drawn event's entrants, not just the in-progress ones, so it
    covers any player a pre-check can blame."""

    snapshot: ScheduleSnapshot
    fingerprint: str
    base: datetime
    fixtures: dict[uuid.UUID, TournamentFixture]
    #: Each namespaced reservation id (``"{event.id}:{reservation.id}"``) mapped to its
    #: offending-day resolver: the venue-local calendar date of its window, in
    #: the event's own timezone frame. The apply reads this to turn a pure
    #: :class:`~app.scheduling.PastWindow` reason (minute offsets + reservation id) into
    #: a named ``past_window`` date on the ledger row — the pure solver stays
    #: minute-only, and naming the wall-clock day is this DB-aware layer's job.
    reservation_dates: dict[str, date] = field(default_factory=dict)
    broken_pin_voids: frozenset[uuid.UUID] = frozenset()
    withdrawn_entry_ids: frozenset[uuid.UUID] = frozenset()
    reservation_resolutions: dict[str, _ReservationResolution] = field(
        default_factory=dict
    )
    fixture_best_of: dict[str, Literal[1, 3, 5, 7]] = field(default_factory=dict)
    table_labels: dict[str, str] = field(default_factory=dict)
    player_names: dict[str, str] = field(default_factory=dict)
    fixture_matchups: dict[str, tuple[str, str]] = field(default_factory=dict)


def _fingerprint(payload: dict[str, Any]) -> str:
    """A stable hash of the canonical-JSON form of the solver's inputs.

    ``sort_keys`` + compact separators make the encoding canonical; every list
    inside ``payload`` is already deterministically ordered by its builder
    (events and fixtures by id, catalogue and reservations in stored order, entrant
    sets sorted)."""
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def _slot_bounds(slot: Slot, tz: ZoneInfo) -> tuple[datetime, datetime]:
    """A reservation ``Slot``'s window as timezone-aware **instants**, composed from its
    ``{date, start, end}`` wall-clock components anchored by the event's venue
    ``timezone`` (ADR "tournament times are timezone-aware instants"). Anchoring
    is what puts the window on the same real-instant axis as ``now``, so an
    evening/"today" venue window is no longer mis-compared against a UTC
    wall-clock (#1068)."""
    start = datetime.strptime(f"{slot.date} {slot.start}", "%Y-%m-%d %H:%M")
    end = datetime.strptime(f"{slot.date} {slot.end}", "%Y-%m-%d %H:%M")
    return start.replace(tzinfo=tz), end.replace(tzinfo=tz)


def _rest_shadows_for(
    completed_at: datetime | None,
    entry_ids: tuple[uuid.UUID, uuid.UUID],
    entry_user: dict[uuid.UUID, uuid.UUID],
    base: datetime,
    now_min: int,
) -> list[RestShadow]:
    """The rest obligations a just-completed fixture leaves on its two humans.

    Rest across the completion boundary (``app.scheduling`` module docstring):
    a just-finished human keeps their ``REST_MIN`` floor even though the
    completed fixture is dropped from the model. Anchor on the match's stable
    completion stamp — no stamp (completed via winner alone) means no anchor, so
    no shadow. Round the anchor UP to the whole minute in the shared offset
    frame (NOT ``to_min``, which floors) so a grid-snapped start never lands a
    sub-minute short of the floor. ``completed_at`` and ``base`` are both
    timezone-aware instants now (ADR "tournament times are timezone-aware
    instants"), so the difference is a straight instant subtraction. Skip a
    window that has already closed relative to ``now`` — no future grid start >=
    now can overlap it (pure waste). One shadow per real human, on user-level ids
    so rest holds across events.
    """
    if completed_at is None:
        return []
    completed_at_min = math.ceil((completed_at - base).total_seconds() / 60)
    if completed_at_min + REST_MIN <= now_min:
        return []
    return [
        RestShadow(
            player_id=PlayerId(str(entry_user[entry_id])),
            completed_at_min=completed_at_min,
        )
        for entry_id in entry_ids
    ]


async def _load_solver_inputs(
    db: AsyncSession,
    tournament_id: uuid.UUID,
    *,
    now: datetime,
    lock: bool,
) -> SolveInputs | None:
    """Read every solver input for the tournament and shape it for the pure
    module: reservations become minute windows, pins become constants, live called
    matches become occupancy, existing unpinned placements become the
    stability tier's previous plan. Pins physics broke never reach the solver
    as pins — a pin whose table left the venue catalogue is demoted to a
    decision variable, a pin whose entrant withdrew is excluded (reservation
    membership breaks nothing — module docstring) — with the findings carried
    on the returned ``SolveInputs`` for the apply's repair (module docstring).

    ``lock=True`` (the apply phase) takes ``FOR UPDATE`` on the fixture rows,
    **ordered by id**, so concurrent placement writers (the pin tick, a
    director's manual PATCH) lock in one order and serialize instead of
    deadlocking. Returns ``None`` when the tournament no longer exists — its
    solve rows died with it by cascade, so there is nothing to record on.
    """
    tournament = (
        await db.execute(select(Tournament).where(Tournament.id == tournament_id))
    ).scalar_one_or_none()
    if tournament is None:
        return None

    events = (
        (
            await db.execute(
                select(TournamentEvent)
                .where(TournamentEvent.tournament_id == tournament_id)
                .order_by(TournamentEvent.id)
            )
        )
        .scalars()
        .all()
    )

    fixture_rows: Sequence[TournamentFixture] = []
    if events:
        # ``event_id`` no longer lives on the fixture (ADR 20260815 decision 5); the
        # event is reachable through the stage.
        fixtures_stmt = (
            select(TournamentFixture)
            .where(
                TournamentFixture.stage_id.in_(
                    stage_ids_for_events([e.id for e in events])
                )
            )
            .order_by(TournamentFixture.id)
        )
        if lock:
            # ``of=TournamentFixture``: a bare ``FOR UPDATE`` would also lock
            # ``tournament_event_stages``, which rides along on every fixture query
            # as the eagerly-joined ``TournamentFixture.stage`` (``lazy="joined"``,
            # ``innerjoin=True``). Stages are deliberately NOT part of this lock —
            # the documented "tournament → schedule_solves → tournament_fixtures"
            # order (module docstring) names three tables, not four.
            fixtures_stmt = fixtures_stmt.with_for_update(of=TournamentFixture)
        fixture_rows = (await db.execute(fixtures_stmt)).scalars().all()

    fixtures_by_event: defaultdict[uuid.UUID, list[TournamentFixture]] = defaultdict(
        list
    )
    for fixture in fixture_rows:
        fixtures_by_event[fixture.event_id].append(fixture)

    # "Every event with a cut draw": an event with no fixtures has nothing to
    # place and contributes nothing — not even to the fingerprint, so cutting
    # it later is drift (its fixtures appear) rather than a silent no-op.
    drawn_events = [event for event in events if fixtures_by_event[event.id]]

    entry_user: dict[uuid.UUID, uuid.UUID] = {}
    active_entries: defaultdict[uuid.UUID, list[str]] = defaultdict(list)
    withdrawn_entry_ids: set[uuid.UUID] = set()
    if drawn_events:
        entry_rows = (
            await db.execute(
                select(
                    TournamentEntry.id,
                    TournamentEntry.user_id,
                    TournamentEntry.status,
                    TournamentEntry.event_id,
                ).where(TournamentEntry.event_id.in_([e.id for e in drawn_events]))
            )
        ).all()
        for entry_id, user_id, entry_status, event_id in entry_rows:
            entry_user[entry_id] = user_id
            if entry_status is TournamentEntryStatus.entered:
                active_entries[event_id].append(str(entry_id))
            else:
                withdrawn_entry_ids.add(entry_id)

    # user_id → display username: the DB-aware resolution a placement conflict's
    # shared human (and each colliding fixture's matchup) is humanized through.
    # Loaded off the same entrant set the snapshot is built from — one IN-query,
    # like ``load_copy_ingredients`` — so it resolves exactly the user ids the
    # solver's PlayerIds are stringified from.
    user_names: dict[uuid.UUID, str] = {}
    if entry_user:
        user_names = {
            user_id: username
            for user_id, username in (
                await db.execute(
                    select(User.id, User.username).where(
                        User.id.in_(set(entry_user.values()))
                    )
                )
            ).all()
        }
    player_names = {str(user_id): name for user_id, name in user_names.items()}

    match_status: dict[uuid.UUID, MatchStatus] = {}
    # A completed match's stable completion stamp (``None`` for one deemed
    # completed via ``winner_entry_id`` alone), the anchor a rest shadow needs
    # to project a just-finished player's rest floor across the completion
    # boundary. Read alongside ``status`` from the same one query.
    match_completed_at: dict[uuid.UUID, datetime | None] = {}
    match_ids = [f.match_id for f in fixture_rows if f.match_id is not None]
    if match_ids:
        match_rows = (
            await db.execute(
                select(Match.id, Match.status, Match.completed_at).where(
                    Match.id.in_(match_ids)
                )
            )
        ).all()
        for match_id, status, completed_at in match_rows:
            match_status[match_id] = status
            match_completed_at[match_id] = completed_at

    # Parse the value-objects once, at this boundary, with the same models the write
    # boundary validated them with (parse, don't validate). The catalogue is rows now
    # (ADR 20260801), eagerly loaded on the tournament and already in the director's
    # order; the solver's ``TableId`` stays a string, so a table's UUID id crosses into
    # it as its text — the same text a reservation's ``table_ids`` and a fixture's
    # ``table_id`` hold.
    parsed_tables = [
        TournamentTable.model_validate(table) for table in tournament.tables
    ]
    catalogue = tuple(TableId(str(table.id)) for table in parsed_tables)
    # table_id → catalogue label: the DB-aware resolution a placement conflict's
    # shared table is humanized through (mirrors ``load_copy_ingredients``).
    table_labels = {str(table.id): table.label for table in parsed_tables}
    parsed_events: list[
        tuple[TournamentEvent, EventMatchSettings, list[Reservation]]
    ] = [
        (
            event,
            EventMatchSettings.model_validate(event.match_settings),
            event_reservations(event),
        )
        for event in drawn_events
    ]
    # The event's own ``slot``, parsed once at this boundary with the model the
    # write boundary validated it with (parse, don't validate). It is the window
    # an event-wide reservation runs in, and — being a real solver input now —
    # part of the fingerprint below.
    event_slots: dict[uuid.UUID, Slot] = {
        event.id: Slot.model_validate(event.slot) for event, _s, _p in parsed_events
    }
    # Per event: the group a fixture names → the RESERVATION key that restricts it
    # (``reservation_keys_by_group``, built through ``restricting_reservation_key``).
    # This is the one place the solver crosses from the draw's vocabulary into the
    # venue's: a ``fixture.group_id`` names a **group**, while the thing this module
    # actually constrains — a set of tables for a window — is the reservation. Keying
    # the solver on the reservation is what makes "which reservation confines this
    # fixture" a lookup rather than an assumption, and it is why the
    # ``ScheduleReservation`` set below has exactly one entry per reservation however
    # many groups map to it. Filled in the spec loop below, read by the fixture loop
    # after it.
    keys_by_event: dict[uuid.UUID, dict[uuid.UUID | None, ReservationId]] = {}

    # Reservation ids are per-event value-objects — two events may both hold a
    # "reservation-a" — so the solver's ReservationId is namespaced by the event id.
    # A reservation's ``table_ids`` are intersected with the catalogue here: the
    # catalogue and the reservations are edited by two separate PATCHes, so a
    # reservation may momentarily name a table the venue no longer has. The catalogue is
    # the venue's truth — a stale ref is a table the reservation cannot use, not a
    # reason to refuse the whole snapshot as incoherent (the raw ``table_ids`` still
    # feed the fingerprint, so the edit itself is drift like any other).
    catalogue_ids = set(catalogue)
    # One pass derives each reservation's key, bounds and usable tables; the
    # ``ScheduleReservation``s are built from these same specs below (only ``base``
    # — which needs every window start first — stands between the two).
    reservation_specs: list[tuple[str, tuple[TableId, ...], datetime, datetime]] = []
    # The offending-day resolver for a past-window reason: each reservation's
    # venue-local date is exactly the day the director entered in its Slot, in
    # the event's own frame — taken verbatim so the apply can name it without
    # re-deriving a date from minute offsets. Keyed by the same namespaced reservation
    # id the pure module carries on its ``PastWindow`` reason.
    reservation_dates: dict[str, date] = {}
    # Resolution lookups the apply humanizes an infeasible solve's reasons
    # through: solver ``ReservationId`` → the reservation's display name + ``HH:MM``
    # bounds, and fixture id → its event's ``length_games`` (``best_of``). Built off the
    # same parsed inputs the snapshot is, so they resolve exactly the ids the reasons
    # carry.
    reservation_resolutions: dict[str, _ReservationResolution] = {}
    fixture_best_of: dict[str, Literal[1, 3, 5, 7]] = {}
    # fixture id → its matchup (the two players' usernames): the DB-aware
    # resolution a placement conflict names each colliding fixture through.
    # Built in the fixture loop below, alongside ``fixture_best_of``.
    fixture_matchups: dict[str, tuple[str, str]] = {}
    for event, _settings, reservations in parsed_events:
        # The event's IANA zone anchors its reservations' wall-clock windows to real
        # instants; it is boundary-validated on write (``EventTimezone``), so
        # ``ZoneInfo`` here cannot raise on a stored value.
        event_tz = ZoneInfo(event.timezone)
        event_wide_key = event_wide_reservation_key(event.id)
        # Which reservation restricts each of this event's fixtures, by the group it
        # names — one lookup table built through the rule, used by the event-wide
        # guard and the per-fixture resolution below. Its non-None entries also feed
        # the over-capacity reason's group/bracket facts below
        # (``group_counts_by_reservation``); ``reservation_group_counts`` at the
        # reads defaults to ``NO_GROUPS_SHARE_THE_RESERVATION``, so a reservation no
        # group maps to — an event-wide one holding only a knockout stage — reports
        # 0 groups (and, there, ``has_bracket=True``), not a miss.
        group_res_ids = group_reservation_ids(event)
        keys_by_group = reservation_keys_by_group(event.id, group_res_ids)
        keys_by_event[event.id] = keys_by_group
        group_counts = group_counts_by_reservation(
            group_res_ids, keys_by_group, group_stage_ids(event)
        )
        for reservation in reservations:
            # Keyed on the reservation's OWN id, now that the projection carries
            # one — no lookup needed here (``keys_by_group`` is for the per-fixture
            # side, which only has a group id to resolve through). This loop emits
            # one spec per reservation, one entry however many groups share it.
            key = reservation_key(event.id, reservation.id)
            start, end = _slot_bounds(reservation.slot, event_tz)
            tables = tuple(
                TableId(table_id)
                for table_id in reservation.table_ids
                if TableId(table_id) in catalogue_ids
            )
            reservation_specs.append((key, tables, start, end))
            reservation_dates[key] = date.fromisoformat(reservation.slot.date)
            counts = reservation_group_counts(group_counts, key)
            reservation_resolutions[key] = _ReservationResolution(
                name=reservation.name,
                window_start=reservation.slot.start,
                window_end=reservation.slot.end,
                group_count=counts.group_count,
                has_bracket=counts.has_bracket,
            )
        if any(
            keys_by_group[fixture.group_id] == event_wide_key
            for fixture in fixtures_by_event[event.id]
        ):
            # The event-wide reservation (ADR "a reservation restricts scheduling, it
            # does not enable it"): one synthetic reservation for the event's ungrouped
            # fixtures — a single-elim or swiss draw's whole field, an
            # rr-then-ko draw's knockout stage — and, since #1387, for a grouped
            # fixture whose group plays in no reservation. Its window is the event's own
            # ``slot`` read in the event's zone; its tables are the whole
            # tournament catalogue. No reservation row exists or is minted — it lives
            # only in this snapshot.
            #
            # Keyed on "the event HAS an ungrouped fixture", not on "an
            # ungrouped fixture reached the snapshot": a knockout's fixtures
            # arrive with their sides still TBD and gain them round by round, so
            # the placeable-only rule would make the reservation (and with it
            # ``base``, the minute frame's origin) appear and disappear under a
            # running tournament. An event-wide reservation carrying no
            # placeable fixture constrains nothing and can prove no cause — the
            # pure module's per-reservation arms all require unpinned demand.
            event_slot = event_slots[event.id]
            start, end = _slot_bounds(event_slot, event_tz)
            reservation_specs.append((event_wide_key, catalogue, start, end))
            reservation_dates[event_wide_key] = date.fromisoformat(event_slot.date)
            event_wide_counts = reservation_group_counts(group_counts, event_wide_key)
            reservation_resolutions[event_wide_key] = _ReservationResolution(
                name=event_wide_reservation_name(event.name),
                window_start=event_slot.start,
                window_end=event_slot.end,
                # Not a reservation: a reason blaming this one must not be answered with
                # a reservation remedy (add a table to it, make it smaller, widen its
                # window). Its controls are the event's window and the
                # tournament's table catalogue.
                reservation="event",
                group_count=event_wide_counts.group_count,
                has_bracket=event_wide_counts.has_bracket,
            )

    # The minute frame's origin: the earliest reservation window start — a
    # reservation's, or an event-wide one's. Everything — windows, pins, previous
    # placements, ``now`` itself — is offset from it, and the apply converts
    # back with the same base.
    base = min((start for _, _, start, _ in reservation_specs), default=now)

    def to_min(moment: datetime) -> int:
        return int((moment - base).total_seconds() // 60)

    now_min = to_min(now)

    schedule_reservations = tuple(
        ScheduleReservation(
            id=ReservationId(key),
            table_ids=tables,
            window=Window(start_min=to_min(start), end_min=to_min(end)),
        )
        for key, tables, start, end in reservation_specs
    )
    event_settings = tuple(
        EventSettings(id=EventId(str(event.id)), length_games=settings.length_games)
        for event, settings, _reservations in parsed_events
    )

    schedule_fixtures: list[ScheduleFixture] = []
    in_progress: list[InProgressMatch] = []
    previous_plan: list[PreviousPlacement] = []
    rest_shadows: list[RestShadow] = []
    broken_pin_voids: set[uuid.UUID] = set()
    for event, settings, _reservations in parsed_events:
        for fixture in fixtures_by_event[event.id]:
            if fixture.entry_a_id is None or fixture.entry_b_id is None:
                # TBD side: cannot be placed; the snapshot builder leaves it
                # out (app.scheduling's contract).
                continue
            # Which reservation restricts this fixture (ADR "a reservation restricts
            # scheduling, it does not enable it"), through the one rule
            # (``restricting_reservation_key``, #1389) the spec loop built the event's
            # lookup table from: its group's booked reservation, or the event-wide one
            # for a fixture naming no group (a single-elim or swiss fixture, an
            # rr-then-ko draw's knockout stage) or a group that plays in none (#1387).
            # Exactly one reservation per fixture, looked up, which is what keeps the
            # CP-SAT interval constraint a single interval instead of a disjunction.
            # Total: a fixture's group belongs to this event's stage 0 by its own
            # composite foreign key, so it is in the map, and so is ``None``; the
            # event-wide branch is present precisely because such a fixture is.
            fixture_reservation_key = keys_by_event[event.id][fixture.group_id]
            status = (
                match_status.get(fixture.match_id)
                if fixture.match_id is not None
                else None
            )
            completed = (
                fixture.winner_entry_id is not None or status is MatchStatus.completed
            )
            pin: Pin | None = None
            if (
                fixture.pinned_at is not None
                and fixture.table_id is not None
                and fixture.scheduled_start is not None
            ):
                # Broken-pin detection (module docstring). A settled match's
                # pin is history, not a promise left to break: completed
                # fixtures are ignored by the solver whatever their pin says,
                # and a voided match is dead — never re-place or cancel one.
                settled = completed or status is MatchStatus.voided
                if not settled and (
                    fixture.entry_a_id in withdrawn_entry_ids
                    or fixture.entry_b_id in withdrawn_entry_ids
                ):
                    # An entrant withdrew: the promised match cannot happen.
                    # Excluded from the snapshot; voided at apply.
                    broken_pin_voids.add(fixture.id)
                    continue
                # Otherwise the pin stands, as-is. Its table is deliberately NOT
                # re-checked against the reservation's ``table_ids`` — an off-group pin
                # on a catalogue table is the director's hand (the manual PATCH
                # allows off-group soft placements, ADR-0790), and pins break on
                # physics, not preferences. Nor against the catalogue, which the
                # foreign key and the tournament PATCH's diff have made an
                # invariant rather than a thing to defend against here (module
                # docstring). The pure module honors it either way: pins are
                # constants there, never checked against reservation residency.
                pin = Pin(
                    table_id=TableId(fixture.table_id),
                    start_min=to_min(fixture.scheduled_start),
                )
            fixture_id = FixtureId(str(fixture.id))
            # Only placeable (both-sides-known) fixtures reach here, and
            # only such a fixture can surface in a WindowTooShortForMatch reason
            # or a placement conflict — so this is exactly the set the apply
            # resolves best_of and matchup names for. Both entries are non-None
            # (guarded above) and their users were loaded into ``user_names``.
            fixture_best_of[fixture_id] = settings.length_games
            fixture_matchups[fixture_id] = (
                user_names[entry_user[fixture.entry_a_id]],
                user_names[entry_user[fixture.entry_b_id]],
            )
            schedule_fixtures.append(
                ScheduleFixture(
                    id=fixture_id,
                    event_id=EventId(str(event.id)),
                    reservation_id=fixture_reservation_key,
                    # User-level ids, not entry ids: the no-double-booking and
                    # rest constraints hold across events, on humans.
                    player_a_id=PlayerId(str(entry_user[fixture.entry_a_id])),
                    player_b_id=PlayerId(str(entry_user[fixture.entry_b_id])),
                    pin=pin,
                    completed=completed,
                )
            )
            if completed:
                # A just-finished human keeps their rest floor even though the
                # completed fixture is dropped from the model (both entries are
                # non-None — guarded above before this branch is reached).
                rest_shadows.extend(
                    _rest_shadows_for(
                        completed_at=(
                            match_completed_at.get(fixture.match_id)
                            if fixture.match_id is not None
                            else None
                        ),
                        entry_ids=(fixture.entry_a_id, fixture.entry_b_id),
                        entry_user=entry_user,
                        base=base,
                        now_min=now_min,
                    )
                )
                continue
            if (
                pin is not None
                and status is MatchStatus.in_progress
                and fixture.scheduled_start is not None
                and fixture.scheduled_start <= now
            ):
                # The physically-underway proxy (module docstring): called,
                # match live, promised start arrived.
                in_progress.append(
                    InProgressMatch(
                        fixture_id=fixture_id,
                        table_id=pin.table_id,
                        start_min=pin.start_min,
                    )
                )
            elif (
                pin is None
                and fixture.table_id is not None
                and fixture.scheduled_start is not None
            ):
                previous_plan.append(
                    PreviousPlacement(
                        fixture_id=fixture_id,
                        table_id=TableId(fixture.table_id),
                        start_min=to_min(fixture.scheduled_start),
                    )
                )

    # One shadow per human, not per match (app.scheduling's ``RestShadow``
    # contract): a human who completed two matches within REST_MIN of each other
    # accumulated a shadow *per completion* above, which would make the whole
    # solve ``infeasible`` (#1145). Coalesce to the latest completion.
    snapshot = ScheduleSnapshot(
        table_ids=catalogue,
        reservations=schedule_reservations,
        events=event_settings,
        fixtures=tuple(schedule_fixtures),
        now_min=now_min,
        in_progress=tuple(in_progress),
        previous_plan=tuple(previous_plan),
        rest_shadows=coalesce_rest_shadows(rest_shadows),
        # Soft-window policy fact (ADR "the solver stops wedging"): once the
        # tournament is live, a reservation window's end is advisory so wall-clock
        # passing it makes the day "overrunning", not instantly infeasible.
        # Pre-live keeps the hard window (a provisional plan flags a misfit).
        is_live=tournament.status is TournamentStatus.live,
    )

    # The fingerprint payload is the *wall-clock* form of exactly these inputs
    # — never minute offsets, which shift with ``now`` and would make every
    # recompute a false drift. One dict, built here, hashed here: it crosses
    # into ``_fingerprint`` and nowhere else.
    payload: dict[str, Any] = {
        "tables": [str(table_id) for table_id in catalogue],
        "events": [
            {
                "id": str(event.id),
                "length_games": settings.length_games,
                # The event's own window and zone: what an event-wide
                # reservation is built from (ADR "a reservation restricts scheduling,
                # it does not enable it"), so an edit to either is input drift
                # the apply must discard as stale. Written for EVERY event, not
                # only the ones that have ungrouped fixtures: a payload whose
                # *shape* varied with a fact would make that fact unhashed,
                # which is the very drift this guard exists to catch.
                "timezone": event.timezone,
                "slot": {
                    "date": event_slots[event.id].date,
                    "start": event_slots[event.id].start,
                    "end": event_slots[event.id].end,
                },
                "reservations": [
                    {
                        # ``str``, because the fingerprint is canonical JSON and a
                        # ``uuid.UUID`` is not JSON-serializable — the id became one
                        # when the server started minting them (ADR 20260801).
                        "id": str(reservation.id),
                        "date": reservation.slot.date,
                        "start": reservation.slot.start,
                        "end": reservation.slot.end,
                        # The event ``timezone`` anchors this window's wall-clock
                        # to the instant the solver reads (ADR "tournament times
                        # are timezone-aware instants"), so a mid-solve zone
                        # change is input drift the apply must discard as stale.
                        "timezone": event.timezone,
                        "table_ids": list(reservation.table_ids),
                    }
                    for reservation in reservations
                ],
                "entrants": sorted(active_entries[event.id]),
            }
            for event, settings, reservations in parsed_events
        ],
        "fixtures": [
            {
                "id": str(fixture.id),
                "event_id": str(fixture.event_id),
                "reservation_id": _opt(fixture.group_id),
                "entry_a": _opt(fixture.entry_a_id),
                "entry_b": _opt(fixture.entry_b_id),
                "winner": _opt(fixture.winner_entry_id),
                "match_status": (
                    match_status[fixture.match_id].value
                    if fixture.match_id is not None and fixture.match_id in match_status
                    else None
                ),
                "table_id": fixture.table_id,
                "scheduled_start": (
                    fixture.scheduled_start.isoformat()
                    if fixture.scheduled_start is not None
                    else None
                ),
                "pinned_at": (
                    fixture.pinned_at.isoformat()
                    if fixture.pinned_at is not None
                    else None
                ),
            }
            for fixture in fixture_rows
        ],
    }

    return SolveInputs(
        snapshot=snapshot,
        fingerprint=_fingerprint(payload),
        base=base,
        fixtures={fixture.id: fixture for fixture in fixture_rows},
        reservation_dates=reservation_dates,
        broken_pin_voids=frozenset(broken_pin_voids),
        withdrawn_entry_ids=frozenset(withdrawn_entry_ids),
        reservation_resolutions=reservation_resolutions,
        fixture_best_of=fixture_best_of,
        table_labels=table_labels,
        player_names=player_names,
        fixture_matchups=fixture_matchups,
    )


def _opt(value: uuid.UUID | None) -> str | None:
    return str(value) if value is not None else None


def _resolve_reason(reason: InfeasibilityReason, inputs: SolveInputs) -> ResolvedReason:
    """Humanize one pure, id-and-minute reason into its resolved read form
    (ADR "structured data, not prose"): the reservation's display name and ``HH:MM``
    window come from ``inputs.reservation_resolutions``, ``best_of`` from
    ``inputs.fixture_best_of``, the blamed human's display name from
    ``inputs.player_names``; the integer minutes pass through untouched for
    the client to format. Direct id lookups are safe here — the apply resolves
    only after the drift guard proved this read's inputs fingerprint-identical
    to the ones the reasons were computed against, so every reservation/fixture id a
    reason carries is present in these maps (the same guarantee the placement
    write relies on when it indexes ``fresh.fixtures``).

    An exhaustive ``match`` with an ``assert_never`` floor, no catch-all: adding
    an arm to :data:`app.scheduling.InfeasibilityReason` is a type error here
    until it is handled."""
    match reason:
        case ReservationHasNoTables():
            no_tables_reservation = inputs.reservation_resolutions[
                reason.reservation_id
            ]
            return ReservationHasNoTablesRead(
                reservation_name=no_tables_reservation.name,
                reservation=no_tables_reservation.reservation,
            )
        case WindowTooShortForMatch():
            reservation = inputs.reservation_resolutions[reason.reservation_id]
            return WindowTooShortForMatchRead(
                reservation_name=reservation.name,
                reservation=reservation.reservation,
                window_start=reservation.window_start,
                window_end=reservation.window_end,
                best_of=inputs.fixture_best_of[reason.fixture_id],
                needed_min=reason.needed_min,
                window_span_min=reason.window_span_min,
            )
        case ReservationOverCapacity():
            reservation = inputs.reservation_resolutions[reason.reservation_id]
            return ReservationOverCapacityRead(
                reservation_name=reservation.name,
                reservation=reservation.reservation,
                window_start=reservation.window_start,
                window_end=reservation.window_end,
                required_min=reason.required_min,
                capacity_min=reason.capacity_min,
                table_count=reason.table_count,
                group_count=reservation.group_count,
                has_bracket=reservation.has_bracket,
            )
        case PlayerOverSubscribed():
            # The one arm that names a *human*: resolved through the same
            # ``player_names`` map the PlayerConflict humanization already uses
            # (solver PlayerId — a user-id string — → display username), built in
            # the same fingerprinted read, so no second lookup is needed.
            reservation = inputs.reservation_resolutions[reason.reservation_id]
            return PlayerOverSubscribedRead(
                player_name=inputs.player_names[reason.player_id],
                reservation_name=reservation.name,
                reservation=reservation.reservation,
                window_start=reservation.window_start,
                window_end=reservation.window_end,
                match_count=reason.match_count,
                required_min=reason.required_min,
                window_span_min=reason.window_span_min,
            )
        case NoSingleCause():
            return NoSingleCauseRead(
                required_min=reason.required_min,
                available_min=reason.available_min,
            )
        case PastWindow():
            # The offending reservation resolves to the venue-local calendar day it was
            # dated for (``inputs.reservation_dates`` — from the same fingerprinted
            # read, so the reservation is present), the actionable "which day to move"
            # fact.
            return PastWindowReasonRead(
                date=inputs.reservation_dates[reason.reservation_id]
            )
        case _:
            assert_never(reason)


def _conflict_fixture(
    fixture_id: FixtureId, inputs: SolveInputs
) -> ConflictFixtureRead:
    """Name one colliding in-progress fixture by its matchup — the two players
    facing off (``inputs.fixture_matchups``). Direct lookup is safe: the apply
    resolves only after the drift guard proved this read's inputs identical to
    the ones the conflicts were computed against, and every in-progress fixture
    a conflict names is a placeable fixture whose matchup was recorded here."""
    player_a, player_b = inputs.fixture_matchups[fixture_id]
    return ConflictFixtureRead(
        fixture_id=fixture_id, player_a=player_a, player_b=player_b
    )


def _resolve_conflict(
    conflict: PlacementConflict, inputs: SolveInputs
) -> ResolvedConflict:
    """Humanize one pure, id-only placement conflict into its resolved read form
    (ADR "overlapping in-progress matches are tolerated and reported"): the
    shared table's catalogue label comes from ``inputs.table_labels``, the
    shared human's display name from ``inputs.player_names``, and each colliding
    fixture is named by its matchup. Same direct-lookup safety as
    :func:`_resolve_reason` (post-drift-guard).

    An exhaustive ``match`` with an ``assert_never`` floor, no catch-all: adding
    an arm to :data:`app.scheduling.PlacementConflict` is a type error here until
    it is handled."""
    fixtures = [
        _conflict_fixture(fixture_id, inputs) for fixture_id in conflict.fixture_ids
    ]
    match conflict:
        case TableConflict():
            return TableConflictRead(
                table_label=inputs.table_labels[conflict.table_id],
                fixtures=fixtures,
            )
        case PlayerConflict():
            return PlayerConflictRead(
                player_name=inputs.player_names[conflict.player_id],
                fixtures=fixtures,
            )
        case _:
            assert_never(conflict)


def run_schedule_solve(schedule_solve_id: str) -> None:
    """RQ entry point: run the schedule solve named by this ledger row id.
    A thin wrapper over :func:`app.rq_async.run_async_db_job`, which owns the
    sync-entry loop-hosting and the per-run ``NullPool`` engine."""
    solve_id = uuid.UUID(schedule_solve_id)
    run_async_db_job(
        f"schedule-solve-{solve_id}",
        lambda sessionmaker: execute_solve(sessionmaker, solve_id),
    )


async def execute_solve(
    sessionmaker: async_sessionmaker[AsyncSession], solve_id: uuid.UUID
) -> None:
    """The job body, sessionmaker-injected so it is runnable anywhere a
    database is (a worker, a REPL, a test with its own engine).

    Phase (a) claims the row and snapshots; (b) solves outside any
    transaction; (c) applies under locks — see the module docstring. The
    ``except`` is the job's boundary handler (api/CLAUDE.md's "let the rest
    propagate to the handler layer" — this *is* that layer for an RQ job):
    whatever broke, the row must not be left ``running`` forever, so the
    final update is best-effort on a fresh session.
    """
    now = _wall_now()

    async with sessionmaker() as db:
        row = (
            await db.execute(
                select(ScheduleSolve)
                .where(ScheduleSolve.id == solve_id)
                .with_for_update()
            )
        ).scalar_one_or_none()
        if row is None or row.status is not ScheduleSolveStatus.queued:
            # Stale: the row was superseded, finished, or never committed
            # (an enqueue whose transaction rolled back).
            return
        tournament_id = row.tournament_id
        row.status = ScheduleSolveStatus.running
        row.started_at = datetime.now(UTC)
        # Committed on its own so that, whatever happens after, the row is
        # ``running`` and the exception handler below can finish it honestly.
        await db.commit()

    try:
        async with sessionmaker() as db:
            inputs = await _load_solver_inputs(db, tournament_id, now=now, lock=False)
            if inputs is None:
                # Tournament deleted mid-flight: the cascade already took the
                # ledger row with it; there is nothing to record on.
                return
            await db.execute(
                update(ScheduleSolve)
                .where(ScheduleSolve.id == solve_id)
                .values(input_fingerprint=inputs.fingerprint)
            )
            await db.commit()

        # (b) The solve itself, outside any transaction / open session.
        result = _solve(
            inputs.snapshot,
            time_cap_s=get_settings().solver_time_cap_s,
            num_search_workers=_solve_num_workers(),
        )

        await _apply_result(sessionmaker, solve_id, tournament_id, inputs, result)
    except Exception as exc:  # noqa: BLE001 -- the job's boundary: never leave a row running
        log.exception("Schedule solve %s failed", solve_id)
        await _finish_failed_best_effort(
            sessionmaker, solve_id, error=str(exc) or type(exc).__name__
        )


async def _apply_result(
    sessionmaker: async_sessionmaker[AsyncSession],
    solve_id: uuid.UUID,
    tournament_id: uuid.UUID,
    first: SolveInputs,
    result: SolveResult,
) -> None:
    """Phase (c): the guarded, whole-or-nothing apply (module docstring).

    A landed plan moves tables and times on the entrants' dashboard panels, so the
    active entrants of every event this apply actually *changed* get a staged
    ``dashboard.changed`` hint before the commit
    (:func:`app.tournament_realtime.stage_event_entrant_hints`). It is staged on
    the worker's own session rather than published inline: the outbox's
    ``after_commit`` listener is what makes "the plan landed" and "the players were
    told" one decision, here in the worker exactly as in the API process. A
    drift-discarded run, an infeasible one, and a re-solve that re-derives the
    identical plan all write nothing and therefore hint nobody.
    """
    async with sessionmaker() as db:
        # Lock order: tournament → schedule_solves → tournament_fixtures.
        # The full tournament row (not just the id): the call evaluation below
        # reads its status, name and table catalogue. Same lock either way.
        tournament = (
            await db.execute(
                select(Tournament)
                .where(Tournament.id == tournament_id)
                .with_for_update()
            )
        ).scalar_one_or_none()
        row = (
            await db.execute(
                select(ScheduleSolve)
                .where(ScheduleSolve.id == solve_id)
                .with_for_update()
            )
        ).scalar_one_or_none()
        if tournament is None or row is None:
            return
        if row.status is not ScheduleSolveStatus.running:
            return

        # Re-read with the fixtures row-locked, against the same wall-clock
        # base frame (the fingerprint is over wall-clock values, so the two
        # ``now``s cannot fake a drift — or hide one).
        apply_now = _wall_now()
        fresh = await _load_solver_inputs(db, tournament_id, now=apply_now, lock=True)
        finished_at = datetime.now(UTC)
        rerun_was_requested = row.rerun_requested
        row.rerun_requested = False
        row.wall_time_ms = result.stats.wall_time_ms
        row.finished_at = finished_at

        if fresh is None or fresh.fingerprint != first.fingerprint:
            # Drift: apply NOTHING. This run honestly produced nothing
            # (``failed``), and the rerun requested here — same transaction —
            # is the run that will. ``rerun_requested`` needs no separate
            # handling: the fresh queued row absorbs it.
            row.status = ScheduleSolveStatus.failed
            row.error = SUPERSEDED_ERROR
            await request_solve(db, tournament_id, ScheduleSolveTrigger.rerun)
            await db.commit()
            return

        call_fanout: list[NotificationJob] = []
        # The events whose entrants' dashboard panels this apply actually moved —
        # the realtime hint audience, gathered as the writes are made rather than
        # guessed at afterwards. A re-solve that re-derives the identical plan
        # (the steady state, since every completion triggers one) writes the same
        # bytes back and moves nobody's panel, so it must hint nobody: an empty
        # set here is the difference between a hint and a hint storm.
        moved_event_ids: set[uuid.UUID] = set()
        match result.verdict:
            case scheduling.Verdict.optimal | scheduling.Verdict.feasible:
                placed = 0
                pinned = 0
                moved_repairs: list[TournamentFixture] = []
                for placement in result.placements:
                    fixture = fresh.fixtures[uuid.UUID(placement.fixture_id)]
                    new_table = str(placement.table_id)
                    new_start = fresh.base + timedelta(minutes=placement.start_min)
                    if fixture.pinned_at is not None:
                        # A called match holds its table, but its start can be
                        # pushed LATER on a re-solve when a predecessor overruns
                        # (ADR "a called match holds its table and slides
                        # later"). The solver floors a pin at its stored start,
                        # so it can only echo that start or return a strictly
                        # later minute. An unchanged pin — off-grid start
                        # included — is byte-stable and moves no one; a slid pin
                        # falls through to the shared moved-repair path below,
                        # which persists the later start, renews ``pinned_at``,
                        # and fires the SAME "moved" correction (its
                        # ``table_id`` write is a no-op, since the solver never
                        # re-tables a pin).
                        if (
                            fixture.scheduled_start is None
                            or new_start <= fixture.scheduled_start
                        ):
                            # Unchanged: a promise's columns are never rewritten,
                            # not even with their own bytes, and nobody is told.
                            pinned += 1
                            continue
                    repaired_pin = fixture.pinned_at is not None
                    if (fixture.table_id, fixture.scheduled_start) != (
                        new_table,
                        new_start,
                    ):
                        # A placement that genuinely moved: this event's panels now
                        # show a different table or a different time.
                        moved_event_ids.add(fixture.event_id)
                    fixture.table_id = new_table
                    fixture.scheduled_start = new_start
                    if repaired_pin:
                        # A pin the solver slid later: physics moved the promise,
                        # so it is renewed — still a pin, re-dated to the moment
                        # the new placement was made — never demoted back to
                        # an estimate.
                        fixture.pinned_at = apply_now
                        moved_repairs.append(fixture)
                    placed += 1
                # Broken pins: an entrant withdrew, so the promised
                # match cannot happen and the fixture stops being schedulable.
                # Whether the draw layer later voids or deletes the fixture is
                # its business; here the placement and the pin are cleared.
                voided_repairs: list[TournamentFixture] = []
                for fixture_id in sorted(fresh.broken_pin_voids):
                    fixture = fresh.fixtures[fixture_id]
                    fixture.table_id = None
                    fixture.scheduled_start = None
                    fixture.pinned_at = None
                    voided_repairs.append(fixture)
                    moved_event_ids.add(fixture.event_id)
                row.status = ScheduleSolveStatus.succeeded
                row.verdict = (
                    SolverVerdict.optimal
                    if result.verdict is scheduling.Verdict.optimal
                    else SolverVerdict.feasible
                )
                row.fixtures_placed = placed
                row.fixtures_pinned = pinned
                # A live day whose soft window let the plan spill past a planned
                # reservation window is recorded as overrunning, not failed — the
                # schedule shows "overrunning" rather than "doesn't fit" (ADR
                # "the solver stops wedging"). False on every pre-live solve.
                row.overrunning = result.overrunning
                # One ingredients batch serves both the repair corrections and
                # the call evaluation below (they read the same fixture set) —
                # loaded only while live, since both are live-gated no-ops
                # otherwise.
                ingredients: match_calls.CopyIngredients | None = None
                if tournament.status is TournamentStatus.live:
                    ingredients = await match_calls.load_copy_ingredients(
                        db, tournament, list(fresh.fixtures.values())
                    )
                # Corrections for the repairs above — same transaction, same
                # locks, live tournaments only: moved → both entrants,
                # cancelled → the remaining entrant. In-app rows persist
                # here; push/email jobs join the post-commit fan-out.
                call_fanout = await match_calls.notify_pin_repairs(
                    db,
                    tournament,
                    moved=moved_repairs,
                    cancelled=voided_repairs,
                    withdrawn_entry_ids=fresh.withdrawn_entry_ids,
                    ingredients=ingredients,
                )
                # Call evaluation — same transaction, same locks: any fixture
                # this apply just placed inside the call-ahead window (or that
                # was already due) is pinned + its in-app notifications
                # persisted here — and an imminent silent pin (pinned
                # pre-live, count 0) gets the match_called it was owed without
                # its pinned_at or placement moving (app.match_calls'
                # notify-without-re-pin transition); the push/email fan-out is
                # enqueued after the commit below (see app.match_calls'
                # atomicity contract).
                call_fanout += await match_calls.call_due_fixtures(
                    db,
                    tournament,
                    list(fresh.fixtures.values()),
                    now=apply_now,
                    ingredients=ingredients,
                )
            case scheduling.Verdict.infeasible:
                # A designed outcome, not a failure: the solver *proved* the
                # day does not fit. No *placement* is written (the last accepted
                # plan stands) — but the run records *why*: each structured,
                # id-and-minute reason is resolved to its humanized read form
                # (reservation name + HH:MM window + best_of, minutes passed through)
                # against ``fresh``'s maps and stored as JSONB. Only this branch
                # writes ``infeasibility_reasons``; every other status leaves it
                # NULL (parsed back at read via
                # ``schemas.schedule_solve.parse_infeasibility_reasons``).
                row.status = ScheduleSolveStatus.infeasible
                row.verdict = SolverVerdict.infeasible
                # Each structured, id-and-minute reason (including the pre-live
                # ``PastWindow`` "a past day is named, not disguised" cause, whose
                # reservation id resolves to its venue-local date via
                # ``fresh.reservation_dates``) is humanized against ``fresh``'s maps and
                # stored as JSONB.
                resolved: list[ResolvedReason] = [
                    _resolve_reason(reason, fresh) for reason in result.reasons
                ]
                # ``mode="json"`` so JSON-native types land in JSONB — the
                # ``past_window`` reason carries a ``date``, which asyncpg's JSONB
                # codec cannot serialize raw; it round-trips back to a ``date`` at
                # read via ``parse_infeasibility_reasons``.
                row.infeasibility_reasons = [
                    reason.model_dump(mode="json") for reason in resolved
                ]
            case scheduling.Verdict.unknown:
                # The cap ran out before any answer. No verdict — the DB enum
                # has no ``unknown``, and a run that proved nothing has none.
                row.status = ScheduleSolveStatus.failed
                row.error = TIME_CAP_ERROR

        # Placement conflicts are orthogonal to the verdict (ADR "overlapping
        # in-progress matches are tolerated and reported"): the solver reports
        # in-progress-vs-in-progress overlaps on ANY verdict — a fully-placed
        # ``optimal``/``feasible`` board can carry them, and so can an
        # ``infeasible``/``unknown`` one — so this write is NOT gated on a
        # branch above. Resolved (ids → player names, table labels) against the
        # same fingerprint-matched ``fresh`` maps the reasons use, and always a
        # list (``[]`` when there were none) so the read boundary never sees
        # NULL for an applied run. Parsed back at read via
        # ``schemas.schedule_solve.parse_placement_conflicts``.
        row.placement_conflicts = [
            _resolve_conflict(conflict, fresh).model_dump()
            for conflict in result.conflicts
        ]

        # The realtime hint for the players whose panels this apply moved. Staged
        # on this session — the same outbox the API-process write paths use, which
        # is exactly why the publisher is synchronous: this runs in the RQ worker,
        # with no event loop to await a publish into, and the ``after_commit``
        # listener on the commit below is what puts the hints on the wire. Nothing
        # is staged on the drift path (it returned above having written nothing) or
        # on an infeasible/unknown verdict, which place nothing.
        await stage_event_entrant_hints(db, sorted(moved_event_ids))
        if rerun_was_requested:
            await request_solve(db, tournament_id, ScheduleSolveTrigger.rerun)
        await db.commit()
    # Post-commit, by design: the pins and their in-app rows are durable;
    # push/email fan-out is best-effort (app.match_calls module docstring).
    match_calls.enqueue_call_fanout(call_fanout)


async def _finish_failed_best_effort(
    sessionmaker: async_sessionmaker[AsyncSession],
    solve_id: uuid.UUID,
    *,
    error: str,
) -> None:
    """Terminal write for a crashed run — best-effort, on a fresh session (the
    one that crashed may hold a broken transaction). Guarded on ``running`` so
    it can never clobber a terminal status a completed apply already wrote."""
    try:
        async with sessionmaker() as db:
            await db.execute(
                update(ScheduleSolve)
                .where(
                    ScheduleSolve.id == solve_id,
                    ScheduleSolve.status == ScheduleSolveStatus.running,
                )
                .values(
                    status=ScheduleSolveStatus.failed,
                    error=error,
                    finished_at=datetime.now(UTC),
                )
            )
            await db.commit()
    except Exception:  # noqa: BLE001 -- best-effort by contract; the failure is already logged
        log.exception(
            "Could not record failure on schedule solve %s (error was: %s)",
            solve_id,
            error,
        )
