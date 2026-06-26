import hashlib
import logging
import os
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated

from coolname import generate_slug
from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from pyrate_limiter import Duration, Rate
from rq.job import Job
from sqlalchemy import ColumnElement, delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app import captcha as captcha_module
from app import queue as queue_module
from app.account_merge import merge_user
from app.db import get_session
from app.leagues import add_user_to_default_league
from app.models import (
    MatchSidePlayer,
    Permission,
    Role,
    RolePermission,
    User,
    UserRole,
    UserToken,
)
from app.rate_limiting import RedisRateLimiter
from app.ratings.jobs import RECOMPUTE_AFTER_MERGE_JOB
from app.schemas.session import (
    ConfirmEmailRequest,
    ConsumeLoginRequest,
    LoginRequestAccepted,
    MergePreview,
    MergePreviewRequest,
    MergeSummary,
    RequestLoginRequest,
    ResendEmailRequest,
    SessionData,
    SessionResponse,
    SessionUser,
    SetEmailRequest,
    UpdateCurrentUserRequest,
)
from app.uniqueness import name_taken

log = logging.getLogger(__name__)

router = APIRouter()

SESSION_COOKIE_NAME = "session"
# Non-HttpOnly companion cookie for the double-submit CSRF defense. The session
# cookie is HttpOnly so a cross-origin attacker can't read it; this one is
# readable by our own JS, which echoes it in the ``X-CSRF-Token`` header on
# mutating requests. ``csrf_protect`` (app/main.py) rejects any unsafe-method
# request that carries a session cookie whose header doesn't match this cookie
# (a cookieless request has no ambient authority to forge, so the guard skips
# it). An attacker's page can ride along the cookies but can neither read this
# value nor set the custom header.
CSRF_COOKIE_NAME = "csrf_token"
CSRF_HEADER_NAME = "x-csrf-token"
# Methods that can't mutate state are exempt from the CSRF check; OPTIONS
# preflights in particular carry no custom header and must pass through. The
# middleware (app/main.py) and the test request hook both read this set so they
# can't drift.
CSRF_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
SESSION_TOKEN_CONTEXT = "session"
# Stable `code` on the 401 we raise when a cookie resolves to a tombstoned
# (merged-away) guest, so clients can tell "your session was merged, sign in"
# apart from an ordinary auth failure and redirect to login (with the owner's
# email prefilled) instead of looping.
SESSION_MERGED_CODE = "session_merged"
# Email-change confirmation tokens carry the *prior* address in their context
# (e.g. "change:old@example.com", or "change:" on first-ever set). This gives
# us an audit trail of what each token was changing away from. Look up
# pending tokens by `context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX)`.
EMAIL_CHANGE_CONTEXT_PREFIX = "change:"
# A guest (no confirmed email of their own) who enters an address that already
# belongs to a verified account gets a *merge* token rather than a plain change
# token. Confirming it folds the guest's data into the owning account and signs
# the browser in as that account — instead of stamping the address onto the
# guest. The context records the owning account's id: "merge:<uuid>".
EMAIL_MERGE_CONTEXT_PREFIX = "merge:"
LOGIN_TOKEN_CONTEXT = "login"
LOGIN_TOKEN_LIFETIME = timedelta(minutes=15)
# Email-change and account-merge confirmation links are mailed (so they tolerate
# slower inbox round-trips than an in-app sign-in) but still expire, so a leaked
# or forwarded link can't be redeemed indefinitely.
EMAIL_CONFIRM_TOKEN_LIFETIME = timedelta(hours=24)
SESSION_LIFETIME = timedelta(days=30)
EMAIL_TAKEN_DETAIL = "That email is already in use."


def _email_change_context(old_email: str | None) -> str:
    return f"{EMAIL_CHANGE_CONTEXT_PREFIX}{old_email or ''}"


def _old_email_from_context(context: str) -> str | None:
    """Inverse of ``_email_change_context``."""
    return context.removeprefix(EMAIL_CHANGE_CONTEXT_PREFIX) or None


def _merge_context(target_user_id: uuid.UUID) -> str:
    return f"{EMAIL_MERGE_CONTEXT_PREFIX}{target_user_id}"


def _target_id_from_merge_context(context: str) -> uuid.UUID | None:
    """Inverse of ``_merge_context``. Returns ``None`` on a malformed id so a
    corrupt context surfaces as an opaque "invalid link" rather than a 500."""
    try:
        return uuid.UUID(context.removeprefix(EMAIL_MERGE_CONTEXT_PREFIX))
    except ValueError:
        return None


def _token_expired(token_row: UserToken, lifetime: timedelta) -> bool:
    """True once ``token_row`` is older than ``lifetime``. ``created_at`` is a
    ``DateTime(timezone=True)`` column, so it is always timezone-aware here."""
    return datetime.now(UTC) - token_row.created_at > lifetime


