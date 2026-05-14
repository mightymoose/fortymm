import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db import get_session
from app.models import (
    Match,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    User,
)
from app.schemas.match import (
    MatchCreate,
    MatchRead,
    MatchSettingsRead,
    MatchSidePlayerRead,
    MatchSideRead,
)
from app.sessions import get_current_user

router = APIRouter(prefix="/v1")


# ----- helpers -------------------------------------------------------------


async def _load_match(db: AsyncSession, match_id: uuid.UUID) -> Match | None:
    """Fetch a match with every relationship the serializer touches eagerly
    loaded — async SQLAlchemy can't lazy-load once the request is in flight."""
    result = await db.execute(
        select(Match)
        .where(Match.id == match_id)
        .options(
            selectinload(Match.match_settings),
            selectinload(Match.sides)
            .selectinload(MatchSide.players)
            .selectinload(MatchSidePlayer.user),
        )
    )
    return result.scalar_one_or_none()


def _serialize_match(match: Match) -> MatchRead:
    sides = sorted(match.sides, key=lambda side: side.side_number)
    return MatchRead(
        id=match.id,
        status=match.status,
        created_by_user_id=match.created_by_user_id,
        created_at=match.created_at,
        settings=MatchSettingsRead.model_validate(match.match_settings),
        sides=[
            MatchSideRead(
                side_number=side.side_number,
                score=side.score,
                won=side.won,
                players=[
                    MatchSidePlayerRead(
                        user_id=player.user_id, username=player.user.username
                    )
                    for player in sorted(
                        side.players, key=lambda p: p.user.username
                    )
                ],
            )
            for side in sides
        ],
    )


def _add_side(match: Match, side_number: int, player: User) -> None:
    """Attach a single-player side to ``match``.

    Wiring up the ``match`` relationship on both the side and the side-player
    is what populates their (non-null, denormalized) ``match_id`` columns on
    flush."""
    side = MatchSide(match=match, side_number=side_number)
    side.players.append(MatchSidePlayer(match=match, user=player))


# ----- endpoints -----------------------------------------------------------


@router.post(
    "/matches", response_model=MatchRead, status_code=status.HTTP_201_CREATED
)
async def create_match(
    payload: MatchCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> MatchRead:
    opponent: User | None = None
    if payload.opponent_user_id is not None:
        if payload.opponent_user_id == current_user.id:
            raise HTTPException(
                status_code=422,
                detail="you cannot start a match against yourself",
            )
        opponent = (
            await db.execute(
                select(User).where(User.id == payload.opponent_user_id)
            )
        ).scalar_one_or_none()
        if opponent is None:
            raise HTTPException(status_code=404, detail="opponent not found")

    if payload.rated and opponent is None:
        raise HTTPException(
            status_code=422,
            detail="a rated match needs a registered opponent",
        )

    # Guest / "start without opponent" matches have only the creator's side,
    # so they can never affect ratings regardless of the requested flag.
    affects_rating = payload.rated and opponent is not None

    settings = MatchSettings(
        team_size=1,
        best_of=payload.best_of,
        affects_rating=affects_rating,
    )
    match = Match(
        match_settings=settings,
        created_by_user_id=current_user.id,
        status=MatchStatus.pending,
    )
    _add_side(match, 1, current_user)
    if opponent is not None:
        _add_side(match, 2, opponent)

    db.add(match)
    await db.commit()

    created = await _load_match(db, match.id)
    assert created is not None  # just committed; the row exists
    return _serialize_match(created)


@router.get("/matches/{match_id}", response_model=MatchRead)
async def get_match(
    match_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
) -> MatchRead:
    match = await _load_match(db, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="match not found")
    return _serialize_match(match)
