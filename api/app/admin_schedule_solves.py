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
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.rbac import require_permission
from app.schedule_solve_queries import (
    LIST_DEFAULT_PAGE_SIZE,
    LIST_MAX_PAGE_SIZE,
    count_schedule_solves,
)
from app.schedule_solve_queries import (
    list_schedule_solves as query_schedule_solves,
)
from app.schemas.admin import AdminScheduleSolveListResponse

# Gates the Administration area's solve-ledger page. Seeded (scripts/seed_rbac.py)
# and granted to the Administrator role, like the other admin-tool permissions.
SCHEDULING_VIEW_PERMISSION = "scheduling.view"

router = APIRouter(
    prefix="/v1",
    dependencies=[Depends(require_permission(SCHEDULING_VIEW_PERMISSION))],
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
    # Query + shaping live in the router-free reader (``schedule_solve_queries``),
    # which the MCP ``list_schedule_solves`` tool composes too; this handler keeps
    # only the ``scheduling.view`` gate (the router dependency) and the pagination
    # envelope. ``total`` counts the same filter the page draws from.
    total = await count_schedule_solves(db, tournament_id=tournament_id)
    items = await query_schedule_solves(
        db, tournament_id=tournament_id, page=page, page_size=page_size
    )
    return AdminScheduleSolveListResponse(
        items=items,
        page=page,
        page_size=page_size,
        total=total,
    )
