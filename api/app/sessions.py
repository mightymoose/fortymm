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
    ConsumeLoginRequest,
    RequestLoginRequest,
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
# Email-change confirmation tokens carry the *prior* address in their context
# (e.g. "change:old@example.com", or "change:" on first-ever set). This gives
# us an audit trail of what each token was changing away from. Look up
# pending tokens by `context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)`.
EMAIL_CHANGE_CONTEXT_PREFIX = "change:"
LOGIN_TOKEN_CONTEXT = "login"
LOGIN_TOKEN_LIFETIME = timedelta(minutes=15)
SESSION_LIFETIME = timedelta(days=30)
EMAIL_TAKEN_DETAIL = "That email is already in use."


def _email_change_context(old_email: str | None) -> str:
    return f"{EMAIL_CHANGE_CONTEXT_PREFIX}{old_email or ''}"


def _hash_cookie_for_key(cookie: str) -> str:
    """Hash the raw session cookie before putting it into a Redis key. The
    cookie is a bearer credential; if it lands in Redis verbatim (snapshots,
    MONITOR, redis_exporter metric labels) anyone with read-only access can
    impersonate the user."""
    return hashlib.sha256(cookie.encode("utf-8")).hexdigest()


def _client_ip(request: Request) -> str:
    client = request.client
    return client.host if client else "unknown"


async def _email_rate_limit_key(request: Request) -> str:
    """Key the email-send limiters by hashed session cookie so legitimate
    users behind a shared NAT aren't penalised collectively. Fall back to
    client IP for cookie-less requests (those will 401 downstream anyway,
    but the limiter still counts the attempt)."""
    cookie = request.cookies.get(SESSION_COOKIE_NAME)
    if cookie:
        return f"session:{_hash_cookie_for_key(cookie)}"
    return f"ip:{_client_ip(request)}"


async def _email_ip_rate_limit_key(request: Request) -> str:
    """Per-IP key for the looser ceiling that catches attackers cycling
    fresh `/v1/session` cookies to bypass the per-session limit."""
    return f"email-ip:{_client_ip(request)}"


# Two-tier limit on the email-sending endpoints:
#   - tight per-session caps so a single user doesn't bulk-spam themselves
#     into a state where bounce-tracking matters,
#   - looser per-IP ceiling so an attacker can't trivially multiply their
#     budget by rotating guest sessions (each `GET /v1/session` mints a new
#     one for free).
email_send_rate_limit = RateLimiter(
    times=5, hours=1, identifier=_email_rate_limit_key
)
email_send_ip_rate_limit = RateLimiter(
    times=20, hours=1, identifier=_email_ip_rate_limit_key
)
email_resend_rate_limit = RateLimiter(
    times=3, hours=1, identifier=_email_rate_limit_key
)
email_resend_ip_rate_limit = RateLimiter(
    times=10, hours=1, identifier=_email_ip_rate_limit_key
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


async def _existing_change_context(
    db: AsyncSession, user_id
) -> str | None:
    """Return the context of the user's pending email-change token, if any.
    Lets ``resend`` preserve the original "change:" + old_email signature
    instead of guessing once the user's row has been overwritten."""
    result = await db.execute(
        select(UserToken.context)
        .where(
            UserToken.user_id == user_id,
            UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX),
        )
        .limit(1)
    )
    return result.scalars().first()


async def _issue_confirmation_token(
    db: AsyncSession, user: User, sent_to: str, context: str
) -> str:
    """Generate, hash, and persist a fresh confirmation token, rotating any
    prior change token for this user. Returns the raw token (only ever in
    memory) so the caller can hand it to the email sender."""
    await db.execute(
        delete(UserToken).where(
            UserToken.user_id == user.id,
            UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX),
        )
    )
    raw_token = secrets.token_urlsafe(32)
    db.add(
        UserToken(
            user_id=user.id,
            context=context,
            token=_hash_token(raw_token),
            sent_to=sent_to,
        )
    )
    return raw_token


def _enqueue_confirmation_email(to_email: str, raw_token: str, username: str):
    # result_ttl=60 / failure_ttl=300 shrinks the window during which the raw
    # token (pickled into the RQ job hash in Redis) is recoverable from a
    # snapshot or dashboard. Defaults are 8m / 1 year respectively.
    return queue_module.get_email_queue().enqueue(
        "app.email.send_confirmation_email",
        to_email,
        raw_token,
        username,
        result_ttl=60,
        failure_ttl=300,
    )


