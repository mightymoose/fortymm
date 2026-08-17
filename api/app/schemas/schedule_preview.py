"""The read boundary for a **schedule preview** — the ephemeral, non-persistent
solve over a **synthetic field** (ADR "a schedule preview is a non-persistent
solve over a synthetic field").

A preview never touches Postgres: its answer lives only in the RQ/Redis job
result. This module is the typed shape that answer takes — the value the preview
job returns and the HTTP poll / MCP tool adapters hand back. It is
the DB-blind projection's *output* contract, mirroring
``app.schemas.schedule_solve`` (the persisted solve's read boundary) but with a
verdict-first summary rather than a ledger row: verdict + estimated duration up
top, then the counts (matches, byes, peak tables), a per-event breakdown, the
resolved infeasibility reasons when it does not fit, and an always-present
honest-notes strip (the disjoint-field caveat + the synthetic counts assumed).

The infeasibility reasons **reuse** the resolved-reason machinery
(:data:`app.schemas.schedule_solve.ResolvedReason`): a preview is the *same*
CP-SAT engine as a real solve, so an infeasible preview explains itself with the
exact same structured, discriminated-on-``kind`` reasons a real infeasible solve
does — humanized once (reservation id → name + ``HH:MM``, fixture id → ``best_of``) and
never re-derived downstream.

These models **do** reach ``openapi.json``: :class:`PreviewEnqueued` is the enqueue
route's response body, :class:`PreviewJobState` (carrying :class:`PreviewResult`) the
poll route's, and :class:`PreviewRequest` the enqueue body — so a change here drifts
the generated clients (``mise run regen-api-types`` / ``regen-ios-api-types``). The
``preview_schedule`` MCP tool returns :class:`PreviewResult` too, but MCP is never in
``schema.d.ts``.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, computed_field

from app.schemas.schedule_solve import ResolvedReason


class PreviewRequest(BaseModel):
    """The request body of a schedule-preview enqueue: the optional per-event
    **field-size overrides** a caller explores a ``"what if N show up"`` scenario
    with. Each key is an event id and each value the synthetic count to draw that
    event's field to; an omitted event fills to its own cap (or the uncapped
    default), so the whole body — and :attr:`overrides` itself — is optional.

    ``extra="forbid"`` so an unknown key is a ``422`` client bug, not a silently
    dropped field (api/CLAUDE.md — "request models reject the unexpected"). An
    override naming an event this tournament does not have is ignored by the
    builder rather than rejected: a preview is advisory, and a stale event id is
    not worth a refusal."""

    model_config = ConfigDict(extra="forbid")

    overrides: dict[uuid.UUID, int] = Field(default_factory=dict)


class PreviewVerdict(enum.Enum):
    """A preview's answer — the DB-blind mirror of :class:`app.scheduling.Verdict`.

    ``optimal``/``feasible`` mean the day fits (the synthetic field can be placed);
    ``infeasible`` means the engine *proved* it cannot; ``unknown`` means the
    (short) preview time cap ran out before any answer — a preview is deliberately
    cap-bounded, so ``unknown`` is "ask again / the day is large", never "your day
    doesn't fit" (that is ``infeasible`` alone)."""

    optimal = "optimal"
    feasible = "feasible"
    infeasible = "infeasible"
    unknown = "unknown"


class PreviewEventBreakdown(BaseModel):
    """One event's contribution to the preview summary: how many matches its
    synthetic field draws, how many byes that field takes, and how long the event
    itself runs.

    ``matches`` is the drawn pairing count (stable regardless of verdict — the draw
    is instant and always completes); ``byes`` is the round-robin sit-outs the
    field incurs (a group of an odd number of players gives one bye per round —
    every player byes exactly once — so an odd group of ``P`` contributes ``P``,
    an even group ``0``). ``duration_min`` is the event's own makespan span (last
    placement end minus first placement start, in minutes) — ``None`` when the
    solve produced no plan (infeasible / unknown), where there is nothing to
    span."""

    event_id: str
    name: str
    matches: int
    byes: int
    duration_min: int | None


