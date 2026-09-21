"""Retain identities while independently controlling access and participation.

Internal operations: callers authorize the target identity and own the transaction.
Identity row locks are held until that transaction ends. Lifecycle transitions do
not transfer ownership, recreate grants, withdraw entries, or rebuild ratings.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Account, Player
from app.models.device_token import DeviceToken
from app.models.email_intent import EmailIntent, FirstSignInIntent
from app.models.user_token import EmailToken, SessionToken
from app.tournament_checkout_invalidation import (
    invalidate_checkouts_for_account_lifecycle,
    invalidate_checkouts_for_player,
    mark_merchant_account_active,
)


class IdentityLifecycleError(ValueError):
    """The requested transition is unavailable for this identity."""


async def _account(db: AsyncSession, account_id: uuid.UUID) -> Account:
    account = await db.scalar(
        select(Account)
        .where(Account.id == account_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if (
        account is None
        or account.merged_at is not None
        or account.erased_at is not None
    ):
        raise IdentityLifecycleError("Account is missing, merged, or erased")
    return account


async def deactivate_account(db: AsyncSession, account_id: uuid.UUID) -> None:
    account = await _account(db, account_id)
    account.deactivated_at = account.deactivated_at or datetime.now(UTC)
    await invalidate_checkouts_for_account_lifecycle(db, account_id)
    await db.execute(delete(SessionToken).where(SessionToken.user_id == account_id))
    await db.execute(delete(DeviceToken).where(DeviceToken.user_id == account_id))
    await db.execute(
        delete(EmailToken).where(
            or_(
                EmailToken.user_id == account_id,
                EmailToken.target_account_id == account_id,
            ),
        )
    )
    await db.execute(
        delete(EmailIntent).where(
            or_(
                EmailIntent.user_id == account_id,
                EmailIntent.target_account_id == account_id,
            )
        )
    )
    await db.execute(
        delete(FirstSignInIntent).where(FirstSignInIntent.user_id == account_id)
    )


async def reactivate_account(db: AsyncSession, account_id: uuid.UUID) -> None:
    account = await _account(db, account_id)
    account.deactivated_at = None
    mark_merchant_account_active(db, account_id)


async def erase_account(db: AsyncSession, account_id: uuid.UUID) -> None:
    account = await _account(db, account_id)
    await deactivate_account(db, account_id)
    # Checkout receipt destinations are independent PII and must disappear in
    # the same erasure transaction; durable provider ids and amounts remain.
    from app.tournament_payment_receipts import (
        erase_tournament_receipt_pii_for_account,
    )

    await erase_tournament_receipt_pii_for_account(db, account_id)
    account.erased_at = datetime.now(UTC)
    account.email = None
    account.display_name = "Erased account"
    account.confirmed_at = None
    account.last_seen_at = None
    account.agent_access_linked_at = None
    account.agent_access_revoked_at = None
    account.login_identities.clear()
    await db.execute(
        delete(EmailToken).where(
            or_(
                EmailToken.user_id == account_id,
                EmailToken.target_account_id == account_id,
                EmailToken.guest_account_id == account_id,
            )
        )
    )
    await db.execute(
        delete(EmailIntent).where(
            or_(
                EmailIntent.user_id == account_id,
                EmailIntent.target_account_id == account_id,
            )
        )
    )
    await db.execute(
        delete(FirstSignInIntent).where(FirstSignInIntent.user_id == account_id)
    )
    await db.execute(delete(DeviceToken).where(DeviceToken.user_id == account_id))


async def _player(db: AsyncSession, player_id: uuid.UUID) -> Player:
    player = await db.scalar(
        select(Player)
        .where(Player.id == player_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if player is None or player.merged_at is not None:
        raise IdentityLifecycleError("Player is missing or merged")
    return player


async def retire_player(db: AsyncSession, player_id: uuid.UUID) -> None:
    player = await _player(db, player_id)
    player.retired_at = player.retired_at or datetime.now(UTC)
    await invalidate_checkouts_for_player(db, player.id)


async def restore_player(db: AsyncSession, player_id: uuid.UUID) -> None:
    player = await _player(db, player_id)
    player.retired_at = None