@router.post(
    "/v1/me/email",
    response_model=SessionResponse,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[
        Depends(email_send_ip_rate_limit),
        Depends(email_send_rate_limit),
    ],
)
async def set_email(
    payload: SetEmailRequest,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> SessionResponse:
    # Honeypot: silently succeed without doing anything. Bots fill it; humans
    # never see it. We respond as if all is well so the bot doesn't learn the
    # field is a trap.
    if payload.fmm_hp_token.strip():
        return await _build_session_response(db, current_user)

    await _verify_captcha_or_400(payload.captcha_token)

    email = payload.email.lower()
    old_email = current_user.email
    if current_user.email != email and await name_taken(
        db, User.id, User.email, email, exclude_id=current_user.id
    ):
        # Don't reveal that the email belongs to another user — that
        # differential lets attackers enumerate the user base by cycling
        # `GET /v1/session` for fresh rate-limit buckets. Return the same
        # 202 + unchanged session shape as the success path. The legitimate
        # owner is unaffected; the typo-on-someone-else's-address case sees
        # a "sent" toast but never receives an email.
        return await _build_session_response(db, current_user)

    if current_user.email != email:
        current_user.email = email

    # Every successful set_email re-starts the confirmation handshake — the
    # user must click the new link even if they re-submitted the same address.
    current_user.confirmed_at = None
    raw_token = await _issue_confirmation_token(
        db, current_user, email, _email_change_context(old_email)
    )

    # Enqueue BEFORE commit so a Redis flap can't leave a previously-verified
    # user silently un-verified with no link sent. If enqueue fails, rollback
    # restores in-memory + on-disk state.
    try:
        job = _enqueue_confirmation_email(
            email, raw_token, current_user.username
        )
    except Exception:
        await db.rollback()
        await db.refresh(current_user)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Email service unavailable. Try again in a moment.",
        )

    try:
        await db.commit()
    except IntegrityError:
        # Race with another user claiming the same address between our
        # `name_taken` probe and our commit. Cancel the now-orphan job and
        # return the same enumeration-safe 202 as the up-front collision.
        await db.rollback()
        try:
            job.cancel()
        except Exception:
            pass
        await db.refresh(current_user)
        return await _build_session_response(db, current_user)

    return await _build_session_response(db, current_user)


@router.post(
    "/v1/me/email/resend",
    response_model=SessionResponse,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[
        Depends(email_resend_ip_rate_limit),
        Depends(email_resend_rate_limit),
    ],
)
async def resend_email_confirmation(
    payload: ResendEmailRequest,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> SessionResponse:
    if payload.fmm_hp_token.strip():
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

    # Reuse the prior token's context so the audit trail still records what
    # the user was originally changing away from.
    prior_context = await _existing_change_context(db, current_user.id)
    raw_token = await _issue_confirmation_token(
        db,
        current_user,
        current_user.email,
        prior_context or _email_change_context(None),
    )
    try:
        job = _enqueue_confirmation_email(
            current_user.email, raw_token, current_user.username
        )
    except Exception:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Email service unavailable. Try again in a moment.",
        )
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        try:
            job.cancel()
        except Exception:
            pass
        raise
    return await _build_session_response(db, current_user)


@router.post("/v1/me/email/confirm", response_model=SessionResponse)
async def confirm_email(
    payload: ConfirmEmailRequest,
    response: Response,
    db: AsyncSession = Depends(get_session),
) -> SessionResponse:
    """Confirm the email-change handshake.

    The token in the email is itself the bearer credential — we don't
    require the click to come from the same browser that requested it.
    That lets users complete the flow on a mobile mail client even when
    their desktop session cookie isn't available, and avoids minting an
    orphan guest user on every cross-device click. The endpoint also
    rotates the caller's session cookie to the token's owner so the
    confirming browser ends up signed in as the right user.
    """
    token_row = (
        await db.execute(
            select(UserToken).where(
                UserToken.token == _hash_token(payload.token),
                UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX),
            )
        )
    ).scalar_one_or_none()
    if token_row is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That confirmation link is invalid or expired.",
        )
    user = (
        await db.execute(select(User).where(User.id == token_row.user_id))
    ).scalar_one_or_none()
    if user is None:
        await db.delete(token_row)
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That confirmation link is invalid or expired.",
        )
    if token_row.sent_to and token_row.sent_to != user.email:
        # The user changed their email between request and click — the link
        # no longer matches the intended address.
        await db.delete(token_row)
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That confirmation link no longer matches your email.",
        )

    user.confirmed_at = datetime.now(timezone.utc)
    await db.delete(token_row)
    # Mint a fresh session for the token's owner so the confirming browser
    # is signed in as them — replaces whatever guest session this browser
    # had (or hadn't) on arrival.
    raw_session = secrets.token_urlsafe(32)
    db.add(
        UserToken(
            user_id=user.id,
            context=SESSION_TOKEN_CONTEXT,
            token=_hash_token(raw_session),
        )
    )
    await db.commit()
    _set_session_cookie(response, raw_session)
    return await _build_session_response(db, user)


