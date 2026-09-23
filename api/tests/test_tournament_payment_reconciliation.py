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
import stripe
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
    Notification,
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
from app.notifications.service import NotificationService
from app.notifications.taxonomy import NotificationCategory
from app.payment_provider import (
    PaymentProviderNotFoundError,
    PaymentProviderSignatureError,
    PaymentProviderUncertainError,
    ProviderPaymentEvent,
    ProviderPaymentIntent,
    ProviderPaymentStatus,
    StripePaymentProvider,
    get_payment_provider,
)
from app.realtime import EventKind, RealtimeBroker
from app.sessions import get_current_user
from app.tournament_entries import withdraw_from_event
from app.tournament_event_stages import mint_stages
from app.tournament_payment_reconciliation import reconcile_stuck_payments
from tests._helpers import (
    FakeSender,
    enqueued_notification_jobs,
    make_user,
    start_session,
)
from tests._realtime import watch_hints

try:
    from app.payment_provider import PaymentProviderCancellationRejectedError
except ImportError:  # The red test defines the provider contract production must add.

    class PaymentProviderCancellationRejectedError(Exception):
        pass


try:
    from app.payment_provider import PaymentProviderReceiptUpdateRejectedError
except ImportError:  # The red test defines the provider contract production must add.

    class PaymentProviderReceiptUpdateRejectedError(Exception):
        pass


try:
    from app.payment_provider import PaymentProviderAmountInvalidError
except ImportError:  # The red test defines the provider contract production must add.

    class PaymentProviderAmountInvalidError(Exception):
        pass


try:
    from app.payment_provider import PaymentProviderResponseInvalidError
except ImportError:  # The red test defines the provider contract production must add.

    class PaymentProviderResponseInvalidError(Exception):
        pass


try:
    from app.payment_provider import PaymentProviderCreateRejectedError
except ImportError:  # The red test defines the provider contract production must add.

    class PaymentProviderCreateRejectedError(Exception):
        pass


try:
    from app.payment_provider import PaymentProviderConfigurationError
except ImportError:  # The red test defines the provider contract production must add.

    class PaymentProviderConfigurationError(Exception):
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
        self.identity_searches: list[str] = []
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
        self, provider_payment_id: str
    ) -> FakeProviderIntent:
        self.retrievals.append(provider_payment_id)
        assert self.intent is not None
        return self.intent

    async def find_payment_intent_by_durable_identity(
        self, durable_identity: str
    ) -> FakeProviderIntent:
        self.identity_searches.append(durable_identity)
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
        if self.intent.status == "canceled":
            raise RuntimeError(
                "Stripe does not allow updating a canceled PaymentIntent"
            )
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
    payment_payload: dict[str, Any] | None = None,
    prepare_payment: bool = True,
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
    if not prepare_payment:
        return payer, tournament, events, checkout
    prepared = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts/{checkout['id']}/payment",
        json=payment_payload or {},
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


async def test_aggregate_checkout_above_provider_maximum_fails_before_create(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    provider = FakePaymentProvider("pi_must_not_be_created")
    _, tournament, _, checkout = await _prepared_checkout(
        api_client,
        db_session,
        monkeypatch,
        provider,
        fees=(Decimal("999999.99"), Decimal("0.50")),
        prepare_payment=False,
    )

    response = await api_client.post(
        _payment_url(tournament, checkout),
        json={},
    )

    assert response.status_code == 409, response.text
    assert provider.creates == []

    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    assert stored is not None
    assert stored.status is TournamentCheckoutStatus.cancelled

    terminal = await api_client.get(_payment_url(tournament, checkout))
    assert terminal.status_code == 200, terminal.text
    assert terminal.json()["payment_state"] == "canceled"
    assert terminal.json()["client_secret"] is None

    # A permanently impossible aggregate must release the event holds rather
    # than leave a live checkout that can only repeat the same 409 forever.
    replacement = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={
            "request_id": str(uuid.uuid4()),
            "event_ids": [line["event_id"] for line in checkout["lines"]],
        },
    )
    assert replacement.status_code == 201, replacement.text


async def test_impossible_oversized_create_does_not_starve_later_sweep_obligation(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    oversized_provider = FakePaymentProvider("pi_oversized_seed")
    _, _, _, oversized_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, oversized_provider
    )
    later_provider = FakePaymentProvider("pi_later_after_oversized")
    _, _, _, later_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, later_provider
    )
    oversized = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(oversized_checkout["id"])
        )
    )
    later = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(later_checkout["id"])
        )
    )
    oversized_row = await db_session.get(
        TournamentCheckout, uuid.UUID(oversized_checkout["id"])
    )
    assert oversized is not None
    assert later is not None
    assert oversized_row is not None
    assert later_provider.intent is not None

    oversized.provider_payment_id = None
    oversized.client_secret = None
    oversized.provider_status = "create_uncertain"
    oversized.state = TournamentPaymentState.preparing
    oversized.amount_cents = 100_000_000
    oversized_row.total_cents = 100_000_000
    await db_session.commit()

    class OversizedThenLaterProvider(FakePaymentProvider):
        async def find_payment_intent_by_durable_identity(
            self, durable_identity: str
        ) -> FakeProviderIntent:
            self.identity_searches.append(durable_identity)
            if durable_identity == oversized.durable_identity:
                raise PaymentProviderNotFoundError
            raise AssertionError("only the unbound payment may use metadata search")

        async def retrieve_payment_intent(
            self, provider_payment_id: str
        ) -> FakeProviderIntent:
            self.retrievals.append(provider_payment_id)
            assert provider_payment_id == later.provider_payment_id
            return FakeProviderIntent(
                **(asdict(later_provider.intent) | {"status": "succeeded"})
            )

        async def create_payment_intent(self, request: object) -> FakeProviderIntent:
            amount_cents = (
                request.amount_cents
                if hasattr(request, "amount_cents")
                else vars(request)["amount_cents"]
            )
            if amount_cents > 99_999_999:
                raise PaymentProviderAmountInvalidError("amount exceeds Stripe maximum")
            raise AssertionError("only the impossible create should be attempted")

    provider = OversizedThenLaterProvider()

    reconciled = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(oversized)
    await db_session.refresh(later)

    assert reconciled == 2
    assert oversized.state is TournamentPaymentState.failed
    assert oversized.support_reference is not None
    assert oversized_row.status is TournamentCheckoutStatus.cancelled
    assert later.state is TournamentPaymentState.succeeded


async def test_malformed_provider_response_is_quarantined_without_starving_later_work(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    malformed_provider = FakePaymentProvider("pi_malformed_response")
    _, _, _, malformed_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, malformed_provider
    )
    later_provider = FakePaymentProvider("pi_after_malformed_response")
    _, _, _, later_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, later_provider
    )
    malformed = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(malformed_checkout["id"])
        )
    )
    later = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(later_checkout["id"])
        )
    )
    assert malformed is not None
    assert later is not None
    assert later_provider.intent is not None

    class MalformedThenValidProvider(FakePaymentProvider):
        async def retrieve_payment_intent(
            self, provider_payment_id: str
        ) -> FakeProviderIntent:
            if provider_payment_id == malformed.provider_payment_id:
                raise PaymentProviderResponseInvalidError(
                    "Stripe PaymentIntent response is missing status"
                )
            assert provider_payment_id == later.provider_payment_id
            return FakeProviderIntent(
                **(asdict(later_provider.intent) | {"status": "succeeded"})
            )

    reconciled = await reconcile_stuck_payments(
        db_session, MalformedThenValidProvider("pi_unused")
    )
    await db_session.refresh(malformed)
    await db_session.refresh(later)

    assert reconciled == 2
    assert malformed.provider_mismatch_at is not None
    assert malformed.support_reference is not None
    assert later.state is TournamentPaymentState.succeeded


