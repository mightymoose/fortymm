import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Tournament, TournamentEvent, User
from app.rbac import require_permission
from app.schemas.tournament import (
    TournamentCreate,
    TournamentDetailRead,
    TournamentEventCreate,
    TournamentEventRead,
    TournamentEventUpdate,
    TournamentRead,
    TournamentUpdate,
)
from app.sessions import get_current_user

# Every route here is gated on this permission (router-wide). PATCH, DELETE, and
# all event mutations additionally require the caller to be the tournament's
# creator.
TOURNAMENT_PERMISSION = "tournament.manage"

router = APIRouter(
    prefix="/v1",
    dependencies=[Depends(require_permission(TOURNAMENT_PERMISSION))],
)


# ----- helpers -------------------------------------------------------------


def _tournament_fields(
    t: Tournament,
    *,
    created_by_username: str,
    current_user_id: uuid.UUID,
) -> dict[str, Any]:
    # The request-scoped fields (``created_by_username``/``can_edit``) aren't on
    # the ORM row. The JSONB columns (``address``/``table_catalogue``) are read
    # straight off the attributes; Pydantic validates them into
    # Address/TournamentTable when the returned dict is fed to model_validate,
    # so the raw dicts never leave the serialize boundary.
    return {
        "id": t.id,
        "name": t.name,
        "description": t.description,
        "status": t.status,
        "start_date": t.start_date,
        "end_date": t.end_date,
        "address": t.address,
        "table_catalogue": t.table_catalogue,
        "created_by_user_id": t.created_by_user_id,
        "created_by_username": created_by_username,
        "can_edit": t.created_by_user_id == current_user_id,
        "created_at": t.created_at,
        "updated_at": t.updated_at,
    }


def _serialize(
    t: Tournament,
    *,
    created_by_username: str,
    current_user_id: uuid.UUID,
) -> TournamentRead:
    return TournamentRead.model_validate(
        _tournament_fields(
            t, created_by_username=created_by_username, current_user_id=current_user_id
        )
    )


def _serialize_detail(
    t: Tournament,
    *,
    created_by_username: str,
    current_user_id: uuid.UUID,
    events: list[TournamentEvent],
) -> TournamentDetailRead:
    # The full aggregate: tournament fields plus its events (each event's JSONB
    # value-objects validate into Pydantic models here, at this single boundary).
    return TournamentDetailRead.model_validate(
        {
            **_tournament_fields(
                t,
                created_by_username=created_by_username,
                current_user_id=current_user_id,
            ),
            "events": [TournamentEventRead.model_validate(e) for e in events],
        }
    )


async def _get_tournament_or_404(
    db: AsyncSession, tournament_id: uuid.UUID
) -> Tournament:
    tournament = (
        await db.execute(select(Tournament).where(Tournament.id == tournament_id))
    ).scalar_one_or_none()
    if tournament is None:
        raise HTTPException(status_code=404, detail="Tournament not found.")
    return tournament


async def _get_event_or_404(
    db: AsyncSession, tournament_id: uuid.UUID, event_id: uuid.UUID
) -> TournamentEvent:
    # The event must belong to the named tournament — scope the lookup by both
    # ids so a mismatched pair is a 404, not a cross-tournament edit.
    event = (
        await db.execute(
            select(TournamentEvent).where(
                TournamentEvent.id == event_id,
                TournamentEvent.tournament_id == tournament_id,
            )
        )
    ).scalar_one_or_none()
    if event is None:
        raise HTTPException(status_code=404, detail="Event not found.")
    return event


def _require_owner(t: Tournament, current_user: User) -> None:
    if t.created_by_user_id != current_user.id:
        raise HTTPException(
            status_code=403,
            detail="You can only modify tournaments you created.",
        )


# ----- tournament routes ---------------------------------------------------


