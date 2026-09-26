"""HTTP adapter for tournament card payments, and the Stripe webhook (#1816)."""

import uuid

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.models import TournamentPaymentProviderEvent, User
from app.payments.dependencies import get_payment_provider
from app.payments.provider import PaymentProvider
from app.schemas.tournament_payment import (
    TournamentPaymentPrepared,
    TournamentPaymentRead,
)
from app.sessions import get_current_user
from app.tournament_payment_errors import PaymentNotFoundError, PaymentNotReadyError
from app.tournament_payments import (
    HANDLED_PROVIDER_EVENT_TYPES,
    find_payment_id_for_provider_event,
    parse_incoming_provider_event,
    prepare_or_resume_payment,
    read_payment_status,
    reconcile_payment,
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
    for secret in secrets:
        try:
            event = stripe.Webhook.construct_event(raw_body, signature, secret)
            break
        except (ValueError, stripe.SignatureVerificationError):
            continue
    if event is None:
        raise HTTPException(status_code=400, detail="Invalid Stripe webhook signature.")

    raw = event.to_dict()
    incoming = parse_incoming_provider_event(raw)
    payment_id = await find_payment_id_for_provider_event(db, incoming)

    # Persist uniquely BEFORE acknowledging (#1816) — a duplicate insert is a
    # no-op, not an error, so a replayed event changes nothing.
    result = await db.execute(
        pg_insert(TournamentPaymentProviderEvent)
        .values(
            provider_event_id=incoming.id,
            event_type=incoming.type,
            payment_id=payment_id,
            payload=raw,
        )
        .on_conflict_do_nothing(
            index_elements=["provider_event_id"],
        )
        .returning(TournamentPaymentProviderEvent.id)
    )
    newly_inserted = result.first() is not None
    await db.commit()

    if (
        newly_inserted
        and payment_id is not None
        and incoming.type in HANDLED_PROVIDER_EVENT_TYPES
    ):
        await reconcile_payment(
            db, payment_id=payment_id, provider=provider, source_event=incoming
        )

    return StripeWebhookAck(received=True)
