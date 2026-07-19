"""The read boundary for a schedule solve's *resolved* infeasibility reasons.

``app.scheduling`` proves a day infeasible and emits structured, id-and-minute
only reasons (:data:`app.scheduling.InfeasibilityReason`) — pure and DB-blind on
purpose. This module is the DB-aware humanizer: it carries the *resolved* form a
client can render without any further lookup — the pool's display **name**, the
window's ``HH:MM`` clock bounds, the event's ``best_of`` — while leaving the raw
integer minutes (needed / span / required / capacity / available) untouched so
the client formats hours itself.

Structured, not prose (ADR "an infeasible solve explains itself with a resolved
reason"): a discriminated union over ``kind`` — the *same* discriminator strings
the pure module stamps — so a downstream renderer ``match``es it exhaustively
with no catch-all, and OpenAPI describes each arm precisely. The union is the
one importable alias :data:`ResolvedReason`, reused wherever a solve's reasons
are read (the ledger's persisted JSONB, and :class:`ScheduleSolveRead`).
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, TypeAdapter


class PoolHasNoTablesRead(BaseModel):
    """A pool with active fixtures but no tables at all — nowhere to place them.
    Resolved: the pool's display ``name`` (never the namespaced solver id)."""

    kind: Literal["pool_has_no_tables"] = "pool_has_no_tables"
    pool_name: str


class WindowTooShortForMatchRead(BaseModel):
    """A single fixture whose pool window cannot hold even one match: its
    ``best_of`` match needs ``needed_min`` minutes but the window spans only
    ``window_span_min``. Resolved: the pool ``name`` and its ``HH:MM`` window
    bounds; the minutes pass through as integers for the client to format."""

    kind: Literal["window_too_short_for_match"] = "window_too_short_for_match"
    pool_name: str
    window_start: str
    window_end: str
    best_of: Literal[1, 3, 5, 7]
    needed_min: int
    window_span_min: int


class PoolOverCapacityRead(BaseModel):
    """A pool whose aggregate match-time (``required_min``) exceeds the
    table-minutes its window offers (``capacity_min`` = window span ×
    ``table_count``). Resolved: the pool ``name`` and its ``HH:MM`` bounds; the
    minutes stay integers."""

    kind: Literal["pool_over_capacity"] = "pool_over_capacity"
    pool_name: str
    window_start: str
    window_end: str
    required_min: int
    capacity_min: int
    table_count: int


class NoSingleCauseRead(BaseModel):
    """CP-SAT proved the day infeasible yet no structural arm explains it — the
    whole-day residual. No pool: it carries only the day aggregate,
    ``required_min`` against ``available_min``, as integer minutes."""

    kind: Literal["no_single_cause"] = "no_single_cause"
    required_min: int
    available_min: int


#: The closed set of *resolved* reasons an infeasible solve carries — the
#: DB-aware mirror of :data:`app.scheduling.InfeasibilityReason`, humanized once
#: at apply and parsed back here at every read. Discriminated on ``kind`` so a
#: renderer is a total function of it (add an arm → a type error until handled).
ResolvedReason = Annotated[
    PoolHasNoTablesRead
    | WindowTooShortForMatchRead
    | PoolOverCapacityRead
    | NoSingleCauseRead,
    Field(discriminator="kind"),
]

#: Parses the ledger's raw JSONB (``list[dict]``) back into the typed union in
#: one place, so no read path downstream ever touches a raw dict (parse, don't
#: validate). Built once at import — a ``TypeAdapter`` is reusable and cached.
_REASONS_ADAPTER: TypeAdapter[list[ResolvedReason]] = TypeAdapter(list[ResolvedReason])


def parse_infeasibility_reasons(
    raw: list[dict[str, Any]] | None,
) -> list[ResolvedReason]:
    """Turn the ledger's ``infeasibility_reasons`` JSONB into typed reasons.

    ``None`` (every non-``infeasible`` status leaves the column NULL) parses to
    the empty list — a solve with no reasons to explain, not an error."""
    if raw is None:
        return []
    return _REASONS_ADAPTER.validate_python(raw)
