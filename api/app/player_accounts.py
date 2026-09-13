"""Resolve sporting authority through explicit account-to-player grants."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.expression import ScalarSelect

from app.models import Account, AccountPlayer, Player


class PlayerAccessDenied(Exception):
    """The account has no authority over this player."""


async def require_player(
    db: AsyncSession, account_id: uuid.UUID, player_id: uuid.UUID
) -> Player:
    # Lifecycle and identity merges take Account before Player. Keep the
    # author's Account stable until the caller commits its authorized action.
    await db.execute(
        select(Account.id)
        .where(Account.id == account_id)
        .order_by(Account.id)
        .with_for_update(read=True)
    )
    player = await db.scalar(
        select(Player)
        .join(AccountPlayer)
        .join(Account)
        .where(
            Account.is_active,
            Player.merged_into_player_id.is_(None),
            Player.retired_at.is_(None),
            AccountPlayer.account_id == account_id,
            AccountPlayer.player_id == player_id,
        )
        .with_for_update(read=True, of=Player)
        .execution_options(populate_existing=True)
    )
    if player is None:
        raise PlayerAccessDenied
    return player


async def primary_player_id(
    db: AsyncSession, account_id: uuid.UUID
) -> uuid.UUID | None:
    """No grant means no player; never choose an arbitrary managed player."""
    result = await db.execute(select(primary_player_reference(account_id)))
    return result.scalar_one_or_none()


def primary_player_reference(account_id: uuid.UUID) -> ScalarSelect[uuid.UUID]:
    """Embed primary-player resolution in a read without adding a round trip."""
    return (
        select(AccountPlayer.player_id)
        .join(Account)
        .join(Player)
        .where(
            AccountPlayer.account_id == account_id,
            AccountPlayer.is_primary,
            Account.is_active,
            Player.merged_into_player_id.is_(None),
            Player.retired_at.is_(None),
        )
        .scalar_subquery()
    )


async def managing_account_ids(
    db: AsyncSession, player_ids: list[uuid.UUID]
) -> list[uuid.UUID]:
    """Resolve recipients and authority from grants, never from Player IDs."""
    if not player_ids:
        return []
    # Recipient resolution must not flush a pending result before its race guard.
    with db.no_autoflush:
        result = await db.scalars(
            select(Account.id)
            .join(AccountPlayer)
            .join(Player)
            .where(
                AccountPlayer.player_id.in_(player_ids),
                Account.is_active,
                Player.merged_into_player_id.is_(None),
                Player.retired_at.is_(None),
            )
            .distinct()
            .order_by(Account.id)
        )
    return list(result)
