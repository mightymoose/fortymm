import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated

from coolname import generate_slug
from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from fastapi_limiter.depends import RateLimiter
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app import captcha as captcha_module
from app import queue as queue_module
from app.db import get_session
from app.leagues import add_user_to_default_league
from app.models import Permission, Role, RolePermission, User, UserRole, UserToken
from app.schemas.session import (
    ConfirmEmailRequest,
    ResendEmailRequest,
    SessionData,
    SessionResponse,
    SessionUser,
    SetEmailRequest,
    UpdateCurrentUserRequest,
)
from app.uniqueness import name_taken

router = APIRouter()

SESSION_COOKIE_NAME = "session"
SESSION_TOKEN_CONTEXT = "session"
EMAIL_CONFIRMATION_TOKEN_CONTEXT = "email_confirmation"
SESSION_LIFETIME = timedelta(days=30)
EMAIL_TAKEN_DETAIL = "That email is already in use."


async def _email_rate_limit_key(request: Request) -> str:
    """Key the email-send limiters by session cookie so legitimate users
    behind a shared NAT aren't punished for each other's submissions. Fall
    back to client IP for cookie-less requests (those will 401 downstream
    anyway, but the limiter still gets to count the attempt)."""
    cookie = request.cookies.get(SESSION_COOKIE_NAME)
    if cookie:
        return f"session:{cookie}"
    client = request.client
    return f"ip:{client.host if client else 'unknown'}"


# Limits chosen to allow normal flows (edit email, immediate resend on typo)
# while making bulk abuse uneconomical. Resend is tighter since users have an
# explicit no-cost path via re-submitting `set_email`.
email_send_rate_limit = RateLimiter(
    times=5, hours=1, identifier=_email_rate_limit_key
)
email_resend_rate_limit = RateLimiter(
    times=3, hours=1, identifier=_email_rate_limit_key
)


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


async def _build_session_response(db: AsyncSession, user: User) -> SessionResponse:
    permissions = await _load_permissions(db, user.id)
    return SessionResponse(
        data=SessionData(
            user=SessionUser(
                username=user.username,
                permissions=permissions,
                email=user.email,
                confirmed_at=user.confirmed_at,
            )
        )
    )


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
    return await _build_session_response(db, user)


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

    return await _build_session_response(db, current_user)


async def _verify_captcha_or_400(captcha_token: str) -> None:
    if not await captcha_module.verify_captcha(captcha_token):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Captcha verification failed. Please try again.",
        )


async def _issue_confirmation_token(
    db: AsyncSession, user: User, email: str
) -> str:
    """Generate, hash, and persist a fresh confirmation token. Returns the
    raw token (only ever in memory) so the caller can hand it to the email
    sender."""
    await db.execute(
        delete(UserToken).where(
            UserToken.user_id == user.id,
            UserToken.context == EMAIL_CONFIRMATION_TOKEN_CONTEXT,
        )
    )
    raw_token = secrets.token_urlsafe(32)
    db.add(
        UserToken(
            user_id=user.id,
            context=EMAIL_CONFIRMATION_TOKEN_CONTEXT,
            token=_hash_token(raw_token),
            sent_to=email,
        )
    )
    return raw_token


def _enqueue_confirmation_email(
    to_email: str, raw_token: str, username: str
) -> None:
    queue_module.get_email_queue().enqueue(
        "app.email.send_confirmation_email",
        to_email,
        raw_token,
        username,
    )


@router.post(
    "/v1/me/email",
    response_model=SessionResponse,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(email_send_rate_limit)],
)
async def set_email(
    payload: SetEmailRequest,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> SessionResponse:
    # Honeypot: silently succeed without doing anything. Bots fill it; humans
    # never see it. We respond as if all is well so the bot doesn't learn the
    # field is a trap.
    if payload.website.strip():
        return await _build_session_response(db, current_user)

    await _verify_captcha_or_400(payload.captcha_token)

    email = payload.email.lower()
    if current_user.email != email:
        if await name_taken(
            db, User.id, User.email, email, exclude_id=current_user.id
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=EMAIL_TAKEN_DETAIL,
            )
        current_user.email = email

    # Every successful set_email re-starts the confirmation handshake — the
    # user must click the new link even if they re-submitted the same address.
    current_user.confirmed_at = None
    raw_token = await _issue_confirmation_token(db, current_user, email)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=EMAIL_TAKEN_DETAIL,
        )
    _enqueue_confirmation_email(email, raw_token, current_user.username)
    return await _build_session_response(db, current_user)


@router.post(
    "/v1/me/email/resend",
    response_model=SessionResponse,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(email_resend_rate_limit)],
)
async def resend_email_confirmation(
    payload: ResendEmailRequest,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> SessionResponse:
    if payload.website.strip():
        return await _build_session_response(db, current_user)
    if not current_user.email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Add an email address before requesting a resend.",
        )
    if current_user.confirmed_at is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This email is already confirmed.",
        )
    await _verify_captcha_or_400(payload.captcha_token)

    raw_token = await _issue_confirmation_token(
        db, current_user, current_user.email
    )
    await db.commit()
    _enqueue_confirmation_email(
        current_user.email, raw_token, current_user.username
    )
    return await _build_session_response(db, current_user)


@router.post("/v1/me/email/confirm", response_model=SessionResponse)
async def confirm_email(
    payload: ConfirmEmailRequest,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> SessionResponse:
    token_row = (
        await db.execute(
            select(UserToken).where(
                UserToken.token == _hash_token(payload.token),
                UserToken.context == EMAIL_CONFIRMATION_TOKEN_CONTEXT,
            )
        )
    ).scalar_one_or_none()
    if token_row is None or token_row.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That confirmation link is invalid or expired.",
        )
    # Defensive: the email on the user may have been changed since the link
    # was sent. If so, the link no longer matches the intended address.
    if token_row.sent_to and token_row.sent_to != current_user.email:
        await db.delete(token_row)
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That confirmation link no longer matches your email.",
        )

    current_user.confirmed_at = datetime.now(timezone.utc)
    await db.delete(token_row)
    await db.commit()
    return await _build_session_response(db, current_user)
