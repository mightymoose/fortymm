import hashlib
import logging
import os
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from email.utils import parseaddr
from typing import Annotated, NamedTuple

import redis.exceptions
from fastapi import (
    APIRouter,
    Cookie,
    Depends,
    HTTPException,
    Request,
    Response,
    status,
)
from fastapi.responses import JSONResponse
from pyrate_limiter import Duration, Rate
from rq.job import Job
from sqlalchemy import ColumnElement, delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app import captcha as captcha_module
from app import queue as queue_module
from app.account_merge import merge_user
from app.config import Settings, get_settings
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
from app.roles import grant_default_role
from app.schemas.session import (
    AccountSwitchPreview,
    ConfirmEmail400Response,
    ConfirmEmailRequest,
    ConsumeLoginRequest,
    LoginRequestAccepted,
    LoginSenderResponse,
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
from app.token_hashing import hash_token
from app.uniqueness import name_taken
from app.usernames import generate_username

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
# Stable `code` on the 401 we raise when a session cookie no longer resolves to a
# usable user — the holder signed out (the cookie is shared across the origin, so
# a sign-out in one tab ends every tab's session) or the session expired. Lets a
# client tell "your session ended, sign in" apart from any other 401 and route to
# login instead of silently minting a fresh guest in the signed-out user's place.
SESSION_ENDED_CODE = "session_ended"
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
# Structured `code`s on the 400 ``consume_login_token`` raises, so the web
# client can tell apart the reasons an emailed sign-in link can fail instead
# of collapsing all of them into one generic message. Capped at three: every
# other cause (never valid, used, claimed first-sign-in row, the merge
# integrity race) reports the same INVALID_OR_EXPIRED as it always has.
LOGIN_INVALID_OR_EXPIRED_CODE = "invalid_or_expired"
LOGIN_EMAIL_CHANGED_CODE = "email_changed"
LOGIN_REPLACED_CODE = "replaced"
# Structured `code` on the 400 ``confirm_email`` raises when the confirmation
# link (change or merge flavour) was superseded by a newer resend (#1616) —
# the confirm-flow counterpart of ``LOGIN_REPLACED_CODE``. Every other dead
# confirmation link keeps the plain-string "invalid or expired" detail it has
# always returned, so this is the only coded reason on the confirm endpoint.
CONFIRM_REPLACED_CODE = "replaced"
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
#
# A *first sign-in* token — cut for an address that had no account, against the
# user this flow just minted — adds a ``first`` marker in the same position:
# ``login:first`` alone, or ``login:first:<guest-id>`` when a guest was
# recorded. Staying inside the ``login:`` prefix is load-bearing. It keeps the
# marker matched by ``_login_token_clause()``, so ``consume_login_token``,
# ``preview_merge`` and the replace-the-live-token DELETE all see it with no
# clause change, and it keeps the marker *out* of
# ``_pending_email_token_clause()``, which matches ``change:`` and ``merge:``.
# A generated guest id is a UUID, so it can never collide with ``first``.
_LOGIN_CONTEXT_PREFIX = f"{LOGIN_TOKEN_CONTEXT}:"
_FIRST_SIGN_IN_MARKER = "first"
_FIRST_SIGN_IN_CONTEXT = f"{_LOGIN_CONTEXT_PREFIX}{_FIRST_SIGN_IN_MARKER}"
_FIRST_SIGN_IN_GUEST_PREFIX = f"{_FIRST_SIGN_IN_CONTEXT}:"


def _login_context(guest_id: uuid.UUID | None, *, first_sign_in: bool = False) -> str:
    if first_sign_in:
        return (
            _FIRST_SIGN_IN_CONTEXT
            if guest_id is None
            else f"{_FIRST_SIGN_IN_GUEST_PREFIX}{guest_id}"
        )
    return (
        LOGIN_TOKEN_CONTEXT
        if guest_id is None
        else f"{_LOGIN_CONTEXT_PREFIX}{guest_id}"
    )


def _is_first_sign_in_context(context: str) -> bool:
    """True for a login token cut against a user this flow minted for an
    address that had no account. Such a user has ``email IS NULL`` until the
    link is clicked, so ``consume_login_token`` stamps the address on instead
    of comparing against it."""
    return context == _FIRST_SIGN_IN_CONTEXT or context.startswith(
        _FIRST_SIGN_IN_GUEST_PREFIX
    )


def _first_sign_in_token_clause() -> ColumnElement[bool]:
    """Match both first-sign-in flavours (``login:first`` and
    ``login:first:<guest>``) — the SQL twin of
    ``_is_first_sign_in_context``."""
    return or_(
        UserToken.context == _FIRST_SIGN_IN_CONTEXT,
        UserToken.context.startswith(_FIRST_SIGN_IN_GUEST_PREFIX),
    )


def _guest_id_from_login_context(context: str) -> uuid.UUID | None:
    """The requesting guest recorded on a login token, or ``None`` for a bare
    ``login`` / ``login:first`` context (or a malformed id)."""
    if context.startswith(_FIRST_SIGN_IN_GUEST_PREFIX):
        raw = context.removeprefix(_FIRST_SIGN_IN_GUEST_PREFIX)
    elif context.startswith(_LOGIN_CONTEXT_PREFIX):
        raw = context.removeprefix(_LOGIN_CONTEXT_PREFIX)
    else:
        return None
    try:
        return uuid.UUID(raw)
    except ValueError:
        return None


def _login_token_clause() -> ColumnElement[bool]:
    """Match both login-token flavours (bare ``login`` and ``login:<guest>``)."""
    return or_(
        UserToken.context == LOGIN_TOKEN_CONTEXT,
        UserToken.context.startswith(_LOGIN_CONTEXT_PREFIX),
    )


def _is_login_context(context: str) -> bool:
    """Python-side twin of ``_login_token_clause`` — true for either login-token
    flavour. Used where a row is already loaded (e.g. ``preview_merge``) and a
    second query would be wasteful."""
    return context == LOGIN_TOKEN_CONTEXT or context.startswith(_LOGIN_CONTEXT_PREFIX)


async def _has_live_login_token(db: AsyncSession, user_id: uuid.UUID) -> bool:
    """Whether ``user_id`` still has a sign-in link that could actually be
    opened — one not yet replaced, and not past ``LOGIN_TOKEN_LIFETIME`` by its
    own ``created_at``.

    ``consume_login_token`` asks this before reporting ``LOGIN_REPLACED_CODE``,
    because that answer sends the user off to open their most recent email and
    the screen it reaches tells them that link is still live. Consume deletes
    the row it accepts, so once the newer link has itself been signed in with
    there is nothing left to open, and ``replaced`` would be one more untrue
    sign-in message — the exact thing #1466 removes. Age is read off
    ``created_at`` rather than inferred from the row still existing, matching
    ``_token_expired``: the sweep in ``_issue_and_send_login_email`` is
    opportunistic and may not have run."""
    live = (
        await db.execute(
            select(UserToken.id)
            .where(
                UserToken.user_id == user_id,
                _login_token_clause(),
                UserToken.replaced_at.is_(None),
                UserToken.created_at >= datetime.now(UTC) - LOGIN_TOKEN_LIFETIME,
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    return live is not None


async def _has_live_email_token(db: AsyncSession, user_id: uuid.UUID) -> bool:
    """Whether ``user_id`` still has a confirmation link (change or merge
    flavour) that could actually be opened — one not yet replaced, not past
    ``EMAIL_CONFIRM_TOKEN_LIFETIME`` by its own ``created_at``, **and** passing
    the validity predicates ``confirm_email`` itself applies before accepting
    such a token (#1616).

    ``confirm_email`` asks this before reporting ``CONFIRM_REPLACED_CODE``,
    because that answer sends the user off to open their most recent email —
    which must actually work once they get there. So the check mirrors the
    acceptance predicates, not just the row's existence:

    * merge flavour — ``_confirm_account_merge`` rejects when the target
      account is gone, already merged away, or no longer holds the address
      the token was cut against (``target.email != token.sent_to``), e.g.
      after the owner confirmed a later change off that address;
    * change flavour — the change branch rejects when the token's user is
      gone, when their current confirmed address no longer matches the
      ``old`` address baked into the context, or when another account
      already holds the address the token would stamp (``sent_to``): that
      write trips the ``users.email`` unique index and the token is burned
      as invalid.

    A newer link that would fail those checks must not be reported as live:
    "replaced" would point the user at an email whose link cannot work — the
    exact thing #1616 removes. Confirm deletes the row it accepts, so once
    the newer link has itself been confirmed there is nothing left to open,
    and "replaced" would be one more untrue confirmation message. Age is read
    off ``created_at`` rather than inferred from the row still existing,
    matching ``_token_expired``: the sweep in ``_issue_confirmation_token`` is
    opportunistic and may not have run."""
    live = (
        await db.execute(
            select(UserToken)
            .where(
                UserToken.user_id == user_id,
                _pending_email_token_clause(),
                UserToken.replaced_at.is_(None),
                UserToken.created_at
                >= datetime.now(UTC) - EMAIL_CONFIRM_TOKEN_LIFETIME,
            )
            .order_by(UserToken.created_at.desc(), UserToken.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if live is None:
        return False
    # Mirror ``confirm_email``'s acceptance predicates for whichever flavour
    # the live row is (see the docstring for why).
    if live.context.startswith(EMAIL_MERGE_CONTEXT_PREFIX):
        target_id = _target_id_from_merge_context(live.context)
        target = await db.get(User, target_id) if target_id is not None else None
        return (
            target is not None
            and target.merged_into_user_id is None
            and target.email == live.sent_to
        )
    user = await db.get(User, live.user_id)
    if user is None:
        return False
    if user.email != _old_email_from_context(live.context):
        return False
    # The confirm write stamps ``live.sent_to`` onto the user, so an account
    # already holding that address trips the ``users.email`` unique index and
    # confirm burns the token as invalid. Two users can hold pending change
    # links for the same formerly-unclaimed address, and whichever confirms
    # first makes the other's newer link unconfirmable — reporting "replaced"
    # would then point at an email that cannot work (#1616). The probe mirrors
    # the raw constraint — case-sensitive, tombstones included — rather than
    # ``name_taken``'s case-insensitive version: every writer of
    # ``users.email`` lowercases first, so the constraint is the only guard
    # confirm relies on here.
    claimed = (
        await db.execute(
            select(User.id)
            .where(User.email == live.sent_to, User.id != live.user_id)
            .limit(1)
        )
    ).scalar_one_or_none()
    return claimed is None


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


async def _automatic_login_destination(
    db: AsyncSession, token_row: UserToken, target: User, *, skip_merge: bool = False
) -> str:
    """Name an empty guest's automatic first-sign-in username adoption."""
    if skip_merge or not _is_first_sign_in_context(token_row.context):
        return target.username
    guest_id = _guest_id_from_login_context(token_row.context)
    guest = await db.get(User, guest_id) if guest_id is not None else None
    if (
        guest is not None
        and guest.id != target.id
        and guest.confirmed_at is None
        and guest.merged_into_user_id is None
        and await _guest_match_count(db, guest.id) == 0
    ):
        return guest.username
    return target.username


async def _account_switch_preview(
    db: AsyncSession,
    session_cookie: str | None,
    target: User,
    *,
    destination_username: str | None = None,
) -> AccountSwitchPreview | None:
    current = await _find_session_user(db, session_cookie) if session_cookie else None
    if (
        current is None
        or current.confirmed_at is None
        or current.merged_into_user_id is not None
        or current.id == target.id
    ):
        return None
    return AccountSwitchPreview(
        from_user_id=current.id,
        from_username=current.username,
        to_username=destination_username or target.username,
    )


async def _require_account_switch_approval(
    db: AsyncSession,
    session_cookie: str | None,
    target: User,
    switch_from_user_id: uuid.UUID | None,
    *,
    destination_username: str | None = None,
) -> None:
    switch = await _account_switch_preview(
        db, session_cookie, target, destination_username=destination_username
    )
    if switch_from_user_id is not None:
        current = (
            await _find_session_user(db, session_cookie) if session_cookie else None
        )
        if current is not None and current.id == switch_from_user_id:
            return
    elif switch is None:
        return
    raise HTTPException(
        status_code=409,
        detail={
            "code": "account_switch_required",
            "message": (
                "Your sign-in changed. Review this account switch before continuing."
            ),
            "account_switch": switch.model_dump(mode="json") if switch else None,
        },
    )


async def _revoke_other_sessions(db: AsyncSession, user: User) -> None:
    """Delete every session token ``user`` currently holds, so only the cookie
    the caller is about to receive still authenticates.

    Every mailed-link confirmation runs this. The link is a bearer credential
    that anybody holding the inbox can redeem from any browser, and confirming
    it used to *add* a session without removing the ones already there — so the
    browser that asked for the link kept a live session for the confirmed
    account after a different person clicked it. Revoking here closes that for
    the sign-in path and for the settings claim flow alike.

    Deliberately broad: it ends the confirmed user's other devices too. A mailed
    confirmation is the strongest ownership proof the product has, and a
    narrower "only the requesting browser" rule cannot be expressed here — the
    click may arrive from a browser that never held a cookie at all.

    Stage this *after* any lookup that resolves the caller from their session
    cookie, and before the replacement token is added.
    """
    await db.execute(
        delete(UserToken).where(
            UserToken.user_id == user.id,
            UserToken.context == SESSION_TOKEN_CONTEXT,
        )
    )


async def _sign_in_after_merge(
    db: AsyncSession,
    response: Response,
    user: User,
    merged: MergeSummary | None,
) -> SessionResponse:
    """Revoke ``user``'s existing sessions, mint a fresh one, commit the pending
    transaction, fire the rating recompute when a merge happened, rotate the
    cookie, and return the session. The shared tail of the token-bound merge
    sign-in paths (``consume_login_token`` and ``_confirm_account_merge``): the
    caller stages the token deletion + merge, this finalizes."""
    await _revoke_other_sessions(db, user)
    raw_session = secrets.token_urlsafe(32)
    db.add(
        UserToken(
            user_id=user.id,
            context=SESSION_TOKEN_CONTEXT,
            token=hash_token(raw_session),
        )
    )
    await db.commit()
    # Enqueue on ANY merge, not only when matches_moved > 0. Two reasons the old
    # `> 0` gate was too narrow: (1) a self-play collision VOIDS the guest's only
    # rated match, so matches_moved is 0 yet the survivor's rating is still
    # inflated by it and must be recomputed (ADR-0013); (2) even a zero-match
    # merge can leave a stale survivor rating that the empty-timeline reset must
    # rewrite. `merged is not None` is also the only gate expressible here: this
    # `merged` is the response `MergeSummary`, which deliberately has no
    # matches_voided count (adding one would drift the OpenAPI clients), so no
    # void-aware condition is available at this layer. The recompute is a
    # deterministic rewrite — enqueuing it on a true no-op merge is harmless.
    if merged is not None:
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
    # request.client.host is the true client IP only when FORWARDED_ALLOW_IPS is
    # set at the uvicorn edge (docs/adr/0008-trust-client-ip-at-the-uvicorn-edge.md);
    # otherwise it's the proxy peer and these limiters become one global bucket (#837).
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


async def _login_consume_ip_rate_limit_key(request: Request) -> str:
    """Separate per-IP key for /v1/login/consume so failed verification
    bursts don't burn the email-send IP budget for legitimate sign-ins
    from the same network."""
    return f"login-consume-ip:{_client_ip(request)}"


class AuthRateLimiters(NamedTuple):
    """The five authentication rate-limit dependencies, built as one set.

    :func:`build_auth_rate_limiters` is the single construction site: tests
    build a fresh set from a configured ``Settings`` through it rather than
    reloading ``app.sessions`` (which would leak ``_instances``/cached-bucket
    state into other cases) — the routes captured the module-level instances
    below at import, so swapping in a fresh set is done with
    ``app.dependency_overrides`` keyed on those.
    """

    send_session: RedisRateLimiter
    send_ip: RedisRateLimiter
    resend_session: RedisRateLimiter
    resend_ip: RedisRateLimiter
    login_consume_ip: RedisRateLimiter


def build_auth_rate_limiters(settings: Settings) -> AuthRateLimiters:
    """Build the five authentication limiter dependencies from ``settings``.

    One settings snapshot, once per process: the ceilings are read here at
    construction and never re-read per request — hot reconfiguration of a
    running process is out of scope, so a changed environment variable needs
    a restart. Bucket keys, identifier callbacks, and the one-hour windows
    are fixed here regardless of configuration.
    """
    return AuthRateLimiters(
        send_session=RedisRateLimiter(
            rates=[Rate(settings.email_send_session_limit_per_hour, Duration.HOUR)],
            bucket_key="email-send",
            identifier=_email_rate_limit_key,
        ),
        send_ip=RedisRateLimiter(
            rates=[Rate(settings.email_send_ip_limit_per_hour, Duration.HOUR)],
            bucket_key="email-send-ip",
            identifier=_email_ip_rate_limit_key,
        ),
        resend_session=RedisRateLimiter(
            rates=[Rate(settings.email_resend_session_limit_per_hour, Duration.HOUR)],
            bucket_key="email-resend",
            identifier=_email_rate_limit_key,
        ),
        resend_ip=RedisRateLimiter(
            rates=[Rate(settings.email_resend_ip_limit_per_hour, Duration.HOUR)],
            bucket_key="email-resend-ip",
            identifier=_email_ip_rate_limit_key,
        ),
        login_consume_ip=RedisRateLimiter(
            rates=[Rate(settings.login_consume_ip_limit_per_hour, Duration.HOUR)],
            bucket_key="login-consume-ip",
            identifier=_login_consume_ip_rate_limit_key,
        ),
    )


# The process's own dependencies, built once at import from one Settings
# snapshot: 5/20/3/10/60 per hour unless the environment overrides a ceiling
# (see app.config). The send and resend IP dependencies deliberately run
# before their session counterparts on the routes below — that order is
# behavior, not preference.
(
    email_send_rate_limit,
    email_send_ip_rate_limit,
    email_resend_rate_limit,
    email_resend_ip_rate_limit,
    login_consume_ip_rate_limit,
) = build_auth_rate_limiters(get_settings())


def _cookie_secure() -> bool:
    return os.environ.get("SESSION_COOKIE_SECURE", "true").lower() != "false"


async def _find_session_user(db: AsyncSession, raw_token: str) -> User | None:
    result = await db.execute(
        select(UserToken).where(
            UserToken.token == hash_token(raw_token),
            UserToken.context == SESSION_TOKEN_CONTEXT,
        )
    )
    token = result.scalar_one_or_none()
    if token is None:
        return None
    user_result = await db.execute(select(User).where(User.id == token.user_id))
    return user_result.scalar_one_or_none()


def _clear_cookie_header() -> dict[str, str]:
    """A ``Set-Cookie`` that clears the session cookie, for attaching to a 401
    that ends a session no longer good for auth — a cookie resolving to a
    tombstoned (merged-away) guest, or one that no longer resolves at all
    (signed out / expired). The cookie is HttpOnly, so only the server can drop
    it — clearing it lets the holder start a fresh guest from the login screen.
    Mirror ``_clear_session_cookie``'s attributes so the browser actually
    matches and drops it."""
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


def _login_token_exception(code: str, message: str) -> HTTPException:
    """Build the 400 ``consume_login_token`` raises for a dead magic link,
    carrying a stable ``code`` alongside the human-readable ``message`` —
    mirrors ``_session_ended_exception`` / ``_merged_session_exception``'s
    structured-detail shape. Capped at three codes; see
    ``LOGIN_INVALID_OR_EXPIRED_CODE`` and friends."""
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={"code": code, "message": message},
    )


def _invalid_or_expired_exception() -> HTTPException:
    """The 400 for a sign-in link that is dead for the generic reason — never
    valid, already used, genuinely expired, a claimed first-sign-in row, or the
    merge integrity race. Five paths in ``consume_login_token`` raise exactly
    this, so a zero-arg helper (matching ``_session_ended_exception``) keeps the
    code and its sentence from drifting apart between them."""
    return _login_token_exception(
        LOGIN_INVALID_OR_EXPIRED_CODE, "That sign-in link is invalid or expired."
    )


class SessionEndedException(HTTPException):
    """An ended identity needs a durable cookie companion on its 401."""


async def session_ended_exception_handler(
    request: Request, exc: SessionEndedException
) -> Response:
    response = JSONResponse(
        status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers
    )
    if not request.cookies.get(CSRF_COOKIE_NAME):
        _set_csrf_cookie(response)
    return response


def _session_ended_exception() -> HTTPException:
    """Build the 401 for a request whose session cookie no longer resolves to a
    usable user — a signed-out or expired session. Carries the stable
    ``SESSION_ENDED_CODE`` so clients redirect to login rather than treating it
    as an ordinary auth failure (or silently minting a fresh guest), and clears
    any lingering dead cookie so the login screen can start a clean guest. There
    is no email to prefill — the holder isn't a known account here."""
    return SessionEndedException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={
            "code": SESSION_ENDED_CODE,
            "message": "You've been signed out. Sign in to continue.",
        },
        headers=_clear_cookie_header(),
    )


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
    return SessionEndedException(
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
                id=user.id,
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
    user = User(username=await generate_username(db))
    db.add(user)
    await db.flush()

    await add_user_to_default_league(db, user.id)
    # Guest-mint is where "everyone" is decided: there is no signup, so this is
    # the moment a person joins the site. Raises (→ 500) if the role is missing;
    # see app/roles.py and ADR-0016.
    await grant_default_role(db, user.id)

    raw_token = secrets.token_urlsafe(32)
    db.add(
        UserToken(
            user_id=user.id,
            context=SESSION_TOKEN_CONTEXT,
            token=hash_token(raw_token),
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


async def _resolve_current_user(
    db: AsyncSession,
    *,
    session_cookie: str | None,
) -> User | None:
    """Resolve the current user from the session cookie, or ``None``.

    Preserves the tombstoned-guest handling: a cookie that resolves to a
    merged-away guest (``merged_into_user_id`` set) raises the structured
    ``session_merged`` 401 rather than silently falling through.

    A resolved, live user gets their ``last_seen_at`` stamped (throttled —
    see ``_stamp_last_seen``): this is the one write that separates a row a
    person browses from a row nobody can reach, which is what the public
    listings key on (#1438). ``get_optional_user`` deliberately bypasses this
    resolver and so never stamps — anonymous-reachable endpoints must not
    grow a write.

    The single resolver shared by ``get_current_user`` and ``GET /v1/session`` so
    the two auth entry points can't drift.
    """
    if session_cookie:
        cookie_user = await _find_session_user(db, session_cookie)
        if cookie_user is not None:
            if cookie_user.merged_into_user_id is not None:
                raise await _merged_session_exception(db, cookie_user)
            await _stamp_last_seen(db, cookie_user)
            return cookie_user
    return None


# How stale a ``last_seen_at`` stamp may get before the next resolved request
# rewrites it. A window, not an exact "last seen": the value backs a listing
# gate, not an activity display.
LAST_SEEN_STAMP_INTERVAL = timedelta(minutes=5)


async def _stamp_last_seen(db: AsyncSession, user: User) -> None:
    """Stamp ``user.last_seen_at``, at most once per
    ``LAST_SEEN_STAMP_INTERVAL``.

    The throttle is tested HERE, in Python, against the already-loaded row: a
    request inside the window issues no SQL at all. Two concurrent requests may
    both pass the test and both write; both write the same wall-clock stamp, so
    the race is idempotent and needs no lock.

    The stamp commits ITSELF rather than riding the route's transaction: it runs
    as a dependency, before the route body, so nothing half-finished can be
    swept up, and ``get_session`` does not auto-commit. The commit does not
    expire the row (``expire_on_commit=False`` in ``app.db``), so the caller's
    in-memory ``User`` stays usable without a lazy reload.

    A failed stamp write RAISES rather than being swallowed. After a failed
    commit the session needs a rollback before any further statement, so
    swallowing would trade one failed request for a broken session on every
    later query — and a broad ``except`` on the auth path would hide real bugs
    (``api/CLAUDE.md``: catch the specific exception). The open question from
    #1438 is settled here, on the raising side.
    """
    now = datetime.now(UTC)
    if (
        user.last_seen_at is not None
        and now - user.last_seen_at < LAST_SEEN_STAMP_INTERVAL
    ):
        return
    user.last_seen_at = now
    await db.commit()


@router.get("/v1/session", response_model=SessionResponse)
async def get_session_endpoint(
    response: Response,
    session_cookie: Annotated[str | None, Cookie(alias=SESSION_COOKIE_NAME)] = None,
    csrf_cookie: Annotated[str | None, Cookie(alias=CSRF_COOKIE_NAME)] = None,
    db: AsyncSession = Depends(get_session),
) -> SessionResponse:
    """Return the current session, resolving the caller from the session cookie.

    The endpoint self-heals a dropped CSRF cookie (reissuing it without rotating
    the session), and a cookie that resolves to a merged-away guest raises the
    structured ``session_merged`` 401 instead of silently swapping identities.

    Only a missing cookie mints a fresh guest. A rejected cookie ends the
    session explicitly instead of silently replacing the caller's identity.
    """
    user = await _resolve_current_user(db, session_cookie=session_cookie)
    if user is None:
        # A surviving CSRF companion identifies a browser whose dead session
        # cookie was cleared. Repeated loads must not silently create a guest.
        if session_cookie is not None or csrf_cookie is not None:
            raise _session_ended_exception()
        user, raw_token = await _create_session(db)
        _set_session_cookie(response, raw_token)
    elif csrf_cookie is None:
        # Returning session whose (non-HttpOnly) CSRF cookie was dropped —
        # reissue it so mutations don't permanently 403. Self-heals on the
        # bootstrap the client makes on every load, without rotating the
        # cookie (or re-setting the session cookie) when one is already
        # present.
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
                UserToken.token == hash_token(session_cookie),
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
    credential and respond ``401`` otherwise.

    The cookie is resolved directly (rather than via ``get_optional_user``) so it
    can tell a *tombstoned* guest — whose cookie still resolves — apart from no
    session at all, raising the structured ``session_merged`` 401 for the former.

    When the cookie resolves no user — no/invalid cookie — the structured
    ``session_ended`` 401 is raised so the client redirects to sign in (instead of
    acting as a merged-away ghost, or silently minting a new guest).
    """
    user = await _resolve_current_user(db, session_cookie=session_cookie)
    if user is None:
        raise _session_ended_exception()
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
    """Return the user's live pending email-change token, if any. Resend needs
    both the prior ``context`` (audit trail) and ``sent_to`` (where to
    re-deliver) — now that ``user.email`` no longer mirrors the pending
    address, the token is the only source of truth for the resend target.
    Also drives the ``pending_email`` field on the session response."""
    # Replaced rows survive their supersession (``_issue_confirmation_token``
    # stamps ``replaced_at`` rather than deleting), so exclude them here —
    # a replaced token is not live and must never drive ``pending_email`` or
    # a resend (#1616). At most one unreplaced token exists at a time, but the
    # most-recent-first ordering stays as defensive determinism: ``id`` is a
    # random UUIDv4, not a sequence, so order by ``created_at`` (the real
    # recency signal); ``id.desc()`` is only a stable tiebreak.
    result = await db.execute(
        select(UserToken)
        .where(
            UserToken.user_id == user_id,
            _pending_email_token_clause(),
            UserToken.replaced_at.is_(None),
        )
        .order_by(UserToken.created_at.desc(), UserToken.id.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _sweep_replaced_email_tokens(db: AsyncSession, user_id: uuid.UUID) -> None:
    """Delete every already-replaced pending-email token row for a user.

    A replaced row survives its supersession only so a click on the dead link
    can still report "a newer link was requested" (#1616) — an answer that is
    only true while a live (unreplaced) token exists. Once the caller has
    permanently deleted a user's live token, the survivors can never be
    reported again and are dead weight holding a ``sent_to`` address: sweep
    them now rather than waiting for a later issuance that may never come
    (#1616)."""
    await db.execute(
        delete(UserToken).where(
            UserToken.user_id == user_id,
            _pending_email_token_clause(),
            UserToken.replaced_at.is_not(None),
        )
    )


async def _issue_confirmation_token(
    db: AsyncSession, user: User, sent_to: str, context: str
) -> str:
    """Generate, hash, and persist a fresh confirmation token, replacing any
    live prior confirmation token (change or merge flavour) for this user.
    Returns the raw token (only ever in memory) so the caller can hand it to
    the email sender.

    Rather than deleting the previous live token outright, this stamps
    ``replaced_at`` on it so a click on the old link can report "a newer link
    was requested" (see ``CONFIRM_REPLACED_CODE`` in ``confirm_email``)
    instead of the generic invalid/expired (#1616). A row survives being
    replaced for up to ``EMAIL_CONFIRM_TOKEN_LIFETIME`` past its own
    ``created_at`` — the sweep below is keyed on age alone, not on
    ``replaced_at``, so a chain of several resends each still reports
    "replaced" (not "gone") until they individually age out. Three sweeps
    bound a replaced row's lifetime: this one (runs at the next issuance),
    ``_sweep_replaced_email_tokens``, which the confirm paths call as soon as
    the live link is consumed or permanently burned without confirming, and
    the scheduled sweep (``app.email_token_sweep``, hourly in every
    deployment) — the last one exists because a user who never requests
    another link and never opens the newest one runs neither of the first
    two (#1616)."""
    now = datetime.now(UTC)
    await db.execute(
        delete(UserToken).where(
            UserToken.user_id == user.id,
            _pending_email_token_clause(),
            UserToken.created_at < now - EMAIL_CONFIRM_TOKEN_LIFETIME,
        )
    )
    await db.execute(
        update(UserToken)
        .where(
            UserToken.user_id == user.id,
            _pending_email_token_clause(),
            UserToken.replaced_at.is_(None),
        )
        .values(replaced_at=now)
    )
    raw_token = secrets.token_urlsafe(32)
    db.add(
        UserToken(
            user_id=user.id,
            context=context,
            token=hash_token(raw_token),
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


def _enqueue_rating_recompute_after_merge(user_id: uuid.UUID) -> None:
    """Fire-and-forget the rating recompute for ``user_id`` after a merge.

    Called after the merge has already committed — a Redis flap here can't
    leave the DB inconsistent because the merge stands on its own. We
    log+swallow enqueue failures rather than fail the sign-in: the recompute
    is recoverable (re-run by admin tool or re-fire on next login), but a
    failed sign-in here is user-visible breakage.

    We catch only the Redis/connection failures we mean to tolerate — a
    programmer error here (a signature mismatch in the recompute job, an
    ImportError from a rename) should crash loudly in tests, not hide behind a
    log line."""
    try:
        queue_module.get_ratings_queue().enqueue(
            RECOMPUTE_AFTER_MERGE_JOB,
            str(user_id),
            result_ttl=60,
            failure_ttl=86400,
        )
    except (redis.exceptions.RedisError, ConnectionError, TimeoutError):
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


@router.post(
    "/v1/me/email/confirm",
    response_model=SessionResponse,
    responses={
        status.HTTP_400_BAD_REQUEST: {
            "model": ConfirmEmail400Response,
            "description": (
                "The confirmation link is dead. Two body shapes exist: a "
                "link a newer resend replaced carries the coded "
                "``ConfirmEmailErrorResponse`` detail (#1616); every other "
                "dead link — invalid, expired, or a replaced row whose "
                "newer link is itself gone — carries the plain-string "
                "detail of ``PlainDetailErrorResponse`` instead."
            ),
        },
    },
)
async def confirm_email(
    payload: ConfirmEmailRequest,
    response: Response,
    session_cookie: Annotated[str | None, Cookie(alias=SESSION_COOKIE_NAME)] = None,
    db: AsyncSession = Depends(get_session),
) -> SessionResponse:
    """Consume an email-change token: stamp the new email + ``confirmed_at``.

    Invariant: ``user.email`` holds the prior confirmed address; the new
    address lives on ``token.sent_to`` until this endpoint runs. This is one of
    three places either column flips — the others are
    ``auth0_provisioning._provision_user``, which stamps ``email`` +
    ``confirmed_at`` together on a first-seen verified Auth0 email, and
    ``consume_login_token``, which stamps them on the pending user a
    first-sign-in link was cut against — so all three writers preserve the same
    invariant (email set ⇒ account confirmed).

    Confirming also revokes the user's other session tokens, so the browser that
    asked for the link no longer holds a session once someone else clicks it.
    See ``_revoke_other_sessions``.

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

    A link a newer resend replaced is distinguishable from every other dead
    link: it 400s with a structured ``{"code": "replaced", "message": ...}``
    detail (#1616), the confirm-flow counterpart of ``consume_login_token``'s
    coded reasons (#1466). Every other dead confirmation link keeps the plain
    string detail it has always returned.
    """
    token_row = (
        await db.execute(
            select(UserToken)
            .where(
                UserToken.token == hash_token(payload.token),
                _pending_email_token_clause(),
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if token_row is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That confirmation link is invalid or expired.",
        )
    # Expiry before replacement, deliberately: a link that is BOTH replaced
    # and past its own EMAIL_CONFIRM_TOKEN_LIFETIME must report expired,
    # because that is true regardless of whether a later resend has physically
    # swept the row out of the table yet (the sweep in
    # ``_issue_confirmation_token`` is opportunistic, not synchronous with
    # every confirm). Age is always read off ``created_at``, never inferred
    # from "the row still exists".
    if _token_expired(token_row, EMAIL_CONFIRM_TOKEN_LIFETIME):
        # Expiry beats replacement, so the row deleted here may be a replaced
        # one whose siblings are still reportable. Sweep those siblings only
        # when the row just burned is the live token itself — afterwards no
        # unreplaced row remains and no click can ever report ``replaced``
        # again (#1616).
        burned_live = token_row.replaced_at is None
        burned_user_id = token_row.user_id
        await db.delete(token_row)
        if burned_live:
            await _sweep_replaced_email_tokens(db, burned_user_id)
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That confirmation link is invalid or expired.",
        )
    if token_row.replaced_at is not None:
        # Superseded by a newer resend. Leave the row alone: it is not expired
        # (checked above) and not single-use-consumed, so a second click on
        # the same dead link keeps reporting the same reason rather than
        # being deleted out from under a person who clicks it twice (#1616).
        #
        # Only say "replaced" while a newer confirmation link is genuinely
        # still openable. That answer tells the user to go and open their
        # most recent email; if that one has since been used or aged out,
        # nothing is waiting there and this link is simply dead.
        if await _has_live_email_token(db, token_row.user_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "code": CONFIRM_REPLACED_CODE,
                    "message": "A newer confirmation link was requested. "
                    "Open the most recent email.",
                },
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That confirmation link is invalid or expired.",
        )
    if token_row.context.startswith(EMAIL_MERGE_CONTEXT_PREFIX):
        return await _confirm_account_merge(
            db,
            response,
            token_row,
            skip_merge=payload.skip_merge,
            session_cookie=session_cookie,
            switch_from_user_id=payload.switch_from_user_id,
        )
    user = (
        await db.execute(select(User).where(User.id == token_row.user_id))
    ).scalar_one_or_none()
    if user is None:
        # The live token is burned without confirming, so its replaced
        # siblings can never be reported again either — sweep them (#1616).
        await db.delete(token_row)
        await _sweep_replaced_email_tokens(db, token_row.user_id)
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
        # The live token dies without confirming, so its replaced siblings
        # can never be reported again either — sweep them (#1616).
        await db.delete(token_row)
        await _sweep_replaced_email_tokens(db, user.id)
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That confirmation link is invalid or expired.",
        )

    await _require_account_switch_approval(
        db, session_cookie, user, payload.switch_from_user_id
    )

    # ``_maybe_merge_prior_session`` runs a query that triggers an
    # autoflush of ``user.email`` before our explicit commit, so the
    # users.email unique-constraint race (another user confirmed this
    # address first) can surface anywhere in this block — not just at
    # commit. Return the opaque "invalid or expired" so we don't leak
    # who owns the address.
    #
    # Capture the token PK before entering the try block so we can
    # issue a targeted DELETE in the except path without touching the
    # expired ORM object after rollback.
    token_id = token_row.id
    token_user_id = token_row.user_id
    raw_session = secrets.token_urlsafe(32)
    try:
        user.email = token_row.sent_to
        user.confirmed_at = datetime.now(UTC)
        await db.delete(token_row)
        # The live link is consumed, so no replaced row for this user can ever
        # report ``replaced`` again (``_has_live_email_token`` now finds no
        # unreplaced row) — sweep them here rather than waiting for a later
        # issuance that may never come (#1616).
        await _sweep_replaced_email_tokens(db, user.id)
        merged = (
            None
            if payload.skip_merge
            else await _maybe_merge_prior_session(db, session_cookie, user)
        )
        # After the cookie lookup above, before the replacement token below.
        await _revoke_other_sessions(db, user)
        db.add(
            UserToken(
                user_id=user.id,
                context=SESSION_TOKEN_CONTEXT,
                token=hash_token(raw_session),
            )
        )
        await db.commit()
    except IntegrityError:
        await db.rollback()
        # Burn the pending-change token so the user isn't trapped in a
        # resend loop: without this, the rollback restores the token and
        # every subsequent resend+click hits the same IntegrityError. The
        # live token dies without confirming, so its replaced siblings can
        # never be reported again either — sweep them (#1616).
        await db.execute(delete(UserToken).where(UserToken.id == token_id))
        await _sweep_replaced_email_tokens(db, token_user_id)
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That confirmation link is invalid or expired.",
        ) from None
    # Enqueue on ANY merge — see the same gate in `_sign_in_after_merge` for why
    # `matches_moved > 0` is too narrow (voided collisions and the empty-timeline
    # reset both need a recompute at matches_moved == 0), and why this is the only
    # gate expressible without drifting the response schema.
    if merged is not None:
        _enqueue_rating_recompute_after_merge(user.id)
    _set_session_cookie(response, raw_session)
    return await _build_session_response(db, user, merged=merged)


async def _confirm_account_merge(
    db: AsyncSession,
    response: Response,
    token_row: UserToken,
    *,
    skip_merge: bool = False,
    session_cookie: str | None = None,
    switch_from_user_id: uuid.UUID | None = None,
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
        # The live merge token is burned without confirming, so its replaced
        # siblings can never be reported again either — sweep them (#1616).
        await db.delete(token_row)
        await _sweep_replaced_email_tokens(db, token_row.user_id)
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That confirmation link is invalid or expired.",
        )

    await _require_account_switch_approval(
        db, session_cookie, target, switch_from_user_id
    )
    merged = (
        None if skip_merge else await _merge_guest_into(db, guest=guest, target=target)
    )
    if merged is None:
        # Nothing folded (declined, or guest gone / already verified / tombstoned)
        # — the inbox click still proves ownership, so sign them in as the owner.
        # A merge would have deleted this token; do it explicitly to stay single-use.
        await db.delete(token_row)
        # ``merge_user`` deletes every guest token on the fold path; this skip
        # path leaves the guest alive, so the sweep here is about rows, not
        # users (#1616).
        await _sweep_replaced_email_tokens(db, token_row.user_id)
    return await _sign_in_after_merge(db, response, target, merged)


def _configured_sender_address() -> str | None:
    """The bare address auth mail really sends from, or ``None`` when
    ``Settings.email_from`` holds nothing address-shaped.

    ``parseaddr`` is lenient by design: for a malformed value it hands back the
    literal input rather than failing (``garbage`` -> ``garbage``,
    ``FortyMM <not-an-email>`` -> ``not-an-email``). Returning that would make
    the ``/login/sent`` receipt row print a non-address as though it were the
    sender — the exact class of untruth #1466 closes — so require a non-empty
    local part and domain and no embedded whitespace before trusting it.

    Deliberately not a full RFC 5322 validator. The job is to keep an obviously
    broken value off the screen, not to police a deployment's configuration:
    anything address-shaped is served as-is, because that is genuinely what
    ``_deliver`` will put in the ``From`` header.
    """
    _, address = parseaddr(get_settings().email_from)
    local, _, domain = address.partition("@")
    if not local or not domain or any(ch.isspace() for ch in address):
        return None
    return address


@router.get("/v1/login/sender", response_model=LoginSenderResponse)
async def get_login_sender() -> LoginSenderResponse:
    """The bare address auth mail really sends from, e.g. for the ``/login/sent``
    receipt screen.

    A static, deployment-wide constant read straight off ``Settings.email_from``
    — takes no input, reads no cookie, and mints no guest session, unlike
    ``GET /v1/session``. Deliberately its own endpoint rather than a field on
    ``LoginRequestAccepted`` (would make the address attacker-controllable
    through a crafted ``/login/sent`` URL) or on ``GET /v1/session`` (would
    create a guest account as a side effect of a bookmarked receipt page).
    """
    return LoginSenderResponse(address=_configured_sender_address())


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

    **Both branches mint a user, send the same email, and return the same 202.**
    An address that already has an account gets a link for that account. An
    address with no account gets one for a user this endpoint mints on the spot,
    whose ``email`` stays NULL until the link is clicked — so the sign-in link,
    its ``Your FortyMM sign-in link`` subject and its 15-minute
    ``LOGIN_TOKEN_LIFETIME`` are identical either way. That is the guard: nothing
    the caller can observe — the status, the response shape, the subject, the
    link lifetime, or the login screen's countdown — reveals whether the address
    had an account. Differential responses would let an attacker enumerate the
    user base by cycling guest sessions for fresh rate-limit budgets, the same
    enumeration vector the email-change flow guards against.

    A minted user is a full member: it joins the default league and holds the
    default user role, exactly as a guest minted by ``GET /v1/session`` does
    (ADR-0016). A repeat request for the same unclaimed address — a resend
    included — reuses that pending user and replaces its token, so one live link
    exists per address at a time.

    Records the requesting browser's guest on the token so the merge it drives
    is token-bound (follows the guest cross-device), mirroring the settings
    merge flow.
    """
    email = payload.email.lower()

    if payload.fmm_hp_token.strip():
        return LoginRequestAccepted(email=email)

    await _verify_captcha_or_400(payload.captcha_token)

    # ``users.email`` is only ever set by ``confirm_email``,
    # ``consume_login_token`` (the first-sign-in branch below) or
    # ``auth0_provisioning._provision_user``, and all three stamp ``confirmed_at``
    # alongside it — so an address lookup can only ever match a confirmed account,
    # and there is no unconfirmed-user branch to handle here.
    user = (
        await db.execute(select(User).where(User.email == email))
    ).scalar_one_or_none()
    first_sign_in = user is None
    if user is None:
        user = await _pending_user_for(db, email) or await _mint_pending_user(db)

    guest_id = await _requesting_guest_id(db, session_cookie, target=user)
    await _issue_and_send_login_email(
        db,
        user,
        email,
        merge_from_guest_id=guest_id,
        first_sign_in=first_sign_in,
    )
    return LoginRequestAccepted(email=email)


async def _pending_user_for(db: AsyncSession, email: str) -> User | None:
    """The unclaimed user a previous first-sign-in request already minted for
    ``email``, if one is still reusable.

    A pending user has ``email IS NULL`` until its link is clicked, so it cannot
    be found by address — its live first-sign-in token is the only link between
    the two, through ``sent_to``. Restricting the lookup to that token context is
    load-bearing: ``sent_to`` is also set on known-account login tokens and on
    ``change:``/``merge:`` tokens, any of which would hand back a *confirmed*
    account to "reuse".

    Two concurrent first requests for one address can each mint, so more than one
    row can legitimately match. Take the newest rather than raising.
    """
    pending = (
        (
            await db.execute(
                select(User)
                .join(UserToken, UserToken.user_id == User.id)
                .where(
                    UserToken.sent_to == email,
                    _first_sign_in_token_clause(),
                )
                .order_by(UserToken.created_at.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )
    if (
        pending is None
        or pending.email is not None
        or pending.confirmed_at is not None
        or pending.merged_into_user_id is not None
    ):
        return None
    return pending


async def _mint_pending_user(db: AsyncSession) -> User:
    """Create the account a first-sign-in link will confirm. Mirrors
    ``_create_session``'s membership setup — default league, default user role
    (ADR-0016) — but mints no session token: nobody is signed in yet, and the
    mailed link is the only thing that can claim this row."""
    user = User(username=await generate_username(db))
    db.add(user)
    await db.flush()
    await add_user_to_default_league(db, user.id)
    await grant_default_role(db, user.id)
    return user


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


async def _issue_and_send_login_email(
    db: AsyncSession,
    user: User,
    email: str,
    merge_from_guest_id: uuid.UUID | None = None,
    *,
    first_sign_in: bool = False,
) -> None:
    """Replace any live login token for this user with a fresh one and
    enqueue the sign-in email. Enqueue before commit so a Redis flap
    rolls the DB write back instead of stranding a tokenless user (and, on a
    first sign-in, rolls the freshly minted user back with it).

    ``merge_from_guest_id`` is recorded in the token context so consuming the
    link folds that specific guest in (token-bound). ``first_sign_in`` marks a
    token cut against a user this flow minted, whose address is stamped on at
    consume time rather than compared against.

    Rather than deleting the previous live token outright, this stamps
    ``replaced_at`` on it so a click on the old link can report "a newer link
    was requested" (see ``LOGIN_REPLACED_CODE`` in ``consume_login_token``)
    instead of the generic invalid/expired. A row survives being replaced for
    up to ``LOGIN_TOKEN_LIFETIME`` past its own ``created_at`` — the sweep below
    is keyed on age alone, not on ``replaced_at``, so a chain of several
    resends each still reports "replaced" (not "gone") until they individually
    age out. That sweep is what bounds a replaced row's lifetime; no separate
    cleanup job is needed."""
    now = datetime.now(UTC)
    await db.execute(
        delete(UserToken).where(
            UserToken.user_id == user.id,
            _login_token_clause(),
            UserToken.created_at < now - LOGIN_TOKEN_LIFETIME,
        )
    )
    await db.execute(
        update(UserToken)
        .where(
            UserToken.user_id == user.id,
            _login_token_clause(),
            UserToken.replaced_at.is_(None),
        )
        .values(replaced_at=now)
    )
    raw_token = secrets.token_urlsafe(32)
    db.add(
        UserToken(
            user_id=user.id,
            context=_login_context(merge_from_guest_id, first_sign_in=first_sign_in),
            token=hash_token(raw_token),
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

    On a *first sign-in* token (``login:first...``) the owner is a user
    ``request_login_email`` minted for an address that had no account, so its
    ``email`` is still NULL. This endpoint stamps ``email`` + ``confirmed_at``
    on it, which makes it the third writer of that pair alongside
    ``confirm_email`` and ``auth0_provisioning._provision_user``. All three
    stamp them together, so the invariant holds: email set implies confirmed.
    """
    token_row = (
        await db.execute(
            select(UserToken)
            .where(
                UserToken.token == hash_token(payload.token),
                _login_token_clause(),
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if token_row is None:
        raise _invalid_or_expired_exception()

    # Expiry before replacement, deliberately: a link that is BOTH replaced and
    # past its own LOGIN_TOKEN_LIFETIME must report expired, because that is
    # true regardless of whether a later request has physically swept the row
    # out of the table yet (the sweep in ``_issue_and_send_login_email`` is
    # opportunistic, not synchronous with every consume). Age is always read
    # off ``created_at``, never inferred from "the row still exists".
    if _token_expired(token_row, LOGIN_TOKEN_LIFETIME):
        await db.delete(token_row)
        await db.commit()
        raise _invalid_or_expired_exception()

    if token_row.replaced_at is not None:
        # Superseded by a newer request. Either way leave the row alone: it is
        # not expired (checked above) and not single-use-consumed, so a second
        # click on the same dead link keeps reporting the same reason rather
        # than being deleted out from under a person who clicks it twice.
        #
        # Only say "replaced" while a newer link is genuinely still openable.
        # That answer tells the user to go and open their most recent email;
        # if that one has since been used or aged out, nothing is waiting there
        # and this link is simply dead.
        if await _has_live_login_token(db, token_row.user_id):
            raise _login_token_exception(
                LOGIN_REPLACED_CODE,
                "A newer sign-in link was requested. Use the most recent email.",
            )
        raise _invalid_or_expired_exception()

    user = (
        await db.execute(select(User).where(User.id == token_row.user_id))
    ).scalar_one_or_none()
    if user is None:
        await db.delete(token_row)
        await db.commit()
        raise _invalid_or_expired_exception()

    first_sign_in = _is_first_sign_in_context(token_row.context)
    if first_sign_in:
        # The owner is the pending user this address was minted for, so it has
        # no email to match against — it must still have none. Anything else
        # means the row was claimed after the link was cut (an Auth0 provision,
        # or a merge that tombstoned it), and the link is stale.
        if (
            not token_row.sent_to
            or user.email is not None
            or user.confirmed_at is not None
            or user.merged_into_user_id is not None
        ):
            await db.delete(token_row)
            await db.commit()
            raise _invalid_or_expired_exception()
    # If the user changed their email between request and click, the link no
    # longer matches the inbox that proved control — reject so the new owner
    # of the old address can't ride an in-flight link.
    elif token_row.sent_to and token_row.sent_to != user.email:
        await db.delete(token_row)
        await db.commit()
        raise _login_token_exception(
            LOGIN_EMAIL_CHANGED_CODE, "That sign-in link no longer matches your email."
        )

    await _require_account_switch_approval(
        db,
        session_cookie,
        user,
        payload.switch_from_user_id,
        destination_username=await _automatic_login_destination(
            db, token_row, user, skip_merge=payload.skip_merge
        ),
    )

    # Token-bound merge: fold the guest recorded at request time (follows the
    # user cross-device). Fall back to the clicking browser's guest when the
    # token didn't record one (bare ``login``). ``skip_merge`` lets the owner
    # sign in without bringing the guest's matches over (the gate's "not now").
    recorded_guest_id = _guest_id_from_login_context(token_row.context)
    # The merge helpers run a query that autoflushes the staged rows before the
    # explicit commit, so the users.email unique-constraint race (the merge
    # re-points rows onto an address another account already confirmed, or —
    # on a first sign-in — another flow confirmed this very address between
    # request and click) can surface anywhere in this block, not just at commit.
    # Roll back and return the opaque "invalid or expired" so we don't leak who
    # owns the address. Mirrors the guard on ``confirm_email``, including
    # capturing the token PK first so the except path can burn the token with a
    # targeted DELETE without touching an ORM object the rollback expired.
    token_id = token_row.id
    # Read the address off the token before it is staged for deletion.
    confirmed_email = token_row.sent_to
    try:
        # Single-use: delete the link the moment we accept it.
        await db.delete(token_row)
        if first_sign_in:
            # Third writer of the (email, confirmed_at) pair — see the docstring.
            user.email = confirmed_email
            user.confirmed_at = datetime.now(UTC)
        if payload.skip_merge:
            merged = None
        elif recorded_guest_id is not None:
            guest = await db.get(User, recorded_guest_id)
            merged = await _merge_guest_into(db, guest=guest, target=user)
            if merged is not None and first_sign_in and guest is not None:
                await _adopt_guest_username(db, guest=guest, target=user)
        else:
            merged = await _maybe_merge_prior_session(db, session_cookie, user)
        return await _sign_in_after_merge(db, response, user, merged)
    except IntegrityError:
        await db.rollback()
        # Burn the token so the person isn't trapped in a resend loop: without
        # this the rollback restores it, and every retry hits the same race.
        await db.execute(delete(UserToken).where(UserToken.id == token_id))
        await db.commit()
        raise _invalid_or_expired_exception() from None


async def _adopt_guest_username(db: AsyncSession, *, guest: User, target: User) -> None:
    """Move the merged guest's username onto the brand-new account it was folded
    into, so a first-time signer keeps the name they have been playing under.

    Only ever called on a first sign-in, where ``target`` was minted moments ago
    and its username is a throwaway generated slug. ``merge_user`` deliberately
    does not move the username, because it also serves the settings claim flow,
    where moving it would rename an established account.

    ``users.username`` is unique and the tombstone row survives the merge, so
    this takes two statements: rename the tombstone to a dead, collision-proof
    value and flush that, then take the freed name. A single swap trips the
    unique index.

    The dead name uses the uuid's ``hex`` form, not its dashed one: 7 + 32 = 39
    characters fits ``USERNAME_MAX_LENGTH`` (40) and matches
    ``USERNAME_PATTERN``, so a tombstone still holds a name the product would
    accept. The dashed form is 43 and would not."""
    adopted = guest.username
    guest.username = f"merged-{guest.id.hex}"
    await db.flush()
    target.username = adopted
    await db.flush()


@router.post(
    "/v1/merge/preview",
    response_model=MergePreview,
    dependencies=[Depends(login_consume_ip_rate_limit)],
)
async def preview_merge(
    payload: MergePreviewRequest,
    session_cookie: Annotated[str | None, Cookie(alias=SESSION_COOKIE_NAME)] = None,
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
                UserToken.token == hash_token(payload.token),
                or_(
                    _login_token_clause(),
                    _pending_email_token_clause(),
                ),
            )
        )
    ).scalar_one_or_none()
    if token_row is None:
        return MergePreview(is_merge=False)

    lifetime = (
        LOGIN_TOKEN_LIFETIME
        if _is_login_context(token_row.context)
        else EMAIL_CONFIRM_TOKEN_LIFETIME
    )
    if token_row.replaced_at is not None or _token_expired(token_row, lifetime):
        return MergePreview(is_merge=False)

    if token_row.context.startswith(EMAIL_MERGE_CONTEXT_PREFIX):
        # Settings merge token: lives on the *guest*; the owner is in the context.
        if token_row.replaced_at is not None:
            return MergePreview(is_merge=False)
        owner_id = _target_id_from_merge_context(token_row.context)
        owner = await db.get(User, owner_id) if owner_id is not None else None
        guest = await db.get(User, token_row.user_id)
    elif token_row.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX):
        owner = await db.get(User, token_row.user_id)
        guest = await _find_session_user(db, session_cookie) if session_cookie else None
    else:
        # Login token: lives on the *owner*; a recorded guest is in the context.
        owner = await db.get(User, token_row.user_id)
        guest_id = _guest_id_from_login_context(token_row.context)
        guest = await db.get(User, guest_id) if guest_id is not None else None

    if owner is None or owner.merged_into_user_id is not None:
        return MergePreview(is_merge=False)
    if token_row.context.startswith(EMAIL_CHANGE_CONTEXT_PREFIX):
        if owner.email != _old_email_from_context(token_row.context):
            return MergePreview(is_merge=False)
        claimed = (
            await db.execute(
                select(User.id)
                .where(User.email == token_row.sent_to, User.id != owner.id)
                .limit(1)
            )
        ).scalar_one_or_none()
        if claimed is not None:
            return MergePreview(is_merge=False)
    elif _is_first_sign_in_context(token_row.context):
        if (
            not token_row.sent_to
            or owner.email is not None
            or owner.confirmed_at is not None
        ):
            return MergePreview(is_merge=False)
    elif token_row.sent_to and owner.email != token_row.sent_to:
        return MergePreview(is_merge=False)

    switch = await _account_switch_preview(
        db,
        session_cookie,
        owner,
        destination_username=await _automatic_login_destination(db, token_row, owner),
    )

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
            account_switch=switch,
        )

    return MergePreview(
        is_merge=True,
        account_switch=switch,
        owner_username=owner.username,
        guest_username=guest.username,
        guest_matches_count=await _guest_match_count(db, guest.id),
        # A first-sign-in link is the only merge that moves the username, so it
        # is the only one whose gate may say the guest name is kept.
        adopts_guest_username=_is_first_sign_in_context(token_row.context),
    )
