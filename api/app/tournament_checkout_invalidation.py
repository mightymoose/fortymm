"""Durably release active checkout holds when their authority disappears."""

import uuid

from sqlalchemy import or_, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from app.models import Tournament, TournamentCheckout, TournamentCheckoutStatus


async def invalidate_checkouts_for_tournament(
    db: AsyncSession, tournament_id: uuid.UUID
) -> None:
    await db.execute(
        update(TournamentCheckout)
        .where(
            TournamentCheckout.tournament_id == tournament_id,
            TournamentCheckout.status == TournamentCheckoutStatus.active,
        )
        .values(status=TournamentCheckoutStatus.invalidated)
    )


async def invalidate_checkouts_for_player(
    db: AsyncSession, player_id: uuid.UUID
) -> None:
    await db.execute(
        update(TournamentCheckout)
        .where(
            TournamentCheckout.entrant_player_id == player_id,
            TournamentCheckout.status == TournamentCheckoutStatus.active,
        )
        .values(status=TournamentCheckoutStatus.invalidated)
    )


async def invalidate_checkouts_for_account_lifecycle(
    db: AsyncSession, account_id: uuid.UUID
) -> None:
    """Release every hold bought or sold by an Account whose lifecycle ended."""
    await db.execute(
        update(TournamentCheckout)
        .where(
            or_(
                TournamentCheckout.merchant_account_id == account_id,
                TournamentCheckout.payer_account_id == account_id,
            ),
            TournamentCheckout.status == TournamentCheckoutStatus.active,
        )
        .values(status=TournamentCheckoutStatus.invalidated)
    )
    # Some service tests and multi-step domain operations deliberately retain one
    # session across the lifecycle transition. Keep already-loaded tournament
    # projections coherent with the database value the column property will return
    # in every fresh request.
    for instance in db.identity_map.values():
        if isinstance(instance, Tournament) and instance.owner_account_id == account_id:
            set_committed_value(instance, "owner_account_is_active", False)


def mark_merchant_account_active(db: AsyncSession, account_id: uuid.UUID) -> None:
    """Refresh loaded tournament capability after explicit account reactivation."""
    for instance in db.identity_map.values():
        if isinstance(instance, Tournament) and instance.owner_account_id == account_id:
            set_committed_value(instance, "owner_account_is_active", True)