def _pending_email_token_clause() -> ColumnElement[bool]:
    """Match either flavour of pending email token — a plain change token
    (``change:OLD``) or a merge-into-existing-account token (``merge:<uuid>``).
    Both drive the session's ``pending_email`` and both are consumed by
    ``confirm_email``."""
    return or_(
        UserToken.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX),
        UserToken.context.startswith(EMAIL_MERGE_CONTEXT_PREFIX),
    )


# A login token records the *requesting* guest in its context so the merge it
# drives is token-bound (works cross-device) like the settings merge: bare
# ``login`` when the requester wasn't an ephemeral guest, else
# ``login:<guest-id>``.
_LOGIN_CONTEXT_PREFIX = f"{LOGIN_TOKEN_CONTEXT}:"


def _login_context(guest_id: uuid.UUID | None) -> str:
    return (
        LOGIN_TOKEN_CONTEXT
        if guest_id is None
        else f"{_LOGIN_CONTEXT_PREFIX}{guest_id}"
    )


def _guest_id_from_login_context(context: str) -> uuid.UUID | None:
    """The requesting guest recorded on a login token, or ``None`` for a bare
    ``login`` context (or a malformed id)."""
    if not context.startswith(_LOGIN_CONTEXT_PREFIX):
        return None
    try:
        return uuid.UUID(context.removeprefix(_LOGIN_CONTEXT_PREFIX))
    except ValueError:
        return None


def _login_token_clause() -> ColumnElement[bool]:
    """Match both login-token flavours (bare ``login`` and ``login:<guest>``)."""
    return or_(
        UserToken.context == LOGIN_TOKEN_CONTEXT,
        UserToken.context.startswith(_LOGIN_CONTEXT_PREFIX),
    )


async def _guest_match_count(db: AsyncSession, guest_id: uuid.UUID) -> int:
    """How many distinct matches the guest is on — what a merge would carry
    over. ``UNIQUE(match_id, user_id)`` means one row per match, but count
    distinct match ids defensively."""
    return (
        await db.execute(
            select(func.count(func.distinct(MatchSidePlayer.match_id))).where(
                MatchSidePlayer.user_id == guest_id
            )
        )
    ).scalar_one()


async def _merge_guest_into(
    db: AsyncSession, *, guest: User | None, target: User
) -> MergeSummary | None:
    """Fold an ephemeral ``guest`` into ``target`` when it's safe, returning the
    summary. ``None`` (no merge) when the guest is missing, is the target, has
    verified an email of its own (would be data loss), or is already tombstoned.
    Runs in the caller's transaction — does not commit.

    The single guard used by every merge path: token-bound sign-in/confirm and
    the browser-bound prior-session fold."""
    if (
        guest is None
        or guest.id == target.id
        or guest.confirmed_at is not None
        or guest.merged_into_user_id is not None
    ):
        return None
    summary = await merge_user(db, from_user_id=guest.id, to_user_id=target.id)
    return MergeSummary(matches_moved=summary.matches_moved)


async def _sign_in_after_merge(
    db: AsyncSession,
    response: Response,
    user: User,
    merged: MergeSummary | None,
) -> SessionResponse:
    """Mint a fresh session for ``user``, commit the pending transaction, fire
    the rating recompute when matches moved, rotate the cookie, and return the
    session. The shared tail of the token-bound merge sign-in paths
    (``consume_login_token`` and ``_confirm_account_merge``): the caller stages
    the token deletion + merge, this finalizes."""
    raw_session = secrets.token_urlsafe(32)
    db.add(
        UserToken(
            user_id=user.id,
            context=SESSION_TOKEN_CONTEXT,
            token=_hash_token(raw_session),
        )
    )
    await db.commit()
    if merged is not None and merged.matches_moved > 0:
        _enqueue_rating_recompute_after_merge(user.id)
    _set_session_cookie(response, raw_session)
    return await _build_session_response(db, user, merged=merged)


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
email_send_rate_limit = RedisRateLimiter(
    rates=[Rate(5, Duration.HOUR)],
    bucket_key="email-send",
    identifier=_email_rate_limit_key,
)
email_send_ip_rate_limit = RedisRateLimiter(
    rates=[Rate(20, Duration.HOUR)],
    bucket_key="email-send-ip",
    identifier=_email_ip_rate_limit_key,
)
email_resend_rate_limit = RedisRateLimiter(
    rates=[Rate(3, Duration.HOUR)],
    bucket_key="email-resend",
    identifier=_email_rate_limit_key,
)
email_resend_ip_rate_limit = RedisRateLimiter(
    rates=[Rate(10, Duration.HOUR)],
    bucket_key="email-resend-ip",
    identifier=_email_ip_rate_limit_key,
)


async def _login_consume_ip_rate_limit_key(request: Request) -> str:
    """Separate per-IP key for /v1/login/consume so failed verification
    bursts don't burn the email-send IP budget for legitimate sign-ins
    from the same network."""
    return f"login-consume-ip:{_client_ip(request)}"


