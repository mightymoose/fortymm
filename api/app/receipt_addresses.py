"""Erase receipt addresses (#1810).

A receipt address is optional PII that one checkout carries, and its payment
snapshots at verified success (#1809). This module is the one place that
removes it, for three callers: the payer's own request, an account erasure and
the daily cleanup sweep. Erasing never touches the Account email, the receipt
page, the payment, or any refund obligation.
"""

import uuid

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import database_now
from app.models import (
    TournamentCheckout,
    TournamentPayment,
    TournamentPaymentRefundObligation,
    TournamentPaymentStatus,
)
from app.tournament_payment_state import TERMINAL_PAYMENT_STATUSES

#: Statuses a payment can still leave. Financial resolution means every payment
#: is terminal: a cancel is best-effort, a processing payment is Stripe's to
#: finish, and ``expired`` is deliberately not terminal (a late success can
#: still land). Erasing the address first would make that late success snapshot
#: nothing. #1817's background reconciliation settles abandoned payments.
UNSETTLED_PAYMENT_STATUSES = tuple(
    status
    for status in TournamentPaymentStatus
    if status not in TERMINAL_PAYMENT_STATUSES
)


async def payment_is_resolved(db: AsyncSession, payment: TournamentPayment) -> bool:
    """The payment is terminal, owes nobody a refund, and hides no refund behind
    an unverified amount. Nothing marks an obligation settled until #1813
    executes refunds, so until then any obligation counts as unresolved."""
    if payment.amount_unverified or payment.status in UNSETTLED_PAYMENT_STATUSES:
        return False
    obligation = await db.scalar(
        select(TournamentPaymentRefundObligation.id)
        .where(TournamentPaymentRefundObligation.payment_id == payment.id)
        .limit(1)
    )
    return obligation is None


async def erase_receipt_address(
    db: AsyncSession,
    *,
    checkout_id: uuid.UUID,
    only_if_resolved: bool = False,
    payer_account_id: uuid.UUID | None = None,
) -> bool:
    """Null the address on a checkout and on its payment, and stamp the payment.

    Idempotent. Takes the checkout lock, then the payment lock: the same order
    every payment writer uses, so it cannot deadlock with admission. A payment
    that has not succeeded keeps no payment tombstone. The checkout always gets
    one, which is what stops a later PATCH from writing the address back. Does
    not commit.

    ``only_if_resolved`` is for the daily sweep. It rechecks, under both locks,
    that the payment owes no refund: reconciliation can record one between the
    sweep's unlocked check and this erase, and the address must then stay.

    ``payer_account_id`` is for the payer's own request. It authorized on an
    unlocked read, and an account merge can move the payment to the survivor
    before the locks below. The erase rechecks the locked payment's payer and
    changes nothing if it moved. Returns whether it erased.
    """
    checkout = await db.scalar(
        select(TournamentCheckout)
        .where(TournamentCheckout.id == checkout_id)
        .with_for_update()
    )
    if checkout is None:
        return False
    payment = await db.scalar(
        select(TournamentPayment)
        .where(TournamentPayment.checkout_id == checkout_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if payer_account_id is not None and (
        payment is None or payment.payer_account_id != payer_account_id
    ):
        return False
    if only_if_resolved and payment is not None:
        if not await payment_is_resolved(db, payment):
            return False
    # The checkout's own tombstone: its setter refuses a new address once this is
    # set, so a PATCH cannot write the address back, even one that was waiting
    # on the lock this erase held.
    checkout.receipt_address = None
    if checkout.receipt_address_erased_at is None:
        checkout.receipt_address_erased_at = await database_now(db)
    if payment is None or payment.status is not TournamentPaymentStatus.succeeded:
        return True
    payment.receipt_address = None
    if payment.receipt_address_erased_at is None:
        payment.receipt_address_erased_at = await database_now(db)
    return True


async def erase_receipt_addresses_of_account(
    db: AsyncSession, *, account_id: uuid.UUID
) -> None:
    """Erase every receipt address held for the account. Does not commit.

    Two ownership paths reach a checkout. The account is its payer, or it owns
    a payment whose checkout still names another payer: an account merge moves
    ``payer_account_id`` of a payment to the survivor and leaves the checkout
    on the merged source. Erasing the survivor must reach both. Checkouts are
    locked in id order, the same order the sweep uses, so two overlapping
    erasures cannot deadlock.
    """
    checkout_ids = await db.scalars(
        select(TournamentCheckout.id)
        .where(
            or_(
                TournamentCheckout.payer_account_id == account_id,
                TournamentCheckout.id.in_(
                    select(TournamentPayment.checkout_id).where(
                        TournamentPayment.payer_account_id == account_id
                    )
                ),
            )
        )
        .order_by(TournamentCheckout.id)
    )
    for checkout_id in checkout_ids.all():
        await erase_receipt_address(db, checkout_id=checkout_id)