def _enqueue_login_email(to_email: str, raw_token: str, username: str):
    return queue_module.get_email_queue().enqueue(
        "app.email.send_login_email",
        to_email,
        raw_token,
        username,
        result_ttl=60,
        failure_ttl=300,
    )


@router.post(
    "/v1/login/request",
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[
        Depends(email_send_ip_rate_limit),
        Depends(email_send_rate_limit),
    ],
)
async def request_login_email(
    payload: RequestLoginRequest,
    db: AsyncSession = Depends(get_session),
) -> dict:
    """Mint a magic-link sign-in token and email it.

    Always returns 202 regardless of whether the address belongs to a
    confirmed account. Differential responses here would let an attacker
    enumerate accounts by cycling guest sessions for fresh rate-limit
    budgets, the same enumeration vector the email-change flow guards
    against.
    """
    if payload.fmm_hp_token.strip():
        return {"email": payload.email}

    await _verify_captcha_or_400(payload.captcha_token)

    email = payload.email.lower()
    user = (
        await db.execute(
            select(User).where(
                User.email == email, User.confirmed_at.is_not(None)
            )
        )
    ).scalar_one_or_none()
    if user is None:
        # Unknown email or unconfirmed account — return the same shape as the
        # success path so the response can't be used to probe membership.
        return {"email": email}

    # One live login token per user — clicking "resend" or re-submitting the
    # form invalidates the prior link.
    await db.execute(
        delete(UserToken).where(
            UserToken.user_id == user.id,
            UserToken.context == LOGIN_TOKEN_CONTEXT,
        )
    )
    raw_token = secrets.token_urlsafe(32)
    db.add(
        UserToken(
            user_id=user.id,
            context=LOGIN_TOKEN_CONTEXT,
            token=_hash_token(raw_token),
            sent_to=email,
        )
    )

    try:
        job = _enqueue_login_email(email, raw_token, user.username)
    except Exception:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Email service unavailable. Try again in a moment.",
        )

    try:
        await db.commit()
    except Exception:
        await db.rollback()
        try:
            job.cancel()
        except Exception:
            pass
        raise
    return {"email": email}


@router.post("/v1/login/consume", response_model=SessionResponse)
async def consume_login_token(
    payload: ConsumeLoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_session),
) -> SessionResponse:
    """Verify a magic-link token and rotate the caller's session cookie.

    The token is itself the bearer credential, so the click is accepted from
    any browser — the inbox proves ownership of the email. The endpoint
    rotates the caller's session cookie to the token's owner regardless of
    which guest session (if any) the browser arrived with.
    """
    token_row = (
        await db.execute(
            select(UserToken).where(
                UserToken.token == _hash_token(payload.token),
                UserToken.context == LOGIN_TOKEN_CONTEXT,
            )
        )
    ).scalar_one_or_none()
    if token_row is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That sign-in link is invalid or expired.",
        )

    issued_at = token_row.created_at
    if issued_at.tzinfo is None:
        issued_at = issued_at.replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) - issued_at > LOGIN_TOKEN_LIFETIME:
        await db.delete(token_row)
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That sign-in link is invalid or expired.",
        )

    user = (
        await db.execute(select(User).where(User.id == token_row.user_id))
    ).scalar_one_or_none()
    if user is None:
        await db.delete(token_row)
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That sign-in link is invalid or expired.",
        )

    # Single-use: delete the link the moment we accept it.
    await db.delete(token_row)
    raw_session = secrets.token_urlsafe(32)
    db.add(
        UserToken(
            user_id=user.id,
            context=SESSION_TOKEN_CONTEXT,
            token=_hash_token(raw_session),
        )
    )
    await db.commit()
    _set_session_cookie(response, raw_session)
    return await _build_session_response(db, user)