# Permissive ceiling on /v1/login/consume — the bearer token is 256 bits
# of entropy, so this is defense-in-depth against floods rather than a
# realistic brute-force barrier.
login_consume_ip_rate_limit = RedisRateLimiter(
    rates=[Rate(60, Duration.HOUR)],
    bucket_key="login-consume-ip",
    identifier=_login_consume_ip_rate_limit_key,
)


def _hash_token(raw_token: str) -> bytes:
    return hashlib.sha256(raw_token.encode("utf-8")).digest()


async def _generate_username(db: AsyncSession) -> str:
    base = generate_slug(2)
    result = await db.execute(
        select(User.username).where(User.username.ilike(f"{base}%", escape="\\"))
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


def _clear_cookie_header() -> dict[str, str]:
    """A ``Set-Cookie`` that clears the session cookie, for attaching to the 401
    we raise when a cookie resolves to a tombstoned guest. The cookie is
    HttpOnly, so only the server can drop it — clearing it lets the holder start
    a fresh guest from the login screen. Mirror ``_clear_session_cookie``'s
    attributes so the browser actually matches and drops it."""
    attrs = [
        f"{SESSION_COOKIE_NAME}=",
        "Path=/",
        "Max-Age=0",
        "HttpOnly",
        "SameSite=lax",
    ]
    if _cookie_secure():
        attrs.append("Secure")
    return {"set-cookie": "; ".join(attrs)}


async def _merged_session_exception(db: AsyncSession, user: User) -> HTTPException:
    """Build the 401 for a cookie that resolves to a tombstoned (merged-away)
    guest. Carries the stable ``SESSION_MERGED_CODE`` so clients redirect to
    login rather than treating it as an ordinary auth failure, plus the owning
    account's email to prefill — safe, since the holder is the one who entered
    it. Also clears the dead cookie."""
    owner = await db.get(User, user.merged_into_user_id)
    detail: dict[str, str] = {
        "code": SESSION_MERGED_CODE,
        "message": "This guest session was merged into your account. "
        "Sign in to continue.",
    }
    if owner is not None and owner.email:
        detail["email"] = owner.email
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers=_clear_cookie_header(),
    )


async def _build_session_response(
    db: AsyncSession, user: User, merged: MergeSummary | None = None
) -> SessionResponse:
    permissions = await _load_permissions(db, user.id)
    pending = await _pending_change_token(db, user.id)
    return SessionResponse(
        data=SessionData(
            user=SessionUser(
                username=user.username,
                permissions=permissions,
                email=user.email,
                confirmed_at=user.confirmed_at,
                pending_email=pending.sent_to if pending else None,
            )
        ),
        merged=merged,
    )


async def _maybe_merge_prior_session(
    db: AsyncSession, session_cookie: str | None, target_user: User
) -> MergeSummary | None:
    """Browser-bound fold: if the clicking browser arrived with an ephemeral
    guest cookie, fold that guest into ``target_user``. The fallback used by
    sign-in when the token didn't record a specific requesting guest.

    ``_merge_guest_into`` enforces the safety guards (skip a verified prior —
    two real accounts sharing a browser — or an already-tombstoned ghost).
    """
    if not session_cookie:
        return None
    prior_user = await _find_session_user(db, session_cookie)
    return await _merge_guest_into(db, guest=prior_user, target=target_user)


async def _load_permissions(db: AsyncSession, user_id: uuid.UUID) -> list[str]:
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
    # Session cookie first so it leads the Set-Cookie list, then a fresh CSRF
    # token. Every session rotation (create, merge sign-in, email confirm,
    # magic-link consume) flows through here, so the CSRF token rotates with
    # the session for free.
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=raw_token,
        max_age=int(SESSION_LIFETIME.total_seconds()),
        path="/",
        httponly=True,
        secure=_cookie_secure(),
        samesite="lax",
    )
    _set_csrf_cookie(response)


def _set_csrf_cookie(response: Response) -> None:
    response.set_cookie(
        key=CSRF_COOKIE_NAME,
        value=secrets.token_urlsafe(32),
        max_age=int(SESSION_LIFETIME.total_seconds()),
        path="/",
        # Intentionally readable by JS — the client must echo it in a header.
        httponly=False,
        secure=_cookie_secure(),
        samesite="lax",
    )


def _clear_session_cookie(response: Response) -> None:
    # Must mirror _set_session_cookie's attributes — browsers match
    # cookies on (name, path, domain) and silently drop a clearing cookie
    # whose attributes don't match the original.
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path="/",
        httponly=True,
        secure=_cookie_secure(),
        samesite="lax",
    )
    response.delete_cookie(
        key=CSRF_COOKIE_NAME,
        path="/",
        httponly=False,
        secure=_cookie_secure(),
        samesite="lax",
    )


