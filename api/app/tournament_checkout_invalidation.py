"""Durably release active checkout holds when their authority disappears."""

import uuid
from collections.abc import Iterable

from sqlalchemy import ColumnElement, func, or_, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from app import required_repairs
from app.models import (
    Tournament,
    TournamentCheckout,
    TournamentCheckoutStatus,
    TournamentPayment,
    TournamentPaymentStatus,
)
from app.tournament_payment_state import TERMINAL_PAYMENT_STATUSES


async def request_cancel_of_open_payments(
    db: AsyncSession, *criteria: ColumnElement[bool]
) -> None:
    """Mark every open payment that matches ``criteria`` ``cancel_requested``
    and stage a best-effort PaymentIntent cancel for each (#1816).

    The caller has just made the payment's checkout unusable, so nobody can
    resume the payment any more. The browser may still hold its client
    secret, so the PaymentIntent is cancelled rather than left open. The
    cancel job runs only after the caller's transaction commits, because it
    is a Stripe call. If Stripe reports success anyway, reconcile admits or
    records a refund obligation exactly as for any other late success.
    """
    payment_ids: Iterable[uuid.UUID] = (
        await db.execute(
            update(TournamentPayment)
            .where(
                TournamentPayment.status.not_in(TERMINAL_PAYMENT_STATUSES),
                *criteria,
            )
            .values(
                status=TournamentPaymentStatus.cancel_requested,
                cancel_requested_at=func.clock_timestamp(),
            )
            .returning(TournamentPayment.id)
        )
    ).scalars()
    for payment_id in payment_ids:
        await required_repairs.request_payment_cancel(db, payment_id)


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
