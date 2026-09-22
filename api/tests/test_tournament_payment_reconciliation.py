"""Payment-provider evidence is the only authority that can grant paid entry.

These tests exercise the two public reconciliation seams: Stripe's raw signed
webhook and the payer's payment-status read.  The double replaces only the
external provider port; Fortymm persistence and admission remain real.
"""

import asyncio
import json
import uuid
from dataclasses import asdict, dataclass, is_dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

import app.tournament_payment_reconciliation as payment_reconciliation
from app.identity_lifecycle import deactivate_account, erase_account
from app.leagues import get_default_league
from app.main import app as fastapi_app
from app.models import (
    DrawType,
    EventFormat,
    Tournament,
    TournamentCheckout,
    TournamentCheckoutStatus,
    TournamentEntry,
    TournamentEntryRegistration,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentPayment,
    TournamentPaymentState,
    TournamentStatus,
    User,
)
from app.notifications.taxonomy import NotificationCategory
from app.payment_provider import (
    PaymentProviderNotFoundError,
    PaymentProviderSignatureError,
    PaymentProviderUncertainError,
    ProviderPaymentEvent,
    ProviderPaymentIntent,
    ProviderPaymentStatus,
    get_payment_provider,
)
from app.tournament_event_stages import mint_stages
from app.tournament_payment_reconciliation import reconcile_stuck_payments
from tests._helpers import (
    enqueued_notification_jobs,
    make_user,
    start_session,
)

try:
    from app.payment_provider import PaymentProviderCancellationRejectedError
except ImportError:  # The red test defines the provider contract production must add.

    class PaymentProviderCancellationRejectedError(Exception):
        pass


@dataclass(frozen=True)
class FakeProviderIntent:
    id: str
    client_secret: str
    status: str
    amount_cents: int
    currency: str
    merchant_account_id: str
    livemode: bool
    durable_identity: str


@dataclass(frozen=True)
class FakeProviderEvent:
    id: str
    type: str
    created_at: datetime
    payment: FakeProviderIntent


class FakePaymentProvider:
    """Narrow double for signed input and authoritative provider retrieval."""

    def __init__(self, intent_id: str = "pi_reconcile_1770") -> None:
        self.intent_id = intent_id
        self.creates: list[dict[str, Any]] = []
        self.events: dict[str, FakeProviderEvent] = {}
        self.intent: FakeProviderIntent | None = None
        self.retrievals: list[str] = []
        self.cancellations: list[str] = []
        self.receipt_updates: list[tuple[str, str | None]] = []
        self.receipt_update_error: Exception | None = None

    async def create_payment_intent(self, request: object) -> FakeProviderIntent:
        if is_dataclass(request) and not isinstance(request, type):
            recorded = asdict(request)
        elif hasattr(request, "model_dump"):
            recorded = request.model_dump()
        else:
            recorded = vars(request)
        self.creates.append(recorded)
        self.intent = FakeProviderIntent(
            id=self.intent_id,
            client_secret=f"{self.intent_id}_secret",
            status="requires_payment_method",
            amount_cents=recorded["amount_cents"],
            currency=recorded["currency"],
            merchant_account_id=recorded["merchant_account_id"],
            livemode=False,
            durable_identity=recorded["idempotency_key"],
        )
        return self.intent

    async def retrieve_payment_intent(
        self, durable_identity: str
    ) -> FakeProviderIntent:
        self.retrievals.append(durable_identity)
        assert self.intent is not None
        return self.intent

    async def cancel_payment_intent(
        self, provider_payment_id: str
    ) -> FakeProviderIntent:
        self.cancellations.append(provider_payment_id)
        assert self.intent is not None
        self.intent = FakeProviderIntent(
            **(asdict(self.intent) | {"status": "canceled"})
        )
        return self.intent

    async def update_payment_intent_receipt(
        self, provider_payment_id: str, receipt_email: str | None
    ) -> FakeProviderIntent:
        self.receipt_updates.append((provider_payment_id, receipt_email))
        if self.receipt_update_error is not None:
            raise self.receipt_update_error
        assert self.intent is not None
        return self.intent

    async def verify_webhook(
        self, payload: bytes, signature: str | None
    ) -> FakeProviderEvent:
        if signature != "test-valid-signature":
            raise PaymentProviderSignatureError
        event_id = json.loads(payload)["id"]
        return self.events[event_id]

    def event(
        self,
        event_id: str,
        *,
        status: str = "succeeded",
        created_at: datetime | None = None,
        **changes: object,
    ) -> bytes:
        assert self.intent is not None
        values = asdict(self.intent)
        values.update(changes)
        values["status"] = status
        event = FakeProviderEvent(
            id=event_id,
            type=f"payment_intent.{status}",
            created_at=created_at or datetime.now(UTC),
            payment=FakeProviderIntent(**values),
        )
        self.events[event_id] = event
        return json.dumps({"id": event_id}).encode()


def _install_provider(provider: FakePaymentProvider) -> None:
    fastapi_app.dependency_overrides[get_payment_provider] = lambda: provider


async def _prepared_checkout(
    api_client: AsyncClient,
    db: AsyncSession,
    monkeypatch,
    provider: FakePaymentProvider,
    *,
    fees: tuple[Decimal, ...] = (Decimal("12.34"),),
    capacities: tuple[int | None, ...] | None = None,
) -> tuple[User, Tournament, list[TournamentEvent], dict[str, Any]]:
    payer = await start_session(api_client, db)
    owner = await make_user(db, f"payment-owner-{uuid.uuid4().hex[:8]}")
    league = await get_default_league(db)
    assert league is not None
    tournament = Tournament(
        name="Payment reconciliation",
        status=TournamentStatus.published,
        registration_open=True,
        registration_generation=1,
        league_id=league.id,
        created_by_user_id=owner.id,
    )
    db.add(tournament)
    await db.flush()
    limits = capacities or tuple(None for _ in fees)
    events = [
        TournamentEvent(
            tournament_id=tournament.id,
            name=f"Paid event {index}",
            format=EventFormat.singles,
            draw_settings=TournamentEventDrawSettings.for_draw_type(
                DrawType.single_elim
            ),
            stages=mint_stages(DrawType.single_elim),
            max_players=limit,
            entry_fee=fee,
            timezone="America/Chicago",
            slot={"date": "2030-04-20", "start": "09:00", "end": "17:00"},
            match_settings={"rated": True, "length_games": 5},
            predicates=[],
        )
        for index, (fee, limit) in enumerate(zip(fees, limits, strict=True), start=1)
    ]
    db.add_all(events)
    await db.commit()
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    monkeypatch.setenv("STRIPE_LIVEMODE", "false")

    created = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={
            "request_id": str(uuid.uuid4()),
            "event_ids": [str(event.id) for event in events],
        },
    )
    assert created.status_code == 201, created.text
    checkout = created.json()
    _install_provider(provider)
    prepared = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts/{checkout['id']}/payment",
        json={},
    )
    assert prepared.status_code == 200, prepared.text
    return payer, tournament, events, checkout


