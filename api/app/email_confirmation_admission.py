"""Bound retries of recoverable merge confirmations before domain row locks."""

from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import and_, exists, literal, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.email_credentials import EMAIL_CONFIRM_TOKEN_LIFETIME
from app.models import EmailPurpose, EmailToken, SessionToken, User
from app.rate_limiting import RateLimitUnavailable, check_expiring_budget


async def admit_merge_confirmation(
    db: AsyncSession,
    token_hash: bytes,
    session_hash: bytes | None = None,
    *,
    skip_merge: bool = False,
) -> None:
    """Live confirmations that can fold a guest allocate expiring retry budgets.

    Ordinary confirmations retain their existing availability. This unlocked,
    indexed peek grants no authority: confirmation reloads and validates the
    credential under its usual locks after admission.
    """
    token_id = await db.scalar(
        select(EmailToken.id).where(
            EmailToken.token == token_hash,
            or_(
                EmailToken.purpose == EmailPurpose.merge,
                and_(
                    literal(not skip_merge),
                    EmailToken.purpose == EmailPurpose.change,
                    exists(
                        select(SessionToken.id)
                        .join(User, User.id == SessionToken.user_id)
                        .where(
                            SessionToken.token == session_hash,
                            User.id != EmailToken.user_id,
                            User.confirmed_at.is_(None),
                            User.merged_into_user_id.is_(None),
                        )
                    ),
                ),
            ),
            EmailToken.replaced_at.is_(None),
            EmailToken.created_at >= datetime.now(UTC) - EMAIL_CONFIRM_TOKEN_LIFETIME,
        )
    )
    if token_id is None:
        return
    acquired = await db.scalar(
        text("SELECT pg_try_advisory_xact_lock(hashtextextended(:credential, 1711))"),
        {"credential": token_hash.hex()},
    )
    if not acquired:
        raise HTTPException(
            status_code=429,
            detail="This confirmation is already in progress. Retry after it finishes.",
            headers={"Retry-After": "5"},
        )
    try:
        allowed = await check_expiring_budget(
            f"email-merge-confirm:{token_hash.hex()}", limit=5, seconds=3600
        )
    except RateLimitUnavailable as error:
        raise HTTPException(
            status_code=503,
            detail="Confirmation is temporarily unavailable. Retry shortly.",
            headers={"Retry-After": "5"},
        ) from error
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail="Too many confirmation attempts. Retry in one hour.",
            headers={"Retry-After": "3600"},
        )
