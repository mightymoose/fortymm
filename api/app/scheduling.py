"""Schedule solving — the *pure* CP-SAT placement domain (ADR "the schedule is
solved; the call is pinned").

The solver owns **placement only**: which table a fixture runs on and when it
starts, over 5-minute buckets. Pairings, pools, and rounds belong to the pure
``DrawStrategy`` family (:mod:`app.draws`, ADR-0786) and arrive here already
decided. Like ``draws``, this module is pure: it holds no session, issues no
query, imports no FastAPI and no SQLAlchemy construct — its input is a frozen
:class:`ScheduleSnapshot` built from literals, and its output is a frozen
:class:`SolveResult`, so a solve is re-runnable anywhere (a REPL, a script, a
test) without a database. Converting wall-clock timestamps to the minute
offsets used throughout is the *snapshot builder's* job (a later slice), not
this module's: every time here is an ``int`` minute offset in one shared frame.

**Two tiers: a plan is an estimate, a call is a promise.** Unpinned fixtures
are free decision variables in both dimensions. A **called** (pinned, not-yet-
started) fixture holds its *table* as a hard constant — it can never be re-placed
onto another court — but its *start* is a free variable that can only be pushed
**later** (``start ≥ pin.start_min``, the promised time as a floor). The start is
anchored downward at the same weight as an unpinned fixture's wait (see the
objective below): with no contention it sits exactly at the floor — the promised
time, no drift — and under contention it slides to the *minimum* legal later
value, just past the obstruction. The start is deliberately **not** snapped to
the :data:`BUCKET_MIN` grid: ``pin.start_min`` may itself be off-grid (a manual
director PATCH, a call tick), and snapping would both re-introduce drift and
over-delay the slide. Pins still outrank windows: a called match pushed past its
pool window by overrun keeps running (no window constraint is applied to it).

Because a called match's start can always slide to the horizon, pins essentially
**stop being a source of infeasibility**: the two promise contradictions that
used to make a day infeasible — *two called matches promised the same table at
overlapping times* and *a called match under an in-progress overrun* — now
auto-resolve by sliding one later on the same table (the apply path notifies the
player, a separate concern). Infeasibility becomes almost entirely a property of
*unpinned* fixtures that cannot fit their pool window — and when it happens the
solve **explains itself with a structured, resolved reason** (a discriminated
:data:`InfeasibilityReason` union carried on :attr:`SolveResult.reasons`) rather
than a bare verdict: pins outrank windows, so a pin is never named as the cause.
A **genuinely in-progress** (being-played) match is different: it stays fully
fixed in both dimensions — reality is not a variable, and a match underway must
never move.

**Overlapping in-progress facts are tolerated, not fatal.** Two in-progress
blocks recorded on the same table, or one human in two of them at once, are
never physical truth — a table holds one match, a human plays one — so they can
only be contradictory data from a director's *soft* manual placement PATCH. A
naïve model would hand two rigid, overlapping fixed intervals to ``AddNoOverlap``
and prove the WHOLE day infeasible, blanking every placement over one bad pin
(#1144). Instead, before ``AddNoOverlap`` the *fixed* obstacle intervals on each
resource (in-progress occupancy plus rest shadows) are **merged into their
union**: fixed-vs-fixed can then never force infeasibility, while every variable
interval still routes conservatively around the merged occupancy (nobody else is
scheduled onto a genuinely-held table or human). The solver does **not** pick
which of the colliding matches is "real" and never moves, re-times, or drops a
live match; it reports the in-progress-vs-in-progress overlaps as
:data:`PlacementConflict`s on :attr:`SolveResult.conflicts` — orthogonal to the
verdict, so a fully-placed ``optimal`` board can still carry them — for the
director to resolve. Rest-shadow overlaps are merged the same way but not
reported (they are not a director-actionable double-booking).

**Rest across the completion boundary.** A player's 10-minute rest floor
(:data:`REST_MIN`) is a hard constraint, and it must survive a match *ending*,
not just a match running. A completed fixture occupies nothing and appears in
no output — it is dropped from the model like it never was — so a recently-
completed match instead projects a per-human **rest shadow**: a fixed interval
``[completed_at, completed_at + REST_MIN]`` on that human's per-player list,
exactly like the rest padding an in-progress or pinned match carries. That
keeps the freed table idle rather than re-calling the just-finished player into
zero rest. A shadow is an orthogonal per-human input (one entry per human, not
per match), independent of the fixtures; the module adds :data:`REST_MIN` so
the floor stays this one module's single source of truth.

**Objective**, three strictly separated tiers (minimized):

1. **Makespan** — the max end over every active fixture. The day finishes as
   early as possible.
2. **Player wait**, proxied as the sum of ``start − now`` over every fixture
   with a start variable — unpinned *and* called (a called match's slide is
   anchored down here, at the same weight, so its start bottoms out at the
   promised floor). The true quantity ("wait beyond the rest floor between a
   player's consecutive matches") needs per-player sequencing variables; total
   start-lateness is monotone with aggregate waiting around, is linear, and
   keeps the model small. Documented trade-off: it also rewards starting the
   whole day promptly, which is indistinguishable from the real goal on the
   instances this serves.
3. **Stability** — the count of unpinned fixtures whose ``(table, start)``
   differs from ``previous_plan``. The board should not churn cosmetically.

The weights are computed **per instance** so the tiers provably never trade
(the fixed "10000/10/1" style breaks once total wait can swing by more than
one makespan minute times the ratio): ``W_stability = 1``,
``W_wait = max stability swing + 1``, ``W_makespan = W_wait · (max total wait
swing) + 1``. The max total wait swing is bounded by the *count* of wait terms
times the span — and that count is now ``len(unpinned) + len(pinned)``, since a
called match contributes a wait term too. A called match's ``start − now`` can
be *negative* when its promised floor is before ``now`` (a call already ticked
past); a negative term only lowers the total, so bounding the positive swing by
``count · span`` still holds. All fit comfortably in int64 at any realistic
instance size.

**Warm start.** Before solving, every unpinned fixture that has a
``previous_plan`` entry *whose prior table is still in its pool* seeds its prior
``(table, start)`` back into the model as a CP-SAT hint (``AddHint`` on the
bucket, the start, and the table presence bools). A mostly-unchanged re-solve
therefore begins the search *at* the previous plan and only has to repair the
local delta, rather than rediscovering the whole board from scratch. Fixtures
with no prior entry — or whose prior table has left the pool (a forced move) —
get no hint and solve fresh; the solver derives ``same_start``/``kept``/
``makespan`` from the hinted values itself and repairs any partial
infeasibility. Crucially a hint only *orders the search* — it can never change
which solution is optimal, so correctness is untouched and only speed changes.

**Verdict.** CP-SAT's OPTIMAL/FEASIBLE map directly; INFEASIBLE returns an
empty placement set and *never raises* — infeasibility is the point of
pre-live solves, a designed outcome, not an error. UNKNOWN (time cap exhausted
before *any* solution was found) is its own verdict rather than a lie in
either direction: it neither proved the day doesn't fit nor produced a plan.
MODEL_INVALID raises :class:`SchedulingError` — that is a bug in this module,
not a property of the tournament.
"""