class PreviewResult(BaseModel):
    """A schedule preview's whole answer — verdict-first, then the day's shape.

    The headline is :attr:`verdict` (does the synthetic field fit?) and
    :attr:`estimated_duration_min` (the day's makespan, in minutes from its first
    window opening), with :attr:`estimated_finish` its wall-clock form when the
    tournament's windows carry real times. Below that: the total match and bye
    counts, the peak concurrent-tables load and its utilization, and a per-event
    breakdown. When it does *not* fit, :attr:`infeasibility_reasons` carries the
    resolved, machine-readable reasons (the same union a real infeasible solve
    records). :attr:`notes` is the always-present honest-notes strip — at minimum
    the disjoint-field caveat and the synthetic counts assumed per event.

    A preview is **optimistic by construction**: its synthetic field is disjoint
    across events (no player is in two), so the duration estimate ignores the
    cross-event contention a multi-event human would cause. That is a stated floor,
    surfaced in :attr:`notes`, not a hidden simplification (ADR).
    """

    verdict: PreviewVerdict
    estimated_duration_min: int | None
    estimated_finish: datetime | None
    total_matches: int
    total_byes: int
    peak_concurrent_tables: int
    table_utilization: float
    events: list[PreviewEventBreakdown]
    infeasibility_reasons: list[ResolvedReason]
    notes: list[str]

    @computed_field  # type: ignore[prop-decorator]  # pydantic computed_field over a property
    @property
    def fits(self) -> bool:
        """Whether the day fits — a pure function of :attr:`verdict`
        (``optimal``/``feasible``), exposed as a derived field so the two can
        never drift (api/CLAUDE.md — "don't carry a field and its own
        derivation")."""
        return self.verdict in (PreviewVerdict.optimal, PreviewVerdict.feasible)


class PreviewFieldSummary(BaseModel):
    """One event's synthetic field size — the count the preview drew a field to
    (the override, the event's cap, or the uncapped default). The immediate,
    pre-solve structure a caller renders a skeleton from, and the ingredient the
    honest-notes strip names per event."""

    event_id: str
    field_size: int


class PreviewFixture(BaseModel):
    """One drawn synthetic pairing, known the instant the draw runs (before the
    solve returns) so a caller can render the grid skeleton immediately. The
    synthetic ids are opaque stand-ins (``Placeholder N`` on the surface); both
    sides are always known (the group stage of a round-robin draw).

    ``reservation_id`` is the namespaced ``f"{event_id}:{reservation_id}"``
    composite the solver keys a reservation by (unique across events) —
    scheduling is reservation-scoped, so this is the reservation the fixture's
    group is confined to, not the group's own id. ``reservation_name`` is the
    human label from the event's reservation config (e.g. ``"Reservation A"``)
    so the grid can head a column with a name a director recognizes rather than
    the raw composite."""

    fixture_id: str
    event_id: str
    reservation_id: str
    reservation_name: str
    player_a_id: str
    player_b_id: str


class PreviewEnqueued(BaseModel):
    """What the enqueue verb hands back the instant a preview is requested: the
    :attr:`token` addressing the ephemeral job (poll / wait on it for the result),
    plus the immediately-known structure — the per-event field sizes and the drawn
    fixtures — so a caller renders the field, the match/bye skeleton and the grid
    outline before the solve has finished (ADR "instant structure and a streamed
    solve")."""

    token: str
    field_summaries: list[PreviewFieldSummary]
    fixtures: list[PreviewFixture]


class PreviewJobStatus(enum.Enum):
    """Where an ephemeral preview job is in its life — the four states a caller
    polling (HTTP) or waiting (MCP) on the token can see. ``queued`` (waiting for a
    free worker slot, possibly behind an in-flight real solve), ``running`` (the
    CP-SAT solve is under way), ``done`` (the :class:`PreviewResult` is ready), or
    ``failed`` (the job errored, was cancelled, or its short-TTL result has already
    expired out of Redis)."""

    queued = "queued"
    running = "running"
    done = "done"
    failed = "failed"


class PreviewJobState(BaseModel):
    """A single read of a preview job's status by token: the :attr:`status`, the
    :attr:`result` when (and only when) it is ``done``, and the :attr:`error`
    string when it ``failed``. Make-illegal-states-unrepresentable is deferred to
    the constructor (:func:`app.schedule_preview_solve.preview_job_state` only ever
    sets ``result`` on ``done`` and ``error`` on ``failed``); this is the boundary
    value the poll endpoint and the MCP tool project."""

    status: PreviewJobStatus
    result: PreviewResult | None = None
    error: str | None = None
