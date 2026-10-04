"""HTTP adapter for tournament card payments, and the Stripe webhook (#1816)."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.db import get_session
from app.models import User
from app.payments.dependencies import get_payment_provider
from app.payments.provider import (
    PaymentProvider,
    WebhookRejected,
    verify_webhook_event,
)
from app.schemas.tournament_payment import (
    TournamentPaymentPrepared,
    TournamentPaymentRead,
    TournamentPaymentReceiptRead,
    TournamentPaymentSummary,
)
from app.sessions import get_current_user
from app.tournament_payment_errors import (
    PaymentNotFoundError,
    PaymentNotReadyError,
    PaymentProviderUnavailableError,
)
from app.tournament_payments import (
    erase_payment_receipt_address,
    list_succeeded_payments,
    prepare_or_resume_payment,
    read_payment_receipt,
    read_payment_status,
    record_and_reconcile_provider_event,
)

router = APIRouter(prefix="/v1")


class StripeWebhookAck(BaseModel):
    received: bool


@router.post(
    "/tournaments/{tournament_id}/checkouts/{checkout_id}/payment",
    response_model=TournamentPaymentPrepared,
    status_code=status.HTTP_201_CREATED,
)
async def prepare_tournament_payment(
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
    provider: PaymentProvider = Depends(get_payment_provider),
    settings: Settings = Depends(get_settings),
) -> TournamentPaymentPrepared:
    """Create (or resume) this checkout's Stripe PaymentIntent. The ONLY
    response that ever carries the Stripe client secret — call this again to
    resume an in-progress payment."""
    try:
        return await prepare_or_resume_payment(
            db,
            tournament_id=tournament_id,
            checkout_id=checkout_id,
            actor=current_user,
            provider=provider,
            settings=settings,
        )
    except PaymentNotFoundError as error:
        raise HTTPException(status_code=404, detail="Checkout not found.") from error
    except PaymentNotReadyError as error:
        raise HTTPException(
            status_code=409, detail="This checkout cannot take a payment right now."
        ) from error


@router.get(
    "/tournaments/{tournament_id}/checkouts/{checkout_id}/payment",
    response_model=TournamentPaymentRead,
)
async def get_tournament_payment(
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
    provider: PaymentProvider = Depends(get_payment_provider),
    settings: Settings = Depends(get_settings),
) -> TournamentPaymentRead:
    """Read a payment's current status, refreshing it against Stripe first
    when it is not yet in a terminal state. Only the payer and the configured
    merchant account may read it (#1816) — everyone else gets a 404. Never
    carries the client secret."""
    try:
        return await read_payment_status(
            db,
            tournament_id=tournament_id,
            checkout_id=checkout_id,
            actor=current_user,
            provider=provider,
            settings=settings,
        )
    except PaymentNotFoundError as error:
        raise HTTPException(status_code=404, detail="Payment not found.") from error


@router.get(
    "/payments/{payment_id}/receipt",
    response_model=TournamentPaymentReceiptRead,
)
async def get_payment_receipt(
    payment_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentPaymentReceiptRead:
    """The itemized receipt of a succeeded payment (#1810). Only the payer and
    the merchant account may read it. Everyone else, and every payment that has
    not succeeded, gets a 404."""
    try:
        return await read_payment_receipt(db, payment_id=payment_id, actor=current_user)
    except PaymentNotFoundError as error:
        raise HTTPException(status_code=404, detail="Receipt not found.") from error


@router.get(
    "/tournaments/{tournament_id}/payments",
    response_model=list[TournamentPaymentSummary],
)
async def list_tournament_payments(
    tournament_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> list[TournamentPaymentSummary]:
    """The caller's own succeeded payments in this tournament (#1810), so a payer
    who left before success can reach each receipt. It lists nobody else's."""
    return await list_succeeded_payments(
        db, tournament_id=tournament_id, actor=current_user
    )


@router.delete(
    "/payments/{payment_id}/receipt-address",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_payment_receipt_address(
    payment_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> None:
    """Erase the receipt address of a succeeded payment at once (#1810). Only
    the payer may. Everyone else, and every payment that has not succeeded,
    gets a 404. The receipt, the payment and the Account email stay."""
    try:
        await erase_payment_receipt_address(
            db, payment_id=payment_id, actor=current_user
        )
    except PaymentNotFoundError as error:
        raise HTTPException(status_code=404, detail="Receipt not found.") from error


@router.post(
    "/webhooks/stripe",
    response_model=StripeWebhookAck,
    status_code=status.HTTP_200_OK,
    include_in_schema=False,
)
async def stripe_webhook(
    request: Request,
    db: AsyncSession = Depends(get_session),
    provider: PaymentProvider = Depends(get_payment_provider),
    settings: Settings = Depends(get_settings),
) -> StripeWebhookAck:
    """Stripe's webhook endpoint (#1816).

    No auth dependency: ``app.sessions``'s CSRF layer already skips cookieless
    requests, so Stripe's signed, cookieless POST passes through unexempted.
    The raw body is read BEFORE any JSON parsing, because signature
    verification needs it. The provider seam checks the signature against
    every configured secret, then parses the event into a typed model. A bad
    signature or a malformed event is a 400.
    """
    try:
        event = verify_webhook_event(
            await request.body(),
            signature=request.headers.get("stripe-signature"),
            secrets=settings.stripe_webhook_signing_secrets,
        )
    except WebhookRejected as error:
        raise HTTPException(
            status_code=400, detail="Invalid Stripe webhook event."
        ) from error

    try:
        await record_and_reconcile_provider_event(
            db, event=event, provider=provider, settings=settings
        )
    except PaymentProviderUnavailableError as error:
        raise HTTPException(
            status_code=503, detail="Payment provider unavailable."
        ) from error

    return StripeWebhookAck(received=True)
