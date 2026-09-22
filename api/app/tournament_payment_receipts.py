"""Durable paid-registration confirmations and checkout-email retention."""

from __future__ import annotations

import logging
import smtplib
import uuid
from datetime import UTC, datetime, timedelta
from typing import Protocol

from redis.exceptions import RedisError
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import selectinload

from app import email
from app import queue as queue_module
from app.models import (
    EventLifecycleHistory,
    EventLifecycleState,
    Tournament,
    TournamentCheckout,
    TournamentEvent,
    TournamentPayment,
    TournamentPaymentReceipt,
    TournamentPaymentState,
    TournamentReceiptState,
    TournamentRefundObligation,
    TournamentRefundState,
)
from app.tournament_payment_receipt_outcomes import parse_receipt_outcomes

log = logging.getLogger(__name__)
RETRY_WINDOW = timedelta(hours=24)
PII_RETENTION = timedelta(days=30)
DELIVERY_JOB = "app.tournament_payment_receipts.deliver_tournament_receipt"


class TournamentReceiptSender(Protocol):
    async def send(self, *, to_email: str, subject: str, body: str) -> None: ...


class ReceiptDeliveryError(Exception):
    """An expected delivery refusal with an explicit retry policy."""

    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


class _EmailSender:
    async def send(self, *, to_email: str, subject: str, body: str) -> None:
        try:
            email.send_notification_email(to_email, subject, body)
        except smtplib.SMTPResponseException as exc:
            raise ReceiptDeliveryError(
                str(exc), retryable=400 <= exc.smtp_code < 500
            ) from exc
        except (smtplib.SMTPServerDisconnected, OSError, TimeoutError) as exc:
            raise ReceiptDeliveryError(str(exc), retryable=True) from exc
        except smtplib.SMTPException as exc:
            raise ReceiptDeliveryError(str(exc), retryable=False) from exc


def _copy(receipt: TournamentPaymentReceipt) -> tuple[str, str]:
    lines = ["Your tournament registration", ""]
    for outcome in parse_receipt_outcomes(receipt.outcomes):
        label = (
            "Entry confirmed"
            if outcome.outcome == "confirmed"
            else "Not admitted — refund pending"
        )
        lines.append(f"{outcome.event_name}: {label}")
    lines += ["", "You can return to FortyMM for the latest status."]
    return "FortyMM tournament registration", "\n".join(lines)


def enqueue_tournament_receipt(
    receipt_id: uuid.UUID, *, delay: timedelta | None = None
) -> bool:
    """Queue only the durable id; addresses and copy are loaded in the worker."""
    queue = queue_module.get_email_queue()
    # A receipt is specifically an asynchronous side effect. Inline queues are
    # used by local/test auth-email flows and would move external I/O back inside
    # the payment settlement request.
    if not getattr(queue, "is_async", getattr(queue, "_is_async", True)):
        return False
    try:
        if delay is None:
            queue.enqueue(
                DELIVERY_JOB,
                str(receipt_id),
                result_ttl=60,
                failure_ttl=86400,
            )
        else:
            queue.enqueue_in(
                delay,
                DELIVERY_JOB,
                str(receipt_id),
                result_ttl=60,
                failure_ttl=86400,
            )
    except (RedisError, OSError, TimeoutError):
        log.exception(
            "Failed to enqueue tournament receipt",
            extra={"receipt_id": str(receipt_id)},
        )
        return False
    return True


async def enqueue_due_tournament_receipts(
    db: AsyncSession, *, now: datetime | None = None
) -> int:
    """Recover queue loss/races from durable receipt facts.

    Duplicate jobs are safe: delivery locks the row and terminal states no-op.
    This scan is run by the minute payment reconciliation job, so a queue
    failure or a worker that races the settlement commit cannot strand mail.
    """
    now = now or datetime.now(UTC)
    ids = list(
        await db.scalars(
            select(TournamentPaymentReceipt.id).where(
                TournamentPaymentReceipt.recipient_email.is_not(None),
                or_(
                    TournamentPaymentReceipt.state == TournamentReceiptState.pending,
                    (
                        TournamentPaymentReceipt.state
                        == TournamentReceiptState.retry_scheduled
                    )
                    & (TournamentPaymentReceipt.next_attempt_at <= now),
                ),
            )
        )
    )
    return sum(enqueue_tournament_receipt(receipt_id) for receipt_id in ids)


