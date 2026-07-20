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
    tournament, compute the input fingerprint, commit. Wall-clock times (naive
    ``scheduled_start`` timestamps, pool ``Slot`` date+HH:MM strings) become
    minute offsets from a per-tournament base — the earliest pool window start
    — because the pure module speaks only ``int`` minutes in one shared frame.
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
    returned placement for an *unpinned* fixture is written back as wall-clock
    (``base + minutes``); a pinned fixture's **table** is never rewritten, and
    its start is left byte-identical when the solver echoes it unchanged (a
    promise is not rewritten even with its own bytes) — but a called match the
    solver slid **later** on its (unchanged) table has that later start
    persisted with ``pinned_at`` refreshed and fires the same "moved"
    correction as a broken-pin move (ADR "a called match holds its table and
    slides later"). (Physics moving a pin is the other exception — see the
    broken-pins section below.) No per-fixture merging, ever: the output is
    taken whole or not at all.

**Lock order: tournament → schedule_solves → tournament_fixtures.** Routes
take the tournament row lock before calling :func:`request_solve` (which takes
``FOR UPDATE`` on solve rows); phase (c) takes the same three in the same
order, so the job and the routes queue behind each other and no pair can
deadlock. Phase (a) takes only the solve-row lock — it never touches the
tournament row, so it participates in no cycle.

The **fingerprint** is a sha256 over a canonical JSON of exactly the inputs
the solver read, in their *wall-clock* form (never minute offsets, which
depend on ``now``): the table catalogue, each drawn event's ``length_games``,
pools (id, window, tables) and *active entrant set*, and every fixture row's
identity, seating, winner, match status, placement and pin. ``now`` itself is
deliberately excluded — the clock advancing is not input drift. The entrant
set is included even though the solver never reads entry *status*, because a
mid-solve withdrawal means the draw is about to be re-cut and a plan computed
against the old field should not land.

**Broken pins: physics may move a pin, with a correction (ADR).** A pin is
inviolable against *optimization*, never against physics. The snapshot phase
detects pins physics broke, so they never reach the solver *as pins*:

* **table gone** — the pinned ``table_id`` is no longer in the venue
  **catalogue**: the fixture enters the snapshot **unpinned** (the solver
  re-places it), and its id is carried in ``SolveInputs.broken_pin_moves``.
  Pool membership does **not** break a pin: a director deliberately pinning a
  fixture to a spare catalogue table outside its pool's ``table_ids`` (the
  manual PATCH allows off-pool soft placements, ADR-0790) is a legitimate
  hand, and pins are broken by physics, not preferences. Such a pin enters
  the snapshot as a pin like any other — the pure module treats pins as
  constants and never checks a pin's table against the pool (or even the
  catalogue) — survives every solve byte-identical, and is called by the
  ordinary call pass when imminent;
