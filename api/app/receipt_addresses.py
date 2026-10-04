"""Erase receipt addresses (#1810).

A receipt address is optional PII that one checkout carries, and its payment
snapshots at verified success (#1809). This module is the one place that
removes it, for three callers: the payer's own request, an account erasure and
the daily cleanup sweep. Erasing never touches the Account email, the receipt,
the payment, or any refund obligation.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import database_now
from app.models import TournamentCheckout, TournamentPayment, TournamentPaymentStatus


async def erase_receipt_address(db: AsyncSession, *, checkout_id: uuid.UUID) -> None:
    """Null the address on a checkout and on its payment, and stamp the payment.

    Idempotent. Takes the checkout lock, then the payment lock: the same order
    every payment writer uses, so it cannot deadlock with admission. A payment
    that has not succeeded keeps no tombstone, because the payer may still set
    a new address on that checkout until success. Does not commit.
    """
    checkout = await db.scalar(
        select(TournamentCheckout)
        .where(TournamentCheckout.id == checkout_id)
        .with_for_update()
    )
    if checkout is None:
        return
    checkout.receipt_address = None
    payment = await db.scalar(
        select(TournamentPayment)
        .where(TournamentPayment.checkout_id == checkout_id)
        .with_for_update()
    )
    if payment is None or payment.status is not TournamentPaymentStatus.succeeded:
        return
    payment.receipt_address = None
    if payment.receipt_address_erased_at is None:
        payment.receipt_address_erased_at = await database_now(db)


async def erase_receipt_addresses_of_account(
    db: AsyncSession, *, account_id: uuid.UUID
) -> None:
    """Erase every receipt address the account's checkouts hold. Does not commit."""
    checkout_ids = await db.scalars(
        select(TournamentCheckout.id).where(
            TournamentCheckout.payer_account_id == account_id
        )
    )
    for checkout_id in checkout_ids.all():
        await erase_receipt_address(db, checkout_id=checkout_id)