from __future__ import annotations

import enum
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Literal, NewType

from ortools.sat.python import cp_model

# Distinct id types so the checker rejects handing a table id to something that
# wants a fixture id. All are opaque strings at runtime: tables and pools are
# JSONB value-object refs (never UUIDs), and fixture/event/player ids are
# stringified by the snapshot builder — this module never mints or parses one.
TableId = NewType("TableId", str)
PoolId = NewType("PoolId", str)
FixtureId = NewType("FixtureId", str)
EventId = NewType("EventId", str)
#: Identifies a *human*, not an entry. Entries are per-event, and the no-double-
#: booking + rest constraints hold across events (pools share the catalogue and
#: the humans), so the snapshot builder must resolve entries to user-level ids.
PlayerId = NewType("PlayerId", str)

#: The scheduling grid. Every unpinned start lands on a multiple of this.
BUCKET_MIN = 5
#: The rest floor: minimum minutes between one match ending and the same
#: player's next match starting.
REST_MIN = 10

MatchLength = Literal[1, 3, 5, 7]


def match_minutes(length_games: MatchLength) -> int:
    """How long a match of this format occupies its table, in minutes.

    Deliberately the *only* place a duration comes from, so learned durations
    (per-event or per-player estimates) are a later drop-in that touches one
    function. Exhaustive over :data:`MatchLength` with no catch-all: a new
    legal length is a type error until it is given a duration.
    """
    match length_games:
        case 1:
            return 15
        case 3:
            return 25
        case 5:
            return 35
        case 7:
            return 45


class SchedulingError(Exception):
    """Base class for every failure this module can raise.

    Raised only for *bugs and incoherent inputs* — never for infeasibility,
    which is a designed outcome (:attr:`Verdict.infeasible`), not an error.
    """


class IncoherentSnapshot(SchedulingError):
    """The snapshot references things it does not contain (a fixture's pool or
    event missing, an in-progress match pointing at no fixture, duplicate ids,
    a fixture pairing a player against themselves). These are bugs in the
    snapshot builder worth failing loudly on at the boundary, not degrees of
    freedom for the solver to quietly absorb."""


class Verdict(enum.Enum):
    """The solve's answer. ``optimal``/``feasible`` carry a full placement set
    (the ADR accepts FEASIBLE under the time cap — mid-tournament we want a
    good answer now, not a proof). ``infeasible`` and ``unknown`` carry none:
    the former *proved* the day does not fit, the latter ran out of time
    before finding any answer — kept distinct because conflating them would
    tell a director "your day doesn't fit" on the solver's exhaustion."""

    optimal = "optimal"
    feasible = "feasible"
    infeasible = "infeasible"
    unknown = "unknown"


@dataclass(frozen=True, slots=True)
class Window:
    """A pool's playable span, as minute offsets: matches may run in
    ``[start_min, end_min)``. Half-open, like every interval here."""

    start_min: int
    end_min: int


@dataclass(frozen=True, slots=True)
class SchedulePool:
    """A pool as the solver needs to see it: which tables it may use and when.

    ``table_ids`` is the slice of the venue catalogue this pool draws on;
    tables may be shared between pools (per-table no-overlap is global)."""

    id: PoolId
    table_ids: tuple[TableId, ...]
    window: Window


@dataclass(frozen=True, slots=True)
class EventSettings:
    """The per-event input to :func:`match_minutes` — all the solver needs to
    know about an event is how long its matches run."""

    id: EventId
    length_games: MatchLength


@dataclass(frozen=True, slots=True)
class Pin:
    """A called placement — a promise. ``table_id`` is a hard constant the
    solve never changes; ``start_min`` is the promised time, which the solve
    treats as a *floor* — a called match may be pushed later on a re-solve (and
    the apply path then notifies the player), but never moved to another table
    and never started earlier than promised."""

    table_id: TableId
    start_min: int


@dataclass(frozen=True, slots=True)
class ScheduleFixture:
    """One schedulable pairing. Both players are known — a fixture with a TBD
    side cannot be placed, and the snapshot builder leaves it out.

    ``completed`` fixtures are carried so the builder needn't filter, and are
    ignored entirely: they occupy nothing and appear in no output.
    """

    id: FixtureId
    event_id: EventId
    pool_id: PoolId
    player_a_id: PlayerId
    player_b_id: PlayerId
    pin: Pin | None = None
    completed: bool = False


@dataclass(frozen=True, slots=True)
class InProgressMatch:
    """A match physically underway: its fixture (which must be in the
    snapshot's ``fixtures`` — players and duration are derived from it), the
    table it is actually on, and when it actually started.

    Reality outranks any plan: an in-progress fixture is excluded from the
    output placements (its truth is the actual start, not an estimate), its
    pin — it was almost certainly called — is ignored in favor of the actual
    occupancy, and its table and players are held until
    ``max(estimated end, now + BUCKET_MIN)`` so an overrunning match keeps
    blocking its table rather than letting the plan schedule into a slot that
    is visibly still occupied.
    """

    fixture_id: FixtureId
    table_id: TableId
    start_min: int


@dataclass(frozen=True, slots=True)
class PreviousPlacement:
    """Where the last accepted plan put an unpinned fixture — the stability
    tier's reference point. Entries for fixtures that are now pinned, running,
    completed, or gone are ignored."""

    fixture_id: FixtureId
    table_id: TableId
    start_min: int


@dataclass(frozen=True, slots=True)
class RestShadow:
    """A recently-completed match's lingering rest obligation on one human.

    A completed fixture occupies nothing and appears in no output (see
    :class:`ScheduleFixture`), but the moment it completes its player's rest
    floor must still hold: they may not be re-called until :data:`REST_MIN`
    minutes after they finished. This is that per-human obligation, orthogonal
    to the fixtures — one entry per human who recently finished, carrying only
    the completion time. The module (not the caller) adds :data:`REST_MIN`, so
    the floor stays this module's single source of truth."""

    player_id: PlayerId
    completed_at_min: int