def _payment_url(tournament: Tournament, checkout: dict[str, Any]) -> str:
    return f"/v1/tournaments/{tournament.id}/checkouts/{checkout['id']}/payment"


async def _webhook(api_client: AsyncClient, body: bytes, signature: str) -> Any:
    return await api_client.post(
        "/v1/webhooks/stripe",
        content=body,
        headers={
            "content-type": "application/json",
            "stripe-signature": signature,
        },
    )


async def _provider_event_count(db: AsyncSession, event_id: str | None = None) -> int:
    exists = await db.scalar(text("SELECT to_regclass('tournament_provider_events')"))
    if exists is None:
        return 0
    if event_id is None:
        query = text("SELECT count(*) FROM tournament_provider_events")
        return int(await db.scalar(query) or 0)
    query = text(
        "SELECT count(*) FROM tournament_provider_events "
        "WHERE provider_event_id = :event_id"
    )
    return int(await db.scalar(query, {"event_id": event_id}) or 0)


async def _refunds(db: AsyncSession) -> list[tuple[uuid.UUID | None, int]]:
    result = await db.execute(
        text(
            "SELECT payment_id, amount_cents "
            "FROM tournament_refund_obligations "
            "ORDER BY payment_id, checkout_line_id NULLS LAST"
        )
    )
    return [(row.payment_id, row.amount_cents) for row in result]


async def _entry_facts(db: AsyncSession, payer: User) -> tuple[list[uuid.UUID], int]:
    event_ids = list(
        await db.scalars(
            select(TournamentEntry.event_id)
            .where(TournamentEntry.user_id == payer.player_id)
            .order_by(TournamentEntry.event_id)
        )
    )
    registrations = int(
        await db.scalar(
            select(func.count(TournamentEntryRegistration.id))
            .join(TournamentEntry)
            .where(TournamentEntry.user_id == payer.player_id)
        )
        or 0
    )
    return event_ids, registrations


