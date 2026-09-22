"""Turn authenticated provider evidence into admission or refund obligations."""

import uuid
from datetime import datetime, timedelta

from pydantic import BaseModel, ConfigDict
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import selectinload

from app.config import get_settings
from app.models import (
    Tournament,
    TournamentCheckout,
    TournamentCheckoutLine,
    TournamentCheckoutStatus,
    TournamentPayment,
    TournamentPaymentAllocation,
    TournamentPaymentLineOutcome,
    TournamentPaymentReceipt,
    TournamentPaymentState,
    TournamentProviderEvent,
    TournamentRefundObligation,
    User,
)
from app.notifications.service import enqueue_notification_job
from app.notifications.taxonomy import NotificationCategory, NotificationChannel
from app.payment_provider import (
    PaymentProvider,
    PaymentProviderNotFoundError,
    PaymentProviderUncertainError,
    ProviderPaymentEvent,
    ProviderPaymentIntent,
    ProviderPaymentStatus,
    StripePaymentProvider,
)
from app.realtime.events import EventKind
from app.realtime.outbox import stage_event
from app.schemas.notification import NotificationJob
from app.tournament_checkouts import _database_now
from app.tournament_entries import admit_to_event
from app.tournament_errors import EntryRefusedError, NonSinglesEntryError
from app.tournament_payment_receipt_outcomes import TournamentReceiptOutcome
from app.tournament_payment_receipts import (
    enqueue_due_tournament_receipts,
    enqueue_tournament_receipt,
)
from app.tournament_payments import (
    provider_create_request_if_authorized,
    public_payment_state,
)


