"""Durable paid-entry confirmations, receipt PII, and payment problems.

These tests deliberately use two public seams only:

* verified Stripe settlement (the existing webhook seam), and
* the receipt worker/sweeper entry points that operate on durable delivery IDs.

The email sender is the external boundary.  Admission, persistence, notification
preferences, and identity lifecycle all remain real.
"""

import importlib
import json
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.identity_lifecycle import erase_account
from app.main import app as fastapi_app
from app.models import (
    EventLifecycleHistory,
    EventLifecycleState,
    NotificationPreference,
    TournamentEntry,
    TournamentPayment,
    TournamentPaymentReceipt,
    TournamentReceiptState,
    TournamentRefundObligation,
    TournamentRefundState,
    TournamentStatus,
)
from app.notifications.service import NotificationService
from app.notifications.taxonomy import NotificationCategory, NotificationChannel
from app.schemas.notification import NotificationJob
from app.sessions import get_current_user
from tests._helpers import (
    CSRF_EVENT_HOOKS,
    FakeSender,
    enqueued_notification_jobs,
    make_user,
)
from tests.test_tournament_payment_reconciliation import (
    FakePaymentProvider,
    _entry_facts,
    _prepared_checkout,
    _webhook,
)


class TransientEmailFailure(Exception):
    """The sender could not establish whether delivery can succeed later."""

    retryable = True


class PermanentEmailFailure(Exception):
    """The destination is permanently unavailable."""

    retryable = False


class RecordingReceiptSender:
    def __init__(self, failures: list[Exception] | None = None) -> None:
        self.failures = list(failures or [])
        self.sent: list[dict[str, str]] = []

    async def send(self, *, to_email: str, subject: str, body: str) -> None:
        if self.failures:
            failure = self.failures.pop(0)
            raise _receipt_service().ReceiptDeliveryError(
                str(failure), retryable=bool(getattr(failure, "retryable", False))
            )
        self.sent.append({"to_email": to_email, "subject": subject, "body": body})


def _receipt_service() -> Any:
    """Resolve the public worker module lazily so collection identifies models first."""
    return importlib.import_module("app.tournament_payment_receipts")


async def _settled_checkout(
    api_client: AsyncClient,
    db: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    *,
    receipt_email: str | None,
    mixed: bool = False,
    previous_receipt_email: str | None = None,
) -> tuple[Any, Any, list[Any], dict[str, Any], TournamentPaymentReceipt | None]:
    provider = FakePaymentProvider()
    capacities = (1, 1) if mixed else None
    fees = ("10.00", "20.00") if mixed else ("12.34",)
    payer, tournament, events, checkout = await _prepared_checkout(
        api_client,
        db,
        monkeypatch,
        provider,
        fees=tuple(Decimal(value) for value in fees),
        capacities=capacities,
    )
    payer.email = "Payer@Example.com"
    payer.confirmed_at = datetime.now(UTC)
    if mixed:
        other = await make_user(db, f"receipt-capacity-{uuid.uuid4().hex[:8]}")
        db.add(TournamentEntry(event_id=events[1].id, user_id=other.player_id))
    await db.commit()

    payment_url = f"/v1/tournaments/{tournament.id}/checkouts/{checkout['id']}/payment"
    if previous_receipt_email is not None:
        previous = await api_client.post(
            payment_url, json={"receipt_email": previous_receipt_email}
        )
        assert previous.status_code == 200, previous.text
    edited = await api_client.post(payment_url, json={"receipt_email": receipt_email})
    assert edited.status_code == 200, edited.text
    settled = await _webhook(
        api_client,
        provider.event(f"evt_receipt_{uuid.uuid4().hex}"),
        "test-valid-signature",
    )
    assert settled.status_code == 200, settled.text
    payment = await db.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    receipt = await db.scalar(
        select(TournamentPaymentReceipt).where(
            TournamentPaymentReceipt.payment_id == payment.id
        )
    )
    return payer, tournament, events, checkout, receipt


