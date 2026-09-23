"""Read-only same-person account-merge projections."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User


async def terminal_active_account_id(
    db: AsyncSession, historical_account_id: uuid.UUID
) -> uuid.UUID | None:
    """Resolve historical ownership to its active terminal account.

    Financial and other audit rows deliberately keep the historical account
    id.  This helper is only for routing present-day projections such as
    notifications and realtime invalidations.
    """
    account_id = historical_account_id
    visited: set[uuid.UUID] = set()
    while account_id not in visited:
        visited.add(account_id)
        account = await db.scalar(
            select(User)
            .where(User.id == account_id)
            .execution_options(populate_existing=True)
        )
        if account is None:
            return None
        if account.merged_into_user_id is None:
            return account.id if account.is_active else None
        account_id = account.merged_into_user_id
    return None


async def is_terminal_merge_survivor(
    db: AsyncSession,
    *,
    historical_account_id: uuid.UUID,
    candidate_account_id: uuid.UUID,
) -> bool:
    """Whether candidate is the active terminal survivor of historical account."""
    return (
        await terminal_active_account_id(db, historical_account_id)
        == candidate_account_id
    )
