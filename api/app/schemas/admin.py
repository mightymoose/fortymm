"""Schemas for the Administration area's cross-tournament surfaces.

Today that is one page: the solve ledger — ``schedule_solves`` read verbatim
(ADR "the schedule is solved; the call is pinned"), across every tournament,
for the operator who wants to know what the solver has been doing platform-wide.
"""

import uuid

from pydantic import BaseModel

from app.schemas.tournament import ScheduleSolveRead


class AdminScheduleSolveRead(ScheduleSolveRead):
    """One ledger row as the *admin* page reads it: everything the
    tournament-facing :class:`ScheduleSolveRead` carries, plus the
    operator-only facts that schema deliberately omits —

    * ``input_fingerprint`` — the drift guard's comparison key (the hash of the
      snapshot this run solved against); ``null`` for a run that never
      snapshotted. The detail BFF's solve strip has no use for it; the operator
      chasing a ``superseded by re-run`` chain does.
    * ``rerun_requested`` — the coalescer's second arm: a trigger landed while
      this run was ``running``. Meaningless (always ``false``) on terminal rows.
    * ``tournament_id`` / ``tournament_name`` — the tournament the run belongs
      to, joined here so the page needs no follow-up lookups. The name is read
      live from the tournament row, not snapshotted at solve time.
    """

    input_fingerprint: str | None
    rerun_requested: bool
    tournament_id: uuid.UUID
    tournament_name: str


class AdminScheduleSolveListResponse(BaseModel):
    """Paginated `/v1/admin/schedule-solves` response backing the Administration
    area's solve-ledger page."""

    items: list[AdminScheduleSolveRead]
    page: int
    page_size: int
    total: int