@router.get("/v1/session", response_model=SessionResponse)
async def get_session_endpoint(
    response: Response,
    session_cookie: Annotated[str | None, Cookie(alias=SESSION_COOKIE_NAME)] = None,
    csrf_cookie: Annotated[str | None, Cookie(alias=CSRF_COOKIE_NAME)] = None,
    db: AsyncSession = Depends(get_session),
) -> SessionResponse:
    user: User | None = None
    if session_cookie:
        user = await _find_session_user(db, session_cookie)
        if user is not None and user.merged_into_user_id is not None:
            # The cookie's guest was folded into another account. Don't silently
            # mint a fresh guest (that would quietly swap identities) — tell the
            # holder so they sign in. A no-cookie / garbage-cookie request still
            # mints below, preserving the zero-friction first visit.
            raise await _merged_session_exception(db, user)
    if user is None:
        user, raw_token = await _create_session(db)
        _set_session_cookie(response, raw_token)
    elif csrf_cookie is None:
        # Returning session whose (non-HttpOnly) CSRF cookie was dropped —
        # reissue it so mutations don't permanently 403. Self-heals on the
        # bootstrap the client makes on every load, without rotating the cookie
        # (or re-setting the session cookie) when one is already present.
        _set_csrf_cookie(response)
    return await _build_session_response(db, user)


@router.delete("/v1/session", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session_endpoint(
    response: Response,
    session_cookie: Annotated[str | None, Cookie(alias=SESSION_COOKIE_NAME)] = None,
    db: AsyncSession = Depends(get_session),
) -> None:
    """Sign the caller out *of this browser*. Revokes the token row tied to
    the current cookie (other devices keep their own tokens) and clears the
    cookie. Idempotent — a missing or already-invalid cookie still 204s and
    clears whatever the browser is holding."""
    if session_cookie:
        await db.execute(
            delete(UserToken).where(
                UserToken.token == _hash_token(session_cookie),
                UserToken.context == SESSION_TOKEN_CONTEXT,
            )
        )
        await db.commit()
    _clear_session_cookie(response)


async def get_optional_user(
    session_cookie: Annotated[str | None, Cookie(alias=SESSION_COOKIE_NAME)] = None,
    db: AsyncSession = Depends(get_session),
) -> User | None:
    """Resolve the user from the session cookie, returning ``None`` when no
    valid session is present.

    For endpoints that are open to anonymous callers but tailor their
    response to a signed-in user when one is present (e.g. flagging the
    current user's side in match details). Never mints a new session — that
    behavior is reserved for ``GET /v1/session``.
    """
    if not session_cookie:
        return None
    user = await _find_session_user(db, session_cookie)
    if user is not None and user.merged_into_user_id is not None:
        # Tombstoned guest → render anonymously on optional endpoints; the next
        # required-auth call (or the session bootstrap) surfaces the redirect.
        return None
    return user


async def get_current_user(
    session_cookie: Annotated[str | None, Cookie(alias=SESSION_COOKIE_NAME)] = None,
    db: AsyncSession = Depends(get_session),
) -> User:
    """Resolve the authenticated user from the session cookie.

    Unlike ``GET /v1/session``, this dependency never mints a new session —
    endpoints that create or mutate data require an already-established
    session and respond ``401`` otherwise.

    Resolves the cookie directly (rather than via ``get_optional_user``) so it
    can tell a *tombstoned* guest — whose cookie still resolves — apart from no
    session at all, and raise the structured ``session_merged`` 401 that sends
    the holder to sign in instead of letting them act as a merged-away ghost.
    """
    user = await _find_session_user(db, session_cookie) if session_cookie else None
    if user is not None and user.merged_into_user_id is not None:
        raise await _merged_session_exception(db, user)
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
            ) from None
        await db.refresh(current_user)

    return await _build_session_response(db, current_user)


async def _verify_captcha_or_400(captcha_token: str) -> None:
    if not await captcha_module.verify_captcha(captcha_token):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Captcha verification failed. Please try again.",
        )


