"""Bound retries of recoverable merge confirmations before domain row locks."""

from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.email_credentials import EMAIL_CONFIRM_TOKEN_LIFETIME
from app.models import EmailPurpose, EmailToken
from app.rate_limiting import RateLimitUnavailable, check_expiring_budget


async def admit_merge_confirmation(db: AsyncSession, token_hash: bytes) -> None:
    """Only live merge bearers allocate expiring retry budgets.

    Ordinary confirmations retain their existing availability. This unlocked,
    indexed peek grants no authority: confirmation reloads and validates the
    credential under its usual locks after admission.
    """
    token_id = await db.scalar(
        select(EmailToken.id).where(
            EmailToken.token == token_hash,
            EmailToken.purpose == EmailPurpose.merge,
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