async def test_provider_configuration_failure_is_visible_without_starving_sweep(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    broken_provider = FakePaymentProvider("pi_bad_provider_configuration")
    _, _, _, broken_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, broken_provider
    )
    later_provider = FakePaymentProvider("pi_after_provider_configuration")
    _, _, _, later_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, later_provider
    )
    broken = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(broken_checkout["id"])
        )
    )
    later = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(later_checkout["id"])
        )
    )
    assert broken is not None
    assert later is not None
    assert later_provider.intent is not None

    class BrokenThenValidProvider(FakePaymentProvider):
        async def retrieve_payment_intent(
            self, provider_payment_id: str
        ) -> FakeProviderIntent:
            if provider_payment_id == broken.provider_payment_id:
                raise PaymentProviderConfigurationError("Stripe key was revoked")
            assert provider_payment_id == later.provider_payment_id
            return FakeProviderIntent(
                **(asdict(later_provider.intent) | {"status": "succeeded"})
            )

    reconciled = await reconcile_stuck_payments(
        db_session, BrokenThenValidProvider("pi_unused")
    )
    await db_session.refresh(broken)
    await db_session.refresh(later)

    assert reconciled == 2
    assert broken.provider_mismatch_at is not None
    assert broken.support_reference is not None
    assert broken.attention_notified_state == "provider_mismatch"
    assert later.state is TournamentPaymentState.succeeded


async def test_rejected_search_is_quarantined_without_duplicate_create(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    broken_provider = FakePaymentProvider("pi_invalid_search")
    _, _, _, broken_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, broken_provider
    )
    later_provider = FakePaymentProvider("pi_after_invalid_search")
    _, _, _, later_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, later_provider
    )
    broken = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(broken_checkout["id"])
        )
    )
    later = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(later_checkout["id"])
        )
    )
    assert broken is not None
    assert later is not None
    assert later_provider.intent is not None
    broken.provider_payment_id = None
    broken.client_secret = None
    broken.provider_status = "create_uncertain"
    broken.state = TournamentPaymentState.preparing
    await db_session.commit()

    def rejected_search(**_kwargs: object) -> object:
        raise stripe.InvalidRequestError("search unavailable", "query")

    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_boundary")
    monkeypatch.setattr(stripe.PaymentIntent, "search", rejected_search)
    stripe_provider = StripePaymentProvider()

    class InvalidSearchThenValidProvider(FakePaymentProvider):
        search_is_rejected = True

        async def find_payment_intent_by_durable_identity(
            self, durable_identity: str
        ) -> ProviderPaymentIntent:
            if durable_identity == broken.durable_identity:
                if self.search_is_rejected:
                    find = stripe_provider.find_payment_intent_by_durable_identity
                    return await find(durable_identity)
                raise PaymentProviderNotFoundError
            raise AssertionError("only the unbound payment may use metadata search")

        async def retrieve_payment_intent(
            self, provider_payment_id: str
        ) -> ProviderPaymentIntent:
            assert provider_payment_id == later.provider_payment_id
            return ProviderPaymentIntent(
                **(asdict(later_provider.intent) | {"status": "succeeded"})
            )

    recovery_provider = InvalidSearchThenValidProvider("pi_unused")
    reconciled = await reconcile_stuck_payments(db_session, recovery_provider)
    await db_session.refresh(broken)
    await db_session.refresh(later)

    assert reconciled == 2
    assert broken.provider_mismatch_at is not None
    assert broken.support_reference is not None
    assert broken.state is TournamentPaymentState.checking
    assert broken.provider_status == "create_uncertain"
    assert broken.attention_notified_state == "provider_mismatch"
    assert recovery_provider.creates == []
    assert later.state is TournamentPaymentState.succeeded

    quarantine_at = broken.provider_mismatch_at
    support_reference = broken.support_reference
    recovery_provider.search_is_rejected = False

    assert await reconcile_stuck_payments(db_session, recovery_provider) == 1
    await db_session.refresh(broken)

    assert broken.provider_mismatch_at == quarantine_at
    assert broken.support_reference == support_reference
    assert broken.state is TournamentPaymentState.checking
    assert broken.attention_notified_state == "provider_mismatch"
    assert recovery_provider.creates == []