async def test_webhook_rejects_invalid_signature_without_persisting_event(
    api_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    provider = FakePaymentProvider()
    _install_provider(provider)

    response = await _webhook(
        api_client, b'{"id":"evt_untrusted"}', "not-a-valid-signature"
    )

    assert response.status_code == 400
    assert await _provider_event_count(db_session) == 0


async def test_verified_success_is_persisted_and_admitted_exactly_once(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    provider = FakePaymentProvider()
    payer, tournament, (event,), checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    succeeded = provider.event("evt_success_once")

    first = await _webhook(api_client, succeeded, "test-valid-signature")
    duplicate = await _webhook(api_client, succeeded, "test-valid-signature")
    status = await api_client.get(_payment_url(tournament, checkout))

    assert first.status_code == duplicate.status_code == 200
    assert await _provider_event_count(db_session, "evt_success_once") == 1
    assert status.status_code == 200, status.text
    assert status.json()["payment_state"] == "succeeded"
    assert status.json()["lines"] == [
        {
            "event_id": str(event.id),
            "amount_cents": 1234,
            "outcome": "confirmed",
            "refund_amount_cents": 0,
        }
    ]
    assert await _entry_facts(db_session, payer) == ([event.id], 1)

    # An older, reordered provider update cannot regress payment or admission.
    older = provider.event(
        "evt_processing_old",
        status="processing",
        created_at=datetime.now(UTC) - timedelta(minutes=1),
    )
    reordered = await _webhook(api_client, older, "test-valid-signature")
    assert reordered.status_code == 200
    assert await _entry_facts(db_session, payer) == ([event.id], 1)
    reread = await api_client.get(_payment_url(tournament, checkout))
    assert reread.json()["payment_state"] == "succeeded"


async def test_older_foreign_intent_evidence_cannot_mutate_current_payment(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    provider = FakePaymentProvider()
    _, _, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    notifications: list[object] = []

    def record_notification(job: object) -> bool:
        notifications.append(job)
        return True

    monkeypatch.setattr(
        payment_reconciliation,
        "enqueue_notification_job",
        record_notification,
    )
    current_evidence_at = datetime.now(UTC)
    current = await _webhook(
        api_client,
        provider.event(
            "evt_current_processing",
            status="processing",
            created_at=current_evidence_at,
        ),
        "test-valid-signature",
    )
    await db_session.refresh(payment)

    assert current.status_code == 200, current.text
    assert payment.state is TournamentPaymentState.checking
    assert payment.provider_status == ProviderPaymentStatus.processing.value
    assert payment.provider_evidence_at == current_evidence_at
    assert payment.support_reference is None
    assert payment.attention_notified_state == "checking"
    assert len(notifications) == 1

    stale_foreign = await _webhook(
        api_client,
        provider.event(
            "evt_older_foreign_intent",
            status="succeeded",
            created_at=current_evidence_at - timedelta(minutes=1),
            id="pi_foreign_older_evidence",
            client_secret="pi_foreign_older_evidence_secret",
        ),
        "test-valid-signature",
    )
    await db_session.refresh(payment)

    assert stale_foreign.status_code == 200, stale_foreign.text
    assert payment.state is TournamentPaymentState.checking
    assert payment.provider_status == ProviderPaymentStatus.processing.value
    assert payment.provider_evidence_at == current_evidence_at
    assert payment.support_reference is None
    assert payment.attention_notified_state == "checking"
    assert len(notifications) == 1


@pytest.mark.parametrize("quarantine_kind", ["bound_foreign_id", "unbound_mismatch"])
async def test_newer_quarantine_evidence_orders_later_provider_events(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    quarantine_kind: str,
) -> None:
    provider = FakePaymentProvider()
    payer, _, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    assert provider.intent is not None
    real_intent = provider.intent
    if quarantine_kind == "unbound_mismatch":
        payment.provider_payment_id = None
        payment.provider_status = "create_uncertain"
        payment.client_secret = None
        payment.state = TournamentPaymentState.preparing
        await db_session.commit()

    original_provider_id = payment.provider_payment_id
    original_provider_status = payment.provider_status
    original_client_secret = payment.client_secret
    newer_evidence_at = datetime.now(UTC)
    quarantine_changes: dict[str, object]
    if quarantine_kind == "bound_foreign_id":
        quarantine_changes = {
            "id": "pi_foreign_newer_evidence",
            "client_secret": "pi_foreign_newer_evidence_secret",
        }
    else:
        quarantine_changes = {
            "amount_cents": real_intent.amount_cents + 1,
            "client_secret": "pi_unassociated_newer_evidence_secret",
        }
    quarantined = await _webhook(
        api_client,
        provider.event(
            f"evt_newer_{quarantine_kind}",
            status="processing",
            created_at=newer_evidence_at,
            **quarantine_changes,
        ),
        "test-valid-signature",
    )
    await db_session.refresh(payment)

    assert quarantined.status_code == 200, quarantined.text
    assert payment.provider_evidence_at == newer_evidence_at
    assert payment.provider_payment_id == original_provider_id
    assert payment.provider_status == original_provider_status
    assert payment.client_secret == original_client_secret
    assert payment.support_reference

    # The valid object is older than evidence already investigated and
    # quarantined. It cannot bind an uncertain payment or settle a bound one.
    older_success = await _webhook(
        api_client,
        provider.event(
            f"evt_older_valid_{quarantine_kind}",
            created_at=newer_evidence_at - timedelta(minutes=1),
            **(asdict(real_intent) | {"status": "succeeded"}),
        ),
        "test-valid-signature",
    )
    await db_session.refresh(payment)

    assert older_success.status_code == 200, older_success.text
    assert payment.provider_evidence_at == newer_evidence_at
    assert payment.provider_payment_id == original_provider_id
    assert payment.provider_status == original_provider_status
    assert payment.client_secret == original_client_secret
    assert payment.state is not TournamentPaymentState.succeeded
    assert await _entry_facts(db_session, payer) == ([], 0)
    assert await _refunds(db_session) == []


@pytest.mark.parametrize(
    ("changed_field", "changed_value"),
    [
        ("amount_cents", 1235),
        ("currency", "EUR"),
        ("merchant_account_id", "acct_someone_else"),
        ("livemode", True),
        ("durable_identity", "fortymm:checkout:someone-else:payment:v1"),
    ],
)
async def test_provider_invariant_mismatch_is_quarantined_with_full_refund(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    changed_field: str,
    changed_value: object,
) -> None:
    provider = FakePaymentProvider()
    payer, tournament, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    body = provider.event(
        f"evt_mismatch_{changed_field}", **{changed_field: changed_value}
    )

    accepted = await _webhook(api_client, body, "test-valid-signature")
    first_read = await api_client.get(_payment_url(tournament, checkout))
    duplicate = await _webhook(api_client, body, "test-valid-signature")
    second_read = await api_client.get(_payment_url(tournament, checkout))

    assert accepted.status_code == duplicate.status_code == 200
    assert await _entry_facts(db_session, payer) == ([], 0)
    assert first_read.status_code == second_read.status_code == 200
    assert first_read.json()["payment_state"] == "failed"
    support_reference = first_read.json()["support_reference"]
    assert support_reference
    assert second_read.json()["support_reference"] == support_reference
    captured = int(changed_value) if changed_field == "amount_cents" else 1234
    assert sum(amount for _, amount in await _refunds(db_session)) == captured


async def test_failed_mismatch_remains_sweepable_until_receipt_sync_succeeds(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    provider = FakePaymentProvider()
    _, tournament, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    assert provider.intent is not None
    desired_email = "receipt-retry@example.net"
    provider.receipt_update_error = TimeoutError("receipt update result unknown")

    edited = await api_client.post(
        _payment_url(tournament, checkout),
        json={"receipt_email": desired_email},
    )

    assert edited.status_code == 200, edited.text
    await db_session.refresh(payment)
    assert payment.receipt_sync_pending is True
    calls_after_edit = len(provider.receipt_updates)

    # Authoritative success with a mismatched invariant quarantines the payment,
    # refunds the full captured amount, and records its operator notification.
    provider.intent = FakeProviderIntent(
        **(
            asdict(provider.intent)
            | {
                "status": "succeeded",
                "amount_cents": 4321,
            }
        )
    )
    first_sweep = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)

    assert first_sweep == 1
    assert payment.state is TournamentPaymentState.failed
    assert payment.attention_notified_state == "provider_mismatch"
    assert payment.receipt_sync_pending is True
    assert [amount for _, amount in await _refunds(db_session)] == [4321]
    assert len(provider.receipt_updates) == calls_after_edit + 1

    # Notification completion must not hide the independent provider receipt
    # obligation. A later sweep retries without needing another webhook.
    provider.receipt_update_error = None
    second_sweep = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)

    assert second_sweep == 1
    assert payment.receipt_sync_pending is False
    assert provider.receipt_updates[-1] == (provider.intent.id, desired_email)


async def test_provider_confirmed_cancellation_clears_receipt_sync_obligation(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    provider = FakePaymentProvider()
    _, tournament, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    assert provider.intent is not None
    provider.receipt_update_error = TimeoutError("receipt update result unknown")

    edited = await api_client.post(
        _payment_url(tournament, checkout),
        json={"receipt_email": "never-issued@example.net"},
    )

    assert edited.status_code == 200, edited.text
    await db_session.refresh(payment)
    assert payment.receipt_sync_pending is True
    calls_after_edit = len(provider.receipt_updates)

    # A provider-confirmed cancellation cannot issue a financial receipt, so
    # the local sync marker is discharged without another provider update.
    provider.intent = FakeProviderIntent(
        **(asdict(provider.intent) | {"status": "canceled"})
    )
    swept = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)

    assert swept == 1
    assert payment.state is TournamentPaymentState.canceled
    assert payment.receipt_sync_pending is False
    assert len(provider.receipt_updates) == calls_after_edit


@pytest.mark.parametrize("foreign_status", ["succeeded", "canceled"])
async def test_sweep_quarantines_terminal_evidence_for_a_foreign_provider_id(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    foreign_status: str,
) -> None:
    provider = FakePaymentProvider()
    payer, _, (event,), checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    assert provider.intent is not None
    real_intent = provider.intent
    real_provider_id = real_intent.id
    provider.intent = FakeProviderIntent(
        **(
            asdict(real_intent)
            | {
                "id": "pi_foreign_terminal_evidence",
                "client_secret": "pi_foreign_terminal_evidence_secret",
                "status": foreign_status,
            }
        )
    )

    first_sweep = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)

    assert first_sweep == 1
    assert payment.provider_payment_id == real_provider_id
    assert payment.state is TournamentPaymentState.checking
    assert payment.support_reference
    assert payment.attention_notified_state == "provider_mismatch"
    assert await _refunds(db_session) == []
    assert await _entry_facts(db_session, payer) == ([], 0)

    # The foreign terminal claim cannot strand the real bound intent. Later
    # authoritative evidence for that intent still settles normally.
    provider.intent = FakeProviderIntent(
        **(asdict(real_intent) | {"status": "succeeded"})
    )
    second_sweep = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)

    assert second_sweep == 1
    assert payment.provider_payment_id == real_provider_id
    assert payment.state is TournamentPaymentState.succeeded
    assert await _refunds(db_session) == []
    assert await _entry_facts(db_session, payer) == ([event.id], 1)


@pytest.mark.parametrize("closed_by", ["expiry", "registration_generation"])
async def test_late_success_never_revives_admission_and_refunds_every_line(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    closed_by: str,
) -> None:
    provider = FakePaymentProvider()
    payer, tournament, _, checkout = await _prepared_checkout(
        api_client,
        db_session,
        monkeypatch,
        provider,
        fees=(Decimal("10.00"), Decimal("20.00")),
    )
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    assert stored is not None
    if closed_by == "expiry":
        stored.created_at = datetime.now(UTC) - timedelta(minutes=20)
        stored.expires_at = datetime.now(UTC) - timedelta(minutes=10)
    else:
        tournament.registration_generation += 1
        tournament.registration_open = False
    await db_session.commit()

    response = await _webhook(
        api_client, provider.event(f"evt_late_{closed_by}"), "test-valid-signature"
    )

    assert response.status_code == 200
    assert await _entry_facts(db_session, payer) == ([], 0)
    refunds = await _refunds(db_session)
    assert sorted(amount for _, amount in refunds) == [1000, 2000]