def coalesce_rest_shadows(shadows: Iterable[RestShadow]) -> tuple[RestShadow, ...]:
    """One shadow per human, keeping the latest completion.

    :class:`RestShadow`'s contract is one entry per human, not per match — but a
    player who completed two matches within :data:`REST_MIN` of each other yields
    a shadow *per completion*, i.e. two fixed rest intervals that land under the
    solver's per-player ``AddNoOverlap`` and are mutually unsatisfiable, turning
    ONE player's close completions into a whole-tournament ``infeasible`` (#1145).
    Rest is "time since your last match", so the max ``completed_at_min`` per
    human subsumes every earlier one's floor — keep only that one."""
    latest: dict[PlayerId, RestShadow] = {}
    for shadow in shadows:
        existing = latest.get(shadow.player_id)
        if existing is None or shadow.completed_at_min > existing.completed_at_min:
            latest[shadow.player_id] = shadow
    return tuple(latest.values())


@dataclass(frozen=True, slots=True)
class ScheduleSnapshot:
    """Everything one solve reads, as one frozen value.

    ``table_ids`` is the venue catalogue — the universe every pool's
    ``table_ids`` must live inside. ``now_min`` is the current time in the
    same minute-offset frame as every other time here: unpinned fixtures may
    not be scheduled before it. ``rest_shadows`` carries the rest obligation
    of humans who just finished a match — orthogonal to ``fixtures``, whose
    completed entries stay dropped and unplaced.
    """

    table_ids: tuple[TableId, ...]
    pools: tuple[SchedulePool, ...]
    events: tuple[EventSettings, ...]
    fixtures: tuple[ScheduleFixture, ...]
    now_min: int
    in_progress: tuple[InProgressMatch, ...] = ()
    previous_plan: tuple[PreviousPlacement, ...] = ()
    rest_shadows: tuple[RestShadow, ...] = ()


@dataclass(frozen=True, slots=True)
class PlacedFixture:
    """One line of the output plan. ``end_min`` is always
    ``start_min + match_minutes(...)`` — carried so consumers never re-derive
    durations. For a called fixture, ``table_id`` is the pin's table (always)
    and ``start_min`` is the pin's promised time or a later slid value the
    solver chose — never earlier than promised."""

    fixture_id: FixtureId
    table_id: TableId
    start_min: int
    end_min: int


@dataclass(frozen=True, slots=True)
class SolveStats:
    """What the solve ledger records about the run itself. ``objective`` is
    ``None`` when no solution was found (infeasible / unknown) — its absolute
    value is only comparable between solves of the same snapshot shape, since
    the tier weights are instance-computed."""

    wall_time_ms: int
    objective: int | None


@dataclass(frozen=True, slots=True)
class PoolHasNoTables:
    """A pool that carries active fixtures but no tables at all — its unpinned
    fixtures have nowhere to be placed. The most specific, most certain cause a
    pool can have: no search is needed to know it cannot run."""

    pool_id: PoolId
    kind: Literal["pool_has_no_tables"] = "pool_has_no_tables"


@dataclass(frozen=True, slots=True)
class WindowTooShortForMatch:
    """A single unpinned fixture whose pool window cannot hold even one match
    contiguously (the ``lo > hi`` case): its match needs ``needed_min`` minutes
    but the pool's playable span is only ``window_span_min``. Certain and
    per-fixture — no other fixture's placement can rescue it."""

    pool_id: PoolId
    fixture_id: FixtureId
    needed_min: int
    window_span_min: int
    kind: Literal["window_too_short_for_match"] = "window_too_short_for_match"


@dataclass(frozen=True, slots=True)
class PoolOverCapacity:
    """A pool whose aggregate *unpinned*-fixture match-time (``required_min``)
    exceeds the table-minutes its window offers (``capacity_min`` =
    ``window_span × table_count``). A pigeonhole bound: it is a *necessary*
    condition for the pool to fit, so a violation proves the day cannot —
    without naming which fixtures collide (that is the CP-SAT conflict core,
    out of scope here). Scoped to unpinned fixtures only: pins/in-progress are
    not constrained to this pool's tables or window (ADR-0790), so counting them
    could invent a false over-capacity. Deliberately conservative — it excludes
    pins and undercounts demand (ignores rest padding) rather than ever
    overcounting, so it never *falsely* reports over-capacity. The trade-off is
    completeness: a pool that fits its unpinned fixtures but only overflows once
    in-window pins are layered in is left to CP-SAT and surfaces as
    ``NoSingleCause``."""

    pool_id: PoolId
    required_min: int
    capacity_min: int
    table_count: int
    kind: Literal["pool_over_capacity"] = "pool_over_capacity"


@dataclass(frozen=True, slots=True)
class NoSingleCause:
    """The honest residual: CP-SAT *proved* the day infeasible, yet no certain
    structural cause (arms above) explains it — the infeasibility lives in the
    combinatorial interaction of windows, rest, and no-double-booking that only
    search sees. Carries the whole-day aggregate for context: ``required_min``
    (Σ every active fixture's duration) against ``available_min`` (Σ over pools
    of ``window_span × table_count``). Typically ``required_min ≤ available_min``
    here — aggregate room exists, but it cannot be packed."""

    required_min: int
    available_min: int
    kind: Literal["no_single_cause"] = "no_single_cause"


#: The closed set of reasons an infeasible solve can carry. A discriminated
#: union over ``kind``: the first three arms are *certain* structural causes a
#: guard proves without the solver (and are collected exhaustively — every one
#: that holds, not just the first), the last is the best-effort residual when
#: CP-SAT refuses but no structure does. Frozen dataclasses + a ``kind``
#: discriminator so a downstream humanizer can ``match`` exhaustively with no
#: catch-all. Ids + minute-ints only: turning these into names and wall-clock
#: is a later, DB-aware layer's job, not this pure module's.
InfeasibilityReason = (
    PoolHasNoTables | WindowTooShortForMatch | PoolOverCapacity | NoSingleCause
)


@dataclass(frozen=True, slots=True)
class TableConflict:
    """Two or more in-progress matches recorded on the *same table* at
    overlapping times — physically impossible (a table holds one match), so it
    can only be contradictory data from a soft manual placement PATCH. Carries
    the shared ``table_id`` and the overlapping ``fixture_ids`` (sorted). The
    solver tolerates it — it merges the overlapping occupancy into one union so
    it never blanks the board — and reports it here for the director to resolve;
    it never adjudicates which match is 'real' and never moves a live match."""

    table_id: TableId
    fixture_ids: tuple[FixtureId, ...]
    kind: Literal["table_conflict"] = "table_conflict"


