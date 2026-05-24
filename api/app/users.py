import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi_limiter.depends import RateLimiter
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import User
from app.schemas.user import UserProfile
from app.sessions import get_current_user

router = APIRouter(prefix="/v1")


async def _public_profile_ip_key(request: Request) -> str:
    """Per-IP key for the unauthenticated profile endpoint — there is no
    session cookie to bucket against, so IP is all we have."""
    client = request.client
    ip = client.host if client else "unknown"
    return f"public-profile-ip:{ip}"


# 60/min per IP: comfortably above a human browsing several profiles in quick
# succession, well below the volume needed to scrape the user table.
public_profile_ip_rate_limit = RateLimiter(
    times=60, minutes=1, identifier=_public_profile_ip_key
)


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


@router.get(
    "/p/users/{username}",
    response_model=UserProfile,
    dependencies=[Depends(public_profile_ip_rate_limit)],
)
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