async def attempt_tournament_receipt_delivery(
    db: AsyncSession,
    receipt_id: uuid.UUID,
    *,
    sender: TournamentReceiptSender,
    now: datetime | None = None,
) -> TournamentPaymentReceipt:
    now = now or datetime.now(UTC)
    receipt = await db.scalar(
        select(TournamentPaymentReceipt)
        .where(TournamentPaymentReceipt.id == receipt_id)
        .with_for_update()
    )
    if receipt is None:
        raise LookupError("tournament payment receipt not found")
    if receipt.state in {
        TournamentReceiptState.sent,
        TournamentReceiptState.failed,
        TournamentReceiptState.canceled,
    }:
        return receipt
    if receipt.recipient_email is None:
        receipt.state = TournamentReceiptState.canceled
        receipt.updated_at = now
        return receipt
    if now >= receipt.retry_deadline_at:
        receipt.state = TournamentReceiptState.failed
        receipt.failed_at = now
        receipt.failure_kind = "retry_exhausted"
        receipt.support_reference = (
            receipt.support_reference or f"PAY-{str(receipt.id)[:8].upper()}"
        )
        receipt.next_attempt_at = None
        receipt.updated_at = now
        return receipt

    subject, body = _copy(receipt)
    receipt.attempt_count += 1
    try:
        await sender.send(to_email=receipt.recipient_email, subject=subject, body=body)
    except ReceiptDeliveryError as exc:
        retryable = exc.retryable
        if retryable and now < receipt.retry_deadline_at:
            minutes = min(60, 5 * (2 ** min(receipt.attempt_count - 1, 4)))
            receipt.next_attempt_at = min(
                now + timedelta(minutes=minutes), receipt.retry_deadline_at
            )
            receipt.state = TournamentReceiptState.retry_scheduled
        else:
            receipt.state = TournamentReceiptState.failed
            receipt.failed_at = now
            receipt.failure_kind = (
                "retry_exhausted" if retryable else "permanent_delivery_failure"
            )
            receipt.support_reference = (
                receipt.support_reference or f"PAY-{str(receipt.id)[:8].upper()}"
            )
            receipt.next_attempt_at = None
        receipt.updated_at = now
        return receipt

    receipt.state = TournamentReceiptState.sent
    receipt.sent_at = now
    receipt.next_attempt_at = None
    receipt.updated_at = now
    return receipt


async def _deliver(
    factory: async_sessionmaker[AsyncSession], receipt_id: uuid.UUID
) -> None:
    async with factory() as db:
        receipt = await attempt_tournament_receipt_delivery(
            db, receipt_id, sender=_EmailSender()
        )
        next_attempt = receipt.next_attempt_at
        await db.commit()
        if receipt.state is TournamentReceiptState.retry_scheduled and next_attempt:
            delay = max(next_attempt - datetime.now(UTC), timedelta())
            enqueue_tournament_receipt(receipt.id, delay=delay)


def deliver_tournament_receipt(receipt_id: str) -> None:
    from app.rq_async import run_async_db_job

    parsed = uuid.UUID(receipt_id)
    run_async_db_job(
        "tournament-payment-receipt", lambda factory: _deliver(factory, parsed)
    )


async def erase_tournament_receipt_pii_for_account(
    db: AsyncSession, account_id: uuid.UUID, *, now: datetime | None = None
) -> int:
    now = now or datetime.now(UTC)
    payments = list(
        await db.scalars(
            select(TournamentPayment)
            .join(
                TournamentCheckout,
                TournamentCheckout.id == TournamentPayment.checkout_id,
            )
            .where(TournamentCheckout.payer_account_id == account_id)
        )
    )
    changed = 0
    for payment in payments:
        if payment.receipt_email is not None:
            payment.receipt_email = None
            changed += 1
        receipt = await db.scalar(
            select(TournamentPaymentReceipt).where(
                TournamentPaymentReceipt.payment_id == payment.id
            )
        )
        if receipt is not None and receipt.recipient_email is not None:
            receipt.recipient_email = None
            receipt.pii_erased_at = now
            if receipt.state not in {
                TournamentReceiptState.sent,
                TournamentReceiptState.failed,
            }:
                receipt.state = TournamentReceiptState.canceled
            receipt.next_attempt_at = None
            receipt.updated_at = now
    return changed


