"""HTTP adapter for tournament card payments, and the Stripe webhook (#1816)."""

import uuid

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.models import User
from app.payments.dependencies import get_payment_provider
from app.payments.provider import PaymentProvider
from app.schemas.tournament_payment import (
    TournamentPaymentPrepared,
    TournamentPaymentRead,
)
from app.sessions import get_current_user
from app.tournament_payment_errors import (
    PaymentNotFoundError,
    PaymentNotReadyError,
    PaymentProviderUnavailableError,
)
from app.tournament_payments import (
    prepare_or_resume_payment,
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
        )
    except PaymentNotFoundError as error:
        raise HTTPException(status_code=404, detail="Payment not found.") from error


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
) -> StripeWebhookAck:
    """Stripe's webhook endpoint (#1816).

    No auth dependency: ``app.sessions``'s CSRF layer already skips cookieless
    requests, so Stripe's signed, cookieless POST passes through unexempted.
    The raw body is read BEFORE any JSON parsing — required for signature
    verification — and the signature is checked against every configured
    secret (more than one may be live at once, e.g. rotating a secret).
    """
    raw_body = await request.body()
    signature = request.headers.get("stripe-signature")
    secrets = get_settings().stripe_webhook_signing_secrets
    event = None
    for secret in secrets if signature else []:
        try:
            event = stripe.Webhook.construct_event(raw_body, signature, secret)
            break
        except (ValueError, stripe.SignatureVerificationError):
            continue
    if event is None:
        raise HTTPException(status_code=400, detail="Invalid Stripe webhook signature.")

    try:
        await record_and_reconcile_provider_event(
            db, raw=event.to_dict(), provider=provider
        )
    except PaymentProviderUnavailableError as error:
        raise HTTPException(
            status_code=503, detail="Payment provider unavailable."
        ) from error

    return StripeWebhookAck(received=True)
