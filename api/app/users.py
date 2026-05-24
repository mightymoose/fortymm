import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import User
from app.schemas.user import UserProfile
from app.sessions import get_current_user

router = APIRouter(prefix="/v1")


@router.get("/users/{user_id}/profile", response_model=UserProfile)
async def get_user_by_id(
    user_id: uuid.UUID,
    _current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> UserProfile:
    user = (
        await db.execute(select(User).where(User.id == user_id))
    ).scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found."
        )
    return UserProfile.model_validate(user)


@router.get("/p/users/{username}", response_model=UserProfile)
async def get_public_user_by_username(
    username: str,
    db: AsyncSession = Depends(get_session),
) -> UserProfile:
    user = (
        await db.execute(select(User).where(User.username == username))
    ).scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found."
        )
    return UserProfile.model_validate(user)
