"""The transport-neutral **schedule preview** verb, its RQ job, and its
result-fetch helpers (ADR "a schedule preview is a non-persistent solve over a
synthetic field").

A **preview** answers *"given my tables, windows, formats and games-per-match,
would the schedule even fit — and roughly how long is the day?"* **before anyone
has registered**. It is the *same* CP-SAT engine a live tournament uses, run over
a **synthetic field** (:mod:`app.schedule_preview`), so "fits / doesn't fit"
means exactly what it will at go-live — but it **persists nothing**: no
``TournamentEntry``, no ``TournamentFixture`` placement, no ``ScheduleSolve``
ledger row. The whole answer lives only in the RQ/Redis job result, with a short
TTL, and is thrown away with the request.

This module is the transport-neutral core the HTTP routes (poll/result) and the
MCP tool (bounded wait) both adapt — the shared-verb-behind-adapters pattern of
the tournament-verbs ADR, mirroring :mod:`app.tournament_solve_service`:

* :func:`request_schedule_preview` is the **enqueue verb** — owner-gated and
  pre-live-guarded (``draft``/``published`` only), it loads the tournament, builds
  the synthetic snapshot **synchronously** (the draw is instant), enqueues the
  solve on the dedicated ``preview`` queue, and returns a token plus the
  immediately-known structure (field sizes + drawn fixtures) so a caller renders a
  skeleton before the solve finishes. It signals refusals with **domain
  exceptions** from :mod:`app.tournament_errors`, never ``HTTPException``.
* :func:`run_schedule_preview` is the **RQ job body** — pure CPU, no database: it
  runs ``app.scheduling.solve`` over the passed snapshot and **returns** a
  serialized :class:`PreviewResult`. It writes nothing.
* :func:`preview_job_state` / :func:`wait_for_preview` read the ephemeral job's
  status and (when done) its result back off Redis — the reusable helpers the
  poll endpoint and the MCP tool sit on.

Unlike the real solve path (:mod:`app.schedule_solves`), which enqueues only a
ledger-row id and re-reads every input from the database in the worker, a preview
has no database state to read: the enqueue verb hands the fully-built inputs to
the job as its argument (they pickle cleanly — frozen value objects only), and
the job hands back the answer as its return value. Nothing here touches the real
solve path's apply / ledger code.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import assert_never

from pydantic import TypeAdapter
from redis.exceptions import RedisError
from rq.command import send_stop_job_command
from rq.exceptions import InvalidJobOperation, NoSuchJobError
from rq.job import Job, JobStatus
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app import queue as queue_module
from app import scheduling
from app.config import get_settings
from app.models import Tournament, TournamentStatus, User
from app.schedule_preview import build_preview_snapshot
from app.schedule_solves import _solve_num_workers
from app.scheduling import (
    InfeasibilityReason,
    MatchLength,
    NoSingleCause,
    PlacedFixture,
    PoolHasNoTables,
    PoolOverCapacity,
    ScheduleSnapshot,
    SolveResult,
    Verdict,
    WindowTooShortForMatch,
)
from app.schemas.schedule_preview import (
    PreviewEnqueued,
    PreviewEventBreakdown,
    PreviewFieldSummary,
    PreviewFixture,
    PreviewJobState,
    PreviewJobStatus,
    PreviewResult,
    PreviewVerdict,
)
from app.schemas.schedule_solve import (
    NoSingleCauseRead,
    PoolHasNoTablesRead,
    PoolOverCapacityRead,
    ResolvedReason,
    WindowTooShortForMatchRead,
)
from app.tournament_draws import event_pools
from app.tournament_errors import (
    NotTournamentOwnerError,
    ScheduleQueueUnavailableError,
    TournamentNotFoundError,
    TournamentNotPreLiveError,
)

#: The dotted path RQ resolves in the worker process — enqueued as a string, like
#: ``app.schedule_solves.RUN_SCHEDULE_SOLVE_JOB``.
RUN_SCHEDULE_PREVIEW_JOB = "app.schedule_preview_solve.run_schedule_preview"

#: Slack, in seconds, on top of ``preview_solver_time_cap_s`` for the RQ job's own
#: ``job_timeout``. Far tighter than the real solve's 60s margin: a preview job
#: has no DB-apply phase — it wraps only the CP-SAT call, with no snapshot read,
#: locked re-read, fixture writes or notification fan-out on either side — so the
#: watchdog need only outlast the solver's own call by a small cushion.
PREVIEW_JOB_TIMEOUT_MARGIN_S = 15

#: How long (seconds) an ephemeral preview result lingers in Redis after the job
#: finishes — long enough for a browser to poll it in, short enough that it never
#: accumulates (ADR "a short TTL, ~5 min"). The job persists nothing else.
_PREVIEW_RESULT_TTL_S = 300

#: The statuses that a tournament is still *pre-live* in, so a preview is allowed
#: (ADR): a draft or a published (registration open, nothing drawn) tournament.
#: ``live`` and ``archived`` are refused with :class:`TournamentNotPreLiveError`.
_PRE_LIVE_STATUSES = frozenset({TournamentStatus.draft, TournamentStatus.published})

#: Module seam for the pure solver, so a test can interpose a canned
#: :class:`SolveResult` on the job body without running the full CP-SAT search —
#: mirrors ``app.schedule_solves._solve``.
_solve = scheduling.solve


@dataclass(frozen=True, slots=True)
class _PreviewPoolResolution:
    """The DB-side facts an infeasibility reason needs to name a pool a human can
    act on: its display ``name`` and the ``HH:MM`` clock bounds of its window
    (already strings on the pool's ``Slot``). Built in the enqueue verb, where the
    tournament's pools are loaded, and carried to the (DB-blind) job — the pure
    snapshot speaks only namespaced ids and minute offsets, so the names cannot be
    re-derived worker-side. Mirrors ``app.schedule_solves._PoolResolution``."""

    name: str
    window_start: str
    window_end: str


@dataclass(frozen=True, slots=True)
class _PreviewEventMeta:
    """One event's honest-notes + breakdown ingredients: its id, display ``name``
    and the synthetic ``field_size`` the preview drew a field to. Carried from the
    enqueue verb (which has the loaded events) to the job (which has only the pure
    snapshot)."""

    event_id: str
    name: str
    field_size: int


@dataclass(frozen=True, slots=True)
class PreviewJobInputs:
    """Everything the ephemeral preview job needs, as one frozen, picklable value:
    the pure :class:`~app.scheduling.ScheduleSnapshot` to solve, the wall-clock
    ``base`` its minute frame is offset from (``None`` when the tournament has no
    real windows — no wall-clock finish can be projected then), the per-pool
    resolutions the job humanizes an infeasible verdict through, and the per-event
    meta the breakdown + honest-notes are built from.

    Holds only pure value objects (no ORM row, no session) so it pickles cleanly
    as an RQ job argument — the preview's non-persistent equivalent of the real
    solve enqueuing a ledger-row id for the worker to re-read from the DB."""

    snapshot: ScheduleSnapshot
    base: datetime | None
    pool_resolutions: dict[str, _PreviewPoolResolution]
    events: tuple[_PreviewEventMeta, ...] = ()


async def _load_owned_pre_live_tournament(
    db: AsyncSession, tournament_id: uuid.UUID, actor: User
) -> Tournament:
    """Load the tournament ``actor`` owns and may preview — with its events (and
    their pools/settings) eagerly attached for the synthetic-snapshot build —
    applying the same **404 → 403** ordering every owner-gated tournament verb
    shares, then the preview's own pre-live gate:

    * **404** — an absent id raises :class:`TournamentNotFoundError`, so ownership
      is judged only once the row exists and a stranger probing ids learns nothing;
    * **403** — a non-creator raises :class:`NotTournamentOwnerError`: a preview is
      owner-gated (``created_by_user_id == actor.id``), the same family as running
      the scheduler, judged before the tournament's *state* is looked at;
    * **pre-live** — a ``live``/``archived`` tournament raises
      :class:`TournamentNotPreLiveError` (carrying the status): a preview only
      answers a pre-registration question.

    Unlocked, unlike the real solve verb's ``FOR UPDATE`` load: a preview persists
    nothing, so there is no coalescing state or judged-then-written invariant a row
    lock would protect — it is a pure read plus an enqueue of an ephemeral job."""
    tournament = (
        await db.execute(
            select(Tournament)
            .where(Tournament.id == tournament_id)
            .options(selectinload(Tournament.events))
        )
    ).scalar_one_or_none()
    if tournament is None:
        raise TournamentNotFoundError()
    if tournament.created_by_user_id != actor.id:
        raise NotTournamentOwnerError()
    if tournament.status not in _PRE_LIVE_STATUSES:
        raise TournamentNotPreLiveError(tournament.status.value)
    return tournament


def _pool_resolutions(tournament: Tournament) -> dict[str, _PreviewPoolResolution]:
    """The namespaced-pool-id → name + ``HH:MM`` map an infeasible preview is
    humanized through, keyed by the solver's ``f"{event.id}:{pool.id}"`` spelling
    (the same one :func:`app.schedule_preview.build_preview_snapshot` stamps on the
    snapshot's pools). Parsed through :class:`~app.schemas.tournament.Pool`, not
    indexed off raw JSONB (parse, don't validate)."""
    resolutions: dict[str, _PreviewPoolResolution] = {}
    for event in tournament.events:
        for pool in event_pools(event):
            resolutions[f"{event.id}:{pool.id}"] = _PreviewPoolResolution(
                name=pool.name,
                window_start=pool.slot.start,
                window_end=pool.slot.end,
            )
    return resolutions


def _base_wall(tournament: Tournament) -> datetime | None:
    """The wall-clock origin of the snapshot's minute frame — the earliest pool
    window start across every event, the same anchor
    :func:`app.schedule_preview.build_preview_snapshot` offsets ``now_min = 0``
    from. ``None`` when no event has a pool (no window to anchor on), in which case
    the preview reports a duration in minutes but no wall-clock finish."""
    starts: list[datetime] = []
    for event in tournament.events:
        for pool in event_pools(event):
            starts.append(
                datetime.strptime(
                    f"{pool.slot.date} {pool.slot.start}", "%Y-%m-%d %H:%M"
                )
            )
    return min(starts) if starts else None


async def request_schedule_preview(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    actor: User,
    count_overrides: Mapping[uuid.UUID, int] | None = None,
) -> PreviewEnqueued:
    """Enqueue an ephemeral **schedule preview** for the tournament ``actor`` owns
    and return its token plus the immediately-known structure.

    Owner-gated and pre-live-guarded (:func:`_load_owned_pre_live_tournament` —
    404 → 403 → pre-live), it then builds the synthetic snapshot **synchronously**
    (:func:`app.schedule_preview.build_preview_snapshot` — the draw is instant),
    and enqueues :func:`run_schedule_preview` on the dedicated ``preview`` queue
    with the fully-built inputs. Nothing is written to Postgres — the whole answer
    will live only in the job result.

    ``count_overrides`` (event id → synthetic field size) lets a caller explore
    "what if 24 show up"; omitted, each event fills to its cap (or the uncapped
    default). Propagates :class:`~app.draws.UnsupportedDrawType` /
    :class:`~app.draws.DegenerateDraw` from the builder untouched — a preview is
    refused loud for any non-round-robin draw, never a partial grid. Raises
    :class:`ScheduleQueueUnavailableError` if the enqueue cannot be placed (Redis
    down), mirroring the real solve verb, so the return type stays non-optional.

    Returns a :class:`PreviewEnqueued`: the ``token`` (the RQ job id) to poll/wait
    on, plus the field sizes and the drawn fixtures a caller renders a skeleton
    from before the solve returns (ADR "instant structure and a streamed solve")."""
    tournament = await _load_owned_pre_live_tournament(db, tournament_id, actor)

    preview = build_preview_snapshot(tournament, count_overrides=count_overrides)
    inputs = PreviewJobInputs(
        snapshot=preview.snapshot,
        base=_base_wall(tournament),
        pool_resolutions=_pool_resolutions(tournament),
        events=tuple(
            _PreviewEventMeta(
                event_id=summary.event_id,
                name=_event_name(tournament, summary.event_id),
                field_size=summary.field_size,
            )
            for summary in preview.field_summaries
        ),
    )

    try:
        job = queue_module.get_preview_queue().enqueue(
            RUN_SCHEDULE_PREVIEW_JOB,
            inputs,
            job_timeout=int(get_settings().preview_solver_time_cap_s)
            + PREVIEW_JOB_TIMEOUT_MARGIN_S,
            result_ttl=_PREVIEW_RESULT_TTL_S,
        )
    except RedisError as exc:
        raise ScheduleQueueUnavailableError() from exc

    return PreviewEnqueued(
        token=job.id,
        field_summaries=[
            PreviewFieldSummary(
                event_id=summary.event_id, field_size=summary.field_size
            )
            for summary in preview.field_summaries
        ],
        fixtures=[
            PreviewFixture(
                fixture_id=fixture.id,
                event_id=fixture.event_id,
                pool_id=fixture.pool_id,
                player_a_id=fixture.player_a_id,
                player_b_id=fixture.player_b_id,
            )
            for fixture in preview.snapshot.fixtures
        ],
    )


def _event_name(tournament: Tournament, event_id: str) -> str:
    """The display name of the event with this (string) id — for the honest-notes
    strip and the per-event breakdown. The event is one of the tournament's own
    (the summary came from its snapshot), so a miss would be a builder bug; fall
    back to the raw id rather than raising, since a preview is advisory."""
    for event in tournament.events:
        if str(event.id) == event_id:
            return event.name
    return event_id


def run_schedule_preview(inputs: PreviewJobInputs) -> dict[str, object]:
    """RQ entry point: solve the synthetic snapshot and **return** the serialized
    :class:`PreviewResult`.

    Pure CPU, no database and no writes — the preview's whole non-persistence
    contract (ADR): it runs ``app.scheduling.solve`` over ``inputs.snapshot`` under
    the (short) preview time cap and projects the result. The return value is the
    only thing the job leaves behind — RQ stores it in the job's Redis result,
    where :func:`preview_job_state` reads it back. Dumped to plain JSON so the
    stored blob is transport-agnostic (the poll endpoint / MCP tool re-validate it
    into a :class:`PreviewResult`)."""
    result = _solve(
        inputs.snapshot,
        time_cap_s=get_settings().preview_solver_time_cap_s,
        num_search_workers=_solve_num_workers(),
    )
    return project_preview_result(inputs, result).model_dump(mode="json")


def project_preview_result(
    inputs: PreviewJobInputs, result: SolveResult
) -> PreviewResult:
    """Build the verdict-first :class:`PreviewResult` from a solve's answer and the
    inputs it was computed over — the DB-blind projection both the job (to store)
    and a test (to assert) call directly.

    Duration is the day's makespan (last placement end, in minutes from the first
    window opening at ``now_min = 0``), with a wall-clock finish when ``base`` is
    known. Match and bye counts are read off the (instant) draw, so they are
    present on every verdict; peak concurrent tables, utilization and per-event
    durations need a plan, so they are zero / ``None`` on an infeasible or unknown
    result. Infeasibility reasons are humanized through ``inputs.pool_resolutions``
    (+ a ``best_of`` map derived from the snapshot) into the *same* resolved union
    a real infeasible solve records."""
    snapshot = inputs.snapshot
    fixtures_by_event = _fixtures_by_event(snapshot)
    byes_by_event = _byes_by_event(snapshot)

    makespan = max((p.end_min for p in result.placements), default=None)
    duration_min = makespan if result.placements else None
    finish = (
        inputs.base + timedelta(minutes=duration_min)
        if inputs.base is not None and duration_min is not None
        else None
    )

    event_durations = _event_durations(result.placements, snapshot)
    breakdown = [
        PreviewEventBreakdown(
            event_id=meta.event_id,
            name=meta.name,
            matches=len(fixtures_by_event.get(meta.event_id, ())),
            byes=byes_by_event.get(meta.event_id, 0),
            duration_min=event_durations.get(meta.event_id),
        )
        for meta in inputs.events
    ]

    num_tables = len(snapshot.table_ids)
    peak = _peak_concurrent_tables(result.placements)
    utilization = _table_utilization(result.placements, num_tables, makespan)

    return PreviewResult(
        verdict=_preview_verdict(result.verdict),
        estimated_duration_min=duration_min,
        estimated_finish=finish,
        total_matches=len(snapshot.fixtures),
        total_byes=sum(byes_by_event.values()),
        peak_concurrent_tables=peak,
        table_utilization=utilization,
        events=breakdown,
        infeasibility_reasons=_resolve_reasons(result.reasons, inputs),
        notes=_honest_notes(inputs),
    )


def _preview_verdict(verdict: Verdict) -> PreviewVerdict:
    """Map the pure verdict onto the preview's read enum — a plain 1:1 rename over
    a closed domain (both enums carry the same four members)."""
    return PreviewVerdict(verdict.value)


def _fixtures_by_event(snapshot: ScheduleSnapshot) -> dict[str, list[str]]:
    """event id → its drawn fixture ids. The match count per event, straight off
    the (instant) draw, so it holds on every verdict — even an infeasible one that
    placed nothing."""
    by_event: dict[str, list[str]] = {}
    for fixture in snapshot.fixtures:
        by_event.setdefault(str(fixture.event_id), []).append(str(fixture.id))
    return by_event


def _byes_by_event(snapshot: ScheduleSnapshot) -> dict[str, int]:
    """event id → its bye count. A round-robin over an **odd** pool of ``P``
    players gives one bye per round and runs ``P`` rounds — every player byes
    exactly once — so an odd pool contributes ``P`` byes and an even pool ``0``.
    A pool's player set is recovered from its fixtures (in a round-robin every
    player meets every other, so each appears), keeping this pure over the
    snapshot with no separate field-size input."""
    players_by_pool: dict[str, set[str]] = {}
    pool_event: dict[str, str] = {}
    for fixture in snapshot.fixtures:
        pool = str(fixture.pool_id)
        pool_event[pool] = str(fixture.event_id)
        members = players_by_pool.setdefault(pool, set())
        members.add(str(fixture.player_a_id))
        members.add(str(fixture.player_b_id))
    byes: dict[str, int] = {}
    for pool, members in players_by_pool.items():
        count = len(members)
        if count % 2 == 1:
            byes[pool_event[pool]] = byes.get(pool_event[pool], 0) + count
    return byes


def _event_durations(
    placements: tuple[PlacedFixture, ...], snapshot: ScheduleSnapshot
) -> dict[str, int]:
    """event id → the event's own makespan span (last placement end minus first
    placement start, in minutes). Empty for an event with no placements (an
    infeasible/unknown solve places nothing), so its breakdown duration is
    ``None``."""
    fixture_event = {str(f.id): str(f.event_id) for f in snapshot.fixtures}
    starts: dict[str, int] = {}
    ends: dict[str, int] = {}
    for placement in placements:
        event_id = fixture_event[str(placement.fixture_id)]
        starts[event_id] = min(
            starts.get(event_id, placement.start_min), placement.start_min
        )
        ends[event_id] = max(ends.get(event_id, placement.end_min), placement.end_min)
    return {event_id: ends[event_id] - starts[event_id] for event_id in ends}


def _peak_concurrent_tables(placements: tuple[PlacedFixture, ...]) -> int:
    """The most matches running at once — a sweep over the placements' half-open
    ``[start, end)`` intervals. At a tie an end is processed before a start (a
    match ending at ``t`` frees its table for one starting at ``t``), so equal
    ``(time, delta)`` with ``delta = -1`` sorts ahead of ``+1``."""
    events: list[tuple[int, int]] = []
    for placement in placements:
        events.append((placement.start_min, 1))
        events.append((placement.end_min, -1))
    events.sort()
    running = 0
    peak = 0
    for _time, delta in events:
        running += delta
        peak = max(peak, running)
    return peak


def _table_utilization(
    placements: tuple[PlacedFixture, ...], num_tables: int, makespan: int | None
) -> float:
    """Fraction of the day's table-time the plan uses: Σ placement durations over
    (``num_tables`` × makespan). ``0.0`` when there is no plan or no room to fill
    (no tables / a zero-length day), never a divide-by-zero."""
    if makespan is None or makespan <= 0 or num_tables <= 0:
        return 0.0
    used = sum(p.end_min - p.start_min for p in placements)
    return used / (num_tables * makespan)


def _resolve_reasons(
    reasons: tuple[InfeasibilityReason, ...], inputs: PreviewJobInputs
) -> list[ResolvedReason]:
    """Humanize a preview's infeasibility reasons into the *same* resolved union a
    real infeasible solve records (:data:`app.schemas.schedule_solve.ResolvedReason`)
    — reusing the resolved-reason machinery rather than forking it. The pool name +
    ``HH:MM`` come from ``inputs.pool_resolutions``; ``best_of`` from a
    fixture-id → ``length_games`` map derived from the snapshot's events (a preview
    has no DB to read it from). Exhaustive ``match`` with an ``assert_never`` floor,
    like ``app.schedule_solves._resolve_reason``."""
    best_of = _fixture_best_of(inputs.snapshot)
    return [
        _resolve_reason(reason, inputs.pool_resolutions, best_of) for reason in reasons
    ]


def _fixture_best_of(snapshot: ScheduleSnapshot) -> dict[str, MatchLength]:
    """fixture id → its event's ``length_games`` (``best_of``) — derived purely
    from the snapshot (its events carry ``length_games``, its fixtures carry
    ``event_id``), so an infeasibility reason naming a fixture can be resolved
    without any DB read."""
    event_best_of = {str(e.id): e.length_games for e in snapshot.events}
    return {
        str(fixture.id): event_best_of[str(fixture.event_id)]
        for fixture in snapshot.fixtures
    }


def _resolve_reason(
    reason: InfeasibilityReason,
    pool_resolutions: Mapping[str, _PreviewPoolResolution],
    best_of: Mapping[str, MatchLength],
) -> ResolvedReason:
    """One pure, id-and-minute reason → its resolved read form, the DB-blind twin
    of ``app.schedule_solves._resolve_reason`` (same union, same arms) taking the
    resolution maps directly rather than a ``SolveInputs``. Exhaustive with an
    ``assert_never`` floor: adding an :data:`~app.scheduling.InfeasibilityReason`
    arm is a type error here until handled."""
    match reason:
        case PoolHasNoTables():
            return PoolHasNoTablesRead(pool_name=pool_resolutions[reason.pool_id].name)
        case WindowTooShortForMatch():
            pool = pool_resolutions[reason.pool_id]
            return WindowTooShortForMatchRead(
                pool_name=pool.name,
                window_start=pool.window_start,
                window_end=pool.window_end,
                best_of=best_of[reason.fixture_id],
                needed_min=reason.needed_min,
                window_span_min=reason.window_span_min,
            )
        case PoolOverCapacity():
            pool = pool_resolutions[reason.pool_id]
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


def _honest_notes(inputs: PreviewJobInputs) -> list[str]:
    """The always-present honest-notes strip (ADR): first the disjoint-field
    caveat that makes a preview *optimistic* (its synthetic fields are disjoint
    across events, so it ignores multi-event contention), then one line per event
    naming the synthetic count it assumed — so the estimate reads as the floor it
    is, never a hidden simplification."""
    notes = [
        "This estimate assumes no player is entered in more than one event; a "
        "real multi-event field would take longer."
    ]
    notes.extend(
        f"Assumed {meta.field_size} entrants for {meta.name}." for meta in inputs.events
    )
    return notes


#: Reads the job's stored JSON result back into a typed :class:`PreviewResult` in
#: one place (parse, don't validate) — the job dumped it to JSON, so no caller
#: downstream ever touches the raw dict.
_RESULT_ADAPTER: TypeAdapter[PreviewResult] = TypeAdapter(PreviewResult)


def preview_job_state(token: str) -> PreviewJobState:
    """Read the ephemeral preview job addressed by ``token`` off Redis and project
    its :class:`PreviewJobState` — the reusable helper the poll endpoint (one shot)
    and :func:`wait_for_preview` (looped) both sit on.

    Maps RQ's job lifecycle onto the four preview states: still waiting for a
    worker (queued/deferred/scheduled) → ``queued``; executing → ``running``;
    finished → ``done`` with the parsed :class:`PreviewResult`; and anything
    terminal-but-not-done (failed / stopped / cancelled) **or a job Redis no longer
    knows** (its short-TTL result expired, or the token was never valid) → ``failed``
    with a best-effort error string. ``result`` is set only on ``done`` and
    ``error`` only on ``failed`` (make illegal states unrepresentable)."""
    queue = queue_module.get_preview_queue()
    try:
        job = Job.fetch(token, connection=queue.connection)
    except NoSuchJobError:
        return PreviewJobState(
            status=PreviewJobStatus.failed,
            error="This preview is no longer available; run it again.",
        )

    status = job.get_status()
    if status == JobStatus.FINISHED:
        return PreviewJobState(
            status=PreviewJobStatus.done,
            result=_RESULT_ADAPTER.validate_python(job.return_value()),
        )
    if status == JobStatus.STARTED:
        return PreviewJobState(status=PreviewJobStatus.running)
    if status in (JobStatus.QUEUED, JobStatus.DEFERRED, JobStatus.SCHEDULED):
        return PreviewJobState(status=PreviewJobStatus.queued)
    return PreviewJobState(
        status=PreviewJobStatus.failed,
        error=job.exc_info or "The preview solve failed.",
    )


def cancel_preview(token: str) -> None:
    """Best-effort cancel of the ephemeral preview job addressed by ``token`` — the
    helper the ``DELETE`` adapter sits on so a caller who has navigated away stops
    an in-flight preview from holding a worker slot.

    Advisory and idempotent by design: a queued job is pulled off with
    :meth:`Job.cancel`, a running one is asked to stop with
    :func:`send_stop_job_command` (the worker's watchdog interrupts the CP-SAT
    call), and the job hash + its short-TTL result are then dropped so a cancelled
    preview can never be polled back as a stale success. **Every** terminal
    condition — a token Redis never knew, a job that already finished, or a Redis
    blip mid-cancel — is a no-op success, not an error: the caller (the DELETE
    route) answers the same ``204`` regardless, since the only invariant a cancel
    protects is "this ephemeral job is not still consuming a worker", and a
    finished/absent job already satisfies it. Nothing here touches Postgres — a
    preview persists nothing, so there is no state to unwind."""
    connection = queue_module.get_preview_queue().connection
    try:
        job = Job.fetch(token, connection=connection)
    except NoSuchJobError:
        return
    try:
        status = job.get_status()
        if status in (JobStatus.QUEUED, JobStatus.DEFERRED, JobStatus.SCHEDULED):
            job.cancel()
        elif status == JobStatus.STARTED:
            send_stop_job_command(connection, token)
    except (RedisError, InvalidJobOperation, NoSuchJobError):
        # The job raced to a terminal state (finished/cancelled) between the fetch
        # and the stop, or Redis blipped — either way the slot is already free, so
        # the cancel has nothing left to do. Fall through to the result drop.
        pass
    try:
        job.delete()
    except (RedisError, NoSuchJobError):
        pass


#: How often (seconds) :func:`wait_for_preview` re-reads the job while waiting —
#: tight enough to return promptly after a fast preview, loose enough not to spin.
_WAIT_POLL_INTERVAL_S = 0.1


def wait_for_preview(token: str, *, timeout_s: float) -> PreviewJobState:
    """Block until the preview job ``token`` reaches a terminal state
    (``done``/``failed``) or ``timeout_s`` elapses, then return its
    :class:`PreviewJobState` — the bounded-wait variant the MCP tool (later chore)
    uses to return a result in one call. On timeout it returns the last non-terminal
    state (``queued``/``running``): the job is still in flight, not failed. Polls at
    :data:`_WAIT_POLL_INTERVAL_S`; a caller wanting non-blocking polling uses
    :func:`preview_job_state` directly."""
    deadline = time.monotonic() + timeout_s
    while True:
        state = preview_job_state(token)
        if state.status in (PreviewJobStatus.done, PreviewJobStatus.failed):
            return state
        if time.monotonic() >= deadline:
            return state
        time.sleep(_WAIT_POLL_INTERVAL_S)