async def sweep_tournament_receipt_pii(
    db: AsyncSession, *, now: datetime | None = None
) -> int:
    """Erase checkout-only addresses after lifecycle and money are both quiet."""
    now = now or datetime.now(UTC)
    payments = list(
        await db.scalars(
            select(TournamentPayment)
            .outerjoin(TournamentPayment.receipt)
            .where(
                or_(
                    TournamentPayment.receipt_email.is_not(None),
                    TournamentPaymentReceipt.recipient_email.is_not(None),
                )
            )
            .options(selectinload(TournamentPayment.receipt))
        )
    )
    erased = 0
    for payment in payments:
        receipt = payment.receipt
        checkout = await db.get(TournamentCheckout, payment.checkout_id)
        if checkout is None:
            continue
        tournament = await db.get(Tournament, checkout.tournament_id)
        if tournament is None:
            continue
        milestones = [
            milestone
            for milestone in [tournament.archive_observed_at]
            if milestone is not None
        ]
        if tournament is not None:
            event_lifecycle = (
                await db.execute(
                    select(
                        func.count(TournamentEvent.id),
                        func.count(TournamentEvent.id).filter(
                            TournamentEvent.lifecycle_state.not_in(
                                [
                                    EventLifecycleState.finished,
                                    EventLifecycleState.cancelled,
                                ]
                            )
                        ),
                        func.max(EventLifecycleHistory.observed_at),
                    )
                    .outerjoin(
                        EventLifecycleHistory,
                        (EventLifecycleHistory.event_id == TournamentEvent.id)
                        & (
                            EventLifecycleHistory.version
                            == TournamentEvent.lifecycle_version
                        ),
                    )
                    .where(TournamentEvent.tournament_id == tournament.id)
                )
            ).one()
            event_count, nonterminal_count, completion_observed_at = event_lifecycle
            if (
                event_count > 0
                and nonterminal_count == 0
                and completion_observed_at is not None
            ):
                milestones.append(completion_observed_at)
        if not milestones:
            continue
        lifecycle_at = min(milestones)
        if payment.state not in {
            TournamentPaymentState.succeeded,
            TournamentPaymentState.failed,
            TournamentPaymentState.expired,
            TournamentPaymentState.canceled,
        }:
            continue
        refunds = list(
            await db.scalars(
                select(TournamentRefundObligation).where(
                    TournamentRefundObligation.payment_id == payment.id
                )
            )
        )
        if any(
            refund.state is not TournamentRefundState.resolved for refund in refunds
        ):
            continue
        financial_at = max(
            (
                refund.resolved_at
                for refund in refunds
                if refund.resolved_at is not None
            ),
            default=lifecycle_at,
        )
        eligible_at = max(lifecycle_at, financial_at) + PII_RETENTION
        if now < eligible_at:
            continue
        if receipt is not None and receipt.recipient_email is not None:
            receipt.recipient_email = None
            receipt.pii_erased_at = now
            receipt.next_attempt_at = None
            if receipt.state in {
                TournamentReceiptState.pending,
                TournamentReceiptState.retry_scheduled,
            }:
                receipt.state = TournamentReceiptState.canceled
        payment.receipt_email = None
        erased += 1
    if erased:
        await db.flush()
    return erased


async def execute_receipt_pii_sweep(
    factory: async_sessionmaker[AsyncSession],
) -> None:
    async with factory() as db:
        await sweep_tournament_receipt_pii(db)
        await db.commit()


def run_receipt_pii_sweep() -> None:
    from app.rq_async import run_async_db_job

    run_async_db_job("tournament-receipt-pii-sweep", execute_receipt_pii_sweep)