async def _pending_change_token(
    db: AsyncSession, user_id: uuid.UUID
) -> UserToken | None:
    """Return the user's pending email-change token, if any. Resend needs
    both the prior ``context`` (audit trail) and ``sent_to`` (where to
    re-deliver) — now that ``user.email`` no longer mirrors the pending
    address, the token is the only source of truth for the resend target.
    Also drives the ``pending_email`` field on the session response."""
    # Defensive determinism: today ``_issue_confirmation_token`` deletes prior
    # change tokens before inserting, so at most one is pending. If a future
    # path ever leaves more than one, return the most recent. ``id`` is a random
    # UUIDv4, not a sequence, so order by ``created_at`` (the real recency
    # signal); ``id.desc()`` is only a stable tiebreak.
    result = await db.execute(
        select(UserToken)
        .where(
            UserToken.user_id == user_id,
            _pending_email_token_clause(),
        )
        .order_by(UserToken.created_at.desc(), UserToken.id.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _issue_confirmation_token(
    db: AsyncSession, user: User, sent_to: str, context: str
) -> str:
    """Generate, hash, and persist a fresh confirmation token, rotating any
    prior change token for this user. Returns the raw token (only ever in
    memory) so the caller can hand it to the email sender."""
    await db.execute(
        delete(UserToken).where(
            UserToken.user_id == user.id,
            _pending_email_token_clause(),
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


def _enqueue_email_job(
    job_func: str, to_email: str, raw_token: str, username: str
) -> Job:
    # result_ttl=60 / failure_ttl=300 shrinks the window during which the raw
    # token (pickled into the RQ job hash in Redis) is recoverable from a
    # snapshot or dashboard. Defaults are 8m / 1 year respectively.
    return queue_module.get_email_queue().enqueue(
        job_func,
        to_email,
        raw_token,
        username,
        result_ttl=60,
        failure_ttl=300,
    )


def _enqueue_confirmation_email(to_email: str, raw_token: str, username: str) -> Job:
    return _enqueue_email_job(
        "app.email.send_confirmation_email", to_email, raw_token, username
    )


def _enqueue_login_email(to_email: str, raw_token: str, username: str) -> Job:
    return _enqueue_email_job(
        "app.email.send_login_email", to_email, raw_token, username
    )


def _enqueue_merge_email(to_email: str, raw_token: str, username: str) -> Job:
    return _enqueue_email_job(
        "app.email.send_merge_email", to_email, raw_token, username
    )


def _enqueue_no_account_email(to_email: str) -> Job:
    """The tokenless 'no account for this email yet' notice. Carries no
    credential — the account doesn't exist — so it takes neither a token nor a
    username.

    Not routed through ``_enqueue_email_job`` (which threads a raw token +
    username), but it mirrors that helper's ``result_ttl`` / ``failure_ttl`` so
    every email job ages out of the RQ registries on the same schedule. There's
    no token to protect here — the short TTLs are just registry hygiene."""
    return queue_module.get_email_queue().enqueue(
        "app.email.send_no_account_email",
        to_email,
        result_ttl=60,
        failure_ttl=300,
    )


def _enqueue_rating_recompute_after_merge(user_id: uuid.UUID) -> None:
    """Fire-and-forget the rating recompute for ``user_id`` after a merge.

    Called after the merge has already committed — a Redis flap here can't
    leave the DB inconsistent because the merge stands on its own. We
    log+swallow enqueue failures rather than fail the sign-in: the recompute
    is recoverable (re-run by admin tool or re-fire on next login), but a
    failed sign-in here is user-visible breakage."""
    try:
        queue_module.get_ratings_queue().enqueue(
            RECOMPUTE_AFTER_MERGE_JOB,
            str(user_id),
            result_ttl=60,
            failure_ttl=86400,
        )
    except Exception:
        log.exception(
            "Failed to enqueue rating recompute after merge",
            extra={"user_id": str(user_id)},
        )


async def _begin_account_merge(
    db: AsyncSession, guest: User, email: str
) -> SessionResponse:
    """Issue a merge token for an ephemeral ``guest`` who entered an address
    owned by an existing account, and email that account a sign-in link.

    Mirrors ``set_email``'s issue/enqueue/commit dance, including the
    enumeration-safe fallbacks: every exit returns the same 202 + session shape
    as a first-time set, so the caller can't distinguish a taken address from a
    free one."""
    target = (
        await db.execute(select(User).where(User.email == email))
    ).scalar_one_or_none()
    if target is None or target.id == guest.id:
        # Lost the race (the owner just changed their address out from under
        # us) or, impossibly, our own row — nothing to merge into.
        return await _build_session_response(db, guest)

    raw_token = await _issue_confirmation_token(
        db, guest, email, _merge_context(target.id)
    )
    try:
        job = _enqueue_merge_email(email, raw_token, target.username)
    except Exception:
        await db.rollback()
        await db.refresh(guest)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Email service unavailable. Try again in a moment.",
        ) from None
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        try:
            job.cancel()
        except Exception:
            pass
        await db.refresh(guest)
        return await _build_session_response(db, guest)
    return await _build_session_response(db, guest)


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
    if old_email == email and current_user.confirmed_at is not None:
        return await _build_session_response(db, current_user)
    if old_email != email and await name_taken(
        db, User.id, User.email, email, exclude_id=current_user.id
    ):
        # The address already belongs to another account. A *guest* (no
        # confirmed email of their own) almost certainly means "this is me —
        # sign me into my real account and bring my guest matches along." Email
        # the owner a merge link; clicking it folds this guest into their
        # account (see ``confirm_email``'s merge branch). The response is the
        # same 202 + pending_email shape as a first-time set, so an attacker
        # still can't tell a taken address from a free one by cycling fresh
        # `/v1/session` cookies.
        #
        # A caller who already has a confirmed email is *changing* addresses,
        # not merging — silently absorbing their account into someone else's
        # would be data loss, so keep the enumeration-safe no-op for them.
        if current_user.confirmed_at is None:
            return await _begin_account_merge(db, current_user, email)
        return await _build_session_response(db, current_user)

    raw_token = await _issue_confirmation_token(
        db, current_user, email, _email_change_context(old_email)
    )

    # Enqueue BEFORE commit so a Redis flap can't leave a previously-verified
    # user silently un-verified with no link sent. If enqueue fails, rollback
    # restores in-memory + on-disk state.
    try:
        job = _enqueue_confirmation_email(email, raw_token, current_user.username)
    except Exception:
        await db.rollback()
        await db.refresh(current_user)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Email service unavailable. Try again in a moment.",
        ) from None

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
    pending = await _pending_change_token(db, current_user.id)
    if pending is None or not pending.sent_to:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No pending email change to resend.",
        )
    await _verify_captcha_or_400(payload.captcha_token)

    raw_token = await _issue_confirmation_token(
        db,
        current_user,
        pending.sent_to,
        pending.context,
    )
    try:
        # A merge token re-sends the "sign in to your existing account" email
        # to the owner, not the plain confirmation copy — same /confirm-email
        # link either way, but the wording has to match what's happening.
        if pending.context.startswith(EMAIL_MERGE_CONTEXT_PREFIX):
            target_id = _target_id_from_merge_context(pending.context)
            target = await db.get(User, target_id) if target_id is not None else None
            owner_username = target.username if target else current_user.username
            job = _enqueue_merge_email(pending.sent_to, raw_token, owner_username)
        else:
            job = _enqueue_confirmation_email(
                pending.sent_to, raw_token, current_user.username
            )
    except Exception:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Email service unavailable. Try again in a moment.",
        ) from None
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
    session_cookie: Annotated[str | None, Cookie(alias=SESSION_COOKIE_NAME)] = None,
    db: AsyncSession = Depends(get_session),
) -> SessionResponse:
    """Consume an email-change token: stamp the new email + ``confirmed_at``.

    Invariant: ``user.email`` holds the prior confirmed address; the new
    address lives on ``token.sent_to`` until this endpoint runs. This is
    the single place either column flips.

    The token in the email is itself the bearer credential — we don't
    require the click to come from the same browser that requested it.
    That lets users complete the flow on a mobile mail client even when
    their desktop session cookie isn't available, and avoids minting an
    orphan guest user on every cross-device click. The endpoint also
    rotates the caller's session cookie to the token's owner so the
    confirming browser ends up signed in as the right user.

    A *merge* token (``merge:<uuid>``) is handled separately: instead of
    stamping an address onto the guest that requested it, the guest is folded
    into the account that owns the address and the caller is signed in as that
    account. See ``_confirm_account_merge``.
    """
    token_row = (
        await db.execute(
            select(UserToken).where(
                UserToken.token == _hash_token(payload.token),
                _pending_email_token_clause(),
            )
        )
    ).scalar_one_or_none()
    if token_row is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That confirmation link is invalid or expired.",
        )
    if _token_expired(token_row, EMAIL_CONFIRM_TOKEN_LIFETIME):
        await db.delete(token_row)
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That confirmation link is invalid or expired.",
        )
    if token_row.context.startswith(EMAIL_MERGE_CONTEXT_PREFIX):
        return await _confirm_account_merge(
            db, response, token_row, skip_merge=payload.skip_merge
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
    expected_old = _old_email_from_context(token_row.context)
    if user.email != expected_old:
        # The user's current confirmed address no longer matches the one
        # this token was cut against — could be an admin reset, or a stale
        # token from a prior change. Burn it and surface the generic
        # "invalid or expired" so we don't leak any state to the caller.
        await db.delete(token_row)
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That confirmation link is invalid or expired.",
        )

    # ``_maybe_merge_prior_session`` runs a query that triggers an
    # autoflush of ``user.email`` before our explicit commit, so the
    # users.email unique-constraint race (another user confirmed this
    # address first) can surface anywhere in this block — not just at
    # commit. Return the opaque "invalid or expired" so we don't leak
    # who owns the address.
    raw_session = secrets.token_urlsafe(32)
    try:
        user.email = token_row.sent_to
        user.confirmed_at = datetime.now(UTC)
        await db.delete(token_row)
        merged = await _maybe_merge_prior_session(db, session_cookie, user)
        db.add(
            UserToken(
                user_id=user.id,
                context=SESSION_TOKEN_CONTEXT,
                token=_hash_token(raw_session),
            )
        )
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That confirmation link is invalid or expired.",
        ) from None
    if merged is not None and merged.matches_moved > 0:
        _enqueue_rating_recompute_after_merge(user.id)
    _set_session_cookie(response, raw_session)
    return await _build_session_response(db, user, merged=merged)