async def test_settlement_creates_one_itemized_receipt_obligation_atomically(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payer, _, events, _, receipt = await _settled_checkout(
        api_client,
        db_session,
        monkeypatch,
        receipt_email="confirmations@example.net",
        mixed=True,
    )

    assert receipt is not None
    assert receipt.recipient_email == "confirmations@example.net"
    assert receipt.state is TournamentReceiptState.pending
    assert receipt.retry_deadline_at == receipt.created_at + timedelta(hours=24)
    assert receipt.outcomes == [
        {
            "event_id": str(events[0].id),
            "event_name": events[0].name,
            "outcome": "confirmed",
        },
        {
            "event_id": str(events[1].id),
            "event_name": events[1].name,
            "outcome": "refund_pending",
        },
    ]
    assert "amount_cents" not in json.dumps(receipt.outcomes)
    assert await _entry_facts(db_session, payer) == ([events[0].id], 1)
    assert (
        await db_session.scalar(
            select(func.count(TournamentPaymentReceipt.id)).where(
                TournamentPaymentReceipt.payment_id == receipt.payment_id
            )
        )
        == 1
    )


async def test_settlement_without_receipt_destination_creates_no_email_work(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, _, _, _, receipt = await _settled_checkout(
        api_client, db_session, monkeypatch, receipt_email=None
    )

    assert receipt is None


async def test_transient_receipt_failure_retries_without_changing_money_or_admission(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payer, _, events, checkout, receipt = await _settled_checkout(
        api_client,
        db_session,
        monkeypatch,
        receipt_email="retry@example.net",
    )
    assert receipt is not None
    first_attempt = receipt.created_at + timedelta(minutes=1)
    sender = RecordingReceiptSender([TransientEmailFailure("smtp timeout")])

    result = await _receipt_service().attempt_tournament_receipt_delivery(
        db_session, receipt.id, sender=sender, now=first_attempt
    )
    await db_session.commit()

    assert result.state is TournamentReceiptState.retry_scheduled
    assert first_attempt < result.next_attempt_at <= first_attempt + timedelta(hours=1)
    assert result.next_attempt_at <= result.retry_deadline_at
    assert await _entry_facts(db_session, payer) == ([events[0].id], 1)
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None and payment.state.value == "succeeded"

    sent = await _receipt_service().attempt_tournament_receipt_delivery(
        db_session, receipt.id, sender=sender, now=result.next_attempt_at
    )
    assert sent.state is TournamentReceiptState.sent
    assert sender.sent[0]["to_email"] == "retry@example.net"
    assert events[0].name in sender.sent[0]["body"]
    assert "Entry confirmed" in sender.sent[0]["body"]


@pytest.mark.parametrize(
    ("failure", "attempt_at"),
    [
        (PermanentEmailFailure("mailbox rejected"), None),
        (TransientEmailFailure("still unavailable"), "after_deadline"),
    ],
)
async def test_permanent_or_exhausted_receipt_failure_is_operator_visible(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    failure: Exception,
    attempt_at: str | None,
) -> None:
    payer, tournament, events, checkout, receipt = await _settled_checkout(
        api_client,
        db_session,
        monkeypatch,
        receipt_email="undeliverable@example.net",
    )
    assert receipt is not None
    now = (
        receipt.retry_deadline_at + timedelta(seconds=1)
        if attempt_at == "after_deadline"
        else receipt.created_at + timedelta(minutes=1)
    )

    failed = await _receipt_service().attempt_tournament_receipt_delivery(
        db_session,
        receipt.id,
        sender=RecordingReceiptSender([failure]),
        now=now,
    )
    await db_session.commit()

    assert failed.state is TournamentReceiptState.failed
    assert failed.support_reference
    assert await _entry_facts(db_session, payer) == ([events[0].id], 1)
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None and payment.state.value == "succeeded"

    fastapi_app.dependency_overrides[get_current_user] = lambda: payer
    try:
        payer_read = await api_client.get(
            f"/v1/tournaments/{tournament.id}/payment-problems"
        )
    finally:
        fastapi_app.dependency_overrides.pop(get_current_user, None)
    assert payer_read.status_code == 403
    owner = await db_session.get(type(payer), tournament.owner_account_id)
    assert owner is not None
    fastapi_app.dependency_overrides[get_current_user] = lambda: owner
    try:
        owner_read = await api_client.get(
            f"/v1/tournaments/{tournament.id}/payment-problems"
        )
    finally:
        fastapi_app.dependency_overrides.pop(get_current_user, None)
    assert owner_read.status_code == 200, owner_read.text
    assert failed.support_reference in {
        item["support_reference"] for item in owner_read.json()["items"]
    }


async def test_receipt_delivery_does_not_start_after_retry_window_closes(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, _, _, _, receipt = await _settled_checkout(
        api_client,
        db_session,
        monkeypatch,
        receipt_email="too-late@example.net",
    )
    assert receipt is not None
    sender = RecordingReceiptSender()

    result = await _receipt_service().attempt_tournament_receipt_delivery(
        db_session,
        receipt.id,
        sender=sender,
        now=receipt.retry_deadline_at + timedelta(seconds=1),
    )

    assert result.state is TournamentReceiptState.failed
    assert sender.sent == []


@pytest.mark.parametrize(
    ("receipt_email", "expected_channels", "expected_emailed"),
    [
        (
            "PAYER@example.COM",
            {NotificationChannel.IN_APP, NotificationChannel.PUSH},
            False,
        ),
        ("receipts@example.net", None, True),
    ],
)
async def test_registration_confirmation_uses_preferences_and_deduplicates_email(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    fake_notifications_queue,
    receipt_email: str,
    expected_channels: set[NotificationChannel] | None,
    expected_emailed: bool,
) -> None:
    payer, _, _, _, receipt = await _settled_checkout(
        api_client,
        db_session,
        monkeypatch,
        receipt_email=receipt_email,
    )
    assert receipt is not None
    jobs = enqueued_notification_jobs(fake_notifications_queue)
    registration = [j for j in jobs if j.category is NotificationCategory.TOURNAMENT]
    assert len(registration) == 1
    if expected_channels is None:
        assert registration[0].channels is None
    else:
        assert set(registration[0].channels or []) == expected_channels

    db_session.add(
        NotificationPreference(
            user_id=payer.id,
            category=NotificationCategory.TOURNAMENT.value,
            channel=NotificationChannel.PUSH.value,
            enabled=False,
        )
    )
    await db_session.commit()
    delivered = await NotificationService(db_session, FakeSender()).notify(
        **registration[0].model_dump()
    )
    assert delivered.in_app_created is True
    assert delivered.pushed == 0
    assert delivered.emailed is expected_emailed


@pytest.mark.parametrize(
    ("provider_status", "expected_event"),
    [("processing", "checking"), ("succeeded", "refund_pending")],
)
async def test_payment_attention_notifications_use_payments_preferences(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    fake_notifications_queue,
    provider_status: str,
    expected_event: str,
) -> None:
    provider = FakePaymentProvider()
    _, _, events, _ = await _prepared_checkout(
        api_client,
        db_session,
        monkeypatch,
        provider,
        fees=(Decimal("10.00"),),
        capacities=(1,),
    )
    if expected_event == "refund_pending":
        other = await make_user(db_session, f"payment-notice-{uuid.uuid4().hex[:8]}")
        db_session.add(TournamentEntry(event_id=events[0].id, user_id=other.player_id))
        await db_session.commit()

    accepted = await _webhook(
        api_client,
        provider.event(f"evt_notice_{uuid.uuid4().hex}", status=provider_status),
        "test-valid-signature",
    )

    assert accepted.status_code == 200
    jobs = enqueued_notification_jobs(fake_notifications_queue)
    payment_jobs = [j for j in jobs if j.category is NotificationCategory.PAYMENTS]
    assert len(payment_jobs) == 1
    assert payment_jobs[0].channels is None


async def test_receipt_jobs_carry_only_an_id_and_account_erasure_clears_pii(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    fake_email_queue,
) -> None:
    fake_email_queue._is_async = True
    payer, _, _, checkout, receipt = await _settled_checkout(
        api_client,
        db_session,
        monkeypatch,
        receipt_email="New.Address@Example.net",
        previous_receipt_email="old-address@example.net",
    )
    assert receipt is not None
    jobs = fake_email_queue.get_jobs()
    dedicated = [
        job
        for job in jobs
        if job.func_name == "app.tournament_payment_receipts.deliver_tournament_receipt"
    ]
    assert len(dedicated) == 1
    assert dedicated[0].args == (str(receipt.id),)
    assert "example.net" not in json.dumps(dedicated[0].args).lower()
    assert receipt.recipient_email == "New.Address@example.net"

    await erase_account(db_session, payer.id)
    await db_session.commit()
    await db_session.refresh(receipt)
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert receipt.recipient_email is None
    assert receipt.state is TournamentReceiptState.canceled
    assert receipt.pii_erased_at is not None
    assert payment is not None
    assert payment.receipt_email is None
    assert payment.provider_payment_id is not None
    assert payment.amount_cents == 1234


async def test_cleanup_waits_thirty_days_after_archive_and_financial_resolution(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, tournament, _, _, receipt = await _settled_checkout(
        api_client,
        db_session,
        monkeypatch,
        receipt_email="cleanup@example.net",
        mixed=True,
    )
    assert receipt is not None
    refund = await db_session.scalar(
        select(TournamentRefundObligation).where(
            TournamentRefundObligation.payment_id == receipt.payment_id
        )
    )
    assert refund is not None
    now = datetime.now(UTC)
    tournament.status = TournamentStatus.archived
    tournament.archive_observed_at = now - timedelta(days=60)
    tournament.archived_at = now - timedelta(days=60)
    await db_session.commit()

    assert (
        await _receipt_service().sweep_tournament_receipt_pii(db_session, now=now) == 0
    )
    await db_session.refresh(receipt)
    assert receipt.recipient_email == "cleanup@example.net"

    refund.state = TournamentRefundState.resolved
    refund.resolved_at = now - timedelta(days=31)
    await db_session.commit()
    # A reopened/new financial issue resets eligibility when the daily sweep
    # rechecks current truth; an old resolution timestamp is not a tombstone.
    refund.state = TournamentRefundState.pending
    refund.resolved_at = None
    await db_session.commit()
    assert (
        await _receipt_service().sweep_tournament_receipt_pii(db_session, now=now) == 0
    )

    refund.state = TournamentRefundState.resolved
    refund.resolved_at = now - timedelta(days=31)
    await db_session.commit()
    assert (
        await _receipt_service().sweep_tournament_receipt_pii(db_session, now=now) == 1
    )
    await db_session.refresh(receipt)
    assert receipt.recipient_email is None
    assert receipt.pii_erased_at == now


async def test_cleanup_accepts_all_events_terminal_without_archiving(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, tournament, events, _, receipt = await _settled_checkout(
        api_client,
        db_session,
        monkeypatch,
        receipt_email="completed@example.net",
    )
    assert receipt is not None
    for event in events:
        event.lifecycle_state = EventLifecycleState.cancelled
    await db_session.commit()
    completion_observed_at = await db_session.scalar(
        select(func.max(EventLifecycleHistory.observed_at)).where(
            EventLifecycleHistory.event_id.in_([event.id for event in events]),
            EventLifecycleHistory.to_state.in_(
                [EventLifecycleState.finished, EventLifecycleState.cancelled]
            ),
        )
    )
    assert completion_observed_at is not None

    # Generic row maintenance is not lifecycle evidence and must not move the
    # retained completion milestone or its PII cleanup deadline.
    for event in events:
        event.updated_at = completion_observed_at + timedelta(days=29)
    await db_session.commit()

    erased = await _receipt_service().sweep_tournament_receipt_pii(
        db_session, now=completion_observed_at + timedelta(days=31)
    )

    assert tournament.archive_observed_at is None
    assert erased == 1
    assert receipt.recipient_email is None


async def test_cleanup_uses_completion_when_it_qualifies_before_archive(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, tournament, events, _, receipt = await _settled_checkout(
        api_client,
        db_session,
        monkeypatch,
        receipt_email="first-milestone@example.net",
    )
    assert receipt is not None
    for event in events:
        event.lifecycle_state = EventLifecycleState.cancelled
    await db_session.commit()
    completion_observed_at = await db_session.scalar(
        select(func.max(EventLifecycleHistory.observed_at)).where(
            EventLifecycleHistory.event_id.in_([event.id for event in events]),
            EventLifecycleHistory.to_state.in_(
                [EventLifecycleState.finished, EventLifecycleState.cancelled]
            ),
        )
    )
    assert completion_observed_at is not None

    tournament.status = TournamentStatus.archived
    await db_session.commit()
    await db_session.refresh(tournament)
    archive_observed_at = tournament.archive_observed_at
    assert archive_observed_at is not None
    assert completion_observed_at < archive_observed_at
    between_deadlines = (
        completion_observed_at
        + timedelta(days=30)
        + (archive_observed_at - completion_observed_at) / 2
    )

    erased = await _receipt_service().sweep_tournament_receipt_pii(
        db_session, now=between_deadlines
    )

    assert erased == 1
    assert receipt.recipient_email is None


async def test_only_tournament_owner_can_read_safe_payment_problems(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = FakePaymentProvider()
    payer, tournament, _, _ = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    mismatch = provider.event(f"evt_problem_{uuid.uuid4().hex}", amount_cents=9999)
    assert (
        await _webhook(api_client, mismatch, "test-valid-signature")
    ).status_code == 200
    owner = await db_session.get(type(payer), tournament.owner_account_id)
    assert owner is not None

    async def read_as(actor: Any) -> Any:
        fastapi_app.dependency_overrides[get_current_user] = lambda: actor
        try:
            async with AsyncClient(
                transport=ASGITransport(app=fastapi_app),
                base_url="http://test",
                event_hooks=CSRF_EVENT_HOOKS,
            ) as client:
                return await client.get(
                    f"/v1/tournaments/{tournament.id}/payment-problems"
                )
        finally:
            fastapi_app.dependency_overrides.pop(get_current_user, None)

    refused = await read_as(payer)
    allowed = await read_as(owner)

    assert refused.status_code == 403
    assert allowed.status_code == 200, allowed.text
    assert len(allowed.json()["items"]) == 1
    item = allowed.json()["items"][0]
    assert item["state"] == "provider_mismatch"
    assert item["support_reference"].startswith("PAY-")
    rendered = json.dumps(allowed.json()).lower()
    assert "client_secret" not in rendered
    assert "secret" not in rendered
    assert "evidence_json" not in rendered
    assert "durable_identity" not in rendered


def test_payments_is_a_preference_controlled_notification_category() -> None:
    assert NotificationCategory.PAYMENTS.value == "payments"
    job = NotificationJob(
        user_id=uuid.uuid4(),
        category=NotificationCategory.PAYMENTS,
        title="Payment needs review",
        body="Use support reference PAY-12345678.",
    )
    assert job.channels is None
