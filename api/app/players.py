from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import User
from app.schemas.player import PlayerRead
from app.sessions import get_current_user

router = APIRouter(prefix="/v1")


@router.get("/players", response_model=list[PlayerRead])
async def list_players(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[PlayerRead]:
    """List registered users the caller can pick as an opponent (everyone but
    themselves)."""
    result = await db.execute(
        select(User)
        .where(User.id != current_user.id)
        .order_by(User.username)
    )
    return [PlayerRead.model_validate(user) for user in result.scalars().all()]