@router.get("/tournaments", response_model=list[TournamentDetailRead])
async def list_tournaments(
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> list[TournamentDetailRead]:
    # The list page's cards render event-derived stats (event count, total
    # entries, table count), so the list returns the full aggregate — events
    # included — rather than a thinner summary. Two queries, no N+1: the
    # tournaments+usernames join, then all their events grouped in memory.
    rows = (
        await db.execute(
            select(Tournament, User.username)
            .join(User, User.id == Tournament.created_by_user_id)
            .order_by(Tournament.created_at.desc())
        )
    ).all()
    tournament_ids = [tournament.id for tournament, _ in rows]
    events_by_tournament: dict[uuid.UUID, list[TournamentEvent]] = {
        tid: [] for tid in tournament_ids
    }
    if tournament_ids:
        events = (
            (
                await db.execute(
                    select(TournamentEvent)
                    .where(TournamentEvent.tournament_id.in_(tournament_ids))
                    .order_by(TournamentEvent.created_at)
                )
            )
            .scalars()
            .all()
        )
        for event in events:
            events_by_tournament[event.tournament_id].append(event)
    return [
        _serialize_detail(
            tournament,
            created_by_username=username,
            current_user_id=current_user.id,
            events=events_by_tournament[tournament.id],
        )
        for tournament, username in rows
    ]


@router.post(
    "/tournaments",
    response_model=TournamentRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_tournament(
    payload: TournamentCreate,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentRead:
    # Persist the value-objects as plain JSONB; the dicts produced by
    # ``model_dump`` don't propagate beyond this write boundary.
    tournament = Tournament(
        name=payload.name,
        description=payload.description,
        status=payload.status,
        start_date=payload.start_date,
        end_date=payload.end_date,
        address=payload.address.model_dump(),
        table_catalogue=[t.model_dump() for t in payload.table_catalogue],
        created_by_user_id=current_user.id,
    )
    db.add(tournament)
    await db.commit()
    await db.refresh(tournament)
    return _serialize(
        tournament,
        created_by_username=current_user.username,
        current_user_id=current_user.id,
    )


@router.get("/tournaments/{tournament_id}", response_model=TournamentDetailRead)
async def get_tournament(
    tournament_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentDetailRead:
    # Fetch the row and creator username in one joined query. The inner join
    # can't drop the row (RESTRICT FK guarantees the creator exists), so a
    # missing row means the tournament itself is absent.
    row = (
        await db.execute(
            select(Tournament, User.username)
            .join(User, User.id == Tournament.created_by_user_id)
            .where(Tournament.id == tournament_id)
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Tournament not found.")
    tournament, username = row
    # A second query loads this tournament's events in creation order.
    events = (
        (
            await db.execute(
                select(TournamentEvent)
                .where(TournamentEvent.tournament_id == tournament_id)
                .order_by(TournamentEvent.created_at)
            )
        )
        .scalars()
        .all()
    )
    return _serialize_detail(
        tournament,
        created_by_username=username,
        current_user_id=current_user.id,
        events=list(events),
    )


@router.patch("/tournaments/{tournament_id}", response_model=TournamentRead)
async def update_tournament(
    tournament_id: uuid.UUID,
    payload: TournamentUpdate,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentRead:
    # Load first (404 if missing), THEN check ownership (403). The ordering is
    # intentional: a permitted non-creator learns the tournament exists.
    tournament = await _get_tournament_or_404(db, tournament_id)
    _require_owner(tournament, current_user)
    # model_dump(exclude_unset=True) already recursively serializes the nested
    # value-objects (address/table_catalogue) to plain dicts/lists, so a single
    # setattr loop covers the JSONB columns and the scalar fields alike. Absent
    # fields stay untouched; the schema validator already rejected an explicit
    # null on the NOT NULL columns.
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(tournament, key, value)
    await db.commit()
    await db.refresh(tournament)
    # The owner is the current user, so the username and can_edit are known.
    return _serialize(
        tournament,
        created_by_username=current_user.username,
        current_user_id=current_user.id,
    )


@router.delete(
    "/tournaments/{tournament_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_tournament(
    tournament_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> Response:
    tournament = await _get_tournament_or_404(db, tournament_id)
    _require_owner(tournament, current_user)
    await db.delete(tournament)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ----- event routes --------------------------------------------------------


@router.post(
    "/tournaments/{tournament_id}/events",
    response_model=TournamentEventRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_event(
    tournament_id: uuid.UUID,
    payload: TournamentEventCreate,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentEventRead:
    tournament = await _get_tournament_or_404(db, tournament_id)
    _require_owner(tournament, current_user)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name=payload.name,
        format=payload.format,
        draw_type=payload.draw_type,
        max_players=payload.max_players,
        entry_fee=payload.entry_fee,
        entered=payload.entered,
        slot=payload.slot.model_dump(),
        match_settings=payload.match_settings.model_dump(),
        predicates=[p.model_dump() for p in payload.predicates],
        pools=[p.model_dump() for p in payload.pools],
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    return TournamentEventRead.model_validate(event)


@router.patch(
    "/tournaments/{tournament_id}/events/{event_id}",
    response_model=TournamentEventRead,
)
async def update_event(
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    payload: TournamentEventUpdate,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentEventRead:
    tournament = await _get_tournament_or_404(db, tournament_id)
    _require_owner(tournament, current_user)
    event = await _get_event_or_404(db, tournament_id, event_id)
    # As in update_tournament: model_dump(exclude_unset=True) serializes the
    # nested value-objects (slot/match_settings/predicates/pools) to plain
    # dicts/lists, so one setattr loop covers the JSONB columns and scalars.
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(event, key, value)
    await db.commit()
    await db.refresh(event)
    return TournamentEventRead.model_validate(event)


@router.delete(
    "/tournaments/{tournament_id}/events/{event_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_event(
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> Response:
    tournament = await _get_tournament_or_404(db, tournament_id)
    _require_owner(tournament, current_user)
    event = await _get_event_or_404(db, tournament_id, event_id)
    await db.delete(event)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