async def test_combined_success_confirms_valid_hold_and_refunds_invalid_line(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    provider = FakePaymentProvider()
    payer, tournament, events, checkout = await _prepared_checkout(
        api_client,
        db_session,
        monkeypatch,
        provider,
        fees=(Decimal("10.00"), Decimal("20.00")),
        capacities=(1, 1),
    )
    other = await make_user(db_session, f"capacity-race-{uuid.uuid4().hex[:8]}")
    db_session.add(TournamentEntry(event_id=events[1].id, user_id=other.player_id))
    await db_session.commit()

    response = await _webhook(
        api_client, provider.event("evt_mixed"), "test-valid-signature"
    )
    status = await api_client.get(_payment_url(tournament, checkout))

    assert response.status_code == 200
    assert await _entry_facts(db_session, payer) == ([events[0].id], 1)
    outcomes = {line["event_id"]: line for line in status.json()["lines"]}
    assert outcomes[str(events[0].id)]["outcome"] == "confirmed"
    assert outcomes[str(events[0].id)]["amount_cents"] == 1000
    assert outcomes[str(events[1].id)]["outcome"] == "refund_pending"
    assert outcomes[str(events[1].id)]["amount_cents"] == 2000
    assert outcomes[str(events[1].id)]["refund_amount_cents"] == 2000
    assert [amount for _, amount in await _refunds(db_session)] == [2000]


async def test_processing_payment_past_deadline_stays_reconcilable_for_late_success(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    provider = FakePaymentProvider()
    payer, _, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert stored is not None
    assert payment is not None
    assert provider.intent is not None
    stored.created_at = datetime.now(UTC) - timedelta(minutes=20)
    stored.expires_at = datetime.now(UTC) - timedelta(minutes=10)
    provider.intent = FakeProviderIntent(
        **(asdict(provider.intent) | {"status": "processing"})
    )
    await db_session.commit()

    first_sweep = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)

    assert first_sweep == 1
    assert payment.state is TournamentPaymentState.checking

    provider.intent = FakeProviderIntent(
        **(asdict(provider.intent) | {"status": "succeeded"})
    )
    second_sweep = await reconcile_stuck_payments(db_session, provider)

    assert second_sweep == 1
    assert await _entry_facts(db_session, payer) == ([], 0)
    assert [amount for _, amount in await _refunds(db_session)] == [1234]


@pytest.mark.parametrize(
    "provider_status",
    [
        "requires_payment_method",
        "requires_confirmation",
        "requires_action",
        "requires_capture",
    ],
)
@pytest.mark.parametrize(
    "authority_loss",
    [TournamentCheckoutStatus.expired, TournamentCheckoutStatus.cancelled],
)
async def test_sweep_cancels_safe_provider_intent_after_checkout_loses_authority(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    provider_status: str,
    authority_loss: TournamentCheckoutStatus,
) -> None:
    provider = FakePaymentProvider()
    _, _, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert stored is not None
    assert payment is not None
    assert provider.intent is not None
    stored.status = authority_loss
    if authority_loss is TournamentCheckoutStatus.expired:
        stored.created_at = datetime.now(UTC) - timedelta(minutes=20)
        stored.expires_at = datetime.now(UTC) - timedelta(minutes=10)
    else:
        stored.cancelled_at = datetime.now(UTC)
    provider.intent = FakeProviderIntent(
        **(asdict(provider.intent) | {"status": provider_status})
    )
    await db_session.commit()

    first_sweep = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)
    second_sweep = await reconcile_stuck_payments(db_session, provider)

    assert first_sweep == 1
    assert provider.cancellations == ["pi_reconcile_1770"]
    assert payment.state is TournamentPaymentState.canceled
    assert second_sweep == 0
    assert provider.retrievals == [payment.durable_identity]


@pytest.mark.parametrize(
    ("changed_field", "changed_value"),
    [
        ("amount_cents", 1235),
        ("durable_identity", "checkout_payment:unrelated"),
    ],
)
async def test_sweep_cancels_bound_safe_intent_despite_invariant_mismatch(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    changed_field: str,
    changed_value: object,
) -> None:
    provider = FakePaymentProvider()
    _, _, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert stored is not None
    assert payment is not None
    assert provider.intent is not None
    stored.status = TournamentCheckoutStatus.expired
    stored.created_at = datetime.now(UTC) - timedelta(minutes=20)
    stored.expires_at = datetime.now(UTC) - timedelta(minutes=10)
    provider.intent = FakeProviderIntent(
        **(
            asdict(provider.intent)
            | {
                "status": "requires_payment_method",
                changed_field: changed_value,
            }
        )
    )
    await db_session.commit()

    first_sweep = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)
    second_sweep = await reconcile_stuck_payments(db_session, provider)

    assert first_sweep == 1
    assert provider.cancellations == ["pi_reconcile_1770"]
    assert payment.state is TournamentPaymentState.failed
    assert payment.support_reference
    assert second_sweep == 0


@pytest.mark.parametrize(
    "provider_status",
    ["requires_payment_method", "requires_action", "requires_capture"],
)
@pytest.mark.parametrize("payer_lifecycle", ["inactive", "erased", "merged"])
async def test_sweep_cancels_safe_intent_when_payer_loses_authority(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    provider_status: str,
    payer_lifecycle: str,
) -> None:
    provider = FakePaymentProvider()
    payer, tournament, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert stored is not None
    assert payment is not None
    assert provider.intent is not None
    assert stored.status is TournamentCheckoutStatus.active
    assert stored.expires_at > datetime.now(UTC)
    assert stored.registration_generation == tournament.registration_generation
    assert stored.merchant_account_id == tournament.owner_account_id
    assert tournament.registration_open is True

    # Isolate payer lifecycle as the only lost authority. The sweep itself is
    # responsible for noticing that a chargeable bound intent is no longer safe.
    now = datetime.now(UTC)
    if payer_lifecycle == "inactive":
        payer.deactivated_at = now
    elif payer_lifecycle == "erased":
        await erase_account(db_session, payer.id)
        await db_session.flush()
        await db_session.refresh(stored)
        # Keep every checkout/tournament fact valid so payer lifecycle remains
        # the sole reason this chargeable intent has lost authority.
        stored.status = TournamentCheckoutStatus.active
        stored.cancelled_at = None
    else:
        survivor = await make_user(
            db_session, f"payment-survivor-{uuid.uuid4().hex[:8]}"
        )
        payer.merged_into_user_id = survivor.id
        payer.merged_at = now
    provider.intent = FakeProviderIntent(
        **(asdict(provider.intent) | {"status": provider_status})
    )
    await db_session.commit()

    reconciled = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)
    await db_session.refresh(stored)

    assert reconciled == 1
    assert provider.cancellations == [provider.intent_id]
    assert payment.state is TournamentPaymentState.canceled
    assert payment.client_secret is None
    assert stored.status is TournamentCheckoutStatus.active
    assert await _entry_facts(db_session, payer) == ([], 0)