@dataclass(frozen=True, slots=True)
class PlayerConflict:
    """Two or more in-progress matches sharing a *human* whose rest-padded
    occupancy intervals overlap — physically impossible (a human plays one
    match at a time), so it is contradictory data from a soft manual PATCH.
    Carries the shared ``player_id`` and the overlapping ``fixture_ids``
    (sorted). Tolerated-and-reported exactly like :class:`TableConflict`."""

    player_id: PlayerId
    fixture_ids: tuple[FixtureId, ...]
    kind: Literal["player_conflict"] = "player_conflict"


#: The closed set of placement conflicts a solve can *report* (distinct from the
#: :data:`InfeasibilityReason`s that explain a failed solve — a conflict is
#: orthogonal to the verdict and can ride on a fully-placed ``optimal`` board).
#: A discriminated union over ``kind``, DB-blind exactly like the reasons union:
#: ids + minute-ints only, so a downstream DB-aware layer resolves them into
#: names and wall-clock. Each arm names one shared resource and the in-progress
#: fixtures colliding on it — the director-actionable "you double-booked" signal.
PlacementConflict = TableConflict | PlayerConflict


@dataclass(frozen=True, slots=True)
class SolveResult:
    """A solve's whole answer. Placements cover every active fixture that is
    not in progress — called fixtures on their fixed table at the promised or a
    slid-later start, unpinned fixtures solved in both dimensions — or are empty
    when ``verdict`` produced no plan. Deterministically ordered by
    ``(start, table, fixture)``.

    ``reasons`` is non-empty exactly when ``verdict`` is
    :attr:`Verdict.infeasible` and empty (``()``) for every other verdict
    (optimal / feasible / unknown, including the trivial no-active-fixtures
    optimal). It carries the structured, id-and-minute-only explanation of
    *why* the day does not fit — see :data:`InfeasibilityReason`.

    ``conflicts`` is **orthogonal to the verdict**: it reports the in-progress-
    vs-in-progress overlaps found in the snapshot (two matches recorded on one
    table, or one human in two matches — contradictory data from a soft manual
    PATCH). Such overlaps are *tolerated*, not fatal — the solver merges the
    overlapping fixed occupancy into its union so it can never blank the board
    (#1144) — so a fully-placed ``optimal`` / ``feasible`` result can still carry
    conflicts. It never adjudicates which match is real and never moves a live
    match; the report is the director-actionable "you double-booked" signal.
    See :data:`PlacementConflict`."""

    verdict: Verdict
    placements: tuple[PlacedFixture, ...]
    stats: SolveStats
    reasons: tuple[InfeasibilityReason, ...] = ()
    conflicts: tuple[PlacementConflict, ...] = ()


def _no_plan(
    verdict: Verdict,
    wall_time_ms: int = 0,
    reasons: tuple[InfeasibilityReason, ...] = (),
    conflicts: tuple[PlacementConflict, ...] = (),
) -> SolveResult:
    return SolveResult(
        verdict=verdict,
        placements=(),
        stats=SolveStats(wall_time_ms=wall_time_ms, objective=None),
        reasons=reasons,
        conflicts=conflicts,
    )


def _aggregate_capacity(snapshot: ScheduleSnapshot) -> tuple[int, int]:
    """``(required_min, available_min)`` for the whole day: Σ every active
    fixture's duration against Σ over pools of ``window_span × table_count``.
    The rough aggregate behind :class:`NoSingleCause`. Reads the event map
    directly — a solve only reaches this on a *built* model, so the snapshot's
    cross-references have already passed :func:`_validated`."""
    events = {e.id: e for e in snapshot.events}
    required = sum(
        match_minutes(events[f.event_id].length_games)
        for f in snapshot.fixtures
        if not f.completed
    )
    available = sum(
        (p.window.end_min - p.window.start_min) * len(p.table_ids)
        for p in snapshot.pools
    )
    return required, available


def _validated(
    snapshot: ScheduleSnapshot,
) -> tuple[
    dict[PoolId, SchedulePool],
    dict[EventId, EventSettings],
    list[ScheduleFixture],
    dict[FixtureId, InProgressMatch],
]:
    """Parse the snapshot's cross-references once, at the boundary, so the
    model builder below can index without a representable ``KeyError``."""
    catalogue = set(snapshot.table_ids)
    pools: dict[PoolId, SchedulePool] = {}
    for pool in snapshot.pools:
        if pool.id in pools:
            raise IncoherentSnapshot(f"Duplicate pool id {pool.id!r}.")
        missing = [t for t in pool.table_ids if t not in catalogue]
        if missing:
            raise IncoherentSnapshot(
                f"Pool {pool.id!r} references tables {missing!r} that are not "
                "in the venue catalogue."
            )
        pools[pool.id] = pool

    events: dict[EventId, EventSettings] = {}
    for event in snapshot.events:
        if event.id in events:
            raise IncoherentSnapshot(f"Duplicate event id {event.id!r}.")
        events[event.id] = event

    fixtures_by_id: dict[FixtureId, ScheduleFixture] = {}
    for fixture in snapshot.fixtures:
        if fixture.id in fixtures_by_id:
            raise IncoherentSnapshot(f"Duplicate fixture id {fixture.id!r}.")
        fixtures_by_id[fixture.id] = fixture

    active = [f for f in snapshot.fixtures if not f.completed]
    for fixture in active:
        if fixture.event_id not in events:
            raise IncoherentSnapshot(
                f"Fixture {fixture.id!r} references unknown event {fixture.event_id!r}."
            )
        if fixture.pool_id not in pools:
            raise IncoherentSnapshot(
                f"Fixture {fixture.id!r} references unknown pool {fixture.pool_id!r}."
            )
        if fixture.player_a_id == fixture.player_b_id:
            raise IncoherentSnapshot(
                f"Fixture {fixture.id!r} pairs player "
                f"{fixture.player_a_id!r} against themselves."
            )

    running: dict[FixtureId, InProgressMatch] = {}
    for match in snapshot.in_progress:
        if match.fixture_id in running:
            raise IncoherentSnapshot(
                f"Fixture {match.fixture_id!r} is in progress twice."
            )
        running_fixture = fixtures_by_id.get(match.fixture_id)
        if running_fixture is None:
            raise IncoherentSnapshot(
                f"In-progress match references unknown fixture {match.fixture_id!r}."
            )
        if running_fixture.completed:
            raise IncoherentSnapshot(
                f"Fixture {match.fixture_id!r} is both completed and in progress."
            )
        running[match.fixture_id] = match

    return pools, events, active, running


