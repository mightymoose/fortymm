"""Prepare and resume the single durable payment for a tournament checkout."""

import uuid
from typing import assert_never

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import get_settings
from app.models import (
    TournamentCheckout,
    TournamentCheckoutStatus,
    TournamentPayment,
    TournamentPaymentAllocation,
    TournamentPaymentState,
    User,
)
from app.payment_provider import (
    PaymentIntentCreate,
    PaymentProvider,
    PaymentProviderNotFoundError,
    PaymentProviderUncertainError,
    ProviderPaymentIntent,
    ProviderPaymentStatus,
)
from app.rbac import user_has_permission
from app.realtime import EventKind, stage_event
from app.schemas.tournament_checkout import (
    TournamentCheckoutPaymentState,
    TournamentPaymentLineOutcomeState,
    TournamentPaymentLineRead,
    TournamentPaymentRead,
)
from app.tournament_checkouts import _database_now

PAYMENTS_VIEW_PERMISSION = "payments.view"


class PaymentNotFoundError(Exception):
    pass


class PaymentCollectionDisabledError(Exception):
    pass


def public_payment_state(
    provider_status: ProviderPaymentStatus,
) -> TournamentPaymentState:
    match provider_status:
        case (
            ProviderPaymentStatus.requires_payment_method
            | ProviderPaymentStatus.requires_confirmation
        ):
            return TournamentPaymentState.ready
        case ProviderPaymentStatus.requires_action:
            return TournamentPaymentState.action_required
        case (
            ProviderPaymentStatus.processing
            | ProviderPaymentStatus.requires_capture
            | ProviderPaymentStatus.succeeded
        ):
            # Success must pass invariant validation and admission reconciliation
            # before the aggregate becomes terminal.
            return TournamentPaymentState.checking
        case ProviderPaymentStatus.canceled:
            return TournamentPaymentState.canceled
    assert_never(provider_status)


def payment_intent_create_request(
    payment: TournamentPayment, checkout: TournamentCheckout
) -> PaymentIntentCreate:
    """Rebuild the provider create command from the durable obligation."""
    return PaymentIntentCreate(
        amount_cents=payment.amount_cents,
        currency=payment.currency,
        merchant_account_id=str(checkout.merchant_account_id),
        payment_method_types=["card"],
        save_payment_method=False,
        idempotency_key=payment.durable_identity,
        receipt_email=payment.receipt_email,
    )


def _read(
    payment: TournamentPayment, *, include_client_secret: bool = True
) -> TournamentPaymentRead:
    event_ids = {line.id: line.event_id for line in payment.checkout.lines}
    return TournamentPaymentRead(
        checkout_id=payment.checkout_id,
        payment_state=TournamentCheckoutPaymentState(payment.state.value),
        client_secret=payment.client_secret if include_client_secret else None,
        receipt_email=payment.receipt_email,
        support_reference=payment.support_reference,
        lines=[
            TournamentPaymentLineRead(
                event_id=event_ids[allocation.checkout_line_id],
                amount_cents=allocation.amount_cents,
                outcome=(
                    TournamentPaymentLineOutcomeState(allocation.outcome.value)
                    if allocation.outcome
                    else None
                ),
                refund_amount_cents=allocation.refund_amount_cents,
            )
            for allocation in payment.allocations
        ],
    )


async def _load(
    db: AsyncSession, tournament_id: uuid.UUID, checkout_id: uuid.UUID
) -> TournamentCheckout | None:
    checkout: TournamentCheckout | None = await db.scalar(
        select(TournamentCheckout)
        .where(
            TournamentCheckout.id == checkout_id,
            TournamentCheckout.tournament_id == tournament_id,
        )
        .options(
            selectinload(TournamentCheckout.lines),
            selectinload(TournamentCheckout.payment),
            selectinload(TournamentCheckout.payment).selectinload(
                TournamentPayment.allocations
            ),
        )
        .execution_options(populate_existing=True)
    )
    return checkout


async def _store_provider_result(
    db: AsyncSession,
    *,
    payment_id: uuid.UUID,
    intent: ProviderPaymentIntent,
) -> TournamentPayment:
    payment = await db.scalar(
        select(TournamentPayment)
        .where(TournamentPayment.id == payment_id)
        .with_for_update()
    )
    if payment is None:
        raise PaymentNotFoundError()
    payment.provider_payment_id = intent.id
    payment.provider_status = intent.status
    payment.client_secret = intent.client_secret
    payment.state = public_payment_state(intent.status)
    payment.updated_at = await _database_now(db)
    await db.commit()
    return payment