async def _confirm_account_merge(
    db: AsyncSession,
    response: Response,
    token_row: UserToken,
    *,
    skip_merge: bool = False,
) -> SessionResponse:
    """Consume a merge token: fold the ephemeral guest that requested it into
    the account that owns the target address, then rotate the caller's session
    cookie to that account. The merge deletes the guest's non-session tokens
    (this one included), so the link is single-use.

    The merge is bound to the *requesting* guest recorded on the token, not to
    whatever session the click arrives with, so it does the right thing across
    devices (desktop request, phone click). ``skip_merge`` signs the owner in
    without folding the guest (the gate's "not now")."""
    target_id = _target_id_from_merge_context(token_row.context)
    guest = await db.get(User, token_row.user_id)
    target = await db.get(User, target_id) if target_id is not None else None
    # The token is only trustworthy while the target still owns the address it
    # was cut against. Reject (and burn the token) if the owner changed their
    # email or is itself tombstoned — surfacing the opaque error so nothing leaks.
    if (
        target is None
        or target.merged_into_user_id is not None
        or target.email != token_row.sent_to
    ):
        await db.delete(token_row)
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That confirmation link is invalid or expired.",
        )

    merged = (
        None if skip_merge else await _merge_guest_into(db, guest=guest, target=target)
    )
    if merged is None:
        # Nothing folded (declined, or guest gone / already verified / tombstoned)
        # — the inbox click still proves ownership, so sign them in as the owner.
        # A merge would have deleted this token; do it explicitly to stay single-use.
        await db.delete(token_row)
    return await _sign_in_after_merge(db, response, target, merged)