@dataclass(frozen=True, slots=True)
class _SolverModel:
    """The built CP-SAT model plus the index a solve needs to read its answer
    back out. Internal seam between :func:`_build_model` (construction, warm-
    start hints included) and :func:`solve` (running the solver, shaping the
    result) — split so a test can build the *real* model, then observe the
    hint's effect deterministically (single worker, fixed seed) without
    touching the production solver parameters. ``model`` carries the hints;
    ``starts``/``presences`` recover each unpinned fixture's chosen start and
    table, ``durations`` its ``end_min``. A called fixture's start is *also* a
    variable now (it can slide later on its fixed table), so its solved start is
    read back from ``pin_starts``; ``pin_tables`` holds its immovable table and
    ``pin_durations`` its length."""

    model: cp_model.CpModel
    unpinned: tuple[ScheduleFixture, ...]
    starts: dict[FixtureId, Any]
    presences: dict[FixtureId, dict[TableId, Any]]
    durations: dict[FixtureId, int]
    pinned: tuple[ScheduleFixture, ...]
    pin_starts: dict[FixtureId, Any]
    pin_tables: dict[FixtureId, TableId]
    pin_durations: dict[FixtureId, int]
    #: In-progress-vs-in-progress overlaps detected from the snapshot (orthogonal
    #: to the solve outcome), carried so :func:`solve` attaches them to whatever
    #: verdict CP-SAT reaches — a placed board can still report conflicts.
    conflicts: tuple[PlacementConflict, ...]


def _merge_spans(spans: Iterable[tuple[int, int]]) -> list[tuple[int, int]]:
    """Union mutually-overlapping half-open ``[start, end)`` intervals.

    A sort-and-sweep over connected overlap components: adjacency
    (``start == end`` of the predecessor) does *not* merge — only a genuine
    overlap does. Used to collapse the *fixed* obstacle intervals on one
    resource (in-progress occupancy + rest shadows) into disjoint blocks before
    ``AddNoOverlap``, so two contradictory fixed facts can never force
    infeasibility while their union stays blocked for every variable interval."""
    ordered = sorted(spans)
    merged: list[tuple[int, int]] = []
    for start, end in ordered:
        if merged and start < merged[-1][1]:
            last_start, last_end = merged[-1]
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))
    return merged


def _overlapping_fixture_ids(
    spans: list[tuple[int, int, FixtureId]],
) -> tuple[FixtureId, ...]:
    """The fixtures that pairwise-overlap at least one other on one resource.

    Half-open overlap (``s1 < e2 and s2 < e1``), pairwise over the resource's
    in-progress spans (counts are tiny). Returns the sorted union of every
    fixture caught in *any* overlap, so a resource is reported once with the
    full set colliding on it — empty when nothing overlaps."""
    colliding: set[FixtureId] = set()
    for i in range(len(spans)):
        start_i, end_i, fixture_i = spans[i]
        for j in range(i + 1, len(spans)):
            start_j, end_j, fixture_j = spans[j]
            if start_i < end_j and start_j < end_i:
                colliding.add(fixture_i)
                colliding.add(fixture_j)
    return tuple(sorted(colliding))


