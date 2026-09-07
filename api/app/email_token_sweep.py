"""Hourly cleanup of expired email credentials and unusable replacement markers.

Pending intents and session credentials have independent lifetimes. The sweep
locks owners before credentials, like issuance and consumption, and never deletes
intent merely because a link expired. Run with ``python -m app.email_token_sweep``.
"""

import asyncio
import logging
from datetime import UTC, datetime

from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db import get_engine
from app.email_credentials import (
    EMAIL_CONFIRM_TOKEN_LIFETIME,
    LOGIN_TOKEN_LIFETIME,
    email_action_is_valid,
    lock_accounts,
    login_token_clause,
    pending_email_token_clause,
)
from app.models import EmailPurpose, EmailToken

logger = logging.getLogger(__name__)


async def sweep_expired_email_tokens(db: AsyncSession) -> int:
    """Delete expired credentials and markers without a usable replacement."""
    now = datetime.now(UTC)
    expired = or_(
        login_token_clause() & (EmailToken.created_at < now - LOGIN_TOKEN_LIFETIME),
        pending_email_token_clause()
        & (EmailToken.created_at < now - EMAIL_CONFIRM_TOKEN_LIFETIME),
    )
    owner_ids = set(
        (
            await db.execute(
                select(EmailToken.user_id)
                .where(or_(expired, EmailToken.replaced_at.is_not(None)))
                .distinct()
            )
        ).scalars()
    )
    if not owner_ids:
        return 0
    await lock_accounts(db, owner_ids)
    removed = list(
        (
            await db.execute(
                delete(EmailToken)
                .where(EmailToken.user_id.in_(owner_ids), expired)
                .returning(EmailToken.id)
            )
        ).scalars()
    )
    tokens = (
        (await db.execute(select(EmailToken).where(EmailToken.user_id.in_(owner_ids))))
        .scalars()
        .all()
    )
    usable = set()
    for token in tokens:
        if token.replaced_at is None and await email_action_is_valid(db, token):
            usable.add(
                (
                    token.user_id,
                    token.purpose in (EmailPurpose.login, EmailPurpose.first_sign_in),
                )
            )
    for token in tokens:
        if (
            token.replaced_at is not None
            and (
                token.user_id,
                token.purpose in (EmailPurpose.login, EmailPurpose.first_sign_in),
            )
            not in usable
        ):
            removed.append(token.id)
            await db.delete(token)
    await db.flush()
    return len(removed)


def run_email_token_sweep() -> None:
    asyncio.run(_run_email_token_sweep())


async def _run_email_token_sweep() -> None:
    sessionmaker = async_sessionmaker(get_engine(), expire_on_commit=False)
    async with sessionmaker() as db:
        deleted = await sweep_expired_email_tokens(db)
        await db.commit()
    logger.info(
        "Email-token sweep: deleted %d expired or unusable credentials", deleted
    )


def main() -> None:
    run_email_token_sweep()


if __name__ == "__main__":
    main()