class ProviderPaymentEvidence(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid")

    id: str
    status: ProviderPaymentStatus
    amount_cents: int
    currency: str
    merchant_account_id: str
    livemode: bool
    durable_identity: str


def _evidence(intent: ProviderPaymentIntent) -> ProviderPaymentEvidence:
    return ProviderPaymentEvidence.model_validate(intent)


async def persist_verified_event(
    db: AsyncSession, event: ProviderPaymentEvent
) -> TournamentProviderEvent:
    existing = await db.scalar(
        select(TournamentProviderEvent).where(
            TournamentProviderEvent.provider_event_id == event.id
        )
    )
    if existing is not None:
        return existing
    row = TournamentProviderEvent(
        provider_event_id=event.id,
        event_type=event.type,
        provider_payment_id=event.payment.id,
        evidence_json=_evidence(event.payment).model_dump_json(),
        provider_created_at=event.created_at,
    )
    db.add(row)
    await db.flush()
    return row


async def _refund(
    db: AsyncSession,
    *,
    payment_id: uuid.UUID,
    allocation: TournamentPaymentAllocation | None,
    amount_cents: int,
    reason: str,
) -> None:
    line_id = allocation.checkout_line_id if allocation is not None else None
    existing = await db.scalar(
        select(TournamentRefundObligation).where(
            TournamentRefundObligation.payment_id == payment_id,
            TournamentRefundObligation.checkout_line_id == line_id,
        )
    )
    if existing is None:
        db.add(
            TournamentRefundObligation(
                payment_id=payment_id,
                checkout_line_id=line_id,
                amount_cents=amount_cents,
                reason=reason,
            )
        )


def _matches(
    payment: TournamentPayment,
    checkout: TournamentCheckout,
    intent: ProviderPaymentIntent,
) -> bool:
    settings = get_settings()
    return (
        intent.id == payment.provider_payment_id
        and intent.durable_identity == payment.durable_identity
        and intent.merchant_account_id == str(checkout.merchant_account_id)
        and intent.livemode == settings.stripe_livemode
        and intent.amount_cents == payment.amount_cents
        and intent.currency.upper() == payment.currency
    )


async def _notify_payment_attention(
    db: AsyncSession, payment: TournamentPayment, event: str
) -> None:
    if payment.attention_notified_state == event:
        return
    copy = {
        "checking": (
            "Payment is still being confirmed",
            "We are checking your tournament payment. No action is needed yet.",
        ),
        "provider_mismatch": (
            "Payment needs review",
            f"Contact support with reference {payment.support_reference}.",
        ),
        "refund_pending": (
            "Refund pending",
            "At least one tournament entry could not be confirmed; "
            "its refund is pending.",
        ),
    }[event]
    checkout_facts = (
        await db.execute(
            select(
                TournamentCheckout.payer_account_id,
                TournamentCheckout.tournament_id,
            ).where(TournamentCheckout.id == payment.checkout_id)
        )
    ).one()
    enqueue_notification_job(
        NotificationJob(
            user_id=checkout_facts.payer_account_id,
            category=NotificationCategory.PAYMENTS,
            title=copy[0],
            body=copy[1],
            link=(
                f"/tournaments/{checkout_facts.tournament_id}/checkouts/"
                f"{payment.checkout_id}"
            ),
        )
    )
    payment.attention_notified_state = event


async def _ensure_settlement_outputs(
    db: AsyncSession, payment: TournamentPayment, now: datetime
) -> None:
    """Create the receipt fact and generic confirmation once under payment lock."""
    checkout_facts = (
        await db.execute(
            select(
                TournamentCheckout.payer_account_id,
                TournamentCheckout.tournament_id,
            ).where(TournamentCheckout.id == payment.checkout_id)
        )
    ).one()
    line_rows = list(
        await db.execute(
            select(
                TournamentCheckoutLine.id,
                TournamentCheckoutLine.event_id,
                TournamentCheckoutLine.event_name,
            ).where(TournamentCheckoutLine.checkout_id == payment.checkout_id)
        )
    )
    line_by_id = {
        line_id: (event_id, event_name) for line_id, event_id, event_name in line_rows
    }
    outcomes = sorted(
        [
            TournamentReceiptOutcome(
                event_id=line_by_id[allocation.checkout_line_id][0],
                event_name=line_by_id[allocation.checkout_line_id][1],
                outcome=allocation.outcome.value,
            )
            for allocation in payment.allocations
            if allocation.outcome is not None
        ],
        key=lambda item: item.event_name,
    )
    receipt = await db.scalar(
        select(TournamentPaymentReceipt).where(
            TournamentPaymentReceipt.payment_id == payment.id
        )
    )
    if receipt is None and payment.receipt_email is not None:
        receipt = TournamentPaymentReceipt(
            payment_id=payment.id,
            recipient_email=payment.receipt_email,
            outcomes=[outcome.to_json() for outcome in outcomes],
            created_at=now,
            updated_at=now,
            retry_deadline_at=now + timedelta(hours=24),
        )
        db.add(receipt)
        await db.flush()
        enqueue_tournament_receipt(receipt.id)

    if payment.settlement_notified_at is None:
        payer = await db.get(User, checkout_facts.payer_account_id)
        channels = None
        if (
            payer is not None
            and payer.email
            and payment.receipt_email
            and payer.email.casefold() == payment.receipt_email.casefold()
        ):
            channels = [NotificationChannel.IN_APP, NotificationChannel.PUSH]
        confirmed = sum(item.outcome == "confirmed" for item in outcomes)
        pending = sum(item.outcome == "refund_pending" for item in outcomes)
        body = f"{confirmed} entr{'y' if confirmed == 1 else 'ies'} confirmed."
        if pending:
            body += f" {pending} refund pending."
        enqueue_notification_job(
            NotificationJob(
                user_id=checkout_facts.payer_account_id,
                category=NotificationCategory.TOURNAMENT,
                title="Tournament registration confirmed",
                body=body,
                link=(
                    f"/tournaments/{checkout_facts.tournament_id}/checkouts/"
                    f"{payment.checkout_id}"
                ),
                channels=channels,
            )
        )
        payment.settlement_notified_at = now
    if any(item.outcome == "refund_pending" for item in outcomes):
        await _notify_payment_attention(db, payment, "refund_pending")


async def reconcile_provider_intent(
    db: AsyncSession,
    *,
    payment_id: uuid.UUID,
    intent: ProviderPaymentIntent,
    evidence_at: datetime | None = None,
) -> TournamentPayment:
    """Apply authoritative evidence idempotently; provider I/O happens upstream."""
    initial = await db.scalar(
        select(TournamentPayment)
        .where(TournamentPayment.id == payment_id)
        .options(selectinload(TournamentPayment.checkout))
    )
    if initial is None:
        raise LookupError("payment not found")
    checkout = initial.checkout

    # Match the entry verb's lock order before locking the payment aggregate.
    await db.execute(
        select(User.id)
        .where(User.id == checkout.payer_account_id)
        .with_for_update(read=True)
    )
    await db.execute(
        select(Tournament.id)
        .where(Tournament.id == checkout.tournament_id)
        .with_for_update()
    )
    payment = await db.scalar(
        select(TournamentPayment)
        .where(TournamentPayment.id == payment_id)
        .options(
            selectinload(TournamentPayment.allocations).selectinload(
                TournamentPaymentAllocation.checkout_line
            ),
            selectinload(TournamentPayment.checkout).selectinload(
                TournamentCheckout.lines
            ),
            selectinload(TournamentPayment.checkout).selectinload(
                TournamentCheckout.tournament
            ),
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if payment is None:
        raise LookupError("payment not found")
    checkout = payment.checkout

    if payment.state in {
        TournamentPaymentState.succeeded,
        TournamentPaymentState.failed,
    }:
        if payment.state is TournamentPaymentState.succeeded:
            await _ensure_settlement_outputs(db, payment, await _database_now(db))
        return payment
    if (
        evidence_at is not None
        and payment.provider_evidence_at is not None
        and evidence_at < payment.provider_evidence_at
    ):
        return payment

    payment.provider_status = intent.status
    payment.provider_evidence_at = evidence_at or payment.provider_evidence_at

    # An uncertain create deliberately has no local provider id yet. Durable
    # identity is the recovery association; once it matches, bind the provider
    # id exactly once before applying the full invariant set.
    if (
        payment.provider_payment_id is None
        and intent.durable_identity == payment.durable_identity
    ):
        payment.provider_payment_id = intent.id

    if not _matches(payment, checkout, intent):
        payment.state = TournamentPaymentState.failed
        payment.support_reference = (
            payment.support_reference or f"PAY-{str(payment.id)[:8].upper()}"
        )
        if intent.status == "succeeded" and intent.amount_cents > 0:
            await _refund(
                db,
                payment_id=payment.id,
                allocation=None,
                amount_cents=intent.amount_cents,
                reason="provider_invariant_mismatch",
            )
        stage_event(db, checkout.payer_account_id, EventKind.dashboard_changed)
        await _notify_payment_attention(db, payment, "provider_mismatch")
        return payment

    # Webhooks can be the first authoritative response after an uncertain
    # create. Retain a usable secret when Stripe includes it; when replayed
    # evidence omits it, ready/action-required sweep states force retrieval.
    if intent.client_secret:
        payment.client_secret = intent.client_secret

    if intent.status != "succeeded":
        if checkout.expires_at <= await _database_now(db):
            payment.state = TournamentPaymentState.expired
        else:
            payment.state = public_payment_state(intent.status)
        stage_event(db, checkout.payer_account_id, EventKind.dashboard_changed)
        if payment.state is TournamentPaymentState.checking:
            await _notify_payment_attention(db, payment, "checking")
        return payment

    now = await _database_now(db)
    tournament = checkout.tournament
    checkout_valid = (
        checkout.status is TournamentCheckoutStatus.active
        and checkout.expires_at > now
        and checkout.registration_generation == tournament.registration_generation
        and tournament.registration_open
    )
    payer = await db.get(User, checkout.payer_account_id)
    if payer is None:
        checkout_valid = False

    tournament_id = checkout.tournament_id
    entrant_player_id = checkout.entrant_player_id
    checkout_id = checkout.id
    payer_account_id = checkout.payer_account_id
    payment_id = payment.id
    allocations = list(
        await db.execute(
            select(
                TournamentPaymentAllocation.id,
                TournamentCheckoutLine.event_id,
            )
            .join(
                TournamentCheckoutLine,
                TournamentCheckoutLine.id
                == TournamentPaymentAllocation.checkout_line_id,
            )
            .where(TournamentPaymentAllocation.payment_id == payment_id)
            .order_by(TournamentPaymentAllocation.checkout_line_id)
        )
    )
    for allocation_id, event_id in allocations:
        allocation = await db.get(TournamentPaymentAllocation, allocation_id)
        if allocation is None:
            raise LookupError("payment allocation not found")
        if allocation.outcome is not None:
            continue
        admitted = False
        if checkout_valid and payer is not None:
            try:
                await admit_to_event(
                    db,
                    tournament_id=tournament_id,
                    event_id=event_id,
                    actor=payer,
                    user_id=entrant_player_id,
                    paid_checkout_id=checkout_id,
                )
                admitted = True
            except (EntryRefusedError, NonSinglesEntryError):
                # Admission's savepoint guarantees a refused line did not leak
                # writes. Provider success still has to resolve every allocation.
                pass
        allocation = await db.get(TournamentPaymentAllocation, allocation_id)
        if allocation is None:
            raise LookupError("payment allocation not found")
        if admitted:
            allocation.outcome = TournamentPaymentLineOutcome.confirmed
        else:
            allocation.outcome = TournamentPaymentLineOutcome.refund_pending
            allocation.refund_amount_cents = allocation.amount_cents
            await _refund(
                db,
                payment_id=payment_id,
                allocation=allocation,
                amount_cents=allocation.amount_cents,
                reason="admission_unavailable",
            )

    payment.state = TournamentPaymentState.succeeded
    await _ensure_settlement_outputs(db, payment, now)
    stage_event(db, payer_account_id, EventKind.dashboard_changed)
    return payment


async def process_verified_event(
    db: AsyncSession, event: ProviderPaymentEvent
) -> TournamentProviderEvent:
    row = await persist_verified_event(db, event)
    if row.processed_at is not None:
        return row
    payment = await db.scalar(
        select(TournamentPayment).where(
            or_(
                TournamentPayment.provider_payment_id == event.payment.id,
                TournamentPayment.durable_identity == event.payment.durable_identity,
            )
        )
    )
    if payment is not None:
        await reconcile_provider_intent(
            db,
            payment_id=payment.id,
            intent=event.payment,
            evidence_at=event.created_at,
        )
        row.processed_at = await _database_now(db)
    return row


async def replay_unprocessed_provider_events(db: AsyncSession) -> int:
    """Replay signature-verified events left durable by an interrupted worker."""
    rows = list(
        await db.scalars(
            select(TournamentProviderEvent)
            .where(TournamentProviderEvent.processed_at.is_(None))
            .order_by(TournamentProviderEvent.received_at)
        )
    )
    processed = 0
    for row in rows:
        evidence = ProviderPaymentEvidence.model_validate_json(row.evidence_json)
        payment = await db.scalar(
            select(TournamentPayment).where(
                or_(
                    TournamentPayment.provider_payment_id == row.provider_payment_id,
                    TournamentPayment.durable_identity == evidence.durable_identity,
                )
            )
        )
        if payment is not None:
            await reconcile_provider_intent(
                db,
                payment_id=payment.id,
                intent=ProviderPaymentIntent(
                    id=evidence.id,
                    client_secret="",
                    status=evidence.status,
                    amount_cents=evidence.amount_cents,
                    currency=evidence.currency,
                    merchant_account_id=evidence.merchant_account_id,
                    livemode=evidence.livemode,
                    durable_identity=evidence.durable_identity,
                ),
                evidence_at=row.provider_created_at,
            )
            row.processed_at = await _database_now(db)
            processed += 1
    await db.commit()
    return processed


async def reconcile_stuck_payments(db: AsyncSession, provider: PaymentProvider) -> int:
    """Retrieve provider truth without holding database or capacity locks."""
    obligations = list(
        await db.scalars(
            select(TournamentPayment)
            .where(
                TournamentPayment.state.in_(
                    [
                        TournamentPaymentState.preparing,
                        TournamentPaymentState.ready,
                        TournamentPaymentState.action_required,
                        TournamentPaymentState.checking,
                    ]
                )
            )
            .options(selectinload(TournamentPayment.checkout))
        )
    )
    reconciled = 0
    for payment in obligations:
        try:
            intent = await provider.retrieve_payment_intent(payment.durable_identity)
        except PaymentProviderNotFoundError:
            if payment.provider_payment_id is not None:
                payment.state = TournamentPaymentState.checking
                payment.updated_at = await _database_now(db)
                stage_event(
                    db,
                    payment.checkout.payer_account_id,
                    EventKind.dashboard_changed,
                )
                await db.commit()
                reconciled += 1
                continue
            if not get_settings().tournament_payment_collection_enabled:
                now = await _database_now(db)
                payment.checkout.status = TournamentCheckoutStatus.cancelled
                payment.checkout.cancelled_at = now
                payment.state = TournamentPaymentState.canceled
                payment.updated_at = now
                stage_event(
                    db,
                    payment.checkout.payer_account_id,
                    EventKind.dashboard_changed,
                )
                await db.commit()
                reconciled += 1
                continue
            try:
                create_request = await provider_create_request_if_authorized(
                    db,
                    tournament_id=payment.checkout.tournament_id,
                    checkout_id=payment.checkout_id,
                    payer_account_id=payment.checkout.payer_account_id,
                    payment_id=payment.id,
                )
                if create_request is None:
                    reconciled += 1
                    continue
                intent = await provider.create_payment_intent(create_request)
            except (TimeoutError, PaymentProviderUncertainError):
                continue
        except (TimeoutError, PaymentProviderUncertainError):
            continue
        await reconcile_provider_intent(db, payment_id=payment.id, intent=intent)
        await db.commit()
        reconciled += 1
    return reconciled


async def execute_reconciliation_sweep(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    async with factory() as db:
        await replay_unprocessed_provider_events(db)
        await reconcile_stuck_payments(db, StripePaymentProvider())
        await enqueue_due_tournament_receipts(db)


def run_reconciliation_sweep() -> None:
    """Synchronous RQ/cron entry point for payment recovery."""
    from app.rq_async import run_async_db_job

    run_async_db_job("tournament-payment-reconciliation", execute_reconciliation_sweep)