async def prepare_payment(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    actor: User,
    provider: PaymentProvider,
    receipt_email: str | None,
    receipt_email_supplied: bool,
) -> TournamentPaymentRead:
    """Persist provider intent before I/O, then create or recover it idempotently."""
    checkout = await _load(db, tournament_id, checkout_id)
    if checkout is None or checkout.payer_account_id != actor.id:
        raise PaymentNotFoundError()

    payment = checkout.payment
    created_obligation = False
    if payment is None:
        if not get_settings().tournament_payment_collection_enabled:
            checkout.status = TournamentCheckoutStatus.cancelled
            checkout.cancelled_at = await _database_now(db)
            await db.commit()
            raise PaymentCollectionDisabledError()
        if checkout.status is not TournamentCheckoutStatus.active:
            raise PaymentNotFoundError()

        payer = await db.get(User, checkout.payer_account_id)
        if payer is None:
            raise PaymentNotFoundError()
        selected_email = receipt_email if receipt_email_supplied else None
        if not receipt_email_supplied and payer.confirmed_at is not None:
            selected_email = payer.email
        identity = f"fortymm:checkout:{checkout.id}:payment:v1"
        payment = TournamentPayment(
            checkout_id=checkout.id,
            durable_identity=identity,
            receipt_email=selected_email,
            currency=checkout.currency,
            amount_cents=checkout.total_cents,
            allocations=[
                TournamentPaymentAllocation(
                    checkout_line_id=line.id,
                    checkout_id=checkout.id,
                    amount_cents=line.price_cents,
                )
                for line in checkout.lines
            ],
        )
        db.add(payment)
        try:
            # This commit is the create obligation. No tournament/capacity lock is
            # held while the external processor is called below.
            stage_event(db, checkout.payer_account_id, EventKind.dashboard_changed)
            await db.commit()
            created_obligation = True
        except IntegrityError:
            await db.rollback()
            checkout = await _load(db, tournament_id, checkout_id)
            if checkout is None or checkout.payment is None:
                raise
            payment = checkout.payment

    if payment.state is TournamentPaymentState.succeeded:
        return _read(payment)

    if (
        not get_settings().tournament_payment_collection_enabled
        and payment.provider_payment_id is None
    ):
        try:
            intent = await provider.retrieve_payment_intent(payment.durable_identity)
        except (TimeoutError, PaymentProviderUncertainError):
            # A transport failure still cannot distinguish no provider object
            # from an accepted create. Preserve the obligation for recovery.
            return _read(payment)
        except PaymentProviderNotFoundError:
            now = await _database_now(db)
            checkout.status = TournamentCheckoutStatus.cancelled
            checkout.cancelled_at = now
            payment.state = TournamentPaymentState.canceled
            payment.updated_at = now
            stage_event(db, checkout.payer_account_id, EventKind.dashboard_changed)
            await db.commit()
            raise PaymentCollectionDisabledError() from None
        payment = await _store_provider_result(db, payment_id=payment.id, intent=intent)
        if isinstance(intent, ProviderPaymentIntent):
            from app.tournament_payment_reconciliation import reconcile_provider_intent

            payment = await reconcile_provider_intent(
                db, payment_id=payment.id, intent=intent
            )
            await db.commit()
        return _read(payment)

    if receipt_email_supplied and payment.receipt_email != receipt_email:
        payment.receipt_email = receipt_email
        payment.updated_at = await _database_now(db)
        await db.commit()
        if payment.provider_payment_id is not None:
            intent = await provider.update_payment_intent_receipt(
                payment.provider_payment_id, receipt_email
            )
            payment = await _store_provider_result(
                db, payment_id=payment.id, intent=intent
            )
            if isinstance(intent, ProviderPaymentIntent):
                from app.tournament_payment_reconciliation import (
                    reconcile_provider_intent,
                )

                payment = await reconcile_provider_intent(
                    db, payment_id=payment.id, intent=intent
                )
                await db.commit()
            return _read(payment)

    if payment.provider_payment_id is not None:
        return _read(payment)

    create_request = payment_intent_create_request(payment, checkout)
    try:
        if created_obligation:
            intent = await provider.create_payment_intent(create_request)
        else:
            try:
                intent = await provider.retrieve_payment_intent(
                    payment.durable_identity
                )
            except PaymentProviderNotFoundError:
                # A process may die after committing the durable obligation but
                # before provider I/O. Retrying create with the same provider
                # idempotency key is the safe recovery for that exact window.
                intent = await provider.create_payment_intent(create_request)
    except (TimeoutError, PaymentProviderUncertainError):
        return _read(payment)

    payment = await _store_provider_result(db, payment_id=payment.id, intent=intent)
    if isinstance(intent, ProviderPaymentIntent):
        from app.tournament_payment_reconciliation import reconcile_provider_intent

        payment = await reconcile_provider_intent(
            db, payment_id=payment.id, intent=intent
        )
        await db.commit()
    if receipt_email_supplied and intent.id:
        # A receipt edit may have been persisted while an uncertain provider
        # create was being recovered. Bring the recovered intent to that value.
        updated = await provider.update_payment_intent_receipt(
            intent.id, payment.receipt_email
        )
        payment = await _store_provider_result(
            db, payment_id=payment.id, intent=updated
        )
    return _read(payment)


async def read_payment_status(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    actor: User,
    provider: PaymentProvider,
) -> TournamentPaymentRead:
    """Authorize, retrieve provider truth without locks, and reconcile it."""
    checkout = await _load(db, tournament_id, checkout_id)
    if checkout is None or checkout.payment is None:
        raise PaymentNotFoundError()
    if checkout.payer_account_id != actor.id and not await user_has_permission(
        db, actor.id, PAYMENTS_VIEW_PERMISSION
    ):
        raise PaymentNotFoundError()
    payment = checkout.payment
    if payment.state not in {
        TournamentPaymentState.succeeded,
        TournamentPaymentState.failed,
        TournamentPaymentState.canceled,
    }:
        try:
            intent = await provider.retrieve_payment_intent(payment.durable_identity)
        except (TimeoutError, PaymentProviderUncertainError):
            pass
        else:
            from app.tournament_payment_reconciliation import reconcile_provider_intent

            payment = await reconcile_provider_intent(
                db, payment_id=payment.id, intent=intent
            )
            await db.commit()
            checkout = await _load(db, tournament_id, checkout_id)
            if checkout is None or checkout.payment is None:
                raise PaymentNotFoundError()
            payment = checkout.payment
    return _read(payment, include_client_secret=False)