async def test_unbound_search_credential_outage_remains_retryable(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = FakePaymentProvider("pi_search_credentials")
    _, _, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    payment.provider_payment_id = None
    payment.client_secret = None
    payment.provider_status = "create_uncertain"
    payment.state = TournamentPaymentState.preparing
    await db_session.commit()

    class CredentialOutageProvider(FakePaymentProvider):
        async def find_payment_intent_by_durable_identity(
            self, durable_identity: str
        ) -> FakeProviderIntent:
            self.identity_searches.append(durable_identity)
            raise PaymentProviderConfigurationError("Stripe key was revoked")

    outage_provider = CredentialOutageProvider("pi_unused")
    assert await reconcile_stuck_payments(db_session, outage_provider) == 1
    await db_session.refresh(payment)

    assert outage_provider.identity_searches == [payment.durable_identity]
    assert outage_provider.creates == []
    assert payment.state is TournamentPaymentState.checking
    assert payment.provider_status == "create_uncertain"
    assert payment.provider_mismatch_at is None
    assert payment.support_reference is None
    assert payment.attention_notified_state != "provider_mismatch"


async def test_unknown_legacy_create_matching_lookup_does_not_emit_stale_review_alert(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = FakePaymentProvider("pi_legacy_unknown_matching")
    _, _, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    assert provider.intent is not None
    payment.provider_payment_id = None
    payment.client_secret = None
    payment.provider_status = "create_parameters_unknown"
    payment.state = TournamentPaymentState.preparing
    await db_session.commit()
    notification_attempts: list[object] = []
    monkeypatch.setattr(
        payment_reconciliation,
        "enqueue_notification_job",
        lambda job: notification_attempts.append(job) or True,
    )

    async def matching_lookup(durable_identity: str) -> FakeProviderIntent:
        # Provider evidence must be consulted before creating operator-visible
        # quarantine state for an identity whose immutable create snapshot was
        # unknowable during migration.
        assert notification_attempts == []
        assert durable_identity == payment.durable_identity
        assert provider.intent is not None
        return provider.intent

    monkeypatch.setattr(
        provider,
        "find_payment_intent_by_durable_identity",
        matching_lookup,
    )

    assert await reconcile_stuck_payments(db_session, provider) == 1
    await db_session.refresh(payment)

    assert payment.provider_payment_id == provider.intent.id
    assert payment.state is TournamentPaymentState.ready
    assert payment.provider_mismatch_at is None
    assert payment.support_reference is None
    assert payment.attention_notified_state != "provider_mismatch"
    assert notification_attempts == []


@pytest.mark.parametrize("evidence", ["not_found", "mismatch"])
async def test_unknown_legacy_create_quarantines_only_after_authoritative_lookup(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    evidence: str,
) -> None:
    provider = FakePaymentProvider(f"pi_legacy_unknown_{evidence}")
    _, _, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    stored_checkout = await db_session.get(
        TournamentCheckout, uuid.UUID(checkout["id"])
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert stored_checkout is not None
    assert payment is not None
    assert provider.intent is not None
    payment.provider_payment_id = None
    payment.client_secret = None
    payment.provider_status = "create_parameters_unknown"
    payment.state = TournamentPaymentState.preparing
    if evidence == "not_found":
        # A definitive metadata miss must be quarantined even after checkout
        # authority is gone; an early authority/gate exit cannot hide it.
        now = datetime.now(UTC)
        stored_checkout.status = TournamentCheckoutStatus.expired
        stored_checkout.created_at = now - timedelta(minutes=20)
        stored_checkout.expires_at = now - timedelta(minutes=10)
    await db_session.commit()
    notification_attempts: list[object] = []
    monkeypatch.setattr(
        payment_reconciliation,
        "enqueue_notification_job",
        lambda job: notification_attempts.append(job) or True,
    )

    async def authoritative_lookup(durable_identity: str) -> FakeProviderIntent:
        assert notification_attempts == []
        assert durable_identity == payment.durable_identity
        if evidence == "not_found":
            raise PaymentProviderNotFoundError()
        assert provider.intent is not None
        return FakeProviderIntent(
            **(
                asdict(provider.intent)
                | {"amount_cents": provider.intent.amount_cents + 1}
            )
        )

    monkeypatch.setattr(
        provider,
        "find_payment_intent_by_durable_identity",
        authoritative_lookup,
    )

    assert await reconcile_stuck_payments(db_session, provider) == 1
    await db_session.refresh(payment)

    assert payment.provider_payment_id is None
    assert payment.state is TournamentPaymentState.checking
    assert payment.provider_mismatch_at is not None
    assert payment.support_reference is not None
    assert payment.attention_notified_state == "provider_mismatch"
    assert len(notification_attempts) == 1


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


async def test_webhook_acknowledges_authenticated_irrelevant_event_without_persisting(
    api_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    class IrrelevantEventProvider(FakePaymentProvider):
        async def verify_webhook(
            self, payload: bytes, signature: str | None
        ) -> ProviderPaymentEvent | None:
            assert payload == b'{"id":"evt_other_integration"}'
            assert signature == "test-valid-signature"
            return None

    _install_provider(IrrelevantEventProvider())

    response = await _webhook(
        api_client,
        b'{"id":"evt_other_integration"}',
        "test-valid-signature",
    )

    assert response.status_code == 200, response.text
    assert await _provider_event_count(db_session) == 0


async def test_webhook_rejects_authenticated_malformed_relevant_event_safely(
    api_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    class MalformedRelevantEventProvider(FakePaymentProvider):
        async def verify_webhook(
            self, payload: bytes, signature: str | None
        ) -> ProviderPaymentEvent | None:
            assert payload == b'{"id":"evt_malformed_fortymm"}'
            assert signature == "test-valid-signature"
            raise PaymentProviderResponseInvalidError(
                "authenticated FortyMM PaymentIntent is missing status"
            )

    _install_provider(MalformedRelevantEventProvider())

    response = await _webhook(
        api_client,
        b'{"id":"evt_malformed_fortymm"}',
        "test-valid-signature",
    )

    assert response.status_code == 400, response.text
    assert await _provider_event_count(db_session) == 0


async def test_webhook_acknowledges_authenticated_unsupported_payment_intent_subtype(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_boundary")
    monkeypatch.setattr(
        stripe.Webhook,
        "construct_event",
        lambda *_args, **_kwargs: {
            "id": "evt_future_payment_intent_subtype",
            "type": "payment_intent.created",
            "created": 1_800_000_000,
            "data": {
                "object": {
                    "id": "pi_future_subtype",
                    "client_secret": "pi_future_subtype_secret",
                    "status": "requires_payment_method",
                    "amount": 1234,
                    "currency": "usd",
                    "livemode": False,
                    "metadata": {
                        "fortymm_identity": "fortymm:checkout:test:payment:v1",
                        "fortymm_merchant_account_id": str(uuid.uuid4()),
                    },
                }
            },
        },
    )
    fastapi_app.dependency_overrides[get_payment_provider] = StripePaymentProvider

    response = await _webhook(api_client, b"{}", "test-valid-signature")

    assert response.status_code == 200, response.text
    assert await _provider_event_count(db_session) == 0


async def test_webhook_maps_stripe_malformed_signed_payload_to_bad_request(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_boundary")

    def reject_malformed_payload(*_args: object, **_kwargs: object) -> object:
        raise ValueError("malformed signed Stripe payload")

    monkeypatch.setattr(stripe.Webhook, "construct_event", reject_malformed_payload)
    fastapi_app.dependency_overrides[get_payment_provider] = StripePaymentProvider

    response = await _webhook(api_client, b"not-json", "test-valid-signature")

    assert response.status_code == 400, response.text
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


@pytest.mark.parametrize("quarantine_kind", ["bound_foreign_id", "unbound_mismatch"])
async def test_not_found_reconciliation_retries_quarantine_notification(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    quarantine_kind: str,
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
    assert provider.intent is not None
    if quarantine_kind == "unbound_mismatch":
        payment.provider_payment_id = None
        payment.provider_status = "create_uncertain"
        payment.client_secret = None
        payment.state = TournamentPaymentState.preparing
        await db_session.commit()

    notification_attempts: list[object] = []

    def enqueue_after_first_outage(job: object) -> bool:
        notification_attempts.append(job)
        return len(notification_attempts) > 1

    monkeypatch.setattr(
        payment_reconciliation,
        "enqueue_notification_job",
        enqueue_after_first_outage,
    )
    mismatch_changes: dict[str, object]
    if quarantine_kind == "bound_foreign_id":
        mismatch_changes = {"id": "pi_foreign_notification_retry"}
    else:
        mismatch_changes = {"amount_cents": provider.intent.amount_cents + 1}
    quarantined = await _webhook(
        api_client,
        provider.event(
            f"evt_notification_retry_{quarantine_kind}",
            status="processing",
            **mismatch_changes,
        ),
        "test-valid-signature",
    )
    await db_session.refresh(payment)

    assert quarantined.status_code == 200, quarantined.text
    assert len(notification_attempts) == 1
    assert payment.attention_notified_state != "provider_mismatch"
    quarantine_at = payment.provider_mismatch_at
    assert quarantine_at is not None
    original_provider_id = payment.provider_payment_id

    async def not_found(_durable_identity: str) -> FakeProviderIntent:
        raise PaymentProviderNotFoundError()

    provider_method = (
        "find_payment_intent_by_durable_identity"
        if quarantine_kind == "unbound_mismatch"
        else "retrieve_payment_intent"
    )
    monkeypatch.setattr(provider, provider_method, not_found)

    assert await reconcile_stuck_payments(db_session, provider) == 1
    await db_session.refresh(payment)

    assert len(notification_attempts) == 2
    assert payment.attention_notified_state == "provider_mismatch"
    assert payment.provider_mismatch_at == quarantine_at
    assert payment.provider_payment_id == original_provider_id


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


async def test_terminal_provider_mismatch_releases_hold_for_replacement_checkout(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    provider = FakePaymentProvider()
    payer, tournament, (event,), checkout = await _prepared_checkout(
        api_client,
        db_session,
        monkeypatch,
        provider,
        fees=(Decimal("12.34"),),
    )

    accepted = await _webhook(
        api_client,
        provider.event("evt_terminal_mismatch_releases_hold", amount_cents=4321),
        "test-valid-signature",
    )
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )

    assert accepted.status_code == 200, accepted.text
    assert stored is not None
    assert payment is not None
    assert payment.state is TournamentPaymentState.failed
    assert await _entry_facts(db_session, payer) == ([], 0)
    assert [amount for _, amount in await _refunds(db_session)] == [4321]

    replacement = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={
            "request_id": str(uuid.uuid4()),
            "event_ids": [str(event.id)],
        },
    )

    assert replacement.status_code == 201, replacement.text
    assert replacement.json()["id"] != checkout["id"]
    assert stored.status is TournamentCheckoutStatus.invalidated


async def test_sweep_repairs_stale_terminal_provider_mismatch_checkout_once(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    fake_notifications_queue,
    realtime_broker: RealtimeBroker,
) -> None:
    provider = FakePaymentProvider()
    payer, tournament, (event,), checkout = await _prepared_checkout(
        api_client,
        db_session,
        monkeypatch,
        provider,
        fees=(Decimal("12.34"),),
    )
    assert provider.intent is not None
    provider.intent = FakeProviderIntent(
        **(asdict(provider.intent) | {"status": "succeeded", "amount_cents": 4321})
    )

    accepted = await _webhook(
        api_client,
        provider.event("evt_stale_terminal_mismatch", amount_cents=4321),
        "test-valid-signature",
    )
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert accepted.status_code == 200, accepted.text
    assert stored is not None
    assert payment is not None
    assert payment.state is TournamentPaymentState.failed
    assert payment.attention_notified_state == "provider_mismatch"

    # Simulate a terminal aggregate persisted before checkout release was part of
    # reconciliation. The payment has no unfinished notification/refund marker
    # that would otherwise keep it in the periodic sweep.
    stored.status = TournamentCheckoutStatus.active
    await db_session.commit()
    refunds_before = await _refunds(db_session)
    jobs_before = len(enqueued_notification_jobs(fake_notifications_queue))

    async with watch_hints(realtime_broker, payer.id) as watch:
        first_sweep = await reconcile_stuck_payments(db_session, provider)
        hints = await watch.collect()
    await db_session.refresh(stored)

    assert first_sweep == 1
    assert stored.status is TournamentCheckoutStatus.invalidated
    assert hints[payer.id] == [EventKind.dashboard_changed]
    assert await _refunds(db_session) == refunds_before
    assert len(enqueued_notification_jobs(fake_notifications_queue)) == jobs_before
    retrievals_after_repair = list(provider.retrievals)

    second_sweep = await reconcile_stuck_payments(db_session, provider)

    assert second_sweep == 0
    assert provider.retrievals == retrievals_after_repair
    assert await _refunds(db_session) == refunds_before
    assert len(enqueued_notification_jobs(fake_notifications_queue)) == jobs_before

    replacement = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={
            "request_id": str(uuid.uuid4()),
            "event_ids": [str(event.id)],
        },
    )
    assert replacement.status_code == 201, replacement.text
    assert replacement.json()["id"] != checkout["id"]


async def test_provider_mismatch_reference_survives_a_truncated_uuid_collision(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 32-bit display prefix must not become a permanent recovery poison pill."""
    first_id = uuid.UUID("12345678-0000-4000-8000-000000000001")
    second_id = uuid.UUID("12345678-ffff-4000-8000-000000000002")
    assert str(first_id)[:8] == str(second_id)[:8]

    blocker_provider = FakePaymentProvider("pi_reference_blocker")
    _, _, _, blocker_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, blocker_provider
    )
    blocker = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(blocker_checkout["id"])
        )
    )
    assert blocker is not None

    target_provider = FakePaymentProvider("pi_reference_target")
    _, _, _, target_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, target_provider
    )
    target = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(target_checkout["id"])
        )
    )
    assert target is not None
    collided_reference = f"PAY-{str(target.id)[:8].upper()}"
    blocker.support_reference = collided_reference
    await db_session.commit()

    mismatch = target_provider.event(
        f"evt_reference_collision_{uuid.uuid4().hex}", amount_cents=9999
    )
    first = await _webhook(api_client, mismatch, "test-valid-signature")
    duplicate = await _webhook(api_client, mismatch, "test-valid-signature")
    await db_session.refresh(target)

    assert first.status_code == duplicate.status_code == 200
    assert target.support_reference
    assert target.support_reference != blocker.support_reference
    assert target.support_reference != collided_reference


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


async def test_provider_confirmed_cancellation_releases_hold_for_replacement_checkout(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    provider = FakePaymentProvider()
    payer, tournament, (event,), checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )

    canceled = await _webhook(
        api_client,
        provider.event("evt_canceled_releases_hold", status="canceled"),
        "test-valid-signature",
    )
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )

    assert canceled.status_code == 200, canceled.text
    assert stored is not None
    assert payment is not None
    assert payment.state is TournamentPaymentState.canceled
    assert await _entry_facts(db_session, payer) == ([], 0)
    assert await _refunds(db_session) == []

    replacement = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={
            "request_id": str(uuid.uuid4()),
            "event_ids": [str(event.id)],
        },
    )

    assert replacement.status_code == 201, replacement.text
    assert replacement.json()["id"] != checkout["id"]
    assert stored.status in {
        TournamentCheckoutStatus.cancelled,
        TournamentCheckoutStatus.invalidated,
    }


async def test_sweep_repairs_stale_provider_canceled_checkout_once(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    fake_notifications_queue,
    realtime_broker: RealtimeBroker,
) -> None:
    provider = FakePaymentProvider()
    payer, tournament, (event,), checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    assert provider.intent is not None
    provider.intent = FakeProviderIntent(
        **(asdict(provider.intent) | {"status": "canceled"})
    )

    canceled = await _webhook(
        api_client,
        provider.event("evt_stale_provider_canceled", status="canceled"),
        "test-valid-signature",
    )
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert canceled.status_code == 200, canceled.text
    assert stored is not None
    assert payment is not None
    assert payment.state is TournamentPaymentState.canceled

    # Seed the pre-fix stale shape: terminal provider evidence alongside a
    # checkout that still owns capacity and blocks replacement registration.
    stored.status = TournamentCheckoutStatus.active
    await db_session.commit()
    refunds_before = await _refunds(db_session)
    jobs_before = len(enqueued_notification_jobs(fake_notifications_queue))

    async with watch_hints(realtime_broker, payer.id) as watch:
        first_sweep = await reconcile_stuck_payments(db_session, provider)
        hints = await watch.collect()
    await db_session.refresh(stored)

    assert first_sweep == 1
    assert stored.status is TournamentCheckoutStatus.invalidated
    assert hints[payer.id] == [EventKind.dashboard_changed]
    assert await _refunds(db_session) == refunds_before == []
    assert len(enqueued_notification_jobs(fake_notifications_queue)) == jobs_before
    retrievals_after_repair = list(provider.retrievals)

    second_sweep = await reconcile_stuck_payments(db_session, provider)

    assert second_sweep == 0
    assert provider.retrievals == retrievals_after_repair
    assert await _refunds(db_session) == []
    assert len(enqueued_notification_jobs(fake_notifications_queue)) == jobs_before

    replacement = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={
            "request_id": str(uuid.uuid4()),
            "event_ids": [str(event.id)],
        },
    )
    assert replacement.status_code == 201, replacement.text
    assert replacement.json()["id"] != checkout["id"]


async def test_canceled_receipt_rejection_is_visible_and_does_not_starve_sweep(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rejected_provider = FakePaymentProvider("pi_canceled_receipt_rejected")
    payer, tournament, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, rejected_provider
    )
    rejected_payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert rejected_payment is not None
    rejected_payment.state = TournamentPaymentState.canceled
    rejected_payment.provider_status = ProviderPaymentStatus.canceled
    rejected_payment.receipt_email = None
    rejected_payment.receipt_sync_pending = True
    rejected_provider.receipt_update_error = PaymentProviderReceiptUpdateRejectedError(
        "Stripe cannot update a canceled PaymentIntent"
    )

    later_provider = FakePaymentProvider("pi_later_sweep_obligation")
    _, _, _, later_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, later_provider
    )
    later_payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(later_checkout["id"])
        )
    )
    assert later_payment is not None
    later_payment.state = TournamentPaymentState.failed
    later_payment.provider_mismatch_at = datetime.now(UTC)
    later_payment.support_reference = f"PAY-{str(later_payment.id)[:8].upper()}"
    later_payment.attention_notified_state = None
    await db_session.commit()

    reconciled = await reconcile_stuck_payments(db_session, rejected_provider)
    await db_session.refresh(rejected_payment)
    await db_session.refresh(later_payment)

    assert reconciled == 2
    assert rejected_payment.receipt_sync_pending is False
    assert later_payment.attention_notified_state == "provider_mismatch"

    owner = await db_session.get(type(payer), tournament.owner_account_id)
    assert owner is not None
    fastapi_app.dependency_overrides[get_current_user] = lambda: owner
    try:
        response = await api_client.get(
            f"/v1/tournaments/{tournament.id}/payment-problems"
        )
    finally:
        fastapi_app.dependency_overrides.pop(get_current_user, None)

    assert response.status_code == 200, response.text
    assert response.json()["items"] == [
        {
            "checkout_id": checkout["id"],
            "state": "receipt_sync_failed",
            "support_reference": rejected_payment.support_reference,
        }
    ]


@pytest.mark.parametrize("malformed_operation", ["receipt_update", "create", "cancel"])
async def test_malformed_provider_operation_is_quarantined_without_starving_sweep(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    malformed_operation: str,
) -> None:
    first_provider = FakePaymentProvider(f"pi_malformed_{malformed_operation}")
    _, _, _, first_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, first_provider
    )
    later_provider = FakePaymentProvider(f"pi_later_{malformed_operation}")
    _, _, _, later_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, later_provider
    )
    first_payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(first_checkout["id"])
        )
    )
    later_payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(later_checkout["id"])
        )
    )
    first_checkout_row = await db_session.get(
        TournamentCheckout, uuid.UUID(first_checkout["id"])
    )
    assert first_payment is not None
    assert later_payment is not None
    assert first_checkout_row is not None
    assert first_provider.intent is not None

    later_payment.state = TournamentPaymentState.failed
    later_payment.provider_mismatch_at = datetime.now(UTC)
    later_payment.support_reference = f"PAY-{str(later_payment.id)[:8].upper()}"
    later_payment.attention_notified_state = None
    if malformed_operation == "receipt_update":
        first_payment.state = TournamentPaymentState.canceled
        first_payment.provider_status = ProviderPaymentStatus.canceled
        first_payment.receipt_sync_pending = True
    elif malformed_operation == "create":
        first_payment.state = TournamentPaymentState.preparing
        first_payment.provider_payment_id = None
        first_payment.client_secret = None
        first_payment.provider_status = "create_uncertain"
    else:
        first_checkout_row.status = TournamentCheckoutStatus.expired
        first_checkout_row.created_at = datetime.now(UTC) - timedelta(minutes=20)
        first_checkout_row.expires_at = datetime.now(UTC) - timedelta(minutes=10)
    await db_session.commit()

    class MalformedOperationProvider(FakePaymentProvider):
        def __init__(self) -> None:
            super().__init__(first_provider.intent.id)
            self.intent = first_provider.intent

        async def retrieve_payment_intent(
            self, provider_payment_id: str
        ) -> FakeProviderIntent:
            assert malformed_operation != "create"
            assert provider_payment_id == first_payment.provider_payment_id
            assert self.intent is not None
            return self.intent

        async def find_payment_intent_by_durable_identity(
            self, durable_identity: str
        ) -> FakeProviderIntent:
            assert malformed_operation == "create"
            assert durable_identity == first_payment.durable_identity
            raise PaymentProviderNotFoundError

        async def create_payment_intent(self, request: object) -> FakeProviderIntent:
            raise PaymentProviderResponseInvalidError("malformed create response")

        async def update_payment_intent_receipt(
            self, provider_payment_id: str, receipt_email: str | None
        ) -> FakeProviderIntent:
            raise PaymentProviderResponseInvalidError("malformed receipt response")

        async def cancel_payment_intent(
            self, provider_payment_id: str
        ) -> FakeProviderIntent:
            raise PaymentProviderResponseInvalidError("malformed cancel response")

    reconciled = await reconcile_stuck_payments(
        db_session, MalformedOperationProvider()
    )
    await db_session.refresh(first_payment)
    await db_session.refresh(later_payment)

    assert reconciled == 2
    assert first_payment.provider_mismatch_at is not None
    assert first_payment.support_reference is not None
    if malformed_operation == "receipt_update":
        assert first_payment.receipt_sync_pending is True
    assert later_payment.attention_notified_state == "provider_mismatch"


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


async def test_fully_refunded_settlement_releases_hold_and_allows_replacement(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    provider = FakePaymentProvider()
    payer, tournament, (event,), checkout = await _prepared_checkout(
        api_client,
        db_session,
        monkeypatch,
        provider,
        fees=(Decimal("10.00"),),
        capacities=(1,),
    )
    other = await make_user(db_session, f"capacity-race-{uuid.uuid4().hex[:8]}")
    occupying_entry = TournamentEntry(event_id=event.id, user_id=other.player_id)
    db_session.add(occupying_entry)
    await db_session.commit()

    response = await _webhook(
        api_client, provider.event("evt_all_refused"), "test-valid-signature"
    )

    assert response.status_code == 200
    assert await _entry_facts(db_session, payer) == ([], 0)
    assert [amount for _, amount in await _refunds(db_session)] == [1000]
    stored_checkout = await db_session.get(
        TournamentCheckout, uuid.UUID(checkout["id"])
    )
    assert stored_checkout is not None
    assert stored_checkout.status is TournamentCheckoutStatus.invalidated

    # Capacity becoming available again must let the same payer replace the settled
    # quote immediately; a terminal payment must not leave its checkout holding the
    # partial unique index or counting toward event capacity until the deadline.
    await withdraw_from_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event.id,
        entry_id=occupying_entry.id,
        actor=other,
    )
    replacement = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={
            "request_id": str(uuid.uuid4()),
            "event_ids": [str(event.id)],
        },
    )
    assert replacement.status_code == 201, replacement.text
    assert replacement.json()["id"] != checkout["id"]


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
        api_client,
        db_session,
        monkeypatch,
        provider,
        payment_payload={"receipt_email": "authority-lost@example.net"},
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
    assert payment.create_receipt_email == "authority-lost@example.net"
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
    assert payment.receipt_email is None
    assert payment.create_receipt_email is None
    assert second_sweep == 0
    assert provider.retrievals == [payment.provider_payment_id]


async def test_authority_loss_does_not_cancel_until_receipt_pii_clear_is_verified(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    provider = FakePaymentProvider("pi_receipt_clear_rejected")
    _, _, _, checkout = await _prepared_checkout(
        api_client,
        db_session,
        monkeypatch,
        provider,
        payment_payload={"receipt_email": "private@example.net"},
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

    # Authority loss must clear provider PII before cancellation regardless of
    # whether a separate lifecycle cleanup already nulled the local desired
    # address. A permanent rejection is a manual-review blocker, not evidence
    # that the provider PII was cleared.
    stored.status = TournamentCheckoutStatus.expired
    stored.created_at = datetime.now(UTC) - timedelta(minutes=20)
    stored.expires_at = datetime.now(UTC) - timedelta(minutes=10)
    assert payment.receipt_email == "private@example.net"
    payment.receipt_sync_pending = False
    provider.receipt_update_error = PaymentProviderReceiptUpdateRejectedError(
        "provider refused receipt clear"
    )
    await db_session.commit()

    reconciled = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)

    assert reconciled == 1
    assert provider.receipt_updates[-1] == (provider.intent_id, None)
    assert provider.cancellations == []
    assert payment.state is TournamentPaymentState.ready
    assert payment.receipt_sync_pending is False
    assert payment.receipt_sync_failed_at is not None
    assert payment.support_reference is not None


@pytest.mark.parametrize(
    "provider_error",
    [
        PaymentProviderConfigurationError("provider credentials unavailable"),
        PaymentProviderResponseInvalidError("malformed receipt update response"),
    ],
    ids=["configuration", "malformed-response"],
)
async def test_receipt_pii_clear_provider_failure_remains_retryable_before_cancel(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    provider_error: Exception,
) -> None:
    provider = FakePaymentProvider("pi_receipt_clear_retry")
    _, _, _, checkout = await _prepared_checkout(
        api_client,
        db_session,
        monkeypatch,
        provider,
        payment_payload={"receipt_email": "private@example.net"},
    )
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert stored is not None
    assert payment is not None
    stored.status = TournamentCheckoutStatus.expired
    stored.created_at = datetime.now(UTC) - timedelta(minutes=20)
    stored.expires_at = datetime.now(UTC) - timedelta(minutes=10)
    provider.receipt_update_error = provider_error
    provider.receipt_updates.clear()
    await db_session.commit()

    first_sweep = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)

    assert first_sweep == 1
    assert provider.receipt_updates == [(provider.intent_id, None)]
    assert provider.cancellations == []
    assert payment.state is TournamentPaymentState.ready
    assert payment.receipt_email is None
    assert payment.receipt_sync_pending is True

    provider.receipt_update_error = None
    second_sweep = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)

    assert second_sweep == 1
    assert provider.receipt_updates == [
        (provider.intent_id, None),
        (provider.intent_id, None),
    ]
    assert provider.cancellations == [provider.intent_id]
    assert payment.state is TournamentPaymentState.canceled
    assert payment.receipt_sync_pending is False


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
    "retrieval_error",
    [
        pytest.param(TimeoutError("retrieve timed out"), id="timeout"),
        pytest.param(
            PaymentProviderUncertainError("retrieve outcome unknown"),
            id="uncertain",
        ),
    ],
)
async def test_uncertain_retrieval_releases_locks_before_later_obligation(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
    retrieval_error: Exception,
) -> None:
    first_provider = FakePaymentProvider("pi_uncertain_retrieve")
    _, _, _, first_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, first_provider
    )
    second_provider = FakePaymentProvider("pi_after_uncertain_retrieve")
    _, _, _, second_checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, second_provider
    )
    first_checkout_id = uuid.UUID(first_checkout["id"])
    second_checkout_id = uuid.UUID(second_checkout["id"])
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
    assert first_payment is not None
    assert second_payment is not None
    assert first_provider.intent is not None
    assert second_provider.intent is not None
    first_payment.created_at = datetime.now(UTC) - timedelta(minutes=2)
    second_payment.created_at = datetime.now(UTC) - timedelta(minutes=1)
    await db_session.commit()

    later_retrieve_entered = asyncio.Event()
    release_later_retrieve = asyncio.Event()

    class UncertainThenBlockingProvider:
        async def retrieve_payment_intent(
            self, provider_payment_id: str
        ) -> FakeProviderIntent:
            if provider_payment_id == first_payment.provider_payment_id:
                raise retrieval_error
            assert provider_payment_id == second_payment.provider_payment_id
            later_retrieve_entered.set()
            await release_later_retrieve.wait()
            return second_provider.intent

    sessions = async_sessionmaker(engine, expire_on_commit=False)
    provider = UncertainThenBlockingProvider()

    async def sweep() -> int:
        async with sessions() as session:
            return await reconcile_stuck_payments(  # type: ignore[arg-type]
                session, provider
            )

    sweeping = asyncio.create_task(sweep())
    first_lifecycle_lock_released = False
    try:
        await asyncio.wait_for(later_retrieve_entered.wait(), timeout=5)
        async with sessions() as concurrent_lifecycle_change:
            try:
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
            except TimeoutError:
                await concurrent_lifecycle_change.rollback()
            else:
                await concurrent_lifecycle_change.commit()
                first_lifecycle_lock_released = True
    finally:
        release_later_retrieve.set()
        await asyncio.gather(sweeping, return_exceptions=True)

    assert first_lifecycle_lock_released
    assert await sweeping == 1


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


async def test_sweep_preserves_intent_for_legacy_generation_zero_open_window(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    """Reconciliation shares the preparation path's legacy-open decision."""
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
    tournament.registration_open = False
    tournament.registration_generation = 0
    stored.registration_generation = 0
    await db_session.commit()

    reconciled = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(stored)
    await db_session.refresh(payment)

    assert reconciled == 1
    assert provider.cancellations == []
    assert stored.status is TournamentCheckoutStatus.active
    assert payment.state is TournamentPaymentState.ready


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
    assert provider.retrievals == [
        payment.provider_payment_id,
        payment.provider_payment_id,
    ]
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
                first_provider.intent.id: FakeProviderIntent(
                    **(
                        asdict(first_provider.intent)
                        | {"status": "requires_payment_method"}
                    )
                ),
                second_provider.intent.id: FakeProviderIntent(
                    **(
                        asdict(second_provider.intent)
                        | {"status": "requires_payment_method"}
                    )
                ),
            }
            self.retrievals: list[str] = []
            self.cancellations: list[str] = []

        async def retrieve_payment_intent(
            self, provider_payment_id: str
        ) -> FakeProviderIntent:
            self.retrievals.append(provider_payment_id)
            return self.intents[provider_payment_id]

        async def cancel_payment_intent(
            self, provider_payment_id: str
        ) -> FakeProviderIntent:
            self.cancellations.append(provider_payment_id)
            intent = self.intents[provider_payment_id]
            if provider_payment_id == "pi_cancel_race":
                self.intents[provider_payment_id] = FakeProviderIntent(
                    **(asdict(intent) | {"status": "succeeded"})
                )
                raise PaymentProviderCancellationRejectedError
            canceled = FakeProviderIntent(**(asdict(intent) | {"status": "canceled"}))
            self.intents[provider_payment_id] = canceled
            return canceled

    provider = RacingCancellationProvider()
    await db_session.commit()

    reconciled = await reconcile_stuck_payments(db_session, provider)  # type: ignore[arg-type]
    await db_session.refresh(first_payment)
    await db_session.refresh(second_payment)

    assert reconciled == 2
    assert set(provider.cancellations) == {"pi_cancel_race", "pi_later_obligation"}
    assert provider.retrievals.count(first_payment.provider_payment_id) == 2
    assert provider.retrievals.count(second_payment.provider_payment_id) == 1
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
            self, provider_payment_id: str
        ) -> FakeProviderIntent:
            assert provider_payment_id == payment.provider_payment_id
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
                first_provider.intent.id: first_provider.intent,
                second_provider.intent.id: second_provider.intent,
            }

        async def retrieve_payment_intent(
            self, provider_payment_id: str
        ) -> FakeProviderIntent:
            if provider_payment_id == second_payment.provider_payment_id:
                later_retrieve_entered.set()
                await release_later_retrieve.wait()
            return self.intents[provider_payment_id]

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
            self, provider_payment_id: str
        ) -> FakeProviderIntent:
            self.retrievals.append(provider_payment_id)
            if provider_payment_id == missing_provider.intent.id:
                if self.missing:
                    raise PaymentProviderNotFoundError
                return FakeProviderIntent(
                    **(asdict(missing_provider.intent) | {"status": "succeeded"})
                )
            assert provider_payment_id == later_provider.intent.id
            return FakeProviderIntent(
                **(asdict(later_provider.intent) | {"status": "succeeded"})
            )

        async def find_payment_intent_by_durable_identity(
            self, durable_identity: str
        ) -> FakeProviderIntent:
            self.identity_searches.append(durable_identity)
            assert durable_identity == missing_payment.durable_identity
            if self.missing:
                raise PaymentProviderNotFoundError
            return FakeProviderIntent(
                **(asdict(missing_provider.intent) | {"status": "succeeded"})
            )

        async def create_payment_intent(self, request: object) -> FakeProviderIntent:
            raise AssertionError("lost payer authority cannot recreate an intent")

    provider = MissingThenFoundProvider()

    first_sweep = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(missing_payment)
    await db_session.refresh(later_payment)

    assert first_sweep == 2
    assert provider.retrievals == (
        [missing_provider.intent.id, later_provider.intent.id]
        if bound
        else [later_provider.intent.id]
    )
    assert provider.identity_searches == (
        [] if bound else [missing_payment.durable_identity]
    )
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


async def _merge_payment_payer(db: AsyncSession, payer: User) -> User:
    survivor = await make_user(db, f"payment-survivor-{uuid.uuid4().hex[:8]}")
    payer.merged_into_user_id = survivor.id
    payer.merged_at = datetime.now(UTC)
    await db.commit()
    return survivor


async def _merge_payment_payer_twice(db: AsyncSession, payer: User) -> User:
    middle = await make_user(db, f"payment-middle-{uuid.uuid4().hex[:8]}")
    survivor = await make_user(db, f"payment-survivor-{uuid.uuid4().hex[:8]}")
    now = datetime.now(UTC)
    payer.merged_into_user_id = middle.id
    payer.merged_at = now
    middle.merged_into_user_id = survivor.id
    middle.merged_at = now
    await db.commit()
    return survivor


async def test_background_create_rejection_after_merge_notifies_and_hints_survivor(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
    fake_notifications_queue,
    realtime_broker: RealtimeBroker,
) -> None:
    initial_provider = FakePaymentProvider("pi_create_reject_merge_race")
    payer, _, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, initial_provider
    )
    survivor = await make_user(
        db_session, f"create-reject-survivor-{uuid.uuid4().hex[:8]}"
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    payment.provider_payment_id = None
    payment.client_secret = None
    payment.state = TournamentPaymentState.preparing
    payment.provider_status = "create_uncertain"
    await db_session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    class MergeDuringRejectedCreate(FakePaymentProvider):
        async def find_payment_intent_by_durable_identity(
            self, durable_identity: str
        ) -> FakeProviderIntent:
            assert durable_identity == payment.durable_identity
            raise PaymentProviderNotFoundError

        async def create_payment_intent(self, request: object) -> FakeProviderIntent:
            async with sessions() as concurrent:
                stale_payer = await concurrent.get(User, payer.id, with_for_update=True)
                assert stale_payer is not None
                stale_payer.merged_into_user_id = survivor.id
                stale_payer.merged_at = datetime.now(UTC)
                await concurrent.commit()
            raise PaymentProviderCreateRejectedError(
                "merchant rejected the idempotent create"
            )

    async with watch_hints(realtime_broker, payer.id, survivor.id) as watch:
        reconciled = await reconcile_stuck_payments(
            db_session, MergeDuringRejectedCreate()
        )
        hints = await watch.collect()
    await db_session.refresh(payment)
    jobs = enqueued_notification_jobs(fake_notifications_queue)

    assert reconciled == 1
    assert payment.state is TournamentPaymentState.failed
    assert payment.support_reference is not None
    assert [(job.user_id, job.category) for job in jobs] == [
        (survivor.id, NotificationCategory.PAYMENTS)
    ]
    assert hints[payer.id] == []
    assert hints[survivor.id] == [EventKind.dashboard_changed]
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    assert stored is not None
    assert stored.payer_account_id == payer.id


async def test_queued_checking_notice_reroutes_when_payer_merges_before_delivery(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    fake_notifications_queue,
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

    checking = await _webhook(
        api_client,
        provider.event("evt_merge_after_checking_enqueue", status="processing"),
        "test-valid-signature",
    )
    await db_session.refresh(payment)
    jobs = enqueued_notification_jobs(fake_notifications_queue)

    assert checking.status_code == 200, checking.text
    assert len(jobs) == 1
    assert jobs[0].user_id == payer.id
    assert payment.attention_notified_state == "checking"

    # The durable marker records successful enqueue, so a merge after this
    # point must be handled by the worker.  Silently no-oping the stale account
    # would permanently lose the notification while preventing re-enqueue.
    survivor = await _merge_payment_payer(db_session, payer)
    delivered = await NotificationService(db_session, FakeSender()).notify(
        **jobs[0].model_dump()
    )
    notices = list(
        await db_session.scalars(
            select(Notification).where(Notification.title == jobs[0].title)
        )
    )

    assert delivered.in_app_created is True
    assert [(notice.user_id, notice.category) for notice in notices] == [
        (survivor.id, NotificationCategory.PAYMENTS.value)
    ]
    assert payment.attention_notified_state == "checking"


async def test_queued_settlement_and_refund_notices_reroute_after_payer_merge(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    fake_notifications_queue,
) -> None:
    provider = FakePaymentProvider()
    payer, _, events, checkout = await _prepared_checkout(
        api_client,
        db_session,
        monkeypatch,
        provider,
        capacities=(1,),
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    competitor = await make_user(db_session, f"merge-race-{uuid.uuid4().hex[:8]}")
    db_session.add(TournamentEntry(event_id=events[0].id, user_id=competitor.player_id))
    await db_session.commit()

    settled = await _webhook(
        api_client,
        provider.event("evt_merge_after_settlement_enqueue", status="succeeded"),
        "test-valid-signature",
    )
    await db_session.refresh(payment)
    jobs = enqueued_notification_jobs(fake_notifications_queue)

    assert settled.status_code == 200, settled.text
    assert {job.category for job in jobs} == {
        NotificationCategory.TOURNAMENT,
        NotificationCategory.PAYMENTS,
    }
    assert {job.user_id for job in jobs} == {payer.id}
    assert payment.settlement_notified_at is not None
    assert payment.attention_notified_state == "refund_pending"

    survivor = await _merge_payment_payer(db_session, payer)
    delivery_results = [
        await NotificationService(db_session, FakeSender()).notify(**job.model_dump())
        for job in jobs
    ]
    notices = list(
        await db_session.scalars(
            select(Notification).where(
                Notification.title.in_([job.title for job in jobs])
            )
        )
    )

    assert all(result.in_app_created for result in delivery_results)
    assert sorted((notice.user_id, notice.category) for notice in notices) == sorted(
        [
            (survivor.id, NotificationCategory.TOURNAMENT.value),
            (survivor.id, NotificationCategory.PAYMENTS.value),
        ],
        key=lambda item: item[1],
    )
    assert payment.settlement_notified_at is not None
    assert payment.attention_notified_state == "refund_pending"


async def test_chained_merged_payer_recovery_routes_to_terminal_survivor(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    fake_notifications_queue,
) -> None:
    provider = FakePaymentProvider()
    payer, tournament, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    survivor = await _merge_payment_payer_twice(db_session, payer)

    checking = await _webhook(
        api_client,
        provider.event("evt_chained_merged_payer_checking", status="processing"),
        "test-valid-signature",
    )
    fastapi_app.dependency_overrides[get_current_user] = lambda: survivor
    try:
        recovery = await api_client.get("/v1/checkouts")
    finally:
        fastapi_app.dependency_overrides.pop(get_current_user, None)

    assert checking.status_code == 200, checking.text
    assert recovery.status_code == 200, recovery.text
    assert [item["checkout_id"] for item in recovery.json()["items"]] == [
        checkout["id"]
    ]
    assert recovery.json()["items"][0]["kind"] == "checking"
    jobs = enqueued_notification_jobs(fake_notifications_queue)
    assert [(job.user_id, job.category) for job in jobs] == [
        (survivor.id, NotificationCategory.PAYMENTS)
    ]
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    assert stored is not None
    assert stored.payer_account_id == payer.id
    assert stored.tournament_id == tournament.id


async def test_merged_payer_checking_recovery_routes_to_survivor(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    fake_notifications_queue,
) -> None:
    provider = FakePaymentProvider()
    payer, tournament, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    survivor = await _merge_payment_payer(db_session, payer)

    checking = await _webhook(
        api_client,
        provider.event("evt_merged_payer_checking", status="processing"),
        "test-valid-signature",
    )
    fastapi_app.dependency_overrides[get_current_user] = lambda: survivor
    try:
        recovery = await api_client.get("/v1/checkouts")
        linked_status = await api_client.get(_payment_url(tournament, checkout))
    finally:
        fastapi_app.dependency_overrides.pop(get_current_user, None)

    assert checking.status_code == 200, checking.text
    assert recovery.status_code == 200, recovery.text
    assert linked_status.status_code == 200, linked_status.text
    assert linked_status.json()["payment_state"] == "checking"
    assert [item["checkout_id"] for item in recovery.json()["items"]] == [
        checkout["id"]
    ]
    assert recovery.json()["items"][0]["kind"] == "checking"
    jobs = enqueued_notification_jobs(fake_notifications_queue)
    assert [(job.user_id, job.category) for job in jobs] == [
        (survivor.id, NotificationCategory.PAYMENTS)
    ]
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    assert stored is not None
    assert stored.payer_account_id == payer.id
    assert stored.tournament_id == tournament.id


async def test_reconciliation_hint_for_merged_payer_routes_to_survivor(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    realtime_broker: RealtimeBroker,
) -> None:
    initial_provider = FakePaymentProvider("pi_merged_reconcile_not_found")
    payer, _, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, initial_provider
    )
    survivor = await _merge_payment_payer(db_session, payer)
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None

    class MissingProvider(FakePaymentProvider):
        async def retrieve_payment_intent(
            self, provider_payment_id: str
        ) -> FakeProviderIntent:
            assert provider_payment_id == payment.provider_payment_id
            raise PaymentProviderNotFoundError

    async with watch_hints(realtime_broker, payer.id, survivor.id) as watch:
        reconciled = await reconcile_stuck_payments(db_session, MissingProvider())
        hints = await watch.collect()
    await db_session.refresh(payment)

    assert reconciled == 1
    assert payment.state is TournamentPaymentState.checking
    assert hints[payer.id] == []
    assert hints[survivor.id] == [EventKind.dashboard_changed]


async def test_merged_payer_settlement_and_refund_notices_route_to_survivor(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    fake_notifications_queue,
) -> None:
    provider = FakePaymentProvider()
    payer, _, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    survivor = await _merge_payment_payer(db_session, payer)
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None

    settled = await _webhook(
        api_client,
        provider.event("evt_merged_payer_settlement"),
        "test-valid-signature",
    )

    assert settled.status_code == 200, settled.text
    jobs = enqueued_notification_jobs(fake_notifications_queue)
    assert [(job.user_id, job.category) for job in jobs] == [
        (survivor.id, NotificationCategory.TOURNAMENT),
        (survivor.id, NotificationCategory.PAYMENTS),
    ]
    assert [amount for _, amount in await _refunds(db_session)] == [1234]
    await db_session.refresh(payment)
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    assert stored is not None
    assert stored.payer_account_id == payer.id
    assert payment.checkout_id == stored.id
    assert payment.state is TournamentPaymentState.succeeded


async def test_merged_payer_provider_mismatch_routes_to_survivor(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    fake_notifications_queue,
) -> None:
    provider = FakePaymentProvider()
    payer, _, _, checkout = await _prepared_checkout(
        api_client, db_session, monkeypatch, provider
    )
    survivor = await _merge_payment_payer(db_session, payer)

    mismatched = await _webhook(
        api_client,
        provider.event(
            "evt_merged_payer_mismatch",
            status="succeeded",
            amount_cents=4321,
        ),
        "test-valid-signature",
    )
    fastapi_app.dependency_overrides[get_current_user] = lambda: survivor
    try:
        recovery = await api_client.get("/v1/checkouts")
    finally:
        fastapi_app.dependency_overrides.pop(get_current_user, None)

    assert mismatched.status_code == 200, mismatched.text
    assert recovery.status_code == 200, recovery.text
    assert [item["checkout_id"] for item in recovery.json()["items"]] == [
        checkout["id"]
    ]
    assert recovery.json()["items"][0]["kind"] == "needs_review"
    jobs = enqueued_notification_jobs(fake_notifications_queue)
    assert [(job.user_id, job.category) for job in jobs] == [
        (survivor.id, NotificationCategory.PAYMENTS)
    ]
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    assert stored is not None
    assert stored.payer_account_id == payer.id
    assert [amount for _, amount in await _refunds(db_session)] == [4321]


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
