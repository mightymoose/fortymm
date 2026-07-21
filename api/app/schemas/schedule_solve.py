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


class ConflictFixtureRead(BaseModel):
    """One of the in-progress matches caught in a conflict, named the way the
    director reads a fixture — by its **matchup**, the two players facing off
    (:attr:`player_a` / :attr:`player_b`, their display usernames). The raw
    ``fixture_id`` rides along so a surface can key/deep-link without re-deriving
    it from the names. Resolved once at apply from the pure conflict's fixture
    ids; the client formats the ``a vs b`` label itself."""

    fixture_id: str
    player_a: str
    player_b: str


class TableConflictRead(BaseModel):
    """Two or more in-progress matches recorded on the *same table* at
    overlapping times — physically impossible (a table holds one match), so
    contradictory data from a soft manual placement PATCH. Resolved: the table's
    catalogue ``table_label`` (never the raw value-object id) and the colliding
    ``fixtures``, each named by its matchup. The DB-aware mirror of
    :class:`app.scheduling.TableConflict`."""

    kind: Literal["table_conflict"] = "table_conflict"
    table_label: str
    fixtures: list[ConflictFixtureRead]


class PlayerConflictRead(BaseModel):
    """Two or more in-progress matches sharing a *human* whose occupancy
    overlaps — physically impossible (a human plays one match at a time), so
    contradictory data from a soft manual PATCH. Resolved: the human's display
    ``player_name`` and the colliding ``fixtures``, each named by its matchup.
    The DB-aware mirror of :class:`app.scheduling.PlayerConflict`."""

    kind: Literal["player_conflict"] = "player_conflict"
    player_name: str
    fixtures: list[ConflictFixtureRead]


#: The closed set of *resolved* placement conflicts a solve can report — the
#: DB-aware mirror of :data:`app.scheduling.PlacementConflict`, humanized once at
#: apply (ids → player names, table labels) and parsed back here at every read.
#: Discriminated on ``kind`` so a renderer is a total function of it (add an arm
#: → a type error until handled). Distinct from :data:`ResolvedReason`: a
#: conflict is orthogonal to the verdict — a fully-placed board can carry one.
ResolvedConflict = Annotated[
    TableConflictRead | PlayerConflictRead,
    Field(discriminator="kind"),
]

#: Parses the ledger's raw ``placement_conflicts`` JSONB (``list[dict]``) back
#: into the typed union in one place (parse, don't validate). Built once at
#: import — a ``TypeAdapter`` is reusable and cached.
_CONFLICTS_ADAPTER: TypeAdapter[list[ResolvedConflict]] = TypeAdapter(
    list[ResolvedConflict]
)


def parse_placement_conflicts(
    raw: list[dict[str, Any]] | None,
) -> list[ResolvedConflict]:
    """Turn the ledger's ``placement_conflicts`` JSONB into typed conflicts.

    ``None`` (a solve that never reached its apply left the column NULL) parses
    to the empty list — no conflicts to report, not an error. A solve that did
    apply writes ``[]`` for the (overwhelmingly common) no-conflict case, which
    parses to the same empty list."""
    if raw is None:
        return []
    return _CONFLICTS_ADAPTER.validate_python(raw)