async def test_sweep_does_not_cancel_a_different_provider_intent_id(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    provider = FakePaymentProvider()
    _, _, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert stored is not None
    assert payment is not None
    assert provider.intent is not None
    bound_provider_id = payment.provider_payment_id
    bound_status = payment.provider_status
    bound_secret = payment.client_secret
    stored.status = TournamentCheckoutStatus.expired
    stored.created_at = datetime.now(UTC) - timedelta(minutes=20)
    stored.expires_at = datetime.now(UTC) - timedelta(minutes=10)
    provider.intent = FakeProviderIntent(
        **(
            asdict(provider.intent)
            | {
                "id": "pi_unrelated",
                "client_secret": "pi_unrelated_secret",
                "status": "requires_payment_method",
            }
        )
    )
    await db_session.commit()

    reconciled = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)

    assert reconciled == 1
    assert provider.cancellations == []
    assert payment.provider_payment_id == bound_provider_id
    assert payment.provider_status == bound_status
    assert payment.client_secret == bound_secret
    assert payment.state is TournamentPaymentState.checking


async def test_sweep_keeps_polling_processing_intent_after_checkout_loses_authority(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    provider = FakePaymentProvider()
    _, _, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert stored is not None
    assert payment is not None
    assert provider.intent is not None
    stored.status = TournamentCheckoutStatus.expired
    stored.created_at = datetime.now(UTC) - timedelta(minutes=20)
    stored.expires_at = datetime.now(UTC) - timedelta(minutes=10)
    provider.intent = FakeProviderIntent(
        **(asdict(provider.intent) | {"status": "processing"})
    )
    await db_session.commit()

    first_sweep = await reconcile_stuck_payments(db_session, provider)
    second_sweep = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)

    assert first_sweep == second_sweep == 1
    assert provider.cancellations == []
    assert provider.retrievals == [payment.durable_identity, payment.durable_identity]
    assert payment.state is TournamentPaymentState.checking


async def test_cancel_rejection_reloads_terminal_truth_and_continues_sweep(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    first_provider = FakePaymentProvider("pi_cancel_race")
    first_payer, _, _, first_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, first_provider
    )
    second_provider = FakePaymentProvider("pi_later_obligation")
    _, _, _, second_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, second_provider
    )
    first_stored = await db_session.get(
        TournamentCheckout, uuid.UUID(first_checkout["id"])
    )
    second_stored = await db_session.get(
        TournamentCheckout, uuid.UUID(second_checkout["id"])
    )
    first_payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(first_checkout["id"])
        )
    )
    second_payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(second_checkout["id"])
        )
    )
    assert first_stored is not None
    assert second_stored is not None
    assert first_payment is not None
    assert second_payment is not None
    assert first_provider.intent is not None
    assert second_provider.intent is not None
    for checkout_row in (first_stored, second_stored):
        checkout_row.status = TournamentCheckoutStatus.expired
        checkout_row.created_at = datetime.now(UTC) - timedelta(minutes=20)
        checkout_row.expires_at = datetime.now(UTC) - timedelta(minutes=10)

    class RacingCancellationProvider:
        def __init__(self) -> None:
            self.intents = {
                first_payment.durable_identity: FakeProviderIntent(
                    **(
                        asdict(first_provider.intent)
                        | {"status": "requires_payment_method"}
                    )
                ),
                second_payment.durable_identity: FakeProviderIntent(
                    **(
                        asdict(second_provider.intent)
                        | {"status": "requires_payment_method"}
                    )
                ),
            }
            self.durable_by_id = {
                intent.id: durable_identity
                for durable_identity, intent in self.intents.items()
            }
            self.retrievals: list[str] = []
            self.cancellations: list[str] = []

        async def retrieve_payment_intent(
            self, durable_identity: str
        ) -> FakeProviderIntent:
            self.retrievals.append(durable_identity)
            return self.intents[durable_identity]

        async def cancel_payment_intent(
            self, provider_payment_id: str
        ) -> FakeProviderIntent:
            self.cancellations.append(provider_payment_id)
            durable_identity = self.durable_by_id[provider_payment_id]
            intent = self.intents[durable_identity]
            if provider_payment_id == "pi_cancel_race":
                self.intents[durable_identity] = FakeProviderIntent(
                    **(asdict(intent) | {"status": "succeeded"})
                )
                raise PaymentProviderCancellationRejectedError
            canceled = FakeProviderIntent(**(asdict(intent) | {"status": "canceled"}))
            self.intents[durable_identity] = canceled
            return canceled

    provider = RacingCancellationProvider()
    await db_session.commit()

    reconciled = await reconcile_stuck_payments(db_session, provider)  # type: ignore[arg-type]
    await db_session.refresh(first_payment)
    await db_session.refresh(second_payment)

    assert reconciled == 2
    assert set(provider.cancellations) == {"pi_cancel_race", "pi_later_obligation"}
    assert provider.retrievals.count(first_payment.durable_identity) == 2
    assert provider.retrievals.count(second_payment.durable_identity) == 1
    assert first_payment.state is TournamentPaymentState.succeeded
    assert second_payment.state is TournamentPaymentState.canceled
    assert await _entry_facts(db_session, first_payer) == ([], 0)
    assert [amount for _, amount in await _refunds(db_session)] == [1234]