def _build_model(snapshot: ScheduleSnapshot) -> SolveResult | _SolverModel:
    """Construct the CP-SAT model for one solve, warm-start hints and all.

    Returns a finished :class:`SolveResult` for the cases that need no solver —
    nothing to place (trivially optimal) or a structural infeasibility a guard
    can prove without search — and otherwise a :class:`_SolverModel` carrying
    the model and the index :func:`solve` reads its answer back out of.

    Raises :class:`IncoherentSnapshot` for inputs that reference things they do
    not contain (via :func:`_validated`).
    """
    pools, events, active, running = _validated(snapshot)

    if not active:
        # Nothing to place and nothing to echo: trivially optimal, no solver.
        return SolveResult(
            verdict=Verdict.optimal,
            placements=(),
            stats=SolveStats(wall_time_ms=0, objective=0),
        )

    def duration_of(fixture: ScheduleFixture) -> int:
        return match_minutes(events[fixture.event_id].length_games)

    now = snapshot.now_min
    in_progress = [f for f in active if f.id in running]
    # A running fixture's pin is superseded by its actual occupancy.
    pinned = [(f, f.pin) for f in active if f.id not in running and f.pin is not None]
    unpinned = [f for f in active if f.id not in running and f.pin is None]

    # An overrunning match keeps blocking its table at least a beat past now.
    occupancy_ends = {
        f.id: max(running[f.id].start_min + duration_of(f), now + BUCKET_MIN)
        for f in in_progress
    }

    # The *fixed* occupancy spans each in-progress match projects onto its table
    # and its two humans (the human span is rest-padded, so a shared-human
    # overlap is judged on the same padded interval per-player NoOverlap uses).
    # Kept as numeric half-open spans so they can be both (a) merged before
    # AddNoOverlap — two overlapping fixed facts are contradictory data that
    # must never blank the board (#1144) — and (b) scanned for the director-
    # actionable in-progress-vs-in-progress conflicts reported on the result.
    table_inprog: defaultdict[TableId, list[tuple[int, int, FixtureId]]] = defaultdict(
        list
    )
    player_inprog: defaultdict[PlayerId, list[tuple[int, int, FixtureId]]] = (
        defaultdict(list)
    )
    for fixture in in_progress:
        match_row = running[fixture.id]
        occ_end = occupancy_ends[fixture.id]
        table_inprog[match_row.table_id].append(
            (match_row.start_min, occ_end, fixture.id)
        )
        for player in (fixture.player_a_id, fixture.player_b_id):
            player_inprog[player].append(
                (match_row.start_min, occ_end + REST_MIN, fixture.id)
            )

    # Report narrowly: only in-progress-vs-in-progress overlaps (rest-shadow
    # overlaps are merged below but never reported). Deterministically ordered
    # by shared resource id, each resource reported once with its colliding set.
    conflicts: tuple[PlacementConflict, ...] = (
        *(
            TableConflict(table_id=table_id, fixture_ids=overlapping)
            for table_id, spans in sorted(table_inprog.items())
            if (overlapping := _overlapping_fixture_ids(spans))
        ),
        *(
            PlayerConflict(player_id=player_id, fixture_ids=overlapping)
            for player_id, spans in sorted(player_inprog.items())
            if (overlapping := _overlapping_fixture_ids(spans))
        ),
    )

    # The latest minute anything can end — the domain ceiling for every start
    # variable (a called match's included, since it can now slide) and for the
    # makespan var. A called match's start is no longer a constant: per-table
    # no-overlap can force it to slide behind every fixed obstruction on its
    # table (an in-progress occupancy end) and behind every other called match
    # promised the same table. The safe worst case is *all* pins stacked end to
    # end just after the latest fixed obstruction, so fold the total pin duration
    # on top of the latest occupancy end and the latest pin floor. The old bound
    # (the largest single ``pin.start_min + duration``) could be too tight for a
    # pin forced past a *later* obstruction — an artificial INFEASIBLE.
    horizon = now + BUCKET_MIN
    for pool in snapshot.pools:
        horizon = max(horizon, pool.window.end_min)
    latest_obstruction = now
    for end in occupancy_ends.values():
        latest_obstruction = max(latest_obstruction, end)
    for _fixture, pin in pinned:
        latest_obstruction = max(latest_obstruction, pin.start_min)
    total_pin_duration = sum(duration_of(fixture) for fixture, _ in pinned)
    horizon = max(horizon, latest_obstruction + total_pin_duration)

    # Structural feasibility first — but gathered *exhaustively*, not first-fail.
    # A day that cannot possibly be placed should explain every certain cause at
    # once (the director fixes them together), not just the first one hit. Three
    # certain, per-structure causes need no solver to prove:
    #   * PoolHasNoTables — a pool with unpinned fixtures but no tables to use,
    #   * WindowTooShortForMatch — a single fixture whose window can't hold it,
    #   * PoolOverCapacity — a pool's unpinned demand exceeds window × tables.
    # We dedupe to the *most specific* cause per pool: a no-tables or window-too-
    # short pool is already unplaceable, so we don't also pile on over-capacity
    # for it. Bucket bounds for the pools that *do* fit are recorded on the way,
    # so the window is walked once; they are only consumed when no reason fires
    # (the clean case populates every unpinned fixture).
    #
    # Every arm scopes to *unpinned* demand only. Pins and in-progress fixtures
    # are deliberately not constrained to their pool's tables or window (ADR-0790:
    # an off-pool or out-of-window pin is a supported director action), so
    # counting them against a pool's window×tables would invent false
    # infeasibility. Only unpinned fixtures are constrained to their pool's tables
    # inside its window by construction, so only they can prove a certain
    # structural cause that can never false-fire.
    unpinned_by_pool: defaultdict[PoolId, list[ScheduleFixture]] = defaultdict(list)
    for fixture in unpinned:
        unpinned_by_pool[fixture.pool_id].append(fixture)

    reasons: list[InfeasibilityReason] = []
    bucket_bounds: dict[FixtureId, tuple[int, int]] = {}
    pools_short_window: set[PoolId] = set()

    # Per-fixture: does this unpinned fixture's window hold even one match
    # contiguously? (Pinned fixtures outrank windows, so they never apply here.)
    # A no-tables pool is covered by PoolHasNoTables below, so skip its fixtures.
    for fixture in unpinned:
        pool = pools[fixture.pool_id]
        if not pool.table_ids:
            continue
        needed = duration_of(fixture)
        earliest = max(now, pool.window.start_min)
        latest = pool.window.end_min - needed
        lo = -(-earliest // BUCKET_MIN)  # ceil: first grid start not in the past
        hi = latest // BUCKET_MIN  # floor: last grid start that still fits
        if lo > hi:
            reasons.append(
                WindowTooShortForMatch(
                    pool_id=pool.id,
                    fixture_id=fixture.id,
                    needed_min=needed,
                    window_span_min=pool.window.end_min - pool.window.start_min,
                )
            )
            pools_short_window.add(pool.id)
            continue
        bucket_bounds[fixture.id] = (lo, hi)

    # Per-pool (in snapshot order for determinism), most-specific cause wins.
    for pool in snapshot.pools:
        pool_unpinned = unpinned_by_pool.get(pool.id)
        if not pool_unpinned:
            continue  # no unpinned demand: no arm can prove a cause here
        if not pool.table_ids:
            # A no-tables pool with ≥1 unpinned fixture: that fixture has nowhere
            # to go. A no-tables pool whose only fixtures are pinned/in-progress
            # (placed off-pool by the director) is fine — it never reaches here.
            reasons.append(PoolHasNoTables(pool_id=pool.id))
            continue  # dominates any capacity claim for this pool
        if pool.id in pools_short_window:
            continue  # window-too-short already dominates this pool
        # Capacity is a pigeonhole *necessary* condition over *unpinned* demand:
        # sum the match-time of this pool's unpinned fixtures (the only ones
        # constrained to its tables inside its window) against the table-minutes
        # the window offers. Pins/in-progress are excluded — they are not bound
        # to this pool's tables or window (ADR-0790), so counting them could
        # invent a false over-capacity. Dropping them keeps the bound truly
        # conservative: a pin only ever adds contention, so unpinned-alone
        # overflowing is a genuine, necessary infeasibility, while unpinned-alone
        # fitting is never falsely flagged. Completeness trade-off: a pool that
        # fits its unpinned fixtures but tips over only once in-window pins are
        # layered in is not reported here — that case is infeasible only if
        # CP-SAT proves it, surfacing as the honest NoSingleCause residual.
        required_min = sum(duration_of(f) for f in pool_unpinned)
        table_count = len(pool.table_ids)
        capacity_min = (pool.window.end_min - pool.window.start_min) * table_count
        if required_min > capacity_min:
            reasons.append(
                PoolOverCapacity(
                    pool_id=pool.id,
                    required_min=required_min,
                    capacity_min=capacity_min,
                    table_count=table_count,
                )
            )

    if reasons:
        # A certain structural infeasibility: refuse without building or running
        # CP-SAT, but carry every cause we found rather than a bare verdict — and
        # any in-progress conflict too (orthogonal to why the day doesn't fit).
        return _no_plan(Verdict.infeasible, reasons=tuple(reasons), conflicts=conflicts)

    model = cp_model.CpModel()
    table_intervals: defaultdict[TableId, list[Any]] = defaultdict(list)
    player_intervals: defaultdict[PlayerId, list[Any]] = defaultdict(list)
    fixed_ends: list[int] = []
    variable_ends: list[Any] = []
    # start − now, summed as the player-wait objective tier. Both unpinned and
    # called fixtures contribute (a called match's slide is anchored here).
    wait_terms: list[Any] = []

    # In-progress matches project fixed occupancy from their *actual* start (the
    # players' spans rest-padded), and each still bounds the makespan.
    fixed_ends.extend(occupancy_ends.values())

    # Rest shadows: a human who just completed a match rests until
    # completed_at + REST_MIN — a fixed span on that player's list that projects
    # the floor across the completion boundary (the completed fixture itself is
    # dropped and unplaced, but its rest lingers). Fixed, no variable, so it
    # needs no makespan/horizon bound. Coalesced to one per human first
    # (:func:`coalesce_rest_shadows`) — belt-and-suspenders for the snapshot
    # builder's "one entry per human" contract — and folded into the same
    # per-player fixed-span pool as the in-progress occupancy so the merge below
    # absorbs any shadow-vs-occupancy overlap too.
    player_fixed_spans: defaultdict[PlayerId, list[tuple[int, int]]] = defaultdict(list)
    for player_id, spans in player_inprog.items():
        player_fixed_spans[player_id].extend((s, e) for s, e, _ in spans)
    for shadow in coalesce_rest_shadows(snapshot.rest_shadows):
        player_fixed_spans[shadow.player_id].append(
            (shadow.completed_at_min, shadow.completed_at_min + REST_MIN)
        )

    # Merge broadly: collapse each resource's *fixed* spans into their disjoint
    # union before AddNoOverlap. Two overlapping fixed facts (two in-progress
    # matches on one table or one human, or a shadow-vs-occupancy overlap) are
    # physically impossible data that would otherwise make AddNoOverlap
    # unsatisfiable and blank the WHOLE board (#1144). The union stays fully
    # blocked for every *variable* interval (unpinned placements, sliding pins),
    # so no one else is scheduled onto genuinely-held occupancy — conservative
    # for everyone else — while fixed-vs-fixed can never force infeasibility. We
    # never move, re-time, or drop the live matches themselves; only what the
    # *other* fixtures see as occupied changes.
    for table_id, spans in table_inprog.items():
        for lo, hi in _merge_spans((s, e) for s, e, _ in spans):
            table_intervals[table_id].append(
                model.NewFixedSizeIntervalVar(lo, hi - lo, f"fixed_t_{table_id}_{lo}")
            )
    for player_id, merge_spans in player_fixed_spans.items():
        for lo, hi in _merge_spans(merge_spans):
            player_intervals[player_id].append(
                model.NewFixedSizeIntervalVar(lo, hi - lo, f"fixed_p_{player_id}_{lo}")
            )

    # Called matches: table hard-fixed, start a free variable pushable only
    # later. The start lives on `table_intervals[pin.table_id]` alone — no
    # table-choice presence bools, so a promise can never be re-placed onto
    # another court — with lower bound `pin.start_min` (never earlier than
    # promised) and no window constraint (pins outrank windows). It is NOT
    # snapped to the BUCKET_MIN grid: `pin.start_min` may itself be off-grid,
    # and snapping would re-introduce drift and over-delay the slide. Occupancy
    # and the rest-padded per-player interval both key off the start variable,
    # exactly like an in-progress or unpinned interval; the end is a *variable*
    # end folded into the makespan bound, not a fixed constant.
    pin_starts: dict[FixtureId, Any] = {}
    pin_tables: dict[FixtureId, TableId] = {}
    pin_durations: dict[FixtureId, int] = {}
    for fixture, pin in pinned:
        duration = duration_of(fixture)
        pin_start = model.NewIntVar(
            pin.start_min, horizon - duration, f"pin_start_{fixture.id}"
        )
        table_intervals[pin.table_id].append(
            model.NewFixedSizeIntervalVar(pin_start, duration, f"pin_{fixture.id}")
        )
        for player in (fixture.player_a_id, fixture.player_b_id):
            player_intervals[player].append(
                model.NewFixedSizeIntervalVar(
                    pin_start, duration + REST_MIN, f"pin_{fixture.id}_{player}"
                )
            )
        variable_ends.append(pin_start + duration)
        # Anchor the start downward at the *same* weight as an unpinned fixture:
        # since `pin.start_min` is the variable's floor, this wait term bottoms
        # out at the promised time (no drift, uncontended) and slides to the
        # minimum legal later value under contention. No new objective tier.
        wait_terms.append(pin_start - now)
        pin_starts[fixture.id] = pin_start
        pin_tables[fixture.id] = pin.table_id
        pin_durations[fixture.id] = duration

    # Unpinned fixtures: one start variable on the 5-minute grid, one optional
    # interval per candidate table (exactly one present), and a mandatory
    # rest-padded interval per player. Padding *every* player interval by
    # REST_MIN makes per-player NoOverlap enforce "gap ≥ rest floor" between
    # any two of that player's matches, in either order, with no sequencing
    # variables.
    starts: dict[FixtureId, Any] = {}
    presences: dict[FixtureId, dict[TableId, Any]] = {}
    buckets: dict[FixtureId, Any] = {}
    durations: dict[FixtureId, int] = {}
    for fixture in unpinned:
        pool = pools[fixture.pool_id]
        duration = duration_of(fixture)
        lo, hi = bucket_bounds[fixture.id]
        bucket = model.NewIntVar(lo, hi, f"bucket_{fixture.id}")
        start = model.NewIntVar(lo * BUCKET_MIN, hi * BUCKET_MIN, f"start_{fixture.id}")
        model.Add(start == bucket * BUCKET_MIN)
        by_table: dict[TableId, Any] = {}
        for table in pool.table_ids:
            present = model.NewBoolVar(f"on_{fixture.id}_{table}")
            by_table[table] = present
            table_intervals[table].append(
                model.NewOptionalFixedSizeIntervalVar(
                    start, duration, present, f"fx_{fixture.id}_{table}"
                )
            )
        model.AddExactlyOne(list(by_table.values()))
        for player in (fixture.player_a_id, fixture.player_b_id):
            player_intervals[player].append(
                model.NewFixedSizeIntervalVar(
                    start, duration + REST_MIN, f"fx_{fixture.id}_{player}"
                )
            )
        starts[fixture.id] = start
        presences[fixture.id] = by_table
        buckets[fixture.id] = bucket
        durations[fixture.id] = duration
        variable_ends.append(start + duration)
        wait_terms.append(start - now)

    for intervals in table_intervals.values():
        if len(intervals) > 1:
            model.AddNoOverlap(intervals)
    for intervals in player_intervals.values():
        if len(intervals) > 1:
            model.AddNoOverlap(intervals)

    makespan = model.NewIntVar(0, horizon, "makespan")
    for end_expr in variable_ends:
        model.Add(makespan >= end_expr)
    if fixed_ends:
        model.Add(makespan >= max(fixed_ends))

    # Stability: an unpinned fixture "kept" its previous plan iff it sits on
    # the same table at the same start. A previous table no longer in the
    # pool means it must move — a constant 1 in the moved count.
    previous = {p.fixture_id: p for p in snapshot.previous_plan}
    kept_literals: list[Any] = []
    forced_moves = 0
    stability_span = 0
    for fixture in unpinned:
        prior = previous.get(fixture.id)
        if prior is None:
            continue
        stability_span += 1
        same_table = presences[fixture.id].get(prior.table_id)
        if same_table is None:
            forced_moves += 1
            continue
        same_start = model.NewBoolVar(f"same_start_{fixture.id}")
        model.Add(starts[fixture.id] == prior.start_min).OnlyEnforceIf(same_start)
        model.Add(starts[fixture.id] != prior.start_min).OnlyEnforceIf(same_start.Not())
        kept = model.NewBoolVar(f"kept_{fixture.id}")
        model.AddBoolAnd([same_table, same_start]).OnlyEnforceIf(kept)
        model.AddBoolOr([same_table.Not(), same_start.Not()]).OnlyEnforceIf(kept.Not())
        kept_literals.append(kept)

    # Instance-computed strictly-lexicographic weights — see module docstring.
    # The wait tier now has one term per unpinned *and* per called fixture, so
    # the count bounding the max total wait swing is len(unpinned) + len(pinned).
    # A called match's `pin_start - now` can be negative (a floor before now),
    # which only lowers the total, so `count * span` still bounds the positive
    # swing and the tiers provably never trade.
    span = max(1, horizon - now)
    w_stability = 1
    w_wait = w_stability * stability_span + 1
    w_makespan = w_wait * max(1, len(unpinned) + len(pinned)) * span + 1

    objective = w_makespan * makespan
    for term in wait_terms:
        objective = objective + w_wait * term
    for kept in kept_literals:
        objective = objective + w_stability * (1 - kept)
    objective = objective + w_stability * forced_moves
    model.Minimize(objective)

    # Warm start: seed each unpinned fixture's prior (table, start) as a hint so
    # a mostly-unchanged re-solve begins *at* the previous plan and only repairs
    # the local delta. A hint whose prior table has left the pool (a forced move)
    # or that has no prior entry is simply omitted — that fixture solves fresh.
    # Hints never change which solution is optimal; they only order the search.
    for fixture in unpinned:
        prior = previous.get(fixture.id)
        if prior is None or prior.table_id not in presences[fixture.id]:
            continue
        model.AddHint(buckets[fixture.id], prior.start_min // BUCKET_MIN)
        model.AddHint(starts[fixture.id], prior.start_min)
        for table, present in presences[fixture.id].items():
            model.AddHint(present, 1 if table == prior.table_id else 0)

    # Warm start each called match's slide variable at its promised time so a
    # re-solve begins at what the player was told and only slides if forced.
    for fixture, pin in pinned:
        model.AddHint(pin_starts[fixture.id], pin.start_min)

    return _SolverModel(
        model=model,
        unpinned=tuple(unpinned),
        starts=starts,
        presences=presences,
        durations=durations,
        pinned=tuple(fixture for fixture, _ in pinned),
        pin_starts=pin_starts,
        pin_tables=pin_tables,
        pin_durations=pin_durations,
        conflicts=conflicts,
    )


def solve(
    snapshot: ScheduleSnapshot,
    time_cap_s: float = 10.0,
    num_search_workers: int = 1,
) -> SolveResult:
    """Place every active fixture: a called match on its fixed table at the
    promised start or a slid-later one (never earlier), everything else solved
    onto its pool's tables inside its pool's window, on the :data:`BUCKET_MIN`
    grid, no earlier than ``now_min``.

    Never raises for infeasibility — see :class:`Verdict`. Raises
    :class:`IncoherentSnapshot` for inputs that reference things they do not
    contain, and :class:`SchedulingError` if CP-SAT rejects the model (a bug
    here, not a property of the tournament).

    ``num_search_workers`` must stay within the caller's CPU budget — CP-SAT
    spawns that many search threads regardless of how many cores are actually
    available, and a value above the caller's CPU limit gets CFS-throttled.
    The default of 1 is also what keeps ``random_seed = 0`` below pinning the
    result: CP-SAT's parallel portfolio is not deterministic across workers.
    """
    built = _build_model(snapshot)
    if isinstance(built, SolveResult):
        # Nothing to solve: trivially optimal, or a structural infeasibility a
        # guard proved without the solver.
        return built

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_cap_s
    solver.parameters.num_search_workers = num_search_workers
    solver.parameters.random_seed = 0
    status = solver.Solve(built.model)
    wall_time_ms = int(solver.WallTime() * 1000)

    if status == cp_model.MODEL_INVALID:
        raise SchedulingError(
            "CP-SAT rejected the scheduling model as invalid — this is a bug "
            "in app.scheduling, not a property of the tournament."
        )
    if status == cp_model.INFEASIBLE:
        # CP-SAT proved it, but the structural pre-check found no certain cause
        # (by construction: it returns before we ever build the model). Attach
        # the honest residual — the whole-day aggregate, no single blamed pool.
        required_min, available_min = _aggregate_capacity(snapshot)
        return _no_plan(
            Verdict.infeasible,
            wall_time_ms,
            reasons=(
                NoSingleCause(required_min=required_min, available_min=available_min),
            ),
            conflicts=built.conflicts,
        )
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return _no_plan(Verdict.unknown, wall_time_ms, conflicts=built.conflicts)

    placements: list[PlacedFixture] = []
    # Called matches: table is the pin's fixed table; start is read back from
    # the solver (it slid later if forced, else sits at the promised floor).
    for fixture in built.pinned:
        pin_start = int(solver.Value(built.pin_starts[fixture.id]))
        duration = built.pin_durations[fixture.id]
        placements.append(
            PlacedFixture(
                fixture_id=fixture.id,
                table_id=built.pin_tables[fixture.id],
                start_min=pin_start,
                end_min=pin_start + duration,
            )
        )
    for fixture in built.unpinned:
        start_value = int(solver.Value(built.starts[fixture.id]))
        table = _chosen_table(solver, built.presences[fixture.id], fixture.id)
        placements.append(
            PlacedFixture(
                fixture_id=fixture.id,
                table_id=table,
                start_min=start_value,
                end_min=start_value + built.durations[fixture.id],
            )
        )
    placements.sort(key=lambda p: (p.start_min, p.table_id, p.fixture_id))

    return SolveResult(
        verdict=(Verdict.optimal if status == cp_model.OPTIMAL else Verdict.feasible),
        placements=tuple(placements),
        stats=SolveStats(
            wall_time_ms=wall_time_ms,
            objective=int(solver.ObjectiveValue()),
        ),
        conflicts=built.conflicts,
    )


def _chosen_table(
    solver: Any, presences: dict[TableId, Any], fixture_id: FixtureId
) -> TableId:
    """The table whose presence literal the solution set — total by the
    AddExactlyOne constraint, so reaching the raise is a solver bug."""
    for table, present in presences.items():
        if solver.Value(present) == 1:
            return table
    raise SchedulingError(
        f"No table selected for fixture {fixture_id!r} despite an "
        "exactly-one constraint — this is a bug."
    )
