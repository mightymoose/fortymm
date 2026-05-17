import hashlib
import os
import secrets
from datetime import timedelta
from typing import Annotated

from coolname import generate_slug
from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.leagues import add_user_to_default_league
from app.models import Permission, Role, RolePermission, User, UserRole, UserToken
from app.schemas.session import (
    SessionData,
    SessionResponse,
    SessionUser,
    UpdateCurrentUserRequest,
)
from app.uniqueness import name_taken

router = APIRouter()

SESSION_COOKIE_NAME = "session"
SESSION_TOKEN_CONTEXT = "session"
SESSION_LIFETIME = timedelta(days=30)


def _hash_token(raw_token: str) -> bytes:
    return hashlib.sha256(raw_token.encode("utf-8")).digest()


async def _generate_username(db: AsyncSession) -> str:
    base = generate_slug(2)
    result = await db.execute(
        select(User.username).where(
            User.username.ilike(f"{base}%", escape="\\")
        )
    )
    taken = {u.lower() for u in result.scalars().all()}
    if base not in taken:
        return base
    suffix = 2
    while f"{base}-{suffix}" in taken:
        suffix += 1
    return f"{base}-{suffix}"


def _cookie_secure() -> bool:
    return os.environ.get("SESSION_COOKIE_SECURE", "true").lower() != "false"


async def _find_session_user(db: AsyncSession, raw_token: str) -> User | None:
    result = await db.execute(
        select(UserToken).where(
            UserToken.token == _hash_token(raw_token),
            UserToken.context == SESSION_TOKEN_CONTEXT,
        )
    )
    token = result.scalar_one_or_none()
    if token is None:
        return None
    user_result = await db.execute(select(User).where(User.id == token.user_id))
    return user_result.scalar_one_or_none()


async def _load_permissions(db: AsyncSession, user_id) -> list[str]:
    result = await db.execute(
        select(Permission.name)
        .join(RolePermission, RolePermission.permission_id == Permission.id)
        .join(Role, Role.id == RolePermission.role_id)
        .join(UserRole, UserRole.role_id == Role.id)
        .where(UserRole.user_id == user_id)
        .distinct()
        .order_by(Permission.name)
    )
    return list(result.scalars().all())


async def _create_session(db: AsyncSession) -> tuple[User, str]:
    user = User(username=await _generate_username(db))
    db.add(user)
    await db.flush()

    await add_user_to_default_league(db, user.id)

    raw_token = secrets.token_urlsafe(32)
    db.add(
        UserToken(
            user_id=user.id,
            context=SESSION_TOKEN_CONTEXT,
            token=_hash_token(raw_token),
        )
    )
    await db.commit()
    await db.refresh(user)
    return user, raw_token


def _set_session_cookie(response: Response, raw_token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=raw_token,
        max_age=int(SESSION_LIFETIME.total_seconds()),
        path="/",
        httponly=True,
        secure=_cookie_secure(),
        samesite="lax",
    )


@router.get("/v1/session", response_model=SessionResponse)
async def get_session_endpoint(
    response: Response,
    session_cookie: Annotated[
        str | None, Cookie(alias=SESSION_COOKIE_NAME)
    ] = None,
    db: AsyncSession = Depends(get_session),
) -> SessionResponse:
    user: User | None = None
    if session_cookie:
        user = await _find_session_user(db, session_cookie)
    if user is None:
        user, raw_token = await _create_session(db)
        _set_session_cookie(response, raw_token)
    permissions = await _load_permissions(db, user.id)
    return SessionResponse(
        data=SessionData(
            user=SessionUser(username=user.username, permissions=permissions)
        )
    )


async def get_current_user(
    session_cookie: Annotated[
        str | None, Cookie(alias=SESSION_COOKIE_NAME)
    ] = None,
    db: AsyncSession = Depends(get_session),
) -> User:
    """Resolve the authenticated user from the session cookie.

    Unlike ``GET /v1/session``, this dependency never mints a new session —
    endpoints that create or mutate data require an already-established
    session and respond ``401`` otherwise.
    """
    user = (
        await _find_session_user(db, session_cookie) if session_cookie else None
    )
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="authentication required",
        )
    return user


@router.patch("/v1/me", response_model=SessionResponse)
async def update_current_user(
    payload: UpdateCurrentUserRequest,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> SessionResponse:
    # Skip the uniqueness probe on a no-op submit so the user's own row
    # doesn't trip a 409 against itself.
    if payload.username != current_user.username:
        if await name_taken(
            db,
            User.id,
            User.username,
            payload.username,
            exclude_id=current_user.id,
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Username already taken.",
            )
        current_user.username = payload.username
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Username already taken.",
            )
        await db.refresh(current_user)

    permissions = await _load_permissions(db, current_user.id)
    return SessionResponse(
        data=SessionData(
            user=SessionUser(
                username=current_user.username, permissions=permissions
            )
        )
    )