@pytest.mark.parametrize("blocked_call", ["cancel", "rejection_fallback"])
async def test_sweep_does_not_hold_lifecycle_locks_during_safe_cancellation_io(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
    blocked_call: str,
) -> None:
    provider = FakePaymentProvider("pi_lock_free_cancel")
    _, _, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    checkout_id = uuid.UUID(checkout["id"])
    stored = await db_session.get(TournamentCheckout, checkout_id)
    payment = await db_session.scalar(
        select(TournamentPayment).where(TournamentPayment.checkout_id == checkout_id)
    )
    assert stored is not None
    assert payment is not None
    assert provider.intent is not None
    stored.status = TournamentCheckoutStatus.expired
    stored.created_at = datetime.now(UTC) - timedelta(minutes=20)
    stored.expires_at = datetime.now(UTC) - timedelta(minutes=10)
    await db_session.commit()

    provider_call_entered = asyncio.Event()
    release_provider_call = asyncio.Event()

    class BlockingCancellationProvider:
        def __init__(self) -> None:
            self.retrieval_count = 0

        async def retrieve_payment_intent(
            self, durable_identity: str
        ) -> FakeProviderIntent:
            assert durable_identity == payment.durable_identity
            self.retrieval_count += 1
            if blocked_call == "rejection_fallback" and self.retrieval_count == 2:
                provider_call_entered.set()
                await release_provider_call.wait()
                return FakeProviderIntent(
                    **(asdict(provider.intent) | {"status": "canceled"})
                )
            return provider.intent

        async def cancel_payment_intent(
            self, provider_payment_id: str
        ) -> FakeProviderIntent:
            assert provider_payment_id == provider.intent.id
            if blocked_call == "rejection_fallback":
                raise PaymentProviderCancellationRejectedError
            provider_call_entered.set()
            await release_provider_call.wait()
            return FakeProviderIntent(
                **(asdict(provider.intent) | {"status": "canceled"})
            )

    sessions = async_sessionmaker(engine, expire_on_commit=False)
    blocking_provider = BlockingCancellationProvider()

    async def sweep() -> int:
        async with sessions() as session:
            return await reconcile_stuck_payments(  # type: ignore[arg-type]
                session, blocking_provider
            )

    sweeping = asyncio.create_task(sweep())
    try:
        await asyncio.wait_for(provider_call_entered.wait(), timeout=5)
        async with sessions() as concurrent_lifecycle_change:
            await asyncio.wait_for(
                concurrent_lifecycle_change.execute(
                    text(
                        "UPDATE tournament_checkouts "
                        "SET cancelled_at = clock_timestamp() WHERE id = :id"
                    ),
                    {"id": checkout_id},
                ),
                timeout=1,
            )
            await concurrent_lifecycle_change.commit()
    finally:
        release_provider_call.set()
        await asyncio.gather(sweeping, return_exceptions=True)

    assert await sweeping == 1
    async with sessions() as observer:
        persisted = await observer.get(TournamentPayment, payment.id)
        assert persisted is not None
        assert persisted.state is TournamentPaymentState.canceled


@pytest.mark.parametrize(
    "cancellation_error",
    [
        pytest.param(TimeoutError("cancel timed out"), id="timeout"),
        pytest.param(
            PaymentProviderUncertainError("cancel outcome unknown"),
            id="uncertain",
        ),
    ],
)
async def test_uncertain_cancellation_releases_locks_before_later_obligation(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
    cancellation_error: Exception,
) -> None:
    first_provider = FakePaymentProvider("pi_uncertain_cancel")
    _, _, _, first_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, first_provider
    )
    second_provider = FakePaymentProvider("pi_after_uncertain_cancel")
    _, _, _, second_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, second_provider
    )
    first_checkout_id = uuid.UUID(first_checkout["id"])
    second_checkout_id = uuid.UUID(second_checkout["id"])
    first_stored = await db_session.get(TournamentCheckout, first_checkout_id)
    second_stored = await db_session.get(TournamentCheckout, second_checkout_id)
    first_payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == first_checkout_id
        )
    )
    second_payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == second_checkout_id
        )
    )
    assert first_stored is not None
    assert second_stored is not None
    assert first_payment is not None
    assert second_payment is not None
    assert first_provider.intent is not None
    assert second_provider.intent is not None
    for checkout_row in (first_stored, second_stored):
        checkout_row.status = TournamentCheckoutStatus.expired
        checkout_row.created_at = datetime.now(UTC) - timedelta(minutes=20)
        checkout_row.expires_at = datetime.now(UTC) - timedelta(minutes=10)
    await db_session.commit()

    later_retrieve_entered = asyncio.Event()
    release_later_retrieve = asyncio.Event()

    class UncertainThenBlockingProvider:
        def __init__(self) -> None:
            self.intents = {
                first_payment.durable_identity: first_provider.intent,
                second_payment.durable_identity: second_provider.intent,
            }

        async def retrieve_payment_intent(
            self, durable_identity: str
        ) -> FakeProviderIntent:
            if durable_identity == second_payment.durable_identity:
                later_retrieve_entered.set()
                await release_later_retrieve.wait()
            return self.intents[durable_identity]

        async def cancel_payment_intent(
            self, provider_payment_id: str
        ) -> FakeProviderIntent:
            if provider_payment_id == first_provider.intent.id:
                raise cancellation_error
            return FakeProviderIntent(
                **(asdict(second_provider.intent) | {"status": "canceled"})
            )

    sessions = async_sessionmaker(engine, expire_on_commit=False)
    blocking_provider = UncertainThenBlockingProvider()

    async def sweep() -> int:
        async with sessions() as session:
            return await reconcile_stuck_payments(  # type: ignore[arg-type]
                session, blocking_provider
            )

    sweeping = asyncio.create_task(sweep())
    try:
        await asyncio.wait_for(later_retrieve_entered.wait(), timeout=5)
        async with sessions() as concurrent_lifecycle_change:
            await asyncio.wait_for(
                concurrent_lifecycle_change.execute(
                    text(
                        "UPDATE tournament_checkouts "
                        "SET cancelled_at = clock_timestamp() WHERE id = :id"
                    ),
                    {"id": first_checkout_id},
                ),
                timeout=1,
            )
            await concurrent_lifecycle_change.commit()
    finally:
        release_later_retrieve.set()
        await asyncio.gather(sweeping, return_exceptions=True)

    assert await sweeping == 1
    async with sessions() as observer:
        first_persisted = await observer.get(TournamentPayment, first_payment.id)
        second_persisted = await observer.get(TournamentPayment, second_payment.id)
        assert first_persisted is not None
        assert second_persisted is not None
        assert first_persisted.state is TournamentPaymentState.ready
        assert second_persisted.state is TournamentPaymentState.canceled


