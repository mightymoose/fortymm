"""Turn authenticated provider evidence into admission or refund obligations."""

import uuid
from datetime import datetime, timedelta

from pydantic import BaseModel, ConfigDict
from sqlalchemy import and_, or_, select
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
    PaymentProviderCancellationRejectedError,
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
    IN_FLIGHT_CREATE_PROVIDER_STATUS,
    UNCERTAIN_CREATE_PROVIDER_STATUS,
    PaymentNotFoundError,
    _sync_provider_receipt,
    _terminalize_stale_checkout,
    provider_create_request_if_authorized,
    public_payment_state,
    reload_payment_for_reconciliation_locked,
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


def _matches_unbound_payment(
    payment: TournamentPayment,
    checkout: TournamentCheckout,
    intent: ProviderPaymentIntent,
) -> bool:
    """Validate recovery association before adopting a provider identity."""
    settings = get_settings()
    return (
        intent.durable_identity == payment.durable_identity
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
    enqueued = enqueue_notification_job(
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
    if enqueued:
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
        if confirmed and pending:
            title = "Tournament registration partially confirmed"
            body = f"{confirmed} entr{'y' if confirmed == 1 else 'ies'} confirmed."
            body += f" {pending} refund pending."
        elif pending:
            title = "Tournament registration refund pending"
            body = (
                "Your tournament registration could not be confirmed. "
                f"{pending} refund{'s' if pending != 1 else ''} pending."
            )
        else:
            title = "Tournament registration confirmed"
            body = f"{confirmed} entr{'y' if confirmed == 1 else 'ies'} confirmed."
        enqueued = enqueue_notification_job(
            NotificationJob(
                user_id=checkout_facts.payer_account_id,
                category=NotificationCategory.TOURNAMENT,
                title=title,
                body=body,
                link=(
                    f"/tournaments/{checkout_facts.tournament_id}/checkouts/"
                    f"{payment.checkout_id}"
                ),
                channels=channels,
            )
        )
        if enqueued:
            payment.settlement_notified_at = now
    if any(item.outcome == "refund_pending" for item in outcomes):
        await _notify_payment_attention(db, payment, "refund_pending")


async def retry_terminal_payment_outputs(
    db: AsyncSession, *, payment_id: uuid.UUID
) -> TournamentPayment:
    """Retry durable local outputs for a settled payment without provider I/O."""
    payment = await db.scalar(
        select(TournamentPayment)
        .where(TournamentPayment.id == payment_id)
        .options(selectinload(TournamentPayment.allocations))
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if payment is None:
        raise LookupError("payment not found")
    if payment.state is TournamentPaymentState.succeeded:
        await _ensure_settlement_outputs(db, payment, await _database_now(db))
    elif (
        payment.state is TournamentPaymentState.failed
        and payment.attention_notified_state != "provider_mismatch"
    ):
        # A terminal mismatch has no more provider transitions to wake the
        # notifier. Read and sweep seams therefore retry its durable alert.
        await _notify_payment_attention(db, payment, "provider_mismatch")
    return payment


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
    payer = await db.scalar(
        select(User)
        .where(User.id == checkout.payer_account_id)
        .with_for_update(read=True)
        .execution_options(populate_existing=True)
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

    provider_confirmed_terminal = payment.state in {
        TournamentPaymentState.succeeded,
        TournamentPaymentState.failed,
    } or (
        payment.state is TournamentPaymentState.canceled
        and payment.provider_payment_id is not None
    )
    if provider_confirmed_terminal:
        if payment.state is TournamentPaymentState.succeeded:
            await _ensure_settlement_outputs(db, payment, await _database_now(db))
        return payment

    # Evidence ordering applies before *any* mutation, including quarantine
    # state and notifications for a foreign provider id. An older event cannot
    # supersede a newer authoritative observation merely because its id is
    # unexpected.
    if (
        evidence_at is not None
        and payment.provider_evidence_at is not None
        and evidence_at < payment.provider_evidence_at
    ):
        return payment

    # Durable-identity lookup is not sufficient evidence that a returned
    # object is the provider object already bound to this payment. Quarantine
    # a foreign id before copying any of its status/evidence, terminalizing the
    # aggregate, or creating a refund for money belonging to another intent.
    # Keeping the aggregate in ``checking`` lets a later sweep retrieve and
    # settle the real bound intent.
    if (
        payment.provider_payment_id is not None
        and intent.id != payment.provider_payment_id
    ):
        if evidence_at is not None:
            payment.provider_evidence_at = evidence_at
        payment.state = TournamentPaymentState.checking
        payment.support_reference = (
            payment.support_reference or f"PAY-{str(payment.id)[:8].upper()}"
        )
        stage_event(db, checkout.payer_account_id, EventKind.dashboard_changed)
        await _notify_payment_attention(db, payment, "provider_mismatch")
        return payment

    # An uncertain create has no provider id to authenticate a lookup result.
    # Validate every immutable association field before adopting that id or
    # copying provider status/secret. In particular, a successful object with
    # only the same metadata key is not evidence that this payment owns its
    # funds, so it must not create a refund obligation either.
    if payment.provider_payment_id is None and not _matches_unbound_payment(
        payment, checkout, intent
    ):
        if evidence_at is not None:
            payment.provider_evidence_at = evidence_at
        payment.support_reference = (
            payment.support_reference or f"PAY-{str(payment.id)[:8].upper()}"
        )
        stage_event(db, checkout.payer_account_id, EventKind.dashboard_changed)
        await _notify_payment_attention(db, payment, "provider_mismatch")
        return payment

    payment.provider_status = intent.status
    payment.provider_evidence_at = evidence_at or payment.provider_evidence_at

    # The complete association check above authorizes this write-once binding.
    if payment.provider_payment_id is None:
        payment.provider_payment_id = intent.id

    if not _matches(payment, checkout, intent):
        payment.state = (
            TournamentPaymentState.failed
            if intent.status
            in {
                ProviderPaymentStatus.succeeded,
                ProviderPaymentStatus.canceled,
            }
            else TournamentPaymentState.checking
        )
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
        provider_state = public_payment_state(intent.status)
        # Once an intent exists, every remotely mutable provider state must
        # remain in the sweep. Expiry removes admission authority, not the need
        # to observe a late capture and refund it.
        payment.state = provider_state
        if provider_state is TournamentPaymentState.canceled:
            # A provider-confirmed cancellation will never issue a receipt.
            # Discharge any uncertain pre-cancellation receipt update locally
            # instead of calling the provider again for a terminal intent, and
            # erase the now-useless payer capability from durable storage.
            payment.receipt_sync_pending = False
            payment.client_secret = None
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
        and checkout.merchant_account_id == tournament.owner_account_id
        and tournament.registration_open
    )
    if payer is None or not payer.is_active or payer.merged_into_user_id is not None:
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
                or_(
                    TournamentPayment.state.in_(
                        [
                            TournamentPaymentState.preparing,
                            TournamentPaymentState.ready,
                            TournamentPaymentState.action_required,
                            TournamentPaymentState.checking,
                        ]
                    ),
                    and_(
                        TournamentPayment.state == TournamentPaymentState.expired,
                        TournamentPayment.provider_payment_id.is_not(None),
                    ),
                    # A create can be accepted remotely while a concurrent
                    # request materializes local expiry/cancellation.  The
                    # pre-I/O marker keeps that unbound aggregate discoverable.
                    and_(
                        TournamentPayment.provider_payment_id.is_(None),
                        TournamentPayment.provider_status
                        == IN_FLIGHT_CREATE_PROVIDER_STATUS,
                    ),
                    and_(
                        TournamentPayment.state == TournamentPaymentState.succeeded,
                        or_(
                            TournamentPayment.receipt_sync_pending.is_(True),
                            TournamentPayment.settlement_notified_at.is_(None),
                            and_(
                                TournamentPayment.attention_notified_state.is_distinct_from(
                                    "refund_pending"
                                ),
                                TournamentPayment.allocations.any(
                                    TournamentPaymentAllocation.outcome
                                    == TournamentPaymentLineOutcome.refund_pending
                                ),
                            ),
                        ),
                    ),
                    and_(
                        TournamentPayment.state == TournamentPaymentState.failed,
                        or_(
                            TournamentPayment.receipt_sync_pending.is_(True),
                            TournamentPayment.attention_notified_state.is_distinct_from(
                                "provider_mismatch"
                            ),
                        ),
                    ),
                )
            )
            .options(
                selectinload(TournamentPayment.checkout).selectinload(
                    TournamentCheckout.tournament
                )
            )
            .order_by(TournamentPayment.created_at, TournamentPayment.id)
        )
    )
    reconciled = 0
    for payment in obligations:
        payment_id = payment.id
        checkout_id = payment.checkout_id
        tournament_id = payment.checkout.tournament_id
        payer_account_id = payment.checkout.payer_account_id
        if payment.state in {
            TournamentPaymentState.succeeded,
            TournamentPaymentState.failed,
        }:
            if (
                payment.receipt_sync_pending
                and payment.provider_payment_id is not None
            ):
                await _sync_provider_receipt(
                    db,
                    provider=provider,
                    payment_id=payment_id,
                    provider_payment_id=payment.provider_payment_id,
                    attempted_email=payment.receipt_email,
                )
            await retry_terminal_payment_outputs(db, payment_id=payment_id)
            await db.commit()
            reconciled += 1
            continue
        try:
            intent = await provider.retrieve_payment_intent(payment.durable_identity)
        except PaymentProviderNotFoundError:
            try:
                payment, payer = await reload_payment_for_reconciliation_locked(
                    db,
                    tournament_id=tournament_id,
                    checkout_id=checkout_id,
                    payer_account_id=payer_account_id,
                    payment_id=payment_id,
                )
            except PaymentNotFoundError:
                # A concurrently removed aggregate cannot be recovered, but it
                # must not prevent later independent obligations from running.
                continue
            if payment.state in {
                TournamentPaymentState.succeeded,
                TournamentPaymentState.failed,
                TournamentPaymentState.canceled,
            }:
                await retry_terminal_payment_outputs(db, payment_id=payment_id)
                await db.commit()
                reconciled += 1
                continue
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
            if payment.attention_notified_state == "provider_mismatch":
                # Mismatched evidence against an unbound uncertain create is
                # intentionally quarantined. NotFound may be metadata lag and
                # cannot safely turn that obligation into local cancellation.
                await db.commit()
                reconciled += 1
                continue
            checkout = payment.checkout
            stale_payment = (
                None
                if payment.provider_status == UNCERTAIN_CREATE_PROVIDER_STATUS
                else payment
            )
            if await _terminalize_stale_checkout(db, checkout, stale_payment):
                reconciled += 1
                continue
            payer_can_recreate = (
                payer is not None
                and payer.is_active
                and payer.merged_into_user_id is None
                and checkout.status is TournamentCheckoutStatus.active
                and checkout.expires_at > await _database_now(db)
                and checkout.registration_generation
                == checkout.tournament.registration_generation
                and checkout.merchant_account_id == checkout.tournament.owner_account_id
                and checkout.tournament.registration_open
            )
            if not payer_can_recreate:
                # Metadata NotFound is not proof that an uncertain create did
                # not land. Once payer authority is gone, retain the recovery
                # obligation without issuing a new provider create.
                await db.commit()
                reconciled += 1
                continue
            if not get_settings().tournament_payment_collection_enabled:
                now = await _database_now(db)
                payment.checkout.status = TournamentCheckoutStatus.cancelled
                payment.checkout.cancelled_at = now
                if payment.provider_status != UNCERTAIN_CREATE_PROVIDER_STATUS:
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
                    tournament_id=tournament_id,
                    checkout_id=checkout_id,
                    payer_account_id=payer_account_id,
                    payment_id=payment_id,
                )
                if create_request is None:
                    reconciled += 1
                    continue
                intent = await provider.create_payment_intent(create_request)
            except (TimeoutError, PaymentProviderUncertainError):
                continue
        except (TimeoutError, PaymentProviderUncertainError):
            continue
        # Provider I/O runs without locks. Reacquire the lifecycle-aware lock
        # order before deciding whether a still-chargeable intent is safe. This
        # path deliberately loads inactive/erased/merged payers: those accounts
        # no longer have authority, but their durable provider work still does.
        try:
            payment, payer = await reload_payment_for_reconciliation_locked(
                db,
                tournament_id=tournament_id,
                checkout_id=checkout_id,
                payer_account_id=payer_account_id,
                payment_id=payment_id,
            )
        except PaymentNotFoundError:
            continue
        checkout = payment.checkout
        authority_lost = not (
            payer is not None
            and payer.is_active
            and payer.merged_into_user_id is None
            and checkout.status is TournamentCheckoutStatus.active
            and checkout.expires_at > await _database_now(db)
            and checkout.registration_generation
            == checkout.tournament.registration_generation
            and checkout.merchant_account_id == checkout.tournament.owner_account_id
            and checkout.tournament.registration_open
        )
        if (
            authority_lost
            and intent.id == payment.provider_payment_id
            and intent.status
            in {
                ProviderPaymentStatus.requires_payment_method,
                ProviderPaymentStatus.requires_confirmation,
                ProviderPaymentStatus.requires_action,
                ProviderPaymentStatus.requires_capture,
            }
        ):
            # The locked read above is the authorization point for attempting
            # cancellation.  No additional local mutation is required to make
            # that decision durable: the existing nonterminal payment remains
            # a reconciliation obligation if this process exits here.  End the
            # transaction before provider I/O so payer/tournament/checkout/
            # payment lifecycle changes are never blocked on the network.
            cancellation_provider_id = intent.id
            cancellation_durable_identity = payment.durable_identity
            await db.commit()
            try:
                intent = await provider.cancel_payment_intent(
                    cancellation_provider_id
                )
            except PaymentProviderCancellationRejectedError:
                try:
                    intent = await provider.retrieve_payment_intent(
                        cancellation_durable_identity
                    )
                except (
                    PaymentProviderNotFoundError,
                    TimeoutError,
                    PaymentProviderUncertainError,
                ):
                    # The next sweep retries this obligation; a race on one
                    # payment must not abort processing later obligations.
                    continue
            except (TimeoutError, PaymentProviderUncertainError):
                # Cancellation may have succeeded remotely. Keep the local
                # obligation sweepable until retrieval confirms the outcome.
                continue

            # Provider evidence can race every lifecycle transition.  Rebuild
            # the lock set and re-read the aggregate before applying it.  In
            # particular, never let a response for the formerly bound intent
            # mutate a payment that was concurrently rebound or terminalized.
            try:
                payment, payer = await reload_payment_for_reconciliation_locked(
                    db,
                    tournament_id=tournament_id,
                    checkout_id=checkout_id,
                    payer_account_id=payer_account_id,
                    payment_id=payment_id,
                )
            except PaymentNotFoundError:
                continue
            checkout = payment.checkout
            authority_lost = not (
                payer is not None
                and payer.is_active
                and payer.merged_into_user_id is None
                and checkout.status is TournamentCheckoutStatus.active
                and checkout.expires_at > await _database_now(db)
                and checkout.registration_generation
                == checkout.tournament.registration_generation
                and checkout.merchant_account_id
                == checkout.tournament.owner_account_id
                and checkout.tournament.registration_open
            )
            if payment.state in {
                TournamentPaymentState.succeeded,
                TournamentPaymentState.failed,
                TournamentPaymentState.canceled,
            }:
                await retry_terminal_payment_outputs(db, payment_id=payment_id)
                await db.commit()
                reconciled += 1
                continue
            if payment.provider_payment_id != cancellation_provider_id:
                await db.commit()
                continue
            if (
                not authority_lost
                and intent.status
                in {
                    ProviderPaymentStatus.requires_payment_method,
                    ProviderPaymentStatus.requires_confirmation,
                    ProviderPaymentStatus.requires_action,
                    ProviderPaymentStatus.requires_capture,
                }
            ):
                # Authority was restored while the cancellation request was in
                # flight and the provider did not terminalize the intent.  Do
                # not apply a response obtained under the stale cancellation
                # decision; the next sweep retrieves it normally.
                await db.commit()
                continue
        payment = await reconcile_provider_intent(
            db, payment_id=payment.id, intent=intent
        )
        if payment.receipt_sync_pending and payment.provider_payment_id is not None:
            await db.commit()
            payment = await _sync_provider_receipt(
                db,
                provider=provider,
                payment_id=payment.id,
                provider_payment_id=payment.provider_payment_id,
                attempted_email=payment.receipt_email,
            )
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