* **entrant withdrew** — an entry of the fixture is ``withdrawn`` (and the
  match isn't already settled): the promised match cannot happen, so the
  fixture is **excluded** from the snapshot and carried in
  ``SolveInputs.broken_pin_voids``;
* a deleted fixture needs nothing — the pin died with its row.

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

Un-pooled fixtures (``pool_id IS NULL`` — single-elim, an rr-then-ko KO
stage) are not scheduled: the solver's windows come from pools (KO-stage
scheduling is a designed later layer, per the ADR). Fixtures with a TBD side
cannot be placed and are left out of the snapshot; both still count toward the
fingerprint, so their arrival or resolution is drift like any other.
"""

import hashlib
import json
import logging
import math
import os
import uuid
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, assert_never

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
    TournamentFixture,
    TournamentStatus,
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
    Pin,
    PlayerId,
    PoolHasNoTables,
    PoolId,
    PoolOverCapacity,
    PreviousPlacement,
    RestShadow,
    ScheduleFixture,
    SchedulePool,
    ScheduleSnapshot,
    SolveResult,
    TableId,
    Window,
    WindowTooShortForMatch,
)
from app.schemas.notification import NotificationJob
from app.schemas.schedule_solve import (
    NoSingleCauseRead,
    PoolHasNoTablesRead,
    PoolOverCapacityRead,
    ResolvedReason,
    WindowTooShortForMatchRead,
)
from app.schemas.tournament import MatchSettings as EventMatchSettings
from app.schemas.tournament import Pool, Slot, TournamentTable
from app.tournament_draws import event_pools

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
    see deploy/uat/templates/worker.yaml). Note ``num_search_workers > 1``
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
    return (
        await db.execute(
            select(
                exists(
                    select(TournamentFixture.id)
                    .join(
                        TournamentEvent,
                        TournamentEvent.id == TournamentFixture.event_id,
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


@dataclass(frozen=True, slots=True)
class _PoolResolution:
    """The DB-side facts an infeasibility reason needs to name a pool a human
    can act on: its display ``name`` and the ``HH:MM`` clock bounds of its
    window (already strings on the pool's ``Slot`` — no minute→clock math)."""

    name: str
    window_start: str
    window_end: str


@dataclass(frozen=True, slots=True)
class SolveInputs:
    """One transactional read of everything a solve consumes: the pure
    snapshot, its fingerprint, the wall-clock origin of the snapshot's minute
    frame, and the fixture rows themselves (keyed by id) so the apply that
    re-read them under lock writes to exactly the rows it fingerprinted.

    The ``broken_pin_*`` sets are the snapshot phase's broken-pin findings
    (module docstring): ``broken_pin_moves`` entered the snapshot unpinned and
    are re-pinned+notified at apply; ``broken_pin_voids`` were excluded from
    the snapshot and have their placement cleared at apply.
    ``withdrawn_entry_ids`` lets the cancelled correction pick the *remaining*
    entrant. Everything these sets derive from is fingerprinted, so a
    fingerprint match between snapshot and apply guarantees the fresh read's
    sets are the ones the solve was computed against.

    ``pool_resolutions`` (keyed by the solver's namespaced ``PoolId`` string
    ``f"{event.id}:{pool.id}"``) and ``fixture_best_of`` (keyed by
    ``str(fixture.id)``) are the resolution lookups the apply humanizes an
    *infeasible* solve's structured reasons through — pool id → name+clock,
    fixture id → its event's ``length_games``. They derive from the same
    fingerprinted inputs, so the fresh read's maps match the ones the reasons
    were computed against."""

    snapshot: ScheduleSnapshot
    fingerprint: str
    base: datetime
    fixtures: dict[uuid.UUID, TournamentFixture]
    broken_pin_moves: frozenset[uuid.UUID] = frozenset()
    broken_pin_voids: frozenset[uuid.UUID] = frozenset()
    withdrawn_entry_ids: frozenset[uuid.UUID] = frozenset()
    pool_resolutions: dict[str, _PoolResolution] = field(default_factory=dict)
    fixture_best_of: dict[str, Literal[1, 3, 5, 7]] = field(default_factory=dict)


def _fingerprint(payload: dict[str, Any]) -> str:
    """A stable hash of the canonical-JSON form of the solver's inputs.

    ``sort_keys`` + compact separators make the encoding canonical; every list
    inside ``payload`` is already deterministically ordered by its builder
    (events and fixtures by id, catalogue and pools in stored order, entrant
    sets sorted)."""
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def _slot_bounds(slot: Slot) -> tuple[datetime, datetime]:
    """A pool ``Slot``'s window as naive wall-clock datetimes — the venue's own
    frame, the same one ``scheduled_start`` lives in (ADR-0790)."""
    start = datetime.strptime(f"{slot.date} {slot.start}", "%Y-%m-%d %H:%M")
    end = datetime.strptime(f"{slot.date} {slot.end}", "%Y-%m-%d %H:%M")
    return start, end


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
    sub-minute short of the floor, normalizing the aware stamp into the naive
    wall-clock frame ``now`` and ``base`` live in first. Skip a window that has
    already closed relative to ``now`` — no future grid start >= now can overlap
    it (pure waste). One shadow per real human, on user-level ids so rest holds
    across events.
    """
    if completed_at is None:
        return []
    completed_local = completed_at.astimezone().replace(tzinfo=None)
    completed_at_min = math.ceil((completed_local - base).total_seconds() / 60)
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
    module: pools become minute windows, pins become constants, live called
    matches become occupancy, existing unpinned placements become the
    stability tier's previous plan. Pins physics broke never reach the solver
    as pins — a pin whose table left the venue catalogue is demoted to a
    decision variable, a pin whose entrant withdrew is excluded (pool
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
        fixtures_stmt = (
            select(TournamentFixture)
            .where(TournamentFixture.event_id.in_([e.id for e in events]))
            .order_by(TournamentFixture.id)
        )
        if lock:
            fixtures_stmt = fixtures_stmt.with_for_update()
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

    # Parse the JSONB value-objects once, at this boundary, with the same
    # models the write boundary validated them with (parse, don't validate).
    catalogue = tuple(
        TableId(TournamentTable.model_validate(table).id)
        for table in tournament.table_catalogue
    )
    parsed_events: list[tuple[TournamentEvent, EventMatchSettings, list[Pool]]] = [
        (
            event,
            EventMatchSettings.model_validate(event.match_settings),
            event_pools(event),
        )
        for event in drawn_events
    ]

    # Pool ids are per-event value-objects — two events may both hold a
    # "pool-a" — so the solver's PoolId is namespaced by the event id.
    # A pool's ``table_ids`` are intersected with the catalogue here: the
    # catalogue and the pools are edited by two separate PATCHes, so a pool
    # may momentarily name a table the venue no longer has. The catalogue is
    # the venue's truth — a stale ref is a table the pool cannot use, not a
    # reason to refuse the whole snapshot as incoherent (the raw ``table_ids``
    # still feed the fingerprint, so the edit itself is drift like any other).
    catalogue_ids = set(catalogue)
    # One pass derives each pool's key, bounds and usable tables; the
    # ``SchedulePool``s are built from these same specs below (only ``base``
    # — which needs every window start first — stands between the two).
    pool_specs: list[tuple[str, tuple[TableId, ...], datetime, datetime]] = []
    # Resolution lookups the apply humanizes an infeasible solve's reasons
    # through: solver ``PoolId`` → the pool's display name + ``HH:MM`` bounds,
    # and fixture id → its event's ``length_games`` (``best_of``). Built off the
    # same parsed inputs the snapshot is, so they resolve exactly the ids the
    # reasons carry.
    pool_resolutions: dict[str, _PoolResolution] = {}
    fixture_best_of: dict[str, Literal[1, 3, 5, 7]] = {}
    for event, _settings, pools in parsed_events:
        for pool in pools:
            key = f"{event.id}:{pool.id}"
            start, end = _slot_bounds(pool.slot)
            tables = tuple(
                TableId(table_id)
                for table_id in pool.table_ids
                if TableId(table_id) in catalogue_ids
            )
            pool_specs.append((key, tables, start, end))
            pool_resolutions[key] = _PoolResolution(
                name=pool.name,
                window_start=pool.slot.start,
                window_end=pool.slot.end,
            )

    # The minute frame's origin: the earliest pool window start. Everything —
    # windows, pins, previous placements, ``now`` itself — is offset from it,
    # and the apply converts back with the same base.
    base = min((start for _, _, start, _ in pool_specs), default=now)

    def to_min(moment: datetime) -> int:
        return int((moment - base).total_seconds() // 60)

    now_min = to_min(now)

    schedule_pools = tuple(
        SchedulePool(
            id=PoolId(key),
            table_ids=tables,
            window=Window(start_min=to_min(start), end_min=to_min(end)),
        )
        for key, tables, start, end in pool_specs
    )
    event_settings = tuple(
        EventSettings(id=EventId(str(event.id)), length_games=settings.length_games)
        for event, settings, _pools in parsed_events
    )

    schedule_fixtures: list[ScheduleFixture] = []
    in_progress: list[InProgressMatch] = []
    previous_plan: list[PreviousPlacement] = []
    rest_shadows: list[RestShadow] = []
    broken_pin_moves: set[uuid.UUID] = set()
    broken_pin_voids: set[uuid.UUID] = set()
    for event, settings, _pools in parsed_events:
        for fixture in fixtures_by_event[event.id]:
            if fixture.pool_id is None:
                # Un-pooled (single-elim / a KO stage): no pool, no window —
                # KO scheduling is a later layer (module docstring).
                continue
            if fixture.entry_a_id is None or fixture.entry_b_id is None:
                # TBD side: cannot be placed; the snapshot builder leaves it
                # out (app.scheduling's contract).
                continue
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
                    # Case (b), entrant withdrew: the promised match cannot
                    # happen. Excluded from the snapshot; voided at apply.
                    broken_pin_voids.add(fixture.id)
                    continue
                if not settled and TableId(fixture.table_id) not in catalogue_ids:
                    # Case (a), table gone from the venue CATALOGUE: enters
                    # the snapshot UNPINNED so the solver re-places it;
                    # re-pinned + moved-notified at apply. The pool's
                    # table_ids are deliberately NOT consulted — an off-pool
                    # pin on a catalogue table is the director's hand (the
                    # manual PATCH allows off-pool soft placements, ADR-0790),
                    # and pins break on physics, not preferences. The pure
                    # module honors it as-is: pins are constants there, never
                    # checked against pool residency.
                    broken_pin_moves.add(fixture.id)
                else:
                    pin = Pin(
                        table_id=TableId(fixture.table_id),
                        start_min=to_min(fixture.scheduled_start),
                    )
            fixture_id = FixtureId(str(fixture.id))
            # Only placeable (pooled, both-sides-known) fixtures reach here, and
            # only such a fixture can surface in a WindowTooShortForMatch reason —
            # so this is exactly the set the apply resolves best_of for.
            fixture_best_of[fixture_id] = settings.length_games
            schedule_fixtures.append(
                ScheduleFixture(
                    id=fixture_id,
                    event_id=EventId(str(event.id)),
                    pool_id=PoolId(f"{event.id}:{fixture.pool_id}"),
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
    # contract): a human who completed two matches within REST_MIN of each
    # other accumulated a shadow *per completion* above — two fixed rest
    # intervals that land under the solver's per-player ``AddNoOverlap`` and are
    # mutually unsatisfiable, turning ONE player's close completions into a
    # whole-tournament ``infeasible`` (#1145). Coalesce to the latest
    # completion: rest is "time since your last match", so the max
    # ``completed_at_min`` per human subsumes every earlier one.
    latest_shadow: dict[PlayerId, RestShadow] = {}
    for shadow in rest_shadows:
        existing = latest_shadow.get(shadow.player_id)
        if existing is None or shadow.completed_at_min > existing.completed_at_min:
            latest_shadow[shadow.player_id] = shadow

    snapshot = ScheduleSnapshot(
        table_ids=catalogue,
        pools=schedule_pools,
        events=event_settings,
        fixtures=tuple(schedule_fixtures),
        now_min=now_min,
        in_progress=tuple(in_progress),
        previous_plan=tuple(previous_plan),
        rest_shadows=tuple(latest_shadow.values()),
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
                "pools": [
                    {
                        "id": pool.id,
                        "date": pool.slot.date,
                        "start": pool.slot.start,
                        "end": pool.slot.end,
                        "table_ids": list(pool.table_ids),
                    }
                    for pool in pools
                ],
                "entrants": sorted(active_entries[event.id]),
            }
            for event, settings, pools in parsed_events
        ],
        "fixtures": [
            {
                "id": str(fixture.id),
                "event_id": str(fixture.event_id),
                "pool_id": fixture.pool_id,
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
        broken_pin_moves=frozenset(broken_pin_moves),
        broken_pin_voids=frozenset(broken_pin_voids),
        withdrawn_entry_ids=frozenset(withdrawn_entry_ids),
        pool_resolutions=pool_resolutions,
        fixture_best_of=fixture_best_of,
    )


def _opt(value: uuid.UUID | None) -> str | None:
    return str(value) if value is not None else None


def _resolve_reason(reason: InfeasibilityReason, inputs: SolveInputs) -> ResolvedReason:
    """Humanize one pure, id-and-minute reason into its resolved read form
    (ADR "structured data, not prose"): the pool's display name and ``HH:MM``
    window come from ``inputs.pool_resolutions``, ``best_of`` from
    ``inputs.fixture_best_of``; the integer minutes pass through untouched for
    the client to format. Direct id lookups are safe here — the apply resolves
    only after the drift guard proved this read's inputs fingerprint-identical
    to the ones the reasons were computed against, so every pool/fixture id a
    reason carries is present in these maps (the same guarantee the placement
    write relies on when it indexes ``fresh.fixtures``).

    An exhaustive ``match`` with an ``assert_never`` floor, no catch-all: adding
    an arm to :data:`app.scheduling.InfeasibilityReason` is a type error here
    until it is handled."""
    match reason:
        case PoolHasNoTables():
            return PoolHasNoTablesRead(
                pool_name=inputs.pool_resolutions[reason.pool_id].name
            )
        case WindowTooShortForMatch():
            pool = inputs.pool_resolutions[reason.pool_id]
            return WindowTooShortForMatchRead(
                pool_name=pool.name,
                window_start=pool.window_start,
                window_end=pool.window_end,
                best_of=inputs.fixture_best_of[reason.fixture_id],
                needed_min=reason.needed_min,
                window_span_min=reason.window_span_min,
            )
        case PoolOverCapacity():
            pool = inputs.pool_resolutions[reason.pool_id]
            return PoolOverCapacityRead(
                pool_name=pool.name,
                window_start=pool.window_start,
                window_end=pool.window_end,
                required_min=reason.required_min,
                capacity_min=reason.capacity_min,
                table_count=reason.table_count,
            )
        case NoSingleCause():
            return NoSingleCauseRead(
                required_min=reason.required_min,
                available_min=reason.available_min,
            )
        case _:
            assert_never(reason)


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
    """Phase (c): the guarded, whole-or-nothing apply (module docstring)."""
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
        match result.verdict:
            case scheduling.Verdict.optimal | scheduling.Verdict.feasible:
                placed = 0
                pinned = 0
                moved_repairs: list[TournamentFixture] = []
                for placement in result.placements:
                    fixture = fresh.fixtures[uuid.UUID(placement.fixture_id)]
                    if (
                        fixture.pinned_at is not None
                        and fixture.id not in fresh.broken_pin_moves
                    ):
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
                        new_start = fresh.base + timedelta(minutes=placement.start_min)
                        if (
                            fixture.scheduled_start is None
                            or new_start <= fixture.scheduled_start
                        ):
                            # Unchanged: a promise's columns are never rewritten,
                            # not even with their own bytes, and nobody is told.
                            pinned += 1
                            continue
                    repaired_pin = fixture.pinned_at is not None
                    fixture.table_id = str(placement.table_id)
                    fixture.scheduled_start = fresh.base + timedelta(
                        minutes=placement.start_min
                    )
                    if repaired_pin:
                        # Broken pin, case (a): physics moved the promise, so
                        # it is renewed — still a pin, re-dated to the moment
                        # the new placement was made — never demoted back to
                        # an estimate.
                        fixture.pinned_at = apply_now
                        moved_repairs.append(fixture)
                    placed += 1
                # Broken pins, case (b): an entrant withdrew, so the promised
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
                row.status = ScheduleSolveStatus.succeeded
                row.verdict = (
                    SolverVerdict.optimal
                    if result.verdict is scheduling.Verdict.optimal
                    else SolverVerdict.feasible
                )
                row.fixtures_placed = placed
                row.fixtures_pinned = pinned
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
                # (pool name + HH:MM window + best_of, minutes passed through)
                # against ``fresh``'s maps and stored as JSONB. Only this branch
                # writes ``infeasibility_reasons``; every other status leaves it
                # NULL (parsed back at read via
                # ``schemas.schedule_solve.parse_infeasibility_reasons``).
                row.status = ScheduleSolveStatus.infeasible
                row.verdict = SolverVerdict.infeasible
                resolved: list[ResolvedReason] = [
                    _resolve_reason(reason, fresh) for reason in result.reasons
                ]
                row.infeasibility_reasons = [reason.model_dump() for reason in resolved]
            case scheduling.Verdict.unknown:
                # The cap ran out before any answer. No verdict — the DB enum
                # has no ``unknown``, and a run that proved nothing has none.
                row.status = ScheduleSolveStatus.failed
                row.error = TIME_CAP_ERROR

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
