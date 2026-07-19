"""The Administration area's solve-ledger endpoint.

``schedule_solves`` is the placement solver's run ledger, and the admin page
reads it **verbatim** (ADR "the schedule is solved; the call is pinned") — this
router is that read: one paginated, cross-tournament listing, joined to the
owning tournament's name so the page needs no follow-up lookups (the BFF
one-endpoint-per-page rule).

Gated on its own permission, the way ``notifications.broadcast`` gates the
broadcast tool: an operator can hand out ledger read access without also
handing out the RBAC-management keys (``authorization.manage``).
"""

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import ColumnElement, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import ScheduleSolve, Tournament
from app.rbac import require_permission
from app.schemas.admin import AdminScheduleSolveListResponse, AdminScheduleSolveRead
from app.schemas.schedule_solve import parse_infeasibility_reasons

# Gates the Administration area's solve-ledger page. Seeded (scripts/seed_rbac.py)
# and granted to the Administrator role, like the other admin-tool permissions.
SCHEDULING_VIEW_PERMISSION = "scheduling.view"

# The roster's pagination contract (app/players.py): 25 to a page, capped at 100.
LIST_DEFAULT_PAGE_SIZE = 25
LIST_MAX_PAGE_SIZE = 100

router = APIRouter(
    prefix="/v1",
    dependencies=[Depends(require_permission(SCHEDULING_VIEW_PERMISSION))],
)


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
        error=solve.error,
        infeasibility_reasons=parse_infeasibility_reasons(solve.infeasibility_reasons),
        input_fingerprint=solve.input_fingerprint,
        rerun_requested=solve.rerun_requested,
        tournament_id=solve.tournament_id,
        tournament_name=tournament_name,
    )


@router.get("/admin/schedule-solves", response_model=AdminScheduleSolveListResponse)
async def list_schedule_solves(
    tournament_id: uuid.UUID | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=LIST_DEFAULT_PAGE_SIZE, ge=1, le=LIST_MAX_PAGE_SIZE),
    db: AsyncSession = Depends(get_session),
) -> AdminScheduleSolveListResponse:
    """Paginated cross-tournament solve ledger backing the Administration area's
    scheduling page, newest request first.

    Each row is one run of the placement solver exactly as ``schedule_solves``
    recorded it (ADR "the schedule is solved; the call is pinned"), plus the
    operator-only facts the tournament-facing read omits: the drift guard's
    ``input_fingerprint``, the coalescer's ``rerun_requested``, and the owning
    tournament's id and name. ``tournament_id`` narrows the ledger to one
    tournament's runs; ``total`` counts the rows matching that same filter.
    """
    filters: list[ColumnElement[bool]] = []
    if tournament_id is not None:
        filters.append(ScheduleSolve.tournament_id == tournament_id)

    total = (
        await db.execute(
            select(func.count()).select_from(ScheduleSolve).where(*filters)
        )
    ).scalar_one()

    rows = (
        await db.execute(
            select(ScheduleSolve, Tournament.name)
            .join(Tournament, Tournament.id == ScheduleSolve.tournament_id)
            .where(*filters)
            # requested_at DESC is the chronology; the id tie-break only makes
            # the page split deterministic for rows minted in one transaction
            # (a drift-discarded run and the rerun it requested share a now()).
            .order_by(ScheduleSolve.requested_at.desc(), ScheduleSolve.id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).all()

    return AdminScheduleSolveListResponse(
        items=[_serialize(solve, name) for solve, name in rows],
        page=page,
        page_size=page_size,
        total=total,
    )
