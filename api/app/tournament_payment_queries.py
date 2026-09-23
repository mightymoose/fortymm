"""Read projections over the tournament payment domain."""

import uuid
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    TournamentCheckout,
    TournamentPayment,
    TournamentPaymentReceipt,
    TournamentReceiptState,
)

PaymentProblemState = Literal[
    "provider_mismatch",
    "receipt_delivery_failed",
    "receipt_sync_failed",
    "create_rejected",
]


@dataclass(frozen=True)
class TournamentPaymentProblem:
    support_reference: str
    state: PaymentProblemState
    checkout_id: uuid.UUID


async def list_tournament_payment_problems(
    db: AsyncSession, *, tournament_id: uuid.UUID
) -> list[TournamentPaymentProblem]:
    """Return the tournament's safe operator-facing payment problem projection."""
    payment_rows = await db.execute(
        select(
            TournamentPayment.support_reference,
            TournamentPayment.checkout_id,
        )
        .join(
            TournamentCheckout,
            TournamentCheckout.id == TournamentPayment.checkout_id,
        )
        .where(
            TournamentCheckout.tournament_id == tournament_id,
            TournamentPayment.provider_mismatch_at.is_not(None),
            TournamentPayment.support_reference.is_not(None),
        )
    )
    receipt_rows = await db.execute(
        select(
            TournamentPaymentReceipt.support_reference,
            TournamentPayment.checkout_id,
        )
        .join(
            TournamentPayment,
            TournamentPayment.id == TournamentPaymentReceipt.payment_id,
        )
        .join(
            TournamentCheckout,
            TournamentCheckout.id == TournamentPayment.checkout_id,
        )
        .where(
            TournamentCheckout.tournament_id == tournament_id,
            TournamentPaymentReceipt.state == TournamentReceiptState.failed,
            TournamentPaymentReceipt.support_reference.is_not(None),
        )
    )
    receipt_sync_rows = await db.execute(
        select(
            TournamentPayment.support_reference,
            TournamentPayment.checkout_id,
        )
        .join(
            TournamentCheckout,
            TournamentCheckout.id == TournamentPayment.checkout_id,
        )
        .where(
            TournamentCheckout.tournament_id == tournament_id,
            TournamentPayment.receipt_sync_failed_at.is_not(None),
            TournamentPayment.support_reference.is_not(None),
        )
    )
    create_rejected_rows = await db.execute(
        select(
            TournamentPayment.support_reference,
            TournamentPayment.checkout_id,
        )
        .join(
            TournamentCheckout,
            TournamentCheckout.id == TournamentPayment.checkout_id,
        )
        .where(
            TournamentCheckout.tournament_id == tournament_id,
            TournamentPayment.provider_status == "create_rejected",
            TournamentPayment.support_reference.is_not(None),
        )
    )
    return (
        [
            TournamentPaymentProblem(
                support_reference=support_reference,
                state="provider_mismatch",
                checkout_id=checkout_id,
            )
            for support_reference, checkout_id in payment_rows
            if support_reference is not None
        ]
        + [
            TournamentPaymentProblem(
                support_reference=support_reference,
                state="receipt_delivery_failed",
                checkout_id=checkout_id,
            )
            for support_reference, checkout_id in receipt_rows
            if support_reference is not None
        ]
        + [
            TournamentPaymentProblem(
                support_reference=support_reference,
                state="receipt_sync_failed",
                checkout_id=checkout_id,
            )
            for support_reference, checkout_id in receipt_sync_rows
            if support_reference is not None
        ]
        + [
            TournamentPaymentProblem(
                support_reference=support_reference,
                state="create_rejected",
                checkout_id=checkout_id,
            )
            for support_reference, checkout_id in create_rejected_rows
            if support_reference is not None
        ]
    )