@pytest.mark.parametrize("payer_lifecycle", ["inactive", "erased", "merged"])
@pytest.mark.parametrize("bound", [True, False])
async def test_inactive_payer_not_found_stays_recoverable_and_does_not_stop_sweep(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    payer_lifecycle: str,
    bound: bool,
) -> None:
    missing_provider = FakePaymentProvider("pi_inactive_payer")
    payer, _, _, missing_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, missing_provider
    )
    later_provider = FakePaymentProvider("pi_later_payment")
    _, _, _, later_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, later_provider
    )
    missing_payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(missing_checkout["id"])
        )
    )
    later_payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(later_checkout["id"])
        )
    )
    missing_stored = await db_session.get(
        TournamentCheckout, uuid.UUID(missing_checkout["id"])
    )
    assert missing_payment is not None
    assert later_payment is not None
    assert missing_stored is not None
    assert missing_provider.intent is not None
    assert later_provider.intent is not None
    if not bound:
        missing_payment.provider_payment_id = None
        missing_payment.provider_status = "create_uncertain"
        missing_payment.client_secret = None
        missing_payment.state = TournamentPaymentState.preparing

    if payer_lifecycle == "inactive":
        await deactivate_account(db_session, payer.id)
    elif payer_lifecycle == "erased":
        await erase_account(db_session, payer.id)
    else:
        survivor = await make_user(
            db_session, f"payment-survivor-{uuid.uuid4().hex[:8]}"
        )
        payer.merged_into_user_id = survivor.id
        payer.merged_at = datetime.now(UTC)
        missing_stored.status = TournamentCheckoutStatus.invalidated
    await db_session.commit()

    class MissingThenFoundProvider(FakePaymentProvider):
        def __init__(self) -> None:
            super().__init__("pi_unused")
            self.missing = True

        async def retrieve_payment_intent(
            self, durable_identity: str
        ) -> FakeProviderIntent:
            self.retrievals.append(durable_identity)
            if durable_identity == missing_payment.durable_identity:
                if self.missing:
                    raise PaymentProviderNotFoundError
                return FakeProviderIntent(
                    **(asdict(missing_provider.intent) | {"status": "succeeded"})
                )
            assert durable_identity == later_payment.durable_identity
            return FakeProviderIntent(
                **(asdict(later_provider.intent) | {"status": "succeeded"})
            )

        async def create_payment_intent(self, request: object) -> FakeProviderIntent:
            raise AssertionError("lost payer authority cannot recreate an intent")

    provider = MissingThenFoundProvider()

    first_sweep = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(missing_payment)
    await db_session.refresh(later_payment)

    assert first_sweep == 2
    assert provider.retrievals == [
        missing_payment.durable_identity,
        later_payment.durable_identity,
    ]
    assert missing_payment.state is (
        TournamentPaymentState.checking if bound else TournamentPaymentState.preparing
    )
    assert missing_payment.provider_status == (
        ProviderPaymentStatus.requires_payment_method.value
        if bound
        else "create_uncertain"
    )
    assert later_payment.state is TournamentPaymentState.succeeded

    provider.missing = False
    second_sweep = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(missing_payment)

    assert second_sweep == 1
    assert missing_payment.state is TournamentPaymentState.succeeded
    assert missing_payment.provider_payment_id == missing_provider.intent.id
    assert [
        amount
        for payment_id, amount in await _refunds(db_session)
        if payment_id == missing_payment.id
    ] == [1234]