@router.post(
    "/v1/login/request",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=LoginRequestAccepted,
    dependencies=[
        Depends(email_send_ip_rate_limit),
        Depends(email_send_rate_limit),
    ],
)
async def request_login_email(
    payload: RequestLoginRequest,
    session_cookie: Annotated[str | None, Cookie(alias=SESSION_COOKIE_NAME)] = None,
    db: AsyncSession = Depends(get_session),
) -> LoginRequestAccepted:
    """Mint a magic-link sign-in token and email it.

    Always returns the same 202 shape regardless of whether the address
    belongs to a known account. Differential responses would let an
    attacker enumerate the user base by cycling guest sessions for fresh
    rate-limit budgets — the same enumeration vector the email-change flow
    guards against. An address with no account still gets a (tokenless)
    "no account yet" email, so a known and an unknown address are
    indistinguishable from the outside — same status, same shape, and a
    piece of mail either way — rather than the unknown case silently
    delivering nothing.

    Accounts whose email hasn't been confirmed yet get the confirmation
    link re-sent instead of a sign-in link. The login token would let
    someone sign in without proving control of the inbox; the confirmation
    link clears that hurdle and (per ``confirm_email``) rotates them into
    a session anyway.

    Records the requesting browser's guest on the token so the merge it drives
    is token-bound (follows the guest cross-device), mirroring the settings
    merge flow.
    """
    email = payload.email.lower()

    if payload.fmm_hp_token.strip():
        return LoginRequestAccepted(email=email)

    await _verify_captcha_or_400(payload.captcha_token)

    user = (
        await db.execute(select(User).where(User.email == email))
    ).scalar_one_or_none()
    if user is None:
        await _send_no_account_email_or_503(email)
        return LoginRequestAccepted(email=email)

    if user.confirmed_at is None:
        await _issue_and_send_confirmation_email(db, user, email)
        return LoginRequestAccepted(email=email)

    guest_id = await _requesting_guest_id(db, session_cookie, target=user)
    await _issue_and_send_login_email(db, user, email, merge_from_guest_id=guest_id)
    return LoginRequestAccepted(email=email)


async def _requesting_guest_id(
    db: AsyncSession, session_cookie: str | None, *, target: User
) -> uuid.UUID | None:
    """The id of the requesting browser's guest, when it's an ephemeral guest
    distinct from ``target`` — so a sign-in can carry its matches over. ``None``
    for a verified / tombstoned / absent requester."""
    if not session_cookie:
        return None
    requester = await _find_session_user(db, session_cookie)
    if (
        requester is None
        or requester.id == target.id
        or requester.confirmed_at is not None
        or requester.merged_into_user_id is not None
    ):
        return None
    return requester.id


async def _send_no_account_email_or_503(email: str) -> None:
    """Enqueue the tokenless 'no account yet' notice for an unknown address.

    There's no DB write to guard, but on an enqueue failure we raise the same
    503 the known-account path raises — so a Redis flap fails both paths
    identically and the outcome never reveals whether the address exists."""
    try:
        _enqueue_no_account_email(email)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Email service unavailable. Try again in a moment.",
        ) from None


async def _issue_and_send_login_email(
    db: AsyncSession,
    user: User,
    email: str,
    merge_from_guest_id: uuid.UUID | None = None,
) -> None:
    """Replace any live login token for this user with a fresh one and
    enqueue the sign-in email. Enqueue before commit so a Redis flap
    rolls the DB write back instead of stranding a tokenless user.

    ``merge_from_guest_id`` is recorded in the token context so consuming the
    link folds that specific guest in (token-bound)."""
    await db.execute(
        delete(UserToken).where(
            UserToken.user_id == user.id,
            _login_token_clause(),
        )
    )
    raw_token = secrets.token_urlsafe(32)
    db.add(
        UserToken(
            user_id=user.id,
            context=_login_context(merge_from_guest_id),
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
        ) from None
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        try:
            job.cancel()
        except Exception:
            pass
        raise


async def _issue_and_send_confirmation_email(
    db: AsyncSession, user: User, email: str
) -> None:
    """Re-issue this user's pending email-confirmation link. Preserves the
    prior change-token's context so the audit trail still records what the
    user was originally changing away from."""
    prior = await _pending_change_token(db, user.id)
    raw_token = await _issue_confirmation_token(
        db, user, email, prior.context if prior else _email_change_context(None)
    )
    try:
        job = _enqueue_confirmation_email(email, raw_token, user.username)
    except Exception:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Email service unavailable. Try again in a moment.",
        ) from None
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        try:
            job.cancel()
        except Exception:
            pass
        raise


