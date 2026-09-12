"""Bound retries of recoverable credential merges before domain row locks."""

from datetime import UTC, datetime
from typing import Literal

from fastapi import HTTPException
from sqlalchemy import and_, exists, literal, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.email_credentials import EMAIL_CONFIRM_TOKEN_LIFETIME, LOGIN_TOKEN_LIFETIME
from app.models import EmailPurpose, EmailToken, SessionToken, User
from app.rate_limiting import RateLimitUnavailable, check_expiring_budget


async def admit_credential_merge(
    db: AsyncSession,
    token_hash: bytes,
    session_hash: bytes | None = None,
    *,
    skip_merge: bool = False,
    flow: Literal["confirmation", "login"] = "confirmation",
) -> None:
    """Live credentials that can fold a guest allocate expiring retry budgets.

    Ordinary confirmations and sign-ins retain their existing availability.
    This unlocked indexed peek grants no authority: the caller reloads and validates the
    credential under its usual locks after admission.
    """
    browser_guest = exists(
        select(SessionToken.id)
        .join(User, User.id == SessionToken.user_id)
        .where(
            SessionToken.token == session_hash,
            User.id != EmailToken.user_id,
            User.confirmed_at.is_(None),
            User.merged_into_user_id.is_(None),
        )
    )
    recorded_guest = exists(
        select(User.id).where(
            User.id == EmailToken.guest_account_id,
            User.id != EmailToken.user_id,
            User.confirmed_at.is_(None),
            User.merged_into_user_id.is_(None),
        )
    )
    if flow == "login":
        will_merge = and_(
            literal(not skip_merge),
            EmailToken.purpose.in_([EmailPurpose.login, EmailPurpose.first_sign_in]),
            or_(
                recorded_guest,
                and_(EmailToken.guest_account_id.is_(None), browser_guest),
            ),
        )
        lifetime = LOGIN_TOKEN_LIFETIME
    else:
        will_merge = or_(
            EmailToken.purpose == EmailPurpose.merge,
            and_(
                literal(not skip_merge),
                EmailToken.purpose == EmailPurpose.change,
                browser_guest,
            ),
        )
        lifetime = EMAIL_CONFIRM_TOKEN_LIFETIME
    token_id = await db.scalar(
        select(EmailToken.id).where(
            EmailToken.token == token_hash,
            will_merge,
            EmailToken.replaced_at.is_(None),
            EmailToken.created_at >= datetime.now(UTC) - lifetime,
        )
    )
    if token_id is None:
        return
    action = "Sign-in" if flow == "login" else "Confirmation"
    acquired = await db.scalar(
        text("SELECT pg_try_advisory_xact_lock(hashtextextended(:credential, 1711))"),
        {"credential": token_hash.hex()},
    )
    if not acquired:
        raise HTTPException(
            status_code=429,
            detail=f"{action} is already in progress. Retry after it finishes.",
            headers={"Retry-After": "5"},
        )
    try:
        allowed = await check_expiring_budget(
            f"email-merge-confirm:{token_hash.hex()}", limit=5, seconds=3600
        )
    except RateLimitUnavailable as error:
        raise HTTPException(
            status_code=503,
            detail=f"{action} is temporarily unavailable. Retry shortly.",
            headers={"Retry-After": "5"},
        ) from error
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"Too many {action.lower()} attempts. Retry in one hour.",
            headers={"Retry-After": "3600"},
        )