async def test_nonterminal_invariant_mismatch_remains_reconcilable_until_capture(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    provider = FakePaymentProvider()
    payer, tournament, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    processing_mismatch = provider.event(
        "evt_processing_mismatch",
        status="processing",
        amount_cents=4321,
    )
    provider.intent = provider.events["evt_processing_mismatch"].payment

    first = await _webhook(api_client, processing_mismatch, "test-valid-signature")
    first_status = await api_client.get(_payment_url(tournament, checkout))

    assert first.status_code == 200
    assert first_status.status_code == 200
    assert first_status.json()["payment_state"] == "checking"
    assert first_status.json()["support_reference"]
    assert await _refunds(db_session) == []

    captured_mismatch = provider.event(
        "evt_succeeded_mismatch",
        status="succeeded",
        amount_cents=4321,
    )
    second = await _webhook(api_client, captured_mismatch, "test-valid-signature")

    assert second.status_code == 200
    assert await _entry_facts(db_session, payer) == ([], 0)
    assert [amount for _, amount in await _refunds(db_session)] == [4321]


async def test_attention_notification_retries_after_enqueue_failure(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    provider = FakePaymentProvider()
    _, _, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    attempted_jobs: list[object] = []

    def enqueue_with_one_failure(job: object) -> bool:
        attempted_jobs.append(job)
        return len(attempted_jobs) > 1

    monkeypatch.setattr(
        payment_reconciliation,
        "enqueue_notification_job",
        enqueue_with_one_failure,
    )

    first = await _webhook(
        api_client,
        provider.event("evt_checking_enqueue_failure", status="processing"),
        "test-valid-signature",
    )
    await db_session.refresh(payment)
    marker_after_failure = payment.attention_notified_state
    second = await _webhook(
        api_client,
        provider.event("evt_checking_enqueue_retry", status="processing"),
        "test-valid-signature",
    )
    await db_session.refresh(payment)

    assert first.status_code == second.status_code == 200
    assert marker_after_failure is None
    assert len(attempted_jobs) == 2
    assert payment.attention_notified_state == "checking"


async def test_settlement_notification_retries_after_enqueue_failure(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    provider = FakePaymentProvider()
    _, _, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    attempted_jobs: list[object] = []

    def enqueue_with_one_failure(job: object) -> bool:
        attempted_jobs.append(job)
        return len(attempted_jobs) > 1

    monkeypatch.setattr(
        payment_reconciliation,
        "enqueue_notification_job",
        enqueue_with_one_failure,
    )

    first = await _webhook(
        api_client,
        provider.event("evt_settlement_enqueue_failure"),
        "test-valid-signature",
    )
    await db_session.refresh(payment)
    marker_after_failure = payment.settlement_notified_at
    second = await _webhook(
        api_client,
        provider.event("evt_settlement_enqueue_retry"),
        "test-valid-signature",
    )
    await db_session.refresh(payment)

    assert first.status_code == second.status_code == 200
    assert marker_after_failure is None
    assert len(attempted_jobs) == 2
    assert payment.settlement_notified_at is not None


async def test_terminal_success_read_retries_failed_settlement_and_refund_notices(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    provider = FakePaymentProvider()
    _, tournament, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert stored is not None
    assert payment is not None
    stored.created_at = datetime.now(UTC) - timedelta(minutes=20)
    stored.expires_at = datetime.now(UTC) - timedelta(minutes=10)
    attempted_jobs: list[object] = []
    accept_jobs = False

    def enqueue_with_outage(job: object) -> bool:
        attempted_jobs.append(job)
        return accept_jobs

    monkeypatch.setattr(
        payment_reconciliation,
        "enqueue_notification_job",
        enqueue_with_outage,
    )
    await db_session.commit()

    settled = await _webhook(
        api_client,
        provider.event("evt_terminal_notice_outage"),
        "test-valid-signature",
    )
    await db_session.refresh(payment)

    assert settled.status_code == 200
    assert payment.state is TournamentPaymentState.succeeded
    assert payment.settlement_notified_at is None
    assert payment.attention_notified_state is None
    assert len(attempted_jobs) == 2

    accept_jobs = True
    status = await api_client.get(_payment_url(tournament, checkout))
    await db_session.refresh(payment)

    assert status.status_code == 200
    assert len(attempted_jobs) == 4
    assert payment.settlement_notified_at is not None
    assert payment.attention_notified_state == "refund_pending"


@pytest.mark.parametrize("retry_seam", ["status_read", "reconciliation_sweep"])
async def test_terminal_provider_mismatch_retries_failed_attention_notification(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    retry_seam: str,
) -> None:
    provider = FakePaymentProvider()
    _, tournament, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    attempted_jobs: list[object] = []
    accept_jobs = False

    def enqueue_with_outage(job: object) -> bool:
        attempted_jobs.append(job)
        return accept_jobs

    monkeypatch.setattr(
        payment_reconciliation,
        "enqueue_notification_job",
        enqueue_with_outage,
    )
    mismatch = await _webhook(
        api_client,
        provider.event(
            "evt_failed_attention_outage",
            status="succeeded",
            amount_cents=4321,
        ),
        "test-valid-signature",
    )
    await db_session.refresh(payment)

    assert mismatch.status_code == 200
    assert payment.state is TournamentPaymentState.failed
    assert payment.attention_notified_state is None
    assert len(attempted_jobs) == 1

    accept_jobs = True
    if retry_seam == "status_read":
        retried = await api_client.get(_payment_url(tournament, checkout))
        assert retried.status_code == 200, retried.text
    else:
        assert await reconcile_stuck_payments(db_session, provider) == 1
    await db_session.refresh(payment)

    assert len(attempted_jobs) == 2
    assert payment.attention_notified_state == "provider_mismatch"


@pytest.mark.parametrize("retry_seam", ["status_read", "reconciliation_sweep"])
async def test_provider_mismatch_notice_supersedes_a_prior_checking_notice(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    retry_seam: str,
) -> None:
    provider = FakePaymentProvider()
    _, tournament, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    assert provider.intent is not None
    attempted_jobs: list[object] = []
    accept_mismatch_notice = False

    def enqueue_with_mismatch_outage(job: object) -> bool:
        attempted_jobs.append(job)
        return len(attempted_jobs) == 1 or accept_mismatch_notice

    monkeypatch.setattr(
        payment_reconciliation,
        "enqueue_notification_job",
        enqueue_with_mismatch_outage,
    )
    common = asdict(provider.intent)
    processing = ProviderPaymentIntent(
        **(common | {"status": ProviderPaymentStatus.processing})
    )
    provider.events["evt_notice_checking"] = ProviderPaymentEvent(  # type: ignore[assignment]
        id="evt_notice_checking",
        type="payment_intent.processing",
        created_at=datetime.now(UTC),
        payment=processing,
    )
    first = await _webhook(
        api_client,
        json.dumps({"id": "evt_notice_checking"}).encode(),
        "test-valid-signature",
    )
    await db_session.refresh(payment)

    assert first.status_code == 200
    assert payment.attention_notified_state == "checking"
    assert len(attempted_jobs) == 1

    mismatch = ProviderPaymentIntent(
        **(
            common
            | {
                "status": ProviderPaymentStatus.succeeded,
                "amount_cents": 4321,
            }
        )
    )
    provider.intent = mismatch  # type: ignore[assignment]
    provider.events["evt_notice_mismatch"] = ProviderPaymentEvent(  # type: ignore[assignment]
        id="evt_notice_mismatch",
        type="payment_intent.succeeded",
        created_at=datetime.now(UTC),
        payment=mismatch,
    )
    second = await _webhook(
        api_client,
        json.dumps({"id": "evt_notice_mismatch"}).encode(),
        "test-valid-signature",
    )
    await db_session.refresh(payment)

    assert second.status_code == 200
    assert payment.state is TournamentPaymentState.failed
    assert payment.attention_notified_state == "checking"
    assert len(attempted_jobs) == 2

    accept_mismatch_notice = True
    if retry_seam == "status_read":
        retried = await api_client.get(_payment_url(tournament, checkout))
        assert retried.status_code == 200, retried.text
    else:
        assert await reconcile_stuck_payments(db_session, provider) == 1
    await db_session.refresh(payment)

    assert len(attempted_jobs) == 3
    assert payment.attention_notified_state == "provider_mismatch"


async def test_all_refunded_settlement_uses_refund_specific_notification_title(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    fake_notifications_queue,
) -> None:
    provider = FakePaymentProvider()
    _, _, _, checkout = await _prepared_checkout(
        api_client,
        db_session,
        monkeypatch,
        provider,
        fees=(Decimal("10.00"), Decimal("20.00")),
    )
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    assert stored is not None
    stored.created_at = datetime.now(UTC) - timedelta(minutes=20)
    stored.expires_at = datetime.now(UTC) - timedelta(minutes=10)
    await db_session.commit()

    accepted = await _webhook(
        api_client, provider.event("evt_all_refunded_notice"), "test-valid-signature"
    )

    assert accepted.status_code == 200
    registration_jobs = [
        job
        for job in enqueued_notification_jobs(fake_notifications_queue)
        if job.category is NotificationCategory.TOURNAMENT
    ]
    assert len(registration_jobs) == 1
    notice = registration_jobs[0]
    assert "refund" in notice.title.casefold()
    assert "confirmed" not in notice.title.casefold()
    assert not notice.body.startswith("0 entries confirmed")


async def test_mixed_settlement_notification_says_registration_is_partial(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    fake_notifications_queue,
) -> None:
    provider = FakePaymentProvider()
    _, _, events, _ = await _prepared_checkout(
        api_client,
        db_session,
        monkeypatch,
        provider,
        fees=(Decimal("10.00"), Decimal("20.00")),
        capacities=(1, 1),
    )
    other = await make_user(db_session, f"mixed-notice-{uuid.uuid4().hex[:8]}")
    db_session.add(TournamentEntry(event_id=events[1].id, user_id=other.player_id))
    await db_session.commit()

    accepted = await _webhook(
        api_client, provider.event("evt_mixed_notice"), "test-valid-signature"
    )

    assert accepted.status_code == 200
    registration_jobs = [
        job
        for job in enqueued_notification_jobs(fake_notifications_queue)
        if job.category is NotificationCategory.TOURNAMENT
    ]
    assert len(registration_jobs) == 1
    notice = registration_jobs[0]
    assert "partial" in notice.title.casefold()
    assert "1 entry confirmed" in notice.body.casefold()
    assert "1 refund pending" in notice.body.casefold()


async def test_browser_claim_cannot_admit_without_matching_provider_evidence(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    provider = FakePaymentProvider()
    payer, tournament, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )

    claimed = await api_client.get(
        _payment_url(tournament, checkout),
        params={
            "payment_intent": "pi_reconcile_1770",
            "redirect_status": "succeeded",
        },
    )

    assert claimed.status_code == 200
    assert claimed.json()["payment_state"] == "ready"
    assert await _entry_facts(db_session, payer) == ([], 0)

    assert provider.intent is not None
    provider.intent = FakeProviderIntent(
        **(asdict(provider.intent) | {"status": "succeeded"})
    )
    reconciled = await api_client.get(_payment_url(tournament, checkout))
    assert reconciled.status_code == 200
    assert reconciled.json()["payment_state"] == "succeeded"
    assert await _entry_facts(db_session, payer) == (
        [uuid.UUID(checkout["lines"][0]["event_id"])],
        1,
    )


async def test_webhook_binding_recovers_client_secret_for_resumable_payment(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    provider = FakePaymentProvider()
    _, tournament, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    payment.client_secret = None
    await db_session.commit()

    webhook = await _webhook(
        api_client,
        provider.event("evt_requires_action", status="requires_action"),
        "test-valid-signature",
    )
    resumed = await api_client.post(_payment_url(tournament, checkout), json={})

    assert webhook.status_code == 200, webhook.text
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["payment_state"] == "action_required"
    assert resumed.json()["client_secret"] == "pi_reconcile_1770_secret"
