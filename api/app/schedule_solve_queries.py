"""The transport-neutral reader behind the Administration area's solve ledger.

``schedule_solves`` is the placement solver's run ledger; this module is the
DB-only query + shaping that reads it verbatim (ADR "the schedule is solved; the
call is pinned") — one paginated, cross-tournament listing joined to each run's
owning tournament name, newest request first, plus the matching row count.

Router-free by design: no FastAPI imports. Both the HTTP admin route
(``app.admin_schedule_solves``) and the MCP ``list_schedule_solves`` tool compose
these reads, each enforcing the ``scheduling.view`` permission at its own adapter
(the reader itself gates nothing — it is pure query + shaping), so the two
surfaces can never drift on what a ledger row is.
"""

import uuid

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ScheduleSolve, Tournament
from app.schemas.admin import AdminScheduleSolveRead
from app.schemas.schedule_solve import (
    parse_infeasibility_reasons,
    parse_placement_conflicts,
)

# The roster's pagination contract (app/players.py): 25 to a page, capped at 100.
# Held here, the single source both adapters read, so the HTTP query-param caps
# and the MCP tool's argument bounds can never disagree on what a valid page is.
LIST_DEFAULT_PAGE_SIZE = 25
LIST_MAX_PAGE_SIZE = 100


def _serialize(solve: ScheduleSolve, tournament_name: str) -> AdminScheduleSolveRead:
    return AdminScheduleSolveRead(
        id=solve.id,
        trigger=solve.trigger,
        status=solve.status,
        verdict=solve.verdict,
        requested_at=solve.requested_at,
        started_at=solve.started_at,
        finished_at=solve.finished_at,
        wall_time_ms=solve.wall_time_ms,
        fixtures_placed=solve.fixtures_placed,
        fixtures_pinned=solve.fixtures_pinned,
        overrunning=solve.overrunning,
        error=solve.error,
        infeasibility_reasons=parse_infeasibility_reasons(solve.infeasibility_reasons),
        placement_conflicts=parse_placement_conflicts(solve.placement_conflicts),
        input_fingerprint=solve.input_fingerprint,
        rerun_requested=solve.rerun_requested,
        tournament_id=solve.tournament_id,
        tournament_name=tournament_name,
    )


def _filters(tournament_id: uuid.UUID | None) -> list[ColumnElement[bool]]:
    """The optional ``tournament_id`` narrowing, shared by the count and the page
    so ``total`` counts exactly the rows the page draws from."""
    filters: list[ColumnElement[bool]] = []
    if tournament_id is not None:
        filters.append(ScheduleSolve.tournament_id == tournament_id)
    return filters


async def count_schedule_solves(
    db: AsyncSession, *, tournament_id: uuid.UUID | None = None
) -> int:
    """The number of ledger rows matching ``tournament_id`` (all rows when
    ``None``) — the ``total`` the paginated admin response reports."""
    return (
        await db.execute(
            select(func.count())
            .select_from(ScheduleSolve)
            .where(*_filters(tournament_id))
        )
    ).scalar_one()


async def list_schedule_solves(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID | None = None,
    page: int = 1,
    page_size: int = LIST_DEFAULT_PAGE_SIZE,
) -> list[AdminScheduleSolveRead]:
    """One page of the cross-tournament solve ledger, newest request first, each
    row joined to its owning tournament's name and carrying the operator-only
    facts the tournament-facing read omits (``input_fingerprint``,
    ``rerun_requested``).

    ``tournament_id`` narrows to one tournament's runs. Pure query + shaping: the
    permission gate lives at each adapter, not here.
    """
    rows = (
        await db.execute(
            select(ScheduleSolve, Tournament.name)
            .join(Tournament, Tournament.id == ScheduleSolve.tournament_id)
            .where(*_filters(tournament_id))
            # requested_at DESC is the chronology; the id tie-break only makes
            # the page split deterministic for rows minted in one transaction
            # (a drift-discarded run and the rerun it requested share a now()).
            .order_by(ScheduleSolve.requested_at.desc(), ScheduleSolve.id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).all()
    return [_serialize(solve, name) for solve, name in rows]