@router.post(
    "/v1/login/consume",
    response_model=SessionResponse,
    dependencies=[Depends(login_consume_ip_rate_limit)],
)
async def consume_login_token(
    payload: ConsumeLoginRequest,
    response: Response,
    session_cookie: Annotated[str | None, Cookie(alias=SESSION_COOKIE_NAME)] = None,
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
                _login_token_clause(),
            )
        )
    ).scalar_one_or_none()
    if token_row is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That sign-in link is invalid or expired.",
        )

    if _token_expired(token_row, LOGIN_TOKEN_LIFETIME):
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

    # If the user changed their email between request and click, the link no
    # longer matches the inbox that proved control — reject so the new owner
    # of the old address can't ride an in-flight link.
    if token_row.sent_to and token_row.sent_to != user.email:
        await db.delete(token_row)
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That sign-in link no longer matches your email.",
        )

    # Token-bound merge: fold the guest recorded at request time (follows the
    # user cross-device). Fall back to the clicking browser's guest when the
    # token didn't record one (bare ``login``). ``skip_merge`` lets the owner
    # sign in without bringing the guest's matches over (the gate's "not now").
    recorded_guest_id = _guest_id_from_login_context(token_row.context)
    # The merge helpers run a query that autoflushes the staged rows before the
    # explicit commit, so the users.email unique-constraint race (the merge
    # re-points rows onto an address another account already confirmed) can
    # surface anywhere in this block — not just at commit. Roll back and return
    # the opaque "invalid or expired" so we don't leak who owns the address.
    # Mirrors the guard on ``confirm_email``.
    try:
        # Single-use: delete the link the moment we accept it.
        await db.delete(token_row)
        if payload.skip_merge:
            merged = None
        elif recorded_guest_id is not None:
            guest = await db.get(User, recorded_guest_id)
            merged = await _merge_guest_into(db, guest=guest, target=user)
        else:
            merged = await _maybe_merge_prior_session(db, session_cookie, user)
        return await _sign_in_after_merge(db, response, user, merged)
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That sign-in link is invalid or expired.",
        ) from None


@router.post(
    "/v1/merge/preview",
    response_model=MergePreview,
    dependencies=[Depends(login_consume_ip_rate_limit)],
)
async def preview_merge(
    payload: MergePreviewRequest,
    db: AsyncSession = Depends(get_session),
) -> MergePreview:
    """Side-effect-free look at an emailed link before it's consumed, so the
    client can show a "bring N matches over?" confirmation. Never consumes,
    rotates, or merges — a wrong/expired token simply returns ``is_merge=False``
    and the client finalizes through the real confirm/consume endpoint.

    Safe to return usernames + counts: the 256-bit token is the bearer
    credential, so only someone holding the link can ask."""
    token_row = (
        await db.execute(
            select(UserToken).where(
                UserToken.token == _hash_token(payload.token),
                or_(
                    _login_token_clause(),
                    UserToken.context.startswith(EMAIL_MERGE_CONTEXT_PREFIX),
                ),
            )
        )
    ).scalar_one_or_none()
    if token_row is None:
        return MergePreview(is_merge=False)

    if token_row.context.startswith(EMAIL_MERGE_CONTEXT_PREFIX):
        # Settings merge token: lives on the *guest*; the owner is in the context.
        owner_id = _target_id_from_merge_context(token_row.context)
        owner = await db.get(User, owner_id) if owner_id is not None else None
        guest = await db.get(User, token_row.user_id)
    else:
        # Login token: lives on the *owner*; a recorded guest is in the context.
        owner = await db.get(User, token_row.user_id)
        guest_id = _guest_id_from_login_context(token_row.context)
        guest = await db.get(User, guest_id) if guest_id is not None else None

    # Only a *mergeable* guest counts — mirror ``_merge_guest_into``'s guards so
    # the preview matches what confirm/consume will actually do.
    if (
        owner is None
        or guest is None
        or guest.id == owner.id
        or guest.confirmed_at is not None
        or guest.merged_into_user_id is not None
    ):
        return MergePreview(
            is_merge=False,
            owner_username=owner.username if owner is not None else None,
        )

    return MergePreview(
        is_merge=True,
        owner_username=owner.username,
        guest_username=guest.username,
        guest_matches_count=await _guest_match_count(db, guest.id),
    )
