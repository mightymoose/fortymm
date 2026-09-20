"""Durably release active checkout holds when their authority disappears."""

import uuid

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import TournamentCheckout, TournamentCheckoutStatus


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
