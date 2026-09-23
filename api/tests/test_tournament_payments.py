"""Behavioral contract for preparing and resuming a checkout payment.

The HTTP operation is the public seam.  ``FakePaymentProvider`` stands in only for
the external processor boundary; the tests deliberately do not mock Fortymm's own
payment or persistence modules.
"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass, is_dataclass, replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
)

import app.tournament_payment_reconciliation as payment_reconciliation
from app.db import get_session
from app.identity_lifecycle import erase_account
from app.leagues import get_default_league
from app.main import app as fastapi_app
from app.models import (
    DrawType,
    EventFormat,
    Tournament,
    TournamentCheckout,
    TournamentCheckoutStatus,
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
    PaymentProviderReceiptUpdateRejectedError,
    PaymentProviderUncertainError,
    ProviderPaymentEvent,
    ProviderPaymentIntent,
    ProviderPaymentStatus,
    get_payment_provider,
)
from app.realtime import EventKind, RealtimeBroker
from app.sessions import get_current_user
from app.tournament_authority import transfer_ownership
from app.tournament_event_stages import mint_stages
from app.tournament_payment_reconciliation import reconcile_stuck_payments
from tests._helpers import (
    enqueued_notification_jobs,
    make_client,
    make_user,
    start_session,
)
from tests._realtime import watch_hints

try:
    from app.payment_provider import PaymentProviderCreateRejectedError
except ImportError:  # The red test defines the provider contract production must add.

    class PaymentProviderCreateRejectedError(Exception):
        pass


@dataclass(frozen=True)
class FakeProviderIntent:
    """Provider result intentionally limited to facts Fortymm must retain."""

    id: str
    client_secret: str
    status: str = "requires_payment_method"
    amount_cents: int = 2345
    currency: str = "USD"
    merchant_account_id: str = ""
    livemode: bool = False
    durable_identity: str = ""


class FakePaymentProvider:
    """A narrow double for the injected payment-provider boundary."""

    def __init__(self) -> None:
        self.creates: list[dict[str, Any]] = []
        self.retrievals: list[str] = []
        self.receipt_updates: list[tuple[str, str | None]] = []
        self.intent = FakeProviderIntent(
            id="pi_checkout_1770",
            client_secret="pi_checkout_1770_secret_same_on_every_device",
        )
        self.create_error: Exception | None = None
        self.retrieved_intent: FakeProviderIntent | None = None
        self.retrieve_error: Exception | None = None
        self.receipt_update_error: Exception | None = None

    async def create_payment_intent(self, request: object) -> FakeProviderIntent:
        if isinstance(request, dict):
            recorded = dict(request)
        elif is_dataclass(request) and not isinstance(request, type):
            recorded = asdict(request)
        elif hasattr(request, "model_dump"):
            recorded = request.model_dump()
        else:
            recorded = vars(request)
        self.creates.append(recorded)
        self.intent = FakeProviderIntent(
            id=self.intent.id,
            client_secret=self.intent.client_secret,
            amount_cents=recorded["amount_cents"],
            currency=recorded["currency"],
            merchant_account_id=recorded["merchant_account_id"],
            durable_identity=recorded["idempotency_key"],
        )
        if self.create_error is not None:
            raise self.create_error
        return self.intent

    async def retrieve_payment_intent(
        self, durable_identity: str
    ) -> FakeProviderIntent:
        self.retrievals.append(durable_identity)
        if self.retrieve_error is not None:
            raise self.retrieve_error
        return self.retrieved_intent or self.intent

    async def update_payment_intent_receipt(
        self, provider_payment_id: str, receipt_email: str | None
    ) -> FakeProviderIntent:
        self.receipt_updates.append((provider_payment_id, receipt_email))
        if self.receipt_update_error is not None:
            raise self.receipt_update_error
        return self.intent


class BlockingNotFoundProvider(FakePaymentProvider):
    """Lets a terminal webhook commit before an in-flight lookup says absent."""

    def __init__(self) -> None:
        super().__init__()
        self.block_retrieval = False
        self.retrieve_entered = asyncio.Event()
        self.release_retrieve = asyncio.Event()
        self.webhook_intent: ProviderPaymentIntent | None = None

    async def retrieve_payment_intent(
        self, durable_identity: str
    ) -> FakeProviderIntent:
        if not self.block_retrieval:
            return await super().retrieve_payment_intent(durable_identity)
        self.retrievals.append(durable_identity)
        self.retrieve_entered.set()
        await self.release_retrieve.wait()
        raise PaymentProviderNotFoundError()

    async def verify_webhook(
        self, payload: bytes, signature: str | None
    ) -> ProviderPaymentEvent:
        assert signature == "test-valid-signature"
        assert self.webhook_intent is not None
        return ProviderPaymentEvent(
            id=payload.decode(),
            type=f"payment_intent.{self.webhook_intent.status.value}",
            created_at=datetime.now(UTC),
            payment=self.webhook_intent,
        )


def _terminal_intent(
    provider: FakePaymentProvider, state: TournamentPaymentState
) -> ProviderPaymentIntent:
    status = (
        ProviderPaymentStatus.canceled
        if state is TournamentPaymentState.canceled
        else ProviderPaymentStatus.succeeded
    )
    return ProviderPaymentIntent(
        id=provider.intent.id,
        client_secret=provider.intent.client_secret,
        status=status,
        amount_cents=(2346 if state is TournamentPaymentState.failed else 2345),
        currency=provider.intent.currency,
        merchant_account_id=provider.intent.merchant_account_id,
        livemode=provider.intent.livemode,
        durable_identity=provider.intent.durable_identity,
    )


def _production_intent(
    provider: FakePaymentProvider,
    status: ProviderPaymentStatus,
    **changes: object,
) -> ProviderPaymentIntent:
    """Build the same concrete value returned by the production adapter."""
    values: dict[str, object] = asdict(provider.intent)
    values.update(changes)
    values["status"] = status
    return ProviderPaymentIntent(**values)  # type: ignore[arg-type]


async def _commit_terminal_webhook(
    api_client: AsyncClient,
    provider: BlockingNotFoundProvider,
    state: TournamentPaymentState,
) -> None:
    provider.webhook_intent = _terminal_intent(provider, state)
    webhook = await api_client.post(
        "/v1/webhooks/stripe",
        content=f"evt_not_found_race_{state.value}_{uuid.uuid4().hex}",
        headers={"stripe-signature": "test-valid-signature"},
    )
    assert webhook.status_code == 200, webhook.text


async def _paid_checkout(
    api_client: AsyncClient,
    db: AsyncSession,
    monkeypatch,
    *,
    payer: User | None = None,
    payer_email: str | None = None,
) -> tuple[User, Tournament, dict[str, Any]]:
    payer = payer or await start_session(api_client, db)
    if payer_email is not None:
        payer.email = payer_email
        payer.confirmed_at = datetime.now(UTC)
        await db.commit()
    owner = await make_user(db, f"payment-merchant-{uuid.uuid4().hex[:8]}")
    league = await get_default_league(db)
    assert league is not None
    tournament = Tournament(
        name="Payment preparation",
        status=TournamentStatus.published,
        registration_open=True,
        registration_generation=1,
        league_id=league.id,
        created_by_user_id=owner.id,
    )
    db.add(tournament)
    await db.flush()
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.single_elim),
        stages=mint_stages(DrawType.single_elim),
        entry_fee=Decimal("23.45"),
        timezone="America/Chicago",
        slot={"date": "2030-04-20", "start": "09:00", "end": "17:00"},
        match_settings={"rated": True, "length_games": 5},
        predicates=[],
    )
    db.add(event)
    await db.commit()
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    created = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={"request_id": str(uuid.uuid4()), "event_ids": [str(event.id)]},
    )
    assert created.status_code == 201, created.text
    return payer, tournament, created.json()


def _payment_url(tournament: Tournament, checkout: dict[str, Any]) -> str:
    return f"/v1/tournaments/{tournament.id}/checkouts/{checkout['id']}/payment"


def _install_provider(provider: FakePaymentProvider) -> None:
    """Override the provider dependency without coupling to its module location."""
    fastapi_app.dependency_overrides[get_payment_provider] = lambda: provider


async def test_prepare_uses_server_owned_card_only_contract_and_resumes_one_intent(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    payer, tournament, checkout = await _paid_checkout(
        api_client,
        db_session,
        monkeypatch,
        payer_email="payer@example.com",
    )
    provider = FakePaymentProvider()
    _install_provider(provider)

    prepared = await api_client.post(_payment_url(tournament, checkout), json={})
    assert prepared.status_code == 200, prepared.text
    assert prepared.json()["payment_state"] == "ready"
    assert prepared.json()["client_secret"] == provider.intent.client_secret
    assert prepared.json()["receipt_email"] == "payer@example.com"

    # A second browser for the same authenticated payer gets the durable payment,
    # not a new processor object or a rotated secret.
    async with make_client() as another_device:
        another_device.cookies.update(api_client.cookies)
        resumed = await another_device.post(_payment_url(tournament, checkout), json={})
    assert resumed.status_code == 200, resumed.text
    assert resumed.json() == prepared.json()
    assert len(provider.creates) == 1

    create = provider.creates[0]
    assert create["amount_cents"] == 2345
    assert create["currency"] == "USD"
    assert create["merchant_account_id"] == str(tournament.owner_account_id)
    assert create["payment_method_types"] == ["card"]
    assert create["save_payment_method"] is False
    assert create["idempotency_key"]
    assert str(checkout["id"]) in create["idempotency_key"]

    checkout_read = await api_client.get(
        f"/v1/tournaments/{tournament.id}/checkouts/{checkout['id']}"
    )
    assert checkout_read.status_code == 200
    assert "client_secret" not in checkout_read.json()
    assert payer.email == "payer@example.com"


async def test_prepare_accepts_legacy_generation_zero_registration_window(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    """A false raw flag at generation zero is the legacy published-open shape."""
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    assert stored is not None
    tournament.registration_open = False
    tournament.registration_generation = 0
    stored.registration_generation = 0
    await db_session.commit()
    provider = FakePaymentProvider()
    _install_provider(provider)

    prepared = await api_client.post(_payment_url(tournament, checkout), json={})
    await db_session.refresh(stored)

    assert prepared.status_code == 200, prepared.text
    assert prepared.json()["payment_state"] == "ready"
    assert stored.status is TournamentCheckoutStatus.active
    assert len(provider.creates) == 1


async def test_prepare_is_payer_only_and_never_discloses_the_client_secret(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    _install_provider(provider)

    owner_read = await api_client.post(_payment_url(tournament, checkout), json={})
    assert owner_read.status_code == 200, owner_read.text

    async with make_client() as stranger:
        await start_session(stranger, db_session)
        refused = await stranger.post(_payment_url(tournament, checkout), json={})

    assert refused.status_code == 404
    assert len(provider.creates) == 1
    assert provider.intent.client_secret not in refused.text


async def test_concrete_checking_response_emits_one_attention_transition(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    _install_provider(provider)
    original_create = provider.create_payment_intent

    async def create_checking_intent(request: object) -> ProviderPaymentIntent:
        await original_create(request)
        return _production_intent(provider, ProviderPaymentStatus.processing)

    dashboard_transitions: list[tuple[uuid.UUID, object]] = []
    attention_notifications: list[object] = []

    def record_dashboard_transition(
        _db: AsyncSession, user_id: uuid.UUID, kind: object
    ) -> None:
        dashboard_transitions.append((user_id, kind))

    def record_attention_notification(job: object) -> bool:
        attention_notifications.append(job)
        return True

    monkeypatch.setattr(provider, "create_payment_intent", create_checking_intent)
    monkeypatch.setattr(
        payment_reconciliation,
        "stage_event",
        record_dashboard_transition,
    )
    monkeypatch.setattr(
        payment_reconciliation,
        "enqueue_notification_job",
        record_attention_notification,
    )

    prepared = await api_client.post(_payment_url(tournament, checkout), json={})

    assert prepared.status_code == 200, prepared.text
    assert prepared.json()["payment_state"] == "checking"
    assert len(attention_notifications) == 1
    assert len(dashboard_transitions) == 1


async def test_receipt_destination_defaults_edits_clears_and_does_not_change_account(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    payer, tournament, checkout = await _paid_checkout(
        api_client,
        db_session,
        monkeypatch,
        payer_email="account@example.com",
    )
    provider = FakePaymentProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)

    defaulted = await api_client.post(url, json={})
    edited = await api_client.post(url, json={"receipt_email": "desk@example.net"})
    cleared = await api_client.post(url, json={"receipt_email": None})

    assert defaulted.status_code == edited.status_code == cleared.status_code == 200
    assert defaulted.json()["receipt_email"] == "account@example.com"
    assert edited.json()["receipt_email"] == "desk@example.net"
    assert cleared.json()["receipt_email"] is None
    await db_session.refresh(payer)
    assert payer.email == "account@example.com"
    assert len(provider.creates) == 1
    assert provider.receipt_updates == [
        (provider.intent.id, "desk@example.net"),
        (provider.intent.id, None),
    ]


async def test_merged_survivor_payment_recovery_is_explicitly_read_only(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    payer, tournament, checkout = await _paid_checkout(
        api_client, db_session, monkeypatch
    )
    provider = FakePaymentProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    assert (await api_client.post(url, json={})).status_code == 200
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    payment.state = TournamentPaymentState.checking
    survivor = await make_user(db_session, f"receipt-survivor-{uuid.uuid4().hex[:8]}")
    payer.merged_into_user_id = survivor.id
    payer.merged_at = datetime.now(UTC)
    await db_session.commit()

    fastapi_app.dependency_overrides[get_current_user] = lambda: survivor
    try:
        recovered = await api_client.get(url)
    finally:
        fastapi_app.dependency_overrides.pop(get_current_user, None)

    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["receipt_editable"] is False


@pytest.mark.parametrize(
    "provider_error",
    [
        TimeoutError("receipt update result unknown"),
        PaymentProviderUncertainError("receipt update may have landed"),
    ],
)
async def test_uncertain_receipt_update_keeps_desired_email_and_returns_payment(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    provider_error: Exception,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    prepared = await api_client.post(url, json={})
    assert prepared.status_code == 200, prepared.text
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    provider.receipt_update_error = provider_error

    updated = await api_client.post(url, json={"receipt_email": "durable@example.net"})

    assert updated.status_code == 200, updated.text
    assert updated.json()["receipt_email"] == "durable@example.net"
    await db_session.refresh(payment)
    assert payment.receipt_email == "durable@example.net"
    assert provider.receipt_updates[-1] == (
        provider.intent.id,
        "durable@example.net",
    )


@pytest.mark.parametrize(
    ("payer_email", "desired_email"),
    [
        (None, "durable@example.net"),
        ("original@example.com", None),
    ],
)
async def test_uncertain_receipt_update_is_retried_after_terminal_success(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    payer_email: str | None,
    desired_email: str | None,
) -> None:
    _, tournament, checkout = await _paid_checkout(
        api_client,
        db_session,
        monkeypatch,
        payer_email=payer_email,
    )
    provider = FakePaymentProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    assert (await api_client.post(url, json={})).status_code == 200
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None

    provider.receipt_update_error = TimeoutError("receipt result unknown")
    changed = await api_client.post(url, json={"receipt_email": desired_email})

    assert changed.status_code == 200, changed.text
    await db_session.refresh(payment)
    assert payment.receipt_email == desired_email
    assert payment.receipt_sync_pending is True
    calls_after_edit = len(provider.receipt_updates)

    # Settlement must not erase the provider-sync obligation. The same sweep
    # that learns terminal truth retries it and preserves pending on uncertainty.
    provider.intent = replace(provider.intent, status="succeeded")
    first_sweep = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)

    assert first_sweep == 1
    assert payment.state is TournamentPaymentState.succeeded
    assert payment.receipt_sync_pending is True
    assert len(provider.receipt_updates) == calls_after_edit + 1
    assert provider.receipt_updates[-1] == (provider.intent.id, desired_email)

    # A terminal payment remains sweepable until the provider confirms the
    # newest desired value; only that confirmation clears the durable marker.
    provider.receipt_update_error = None
    second_sweep = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)

    assert second_sweep == 1
    assert payment.state is TournamentPaymentState.succeeded
    assert payment.receipt_sync_pending is False
    assert provider.receipt_updates[-1] == (provider.intent.id, desired_email)


async def test_explicit_receipt_edit_retries_provider_sync_after_failure(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    assert (await api_client.post(url, json={})).status_code == 200

    provider.receipt_update_error = RuntimeError("provider unavailable")
    with pytest.raises(RuntimeError, match="provider unavailable"):
        await api_client.post(url, json={"receipt_email": "retry@example.net"})

    provider.receipt_update_error = None
    retried = await api_client.post(url, json={"receipt_email": "retry@example.net"})

    assert retried.status_code == 200, retried.text
    assert provider.receipt_updates == [
        (provider.intent.id, "retry@example.net"),
        (provider.intent.id, "retry@example.net"),
    ]


async def test_new_receipt_choice_clears_stale_manual_review_marker(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    assert (await api_client.post(url, json={})).status_code == 200
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    payment.receipt_sync_failed_at = datetime.now(UTC) - timedelta(minutes=5)
    await db_session.commit()

    # The new desired value owns a fresh sync attempt. If its provider result is
    # uncertain, it stays pending without retaining the obsolete operator alert.
    provider.receipt_update_error = TimeoutError("new receipt result unknown")
    changed = await api_client.post(
        url, json={"receipt_email": "new-choice@example.net"}
    )

    assert changed.status_code == 200, changed.text
    await db_session.refresh(payment)
    assert payment.receipt_email == "new-choice@example.net"
    assert payment.receipt_sync_pending is True
    assert payment.receipt_sync_failed_at is None


async def test_concurrent_receipt_edits_leave_provider_at_current_desired_email(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    url = _payment_url(tournament, checkout)
    provider = FakePaymentProvider()
    _install_provider(provider)
    assert (await api_client.post(url, json={})).status_code == 200

    first_update_entered = asyncio.Event()
    release_first_update = asyncio.Event()
    provider_receipt_email: str | None = None
    original_update = provider.update_payment_intent_receipt

    async def reorder_updates(
        provider_payment_id: str, receipt_email: str | None
    ) -> FakeProviderIntent:
        nonlocal provider_receipt_email
        if receipt_email == "first@example.net":
            first_update_entered.set()
            await release_first_update.wait()
        intent = await original_update(provider_payment_id, receipt_email)
        provider_receipt_email = receipt_email
        return intent

    monkeypatch.setattr(provider, "update_payment_intent_receipt", reorder_updates)
    make_session = async_sessionmaker(engine, expire_on_commit=False)

    async def independent_session() -> AsyncIterator[AsyncSession]:
        async with make_session() as session:
            yield session

    # Concurrent HTTP requests need independent transactions. The ordinary test
    # client intentionally shares one fixture session for simpler assertions.
    fastapi_app.dependency_overrides[get_session] = independent_session
    async with make_client() as other_device:
        other_device.cookies.update(api_client.cookies)
        first = asyncio.create_task(
            api_client.post(url, json={"receipt_email": "first@example.net"})
        )
        try:
            await asyncio.wait_for(first_update_entered.wait(), timeout=5)
            second = await other_device.post(
                url, json={"receipt_email": "current@example.net"}
            )
            assert second.status_code == 200, second.text
        finally:
            release_first_update.set()
        first_response = await first

    assert first_response.status_code == 200, first_response.text
    async with make_session() as observer:
        desired_email = await observer.scalar(
            select(TournamentPayment.receipt_email).where(
                TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
            )
        )
    assert desired_email == "current@example.net"
    assert provider_receipt_email == desired_email


async def test_stale_receipt_rejection_cannot_terminalize_newer_edit(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    url = _payment_url(tournament, checkout)
    provider = FakePaymentProvider()
    _install_provider(provider)
    assert (await api_client.post(url, json={})).status_code == 200

    stale_update_entered = asyncio.Event()
    release_stale_update = asyncio.Event()

    async def reject_stale_update(
        provider_payment_id: str, receipt_email: str | None
    ) -> FakeProviderIntent:
        provider.receipt_updates.append((provider_payment_id, receipt_email))
        if receipt_email == "stale@example.net":
            stale_update_entered.set()
            await release_stale_update.wait()
            raise PaymentProviderReceiptUpdateRejectedError()
        if receipt_email == "current@example.net":
            raise TimeoutError("newer receipt result remains uncertain")
        return provider.intent

    monkeypatch.setattr(provider, "update_payment_intent_receipt", reject_stale_update)
    make_session = async_sessionmaker(engine, expire_on_commit=False)

    async def independent_session() -> AsyncIterator[AsyncSession]:
        async with make_session() as session:
            yield session

    fastapi_app.dependency_overrides[get_session] = independent_session
    async with make_client() as other_device:
        other_device.cookies.update(api_client.cookies)
        stale = asyncio.create_task(
            api_client.post(url, json={"receipt_email": "stale@example.net"})
        )
        try:
            await asyncio.wait_for(stale_update_entered.wait(), timeout=5)
            current = await other_device.post(
                url, json={"receipt_email": "current@example.net"}
            )
            assert current.status_code == 200, current.text
        finally:
            release_stale_update.set()
        stale_response = await stale

    assert stale_response.status_code == 200, stale_response.text
    async with make_session() as observer:
        payment = await observer.scalar(
            select(TournamentPayment).where(
                TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
            )
        )
    assert payment is not None
    assert payment.receipt_email == "current@example.net"
    assert payment.receipt_sync_pending is True
    assert payment.receipt_sync_failed_at is None


async def test_receipt_sync_bounds_continuous_concurrent_edits_and_remains_retryable(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    assert (await api_client.post(url, json={})).status_code == 200
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    make_session = async_sessionmaker(engine, expire_on_commit=False)
    original_update = provider.update_payment_intent_receipt
    forced_receipts: list[str] = []
    provider_receipt: str | None = None

    async def continuously_change_desired_receipt(
        provider_payment_id: str, receipt_email: str | None
    ) -> FakeProviderIntent:
        nonlocal provider_receipt
        intent = await original_update(provider_payment_id, receipt_email)
        provider_receipt = receipt_email
        # Keep changing longer than any acceptable per-request retry budget,
        # then stop so the pre-fix unbounded loop fails by call count without
        # leaving a cancelled database request behind in the shared fixture.
        if len(forced_receipts) >= 8:
            return intent
        forced_receipt = f"concurrent-{len(forced_receipts)}@example.net"
        forced_receipts.append(forced_receipt)
        async with make_session() as concurrent_change:
            current = await concurrent_change.get(TournamentPayment, payment.id)
            assert current is not None
            current.receipt_email = forced_receipt
            await concurrent_change.commit()
        return intent

    monkeypatch.setattr(
        provider,
        "update_payment_intent_receipt",
        continuously_change_desired_receipt,
    )

    response = await api_client.post(
        url, json={"receipt_email": "requested@example.net"}
    )

    assert response.status_code == 200, response.text
    assert 1 <= len(forced_receipts) <= 5
    async with make_session() as observer:
        durable_receipt = await observer.scalar(
            select(TournamentPayment.receipt_email).where(
                TournamentPayment.id == payment.id
            )
        )
    assert durable_receipt == forced_receipts[-1]
    assert response.json()["receipt_email"] == durable_receipt
    assert provider_receipt != durable_receipt

    # The desired value is durable even when one request cannot converge under
    # nonstop writers. A later ordinary prepare retries and repairs the provider.
    monkeypatch.setattr(provider, "update_payment_intent_receipt", original_update)
    calls_before_retry = len(provider.receipt_updates)
    retried = await api_client.post(url, json={"receipt_email": durable_receipt})

    assert retried.status_code == 200, retried.text
    assert len(provider.receipt_updates) == calls_before_retry + 1
    assert provider.receipt_updates[-1] == (provider.intent.id, durable_receipt)


async def test_checkout_without_email_can_prepare_payment(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    _install_provider(provider)

    prepared = await api_client.post(_payment_url(tournament, checkout), json={})

    assert prepared.status_code == 200, prepared.text
    assert prepared.json()["receipt_email"] is None
    assert prepared.json()["client_secret"] == provider.intent.client_secret


async def test_resume_retrieves_provider_when_bound_payment_lacks_client_secret(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    assert (await api_client.post(url, json={})).status_code == 200
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    payment.client_secret = None
    provider.retrievals.clear()
    await db_session.commit()

    resumed = await api_client.post(url, json={})

    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["client_secret"] == provider.intent.client_secret
    assert provider.retrievals == [payment.durable_identity]


async def test_bound_payment_missing_secret_survives_provider_lookup_not_found(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    assert (await api_client.post(url, json={})).status_code == 200
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    assert payment.provider_payment_id == provider.intent.id
    payment.client_secret = None
    provider.retrieve_error = PaymentProviderNotFoundError()
    creates_before_resume = len(provider.creates)
    await db_session.commit()

    resumed = await api_client.post(url, json={})

    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["payment_state"] == "checking"
    assert resumed.json()["client_secret"] is None
    assert len(provider.creates) == creates_before_resume
    await db_session.refresh(payment)
    assert payment.provider_payment_id == provider.intent.id


@pytest.mark.parametrize("response_seam", ["prepare", "receipt", "recovery"])
@pytest.mark.parametrize("invariant_mismatch", [False, True])
async def test_concrete_success_response_reconciles_before_becoming_terminal(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    response_seam: str,
    invariant_mismatch: bool,
) -> None:
    payer, tournament, checkout = await _paid_checkout(
        api_client, db_session, monkeypatch
    )
    provider = FakePaymentProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    original_create = provider.create_payment_intent

    async def create_with_concrete_success(request: object) -> ProviderPaymentIntent:
        await original_create(request)
        return _production_intent(
            provider,
            ProviderPaymentStatus.succeeded,
            amount_cents=(2346 if invariant_mismatch else 2345),
        )

    if response_seam == "prepare":
        monkeypatch.setattr(
            provider, "create_payment_intent", create_with_concrete_success
        )
        response = await api_client.post(url, json={})
    else:
        prepared = await api_client.post(url, json={})
        assert prepared.status_code == 200, prepared.text
        concrete_success = _production_intent(
            provider,
            ProviderPaymentStatus.succeeded,
            amount_cents=(2346 if invariant_mismatch else 2345),
        )
        if response_seam == "receipt":

            async def update_with_concrete_success(
                provider_payment_id: str, receipt_email: str | None
            ) -> ProviderPaymentIntent:
                return concrete_success

            monkeypatch.setattr(
                provider,
                "update_payment_intent_receipt",
                update_with_concrete_success,
            )
            response = await api_client.post(
                url, json={"receipt_email": "settled@example.net"}
            )
        else:
            payment = await db_session.scalar(
                select(TournamentPayment).where(
                    TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
                )
            )
            assert payment is not None
            payment.client_secret = None
            provider.retrieved_intent = concrete_success  # type: ignore[assignment]
            await db_session.commit()
            response = await api_client.post(url, json={})

    assert response.status_code == 200, response.text
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    entry_count = int(
        await db_session.scalar(
            text(
                "SELECT count(*) FROM tournament_entry_members "
                "WHERE player_id = :user_id AND left_at IS NULL"
            ),
            {"user_id": payer.player_id},
        )
        or 0
    )
    refunded = int(
        await db_session.scalar(
            text(
                "SELECT coalesce(sum(amount_cents), 0) "
                "FROM tournament_refund_obligations WHERE payment_id = :payment_id"
            ),
            {"payment_id": payment.id},
        )
        or 0
    )
    if invariant_mismatch and response_seam == "prepare":
        assert response.json()["payment_state"] == "preparing"
        assert response.json()["support_reference"]
        assert payment.provider_payment_id is None
        assert entry_count == 0
        assert refunded == 0
    elif invariant_mismatch:
        assert response.json()["payment_state"] == "failed"
        assert response.json()["support_reference"]
        assert entry_count == 0
        assert refunded == 2346
    else:
        assert response.json()["payment_state"] == "succeeded"
        assert response.json()["lines"][0]["outcome"] == "confirmed"
        assert entry_count == 1
        assert refunded == 0


@pytest.mark.parametrize(
    ("changed_field", "changed_value"),
    [
        ("durable_identity", "checkout_payment:unrelated"),
        ("merchant_account_id", str(uuid.uuid4())),
        ("livemode", True),
        ("amount_cents", 2346),
        ("currency", "EUR"),
    ],
)
async def test_uncertain_create_recovery_does_not_bind_unassociated_intent(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    changed_field: str,
    changed_value: object,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    provider.create_error = TimeoutError("provider result unknown")
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    uncertain = await api_client.post(url, json={})
    assert uncertain.status_code == 200, uncertain.text
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    assert payment.provider_payment_id is None
    original_status = payment.provider_status
    original_secret = payment.client_secret

    provider.create_error = None
    provider.retrieved_intent = _production_intent(  # type: ignore[assignment]
        provider,
        ProviderPaymentStatus.succeeded,
        **{changed_field: changed_value},
    )

    recovered = await api_client.post(url, json={})

    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["payment_state"] == "preparing"
    assert recovered.json()["client_secret"] == original_secret
    await db_session.refresh(payment)
    assert payment.provider_payment_id is None
    assert payment.provider_status == original_status
    assert payment.client_secret == original_secret
    refunded = await db_session.scalar(
        text(
            "SELECT coalesce(sum(amount_cents), 0) "
            "FROM tournament_refund_obligations WHERE payment_id = :payment_id"
        ),
        {"payment_id": payment.id},
    )
    assert refunded == 0


async def test_bound_secret_recovery_rejects_a_different_provider_intent_id(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    assert (await api_client.post(url, json={})).status_code == 200
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    original_provider_id = payment.provider_payment_id
    payment.client_secret = None
    payment.provider_status = ProviderPaymentStatus.requires_action.value
    original_provider_status = payment.provider_status
    different_secret = "pi_unrelated_secret_must_not_escape"
    provider.retrieved_intent = _production_intent(  # type: ignore[assignment]
        provider,
        ProviderPaymentStatus.requires_payment_method,
        id="pi_unrelated",
        client_secret=different_secret,
    )
    await db_session.commit()

    response = await api_client.post(url, json={})

    assert response.status_code == 200, response.text
    assert response.json()["payment_state"] == "checking"
    assert response.json()["client_secret"] is None
    assert response.json()["support_reference"]
    assert different_secret not in response.text
    await db_session.refresh(payment)
    assert payment.provider_payment_id == original_provider_id
    assert payment.provider_status == original_provider_status
    assert payment.client_secret is None


async def test_concrete_canceled_mismatch_is_quarantined_during_prepare(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    _install_provider(provider)
    original_create = provider.create_payment_intent

    async def create_with_canceled_mismatch(request: object) -> ProviderPaymentIntent:
        await original_create(request)
        return _production_intent(
            provider,
            ProviderPaymentStatus.canceled,
            amount_cents=2346,
        )

    monkeypatch.setattr(
        provider, "create_payment_intent", create_with_canceled_mismatch
    )

    response = await api_client.post(_payment_url(tournament, checkout), json={})

    assert response.status_code == 200, response.text
    assert response.json()["payment_state"] == "preparing"
    assert response.json()["support_reference"]
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    assert payment.provider_payment_id is None
    assert payment.state is TournamentPaymentState.preparing
    assert payment.attention_notified_state == "provider_mismatch"


async def test_bound_secret_recovery_revalidates_authority_after_provider_io(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    assert (await api_client.post(url, json={})).status_code == 200
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    payment.client_secret = None
    await db_session.commit()

    retrieve_entered = asyncio.Event()
    release_retrieve = asyncio.Event()
    original_retrieve = provider.retrieve_payment_intent

    async def blocking_retrieve(durable_identity: str) -> FakeProviderIntent:
        retrieve_entered.set()
        await release_retrieve.wait()
        return await original_retrieve(durable_identity)

    monkeypatch.setattr(provider, "retrieve_payment_intent", blocking_retrieve)
    make_session = async_sessionmaker(engine, expire_on_commit=False)

    async def independent_session() -> AsyncIterator[AsyncSession]:
        async with make_session() as session:
            yield session

    fastapi_app.dependency_overrides[get_session] = independent_session
    recovering = asyncio.create_task(api_client.post(url, json={}))
    try:
        await asyncio.wait_for(retrieve_entered.wait(), timeout=5)
        async with make_session() as concurrent_change:
            current = await concurrent_change.get(Tournament, tournament.id)
            assert current is not None
            current.registration_open = False
            await concurrent_change.commit()
    finally:
        release_retrieve.set()
    response = await recovering

    assert response.status_code == 404
    assert provider.intent.client_secret not in response.text
    async with make_session() as observer:
        persisted = await observer.get(TournamentPayment, payment.id)
        assert persisted is not None
        assert persisted.provider_payment_id == provider.intent.id
        assert persisted.state in {
            TournamentPaymentState.ready,
            TournamentPaymentState.action_required,
            TournamentPaymentState.checking,
        }


async def test_uncertain_create_recovery_revalidates_authority_after_provider_io(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    provider.create_error = TimeoutError("provider result unknown")
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    uncertain = await api_client.post(url, json={})
    assert uncertain.status_code == 200, uncertain.text
    assert uncertain.json()["payment_state"] == "preparing"
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    assert payment.provider_payment_id is None

    retrieve_entered = asyncio.Event()
    release_retrieve = asyncio.Event()
    provider.create_error = None
    provider.retrieved_intent = provider.intent
    original_retrieve = provider.retrieve_payment_intent

    async def blocking_retrieve(durable_identity: str) -> FakeProviderIntent:
        retrieve_entered.set()
        await release_retrieve.wait()
        return await original_retrieve(durable_identity)

    monkeypatch.setattr(provider, "retrieve_payment_intent", blocking_retrieve)
    make_session = async_sessionmaker(engine, expire_on_commit=False)

    async def independent_session() -> AsyncIterator[AsyncSession]:
        async with make_session() as session:
            yield session

    fastapi_app.dependency_overrides[get_session] = independent_session
    recovering = asyncio.create_task(api_client.post(url, json={}))
    try:
        await asyncio.wait_for(retrieve_entered.wait(), timeout=5)
        async with make_session() as concurrent_change:
            current = await concurrent_change.get(Tournament, tournament.id)
            assert current is not None
            current.registration_open = False
            await concurrent_change.commit()
    finally:
        release_retrieve.set()
    response = await recovering

    assert response.status_code == 404
    assert provider.intent.client_secret not in response.text
    async with make_session() as observer:
        persisted = await observer.get(TournamentPayment, payment.id)
        assert persisted is not None
        assert persisted.provider_payment_id == provider.intent.id
        assert persisted.state in {
            TournamentPaymentState.ready,
            TournamentPaymentState.action_required,
            TournamentPaymentState.checking,
        }


async def test_receipt_update_revalidates_authority_after_provider_io(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    assert (await api_client.post(url, json={})).status_code == 200
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None

    update_entered = asyncio.Event()
    release_update = asyncio.Event()
    original_update = provider.update_payment_intent_receipt

    async def blocking_update(
        provider_payment_id: str, receipt_email: str | None
    ) -> FakeProviderIntent:
        update_entered.set()
        await release_update.wait()
        return await original_update(provider_payment_id, receipt_email)

    monkeypatch.setattr(provider, "update_payment_intent_receipt", blocking_update)
    make_session = async_sessionmaker(engine, expire_on_commit=False)

    async def independent_session() -> AsyncIterator[AsyncSession]:
        async with make_session() as session:
            yield session

    fastapi_app.dependency_overrides[get_session] = independent_session
    updating = asyncio.create_task(
        api_client.post(url, json={"receipt_email": "race@example.net"})
    )
    try:
        await asyncio.wait_for(update_entered.wait(), timeout=5)
        async with make_session() as concurrent_change:
            current = await concurrent_change.get(Tournament, tournament.id)
            assert current is not None
            current.registration_open = False
            await concurrent_change.commit()
    finally:
        release_update.set()
    response = await updating

    assert response.status_code == 404
    assert provider.intent.client_secret not in response.text
    async with make_session() as observer:
        persisted = await observer.get(TournamentPayment, payment.id)
        assert persisted is not None
        assert persisted.provider_payment_id == provider.intent.id
        assert persisted.state in {
            TournamentPaymentState.ready,
            TournamentPaymentState.action_required,
            TournamentPaymentState.checking,
        }


async def test_receipt_edit_cannot_restore_pii_after_account_erasure_wins(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
) -> None:
    payer, tournament, checkout = await _paid_checkout(
        api_client, db_session, monkeypatch
    )

    class ReceiptTrackingProvider(FakePaymentProvider):
        def __init__(self) -> None:
            super().__init__()
            self.provider_receipt_email: str | None = None
            self.cancellations: list[str] = []

        async def update_payment_intent_receipt(
            self, provider_payment_id: str, receipt_email: str | None
        ) -> FakeProviderIntent:
            intent = await super().update_payment_intent_receipt(
                provider_payment_id, receipt_email
            )
            self.provider_receipt_email = receipt_email
            return intent

        async def cancel_payment_intent(
            self, provider_payment_id: str
        ) -> FakeProviderIntent:
            self.cancellations.append(provider_payment_id)
            self.intent = replace(self.intent, status="canceled")
            return self.intent

    provider = ReceiptTrackingProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    initial_email = "before-erasure@example.net"
    desired_email = "stale-edit@example.net"
    initial = await api_client.post(url, json={"receipt_email": initial_email})
    assert initial.status_code == 200, initial.text
    assert provider.provider_receipt_email == initial_email
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    await db_session.commit()

    # Existing-payment preparation deliberately releases its initial lifecycle
    # locks before doing any provider I/O. Pause immediately after that release
    # so account erasure can commit in the exact stale-edit window.
    validation_released = asyncio.Event()
    release_edit = asyncio.Event()
    original_commit = db_session.commit
    intercept_next_commit = True

    async def pause_after_validation_commit() -> None:
        nonlocal intercept_next_commit
        await original_commit()
        if intercept_next_commit:
            intercept_next_commit = False
            validation_released.set()
            await release_edit.wait()

    monkeypatch.setattr(db_session, "commit", pause_after_validation_commit)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as eraser:
        editing = asyncio.create_task(
            api_client.post(url, json={"receipt_email": desired_email})
        )
        try:
            await asyncio.wait_for(validation_released.wait(), timeout=5)
            await erase_account(eraser, payer.id)
            await eraser.commit()
            release_edit.set()
            response = await editing
        finally:
            release_edit.set()
            if not editing.done():
                editing.cancel()
                await asyncio.gather(editing, return_exceptions=True)

    assert response.status_code == 404
    await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)

    assert payment.receipt_email is None
    assert provider.provider_receipt_email is None
    assert all(email != desired_email for _, email in provider.receipt_updates)


@pytest.mark.parametrize(
    ("terminal_state", "webhook_status", "amount_cents"),
    [
        (TournamentPaymentState.succeeded, ProviderPaymentStatus.succeeded, 2345),
        (TournamentPaymentState.canceled, ProviderPaymentStatus.canceled, 2345),
        # A captured amount mismatch is durable failed evidence.
        (TournamentPaymentState.failed, ProviderPaymentStatus.succeeded, 2346),
    ],
)
async def test_receipt_update_response_cannot_regress_concurrent_terminal_webhook(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
    terminal_state: TournamentPaymentState,
    webhook_status: ProviderPaymentStatus,
    amount_cents: int,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)

    class BlockingReceiptProvider(FakePaymentProvider):
        def __init__(self) -> None:
            super().__init__()
            self.update_entered = asyncio.Event()
            self.release_update = asyncio.Event()
            self.webhook_intent: ProviderPaymentIntent | None = None

        async def update_payment_intent_receipt(
            self, provider_payment_id: str, receipt_email: str | None
        ) -> FakeProviderIntent:
            # Return the stale pre-webhook provider response after terminal
            # evidence has committed through the real webhook seam.
            stale_response = await super().update_payment_intent_receipt(
                provider_payment_id, receipt_email
            )
            self.update_entered.set()
            await self.release_update.wait()
            return stale_response

        async def verify_webhook(
            self, payload: bytes, signature: str | None
        ) -> ProviderPaymentEvent:
            assert signature == "test-valid-signature"
            assert self.webhook_intent is not None
            return ProviderPaymentEvent(
                id=payload.decode(),
                type=f"payment_intent.{self.webhook_intent.status.value}",
                created_at=datetime.now(UTC),
                payment=self.webhook_intent,
            )

    provider = BlockingReceiptProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    assert (await api_client.post(url, json={})).status_code == 200
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    provider.webhook_intent = ProviderPaymentIntent(
        id=provider.intent.id,
        client_secret=provider.intent.client_secret,
        status=webhook_status,
        amount_cents=amount_cents,
        currency=provider.intent.currency,
        merchant_account_id=provider.intent.merchant_account_id,
        livemode=provider.intent.livemode,
        durable_identity=provider.intent.durable_identity,
    )
    make_session = async_sessionmaker(engine, expire_on_commit=False)

    async def independent_session() -> AsyncIterator[AsyncSession]:
        async with make_session() as session:
            yield session

    fastapi_app.dependency_overrides[get_session] = independent_session
    updating = asyncio.create_task(
        api_client.post(url, json={"receipt_email": "terminal-race@example.net"})
    )
    try:
        await asyncio.wait_for(provider.update_entered.wait(), timeout=5)
        webhook = await api_client.post(
            "/v1/webhooks/stripe",
            content=f"evt_{terminal_state.value}",
            headers={"stripe-signature": "test-valid-signature"},
        )
        assert webhook.status_code == 200, webhook.text
    finally:
        provider.release_update.set()
    response = await updating

    assert response.status_code == 200, response.text
    assert response.json()["payment_state"] == terminal_state.value
    assert response.json()["client_secret"] is None
    assert provider.intent.client_secret not in response.text
    async with make_session() as observer:
        persisted = await observer.get(TournamentPayment, payment.id)
        assert persisted is not None
        assert persisted.state is terminal_state


async def test_closed_gate_cancels_unprepared_checkout_but_preserves_created_intent(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    payer, tournament, checkout = await _paid_checkout(
        api_client, db_session, monkeypatch
    )
    provider = FakePaymentProvider()
    _install_provider(provider)
    monkeypatch.setenv("TOURNAMENT_PAYMENT_COLLECTION_ENABLED", "false")

    refused = await api_client.post(_payment_url(tournament, checkout), json={})
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "collection_disabled"
    cancelled = await api_client.get(
        f"/v1/tournaments/{tournament.id}/checkouts/{checkout['id']}"
    )
    assert cancelled.json()["status"] == "cancelled"
    terminal = await api_client.get(_payment_url(tournament, checkout))
    assert terminal.status_code == 200, terminal.text
    assert terminal.json()["payment_state"] == "canceled"
    assert terminal.json()["client_secret"] is None
    assert provider.creates == []

    # Closing the gate later must not strand or erase an intent already created.
    monkeypatch.setenv("TOURNAMENT_PAYMENT_COLLECTION_ENABLED", "true")
    _, next_tournament, next_checkout = await _paid_checkout(
        api_client, db_session, monkeypatch, payer=payer
    )
    created = await api_client.post(
        _payment_url(next_tournament, next_checkout), json={}
    )
    assert created.status_code == 200, created.text
    monkeypatch.setenv("TOURNAMENT_PAYMENT_COLLECTION_ENABLED", "false")
    resumed = await api_client.post(
        _payment_url(next_tournament, next_checkout), json={}
    )
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["client_secret"] == created.json()["client_secret"]
    assert len(provider.creates) == 1


async def test_generic_permanent_create_rejection_is_not_reported_as_bad_amount(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()

    async def reject_create(_request: object) -> ProviderPaymentIntent:
        raise PaymentProviderCreateRejectedError("connected account is unavailable")

    monkeypatch.setattr(provider, "create_payment_intent", reject_create)
    _install_provider(provider)

    response = await api_client.post(_payment_url(tournament, checkout), json={})

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "payment_rejected"
    assert "amount" not in detail["message"].casefold()
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    owner = await db_session.get(User, tournament.owner_account_id)
    assert payment is not None
    assert owner is not None
    assert payment.support_reference is not None

    fastapi_app.dependency_overrides[get_current_user] = lambda: owner
    try:
        problems = await api_client.get(
            f"/v1/tournaments/{tournament.id}/payment-problems"
        )
    finally:
        fastapi_app.dependency_overrides.pop(get_current_user, None)

    assert problems.status_code == 200, problems.text
    assert problems.json()["items"] == [
        {
            "checkout_id": checkout["id"],
            "state": "create_rejected",
            "support_reference": payment.support_reference,
        }
    ]


async def test_foreground_create_rejection_after_merge_notifies_and_hints_survivor(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
    fake_notifications_queue,
    realtime_broker: RealtimeBroker,
) -> None:
    payer, tournament, checkout = await _paid_checkout(
        api_client, db_session, monkeypatch
    )
    payer_id = payer.id
    survivor = await make_user(
        db_session, f"foreground-reject-survivor-{uuid.uuid4().hex[:8]}"
    )
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    class MergeDuringRejectedCreate(FakePaymentProvider):
        def __init__(self) -> None:
            super().__init__()
            self.merged = asyncio.Event()
            self.release = asyncio.Event()

        async def create_payment_intent(self, request: object) -> FakeProviderIntent:
            async with sessions() as concurrent:
                stale_payer = await concurrent.get(User, payer.id, with_for_update=True)
                assert stale_payer is not None
                stale_payer.merged_into_user_id = survivor.id
                stale_payer.merged_at = datetime.now(UTC)
                await concurrent.commit()
            self.merged.set()
            await self.release.wait()
            raise PaymentProviderCreateRejectedError(
                "merchant rejected the foreground create"
            )

    provider = MergeDuringRejectedCreate()
    _install_provider(provider)
    preparing = asyncio.create_task(
        api_client.post(_payment_url(tournament, checkout), json={})
    )
    await asyncio.wait_for(provider.merged.wait(), timeout=5)
    try:
        async with watch_hints(realtime_broker, payer.id, survivor.id) as watch:
            provider.release.set()
            response = await preparing
            hints = await watch.collect()
    finally:
        provider.release.set()
        if not preparing.done():
            await preparing

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "payment_rejected"
    jobs = enqueued_notification_jobs(fake_notifications_queue)
    assert [(job.user_id, job.category) for job in jobs] == [
        (survivor.id, NotificationCategory.PAYMENTS)
    ]
    assert hints[payer.id] == []
    assert hints[survivor.id] == [EventKind.dashboard_changed]

    db_session.expire_all()
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    assert stored is not None
    assert stored.payer_account_id == payer_id


@pytest.mark.parametrize(
    ("terminal_status", "payload"),
    [
        (TournamentCheckoutStatus.cancelled, {}),
        (TournamentCheckoutStatus.cancelled, {"receipt_email": "new@example.net"}),
        (TournamentCheckoutStatus.invalidated, {}),
        (
            TournamentCheckoutStatus.invalidated,
            {"receipt_email": "new@example.net"},
        ),
    ],
)
async def test_prepare_never_exposes_secret_for_terminal_checkout_with_bound_intent(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    terminal_status: TournamentCheckoutStatus,
    payload: dict[str, str],
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    prepared = await api_client.post(url, json={})
    assert prepared.status_code == 200, prepared.text
    secret = prepared.json()["client_secret"]
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    assert stored is not None
    stored.status = terminal_status
    if terminal_status is TournamentCheckoutStatus.cancelled:
        stored.cancelled_at = datetime.now(UTC)
    await db_session.commit()
    creates_before_retry = len(provider.creates)
    receipt_updates_before_retry = len(provider.receipt_updates)

    refused = await api_client.post(url, json=payload)

    assert refused.status_code == 404
    assert secret not in refused.text
    assert len(provider.creates) == creates_before_retry
    assert len(provider.receipt_updates) == receipt_updates_before_retry


@pytest.mark.parametrize("receipt_edit", [False, True])
@pytest.mark.parametrize(
    "authority_change",
    [
        "materialized_expiry",
        "elapsed_deadline",
        "registration_generation",
        "merchant_owner",
        "registration_closed",
    ],
)
async def test_bound_prepare_revalidates_authority_without_stranding_late_success(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    authority_change: str,
    receipt_edit: bool,
) -> None:
    payer, tournament, checkout = await _paid_checkout(
        api_client, db_session, monkeypatch
    )
    provider = FakePaymentProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    prepared = await api_client.post(url, json={})
    assert prepared.status_code == 200, prepared.text
    secret = prepared.json()["client_secret"]
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert stored is not None
    assert payment is not None
    assert payment.provider_payment_id == provider.intent.id
    if authority_change == "materialized_expiry":
        stored.status = TournamentCheckoutStatus.expired
    elif authority_change == "elapsed_deadline":
        stored.created_at = datetime.now(UTC) - timedelta(minutes=20)
        stored.expires_at = datetime.now(UTC) - timedelta(minutes=10)
    elif authority_change == "registration_generation":
        tournament.registration_generation += 1
    elif authority_change == "merchant_owner":
        replacement = await make_user(
            db_session, f"new-payment-owner-{uuid.uuid4().hex[:8]}"
        )
        await transfer_ownership(
            db_session,
            tournament.id,
            actor_id=tournament.owner_account_id,
            account_id=replacement.id,
        )
        # Ownership transfer normally materializes invalidation too. Keep the
        # quote active here so reconciliation must independently enforce the
        # immutable checkout merchant against the tournament's current owner.
        stored.status = TournamentCheckoutStatus.active
    else:
        tournament.registration_open = False
    await db_session.commit()
    if authority_change == "merchant_owner":
        await db_session.refresh(stored)
        await db_session.refresh(tournament)
        assert stored.status is TournamentCheckoutStatus.active
        assert stored.merchant_account_id != tournament.owner_account_id
    provider_operations_before_denial = (
        len(provider.creates),
        len(provider.retrievals),
        len(provider.receipt_updates),
    )
    original_receipt = payment.receipt_email
    payload = {"receipt_email": "changed@example.net"} if receipt_edit else {}

    refused = await api_client.post(url, json=payload)

    assert refused.status_code == 404
    assert secret not in refused.text
    assert (
        len(provider.creates),
        len(provider.retrievals),
        len(provider.receipt_updates),
    ) == provider_operations_before_denial
    await db_session.refresh(payment)
    assert payment.provider_payment_id == provider.intent.id
    assert payment.receipt_email == original_receipt
    assert payment.state in {
        TournamentPaymentState.ready,
        TournamentPaymentState.action_required,
        TournamentPaymentState.checking,
    }

    provider.intent = replace(provider.intent, status="succeeded")
    reconciled = await reconcile_stuck_payments(db_session, provider)

    assert reconciled == 1
    entry_count = await db_session.scalar(
        text(
            "SELECT count(*) FROM tournament_entry_members "
            "WHERE player_id = :player_id AND left_at IS NULL"
        ),
        {"player_id": payer.player_id},
    )
    refunded = await db_session.scalar(
        text(
            "SELECT coalesce(sum(amount_cents), 0) "
            "FROM tournament_refund_obligations WHERE payment_id = :payment_id"
        ),
        {"payment_id": payment.id},
    )
    assert entry_count == 0
    assert refunded == 2345


@pytest.mark.parametrize(
    "terminal_status",
    [TournamentCheckoutStatus.expired, TournamentCheckoutStatus.invalidated],
)
async def test_succeeded_payment_remains_readable_after_checkout_becomes_terminal(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    terminal_status: TournamentCheckoutStatus,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    prepared = await api_client.post(url, json={})
    assert prepared.status_code == 200, prepared.text
    secret = prepared.json()["client_secret"]
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert stored is not None
    assert payment is not None
    payment.state = TournamentPaymentState.succeeded
    stored.status = terminal_status
    await db_session.commit()
    provider_operations_before_read = (
        len(provider.creates),
        len(provider.retrievals),
        len(provider.receipt_updates),
    )

    recovered = await api_client.post(url, json={})

    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["payment_state"] == "succeeded"
    assert recovered.json()["client_secret"] is None
    assert secret not in recovered.text
    assert (
        len(provider.creates),
        len(provider.retrievals),
        len(provider.receipt_updates),
    ) == provider_operations_before_read


@pytest.mark.parametrize("receipt_edit", [False, True])
@pytest.mark.parametrize(
    "terminal_payment_state",
    [
        TournamentPaymentState.failed,
        TournamentPaymentState.canceled,
        TournamentPaymentState.succeeded,
    ],
)
async def test_terminal_payment_history_never_returns_secret_or_mutates_provider(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    terminal_payment_state: TournamentPaymentState,
    receipt_edit: bool,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    prepared = await api_client.post(url, json={})
    assert prepared.status_code == 200, prepared.text
    secret = prepared.json()["client_secret"]
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    payment.state = terminal_payment_state
    original_receipt = payment.receipt_email
    await db_session.commit()
    provider_operations_before_read = (
        len(provider.creates),
        len(provider.retrievals),
        len(provider.receipt_updates),
    )
    payload = {"receipt_email": "too-late@example.net"} if receipt_edit else {}

    recovered = await api_client.post(url, json=payload)

    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["payment_state"] == terminal_payment_state.value
    assert recovered.json()["client_secret"] is None
    assert secret not in recovered.text
    assert (
        len(provider.creates),
        len(provider.retrievals),
        len(provider.receipt_updates),
    ) == provider_operations_before_read
    await db_session.refresh(payment)
    assert payment.state is terminal_payment_state
    assert payment.receipt_email == original_receipt


async def test_unbound_expired_obligation_is_durable_history_on_prepare_retry(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    provider.create_error = RuntimeError("process stopped after obligation commit")
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    with pytest.raises(RuntimeError, match="obligation commit"):
        await api_client.post(url, json={})

    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert stored is not None
    assert payment is not None
    assert payment.provider_payment_id is None
    stored.created_at = datetime.now(UTC) - timedelta(minutes=20)
    stored.expires_at = datetime.now(UTC) - timedelta(minutes=10)
    await db_session.commit()
    provider.create_error = None
    original_receipt = payment.receipt_email
    provider_operations_before_discovery = (
        len(provider.creates),
        len(provider.retrievals),
        len(provider.receipt_updates),
    )

    materialized = await api_client.post(url, json={})

    assert materialized.status_code == 200, materialized.text
    assert materialized.json()["payment_state"] == "expired"
    assert materialized.json()["client_secret"] is None
    assert (
        len(provider.creates),
        len(provider.retrievals),
        len(provider.receipt_updates),
    ) == provider_operations_before_discovery
    await db_session.refresh(payment)
    assert payment.state is TournamentPaymentState.expired
    assert payment.receipt_email == original_receipt
    provider_operations_before_retry = (
        len(provider.creates),
        len(provider.retrievals),
        len(provider.receipt_updates),
    )

    recovered = await api_client.post(
        url, json={"receipt_email": "too-late@example.net"}
    )

    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["payment_state"] == "expired"
    assert recovered.json()["client_secret"] is None
    assert (
        len(provider.creates),
        len(provider.retrievals),
        len(provider.receipt_updates),
    ) == provider_operations_before_retry
    await db_session.refresh(payment)
    assert payment.state is TournamentPaymentState.expired
    assert payment.receipt_email == original_receipt


async def test_uncertain_accepted_create_remains_sweepable_after_checkout_expiry(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    payer, tournament, checkout = await _paid_checkout(
        api_client, db_session, monkeypatch
    )
    provider = FakePaymentProvider()
    provider.create_error = TimeoutError("create response was lost")
    _install_provider(provider)
    url = _payment_url(tournament, checkout)

    uncertain = await api_client.post(url, json={})
    assert uncertain.status_code == 200, uncertain.text
    assert uncertain.json()["payment_state"] == "preparing"
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    assert payment is not None
    assert stored is not None
    assert payment.provider_payment_id is None

    stored.created_at = datetime.now(UTC) - timedelta(minutes=20)
    stored.expires_at = datetime.now(UTC) - timedelta(minutes=10)
    await db_session.commit()
    provider.create_error = None
    provider.retrieve_error = TimeoutError("metadata lookup is temporarily uncertain")

    stale_retry = await api_client.post(url, json={})

    assert stale_retry.status_code == 404, stale_retry.text
    await db_session.refresh(payment)
    assert payment.provider_payment_id is None
    assert payment.state is TournamentPaymentState.preparing

    provider.retrieve_error = None
    provider.retrieved_intent = replace(provider.intent, status="succeeded")
    reconciled = await reconcile_stuck_payments(db_session, provider)

    assert reconciled == 1
    await db_session.refresh(payment)
    assert payment.provider_payment_id == provider.intent.id
    assert payment.state is TournamentPaymentState.succeeded
    entry_count = await db_session.scalar(
        text(
            "SELECT count(*) FROM tournament_entry_members "
            "WHERE player_id = :player_id AND left_at IS NULL"
        ),
        {"player_id": payer.player_id},
    )
    refunded = await db_session.scalar(
        text(
            "SELECT coalesce(sum(amount_cents), 0) "
            "FROM tournament_refund_obligations WHERE payment_id = :payment_id"
        ),
        {"payment_id": payment.id},
    )
    assert entry_count == 0
    assert refunded == 2345


async def test_inflight_accepted_create_timeout_survives_concurrent_expiry(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
) -> None:
    payer, tournament, checkout = await _paid_checkout(
        api_client, db_session, monkeypatch
    )

    class BlockingAcceptedCreateProvider(FakePaymentProvider):
        def __init__(self) -> None:
            super().__init__()
            self.create_entered = asyncio.Event()
            self.release_create = asyncio.Event()

        async def create_payment_intent(self, request: object) -> FakeProviderIntent:
            await super().create_payment_intent(request)
            self.create_entered.set()
            await self.release_create.wait()
            raise TimeoutError("accepted create response was lost")

    provider = BlockingAcceptedCreateProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    checkout_id = uuid.UUID(checkout["id"])
    make_session = async_sessionmaker(engine, expire_on_commit=False)

    async def independent_session() -> AsyncIterator[AsyncSession]:
        async with make_session() as session:
            yield session

    fastapi_app.dependency_overrides[get_session] = independent_session
    creating = asyncio.create_task(api_client.post(url, json={}))
    try:
        await asyncio.wait_for(provider.create_entered.wait(), timeout=5)
        async with make_session() as concurrent_change:
            current = await concurrent_change.get(TournamentCheckout, checkout_id)
            assert current is not None
            current.created_at = datetime.now(UTC) - timedelta(minutes=20)
            current.expires_at = datetime.now(UTC) - timedelta(minutes=10)
            await concurrent_change.commit()

        async with make_client() as other_device:
            other_device.cookies.update(api_client.cookies)
            expired = await other_device.post(url, json={})
        assert expired.status_code == 200, expired.text
        assert expired.json()["payment_state"] == "expired"
        assert expired.json()["client_secret"] is None
    finally:
        provider.release_create.set()
    timed_out = await creating

    assert timed_out.status_code == 200, timed_out.text
    assert timed_out.json()["client_secret"] is None
    async with make_session() as observer:
        payment = await observer.scalar(
            select(TournamentPayment).where(
                TournamentPayment.checkout_id == checkout_id
            )
        )
        assert payment is not None
        payment_id = payment.id
        assert payment.provider_payment_id is None
        assert payment.provider_status == "create_uncertain"

    # The accepted provider object can surface after local authority is gone.
    # Recovery must keep finding it and refund the entire charge, never admit.
    provider.retrieved_intent = replace(provider.intent, status="succeeded")
    async with make_session() as sweep_session:
        reconciled = await reconcile_stuck_payments(sweep_session, provider)
    async with make_session() as observer:
        payment = await observer.get(TournamentPayment, payment_id)
        refunded = await observer.scalar(
            text(
                "SELECT coalesce(sum(amount_cents), 0) "
                "FROM tournament_refund_obligations WHERE payment_id = :payment_id"
            ),
            {"payment_id": payment_id},
        )
        entry_count = await observer.scalar(
            text(
                "SELECT count(*) FROM tournament_entry_members "
                "WHERE player_id = :player_id AND left_at IS NULL"
            ),
            {"player_id": payer.player_id},
        )
    assert reconciled == 1
    assert payment is not None
    assert payment.provider_payment_id == provider.intent.id
    assert payment.state is TournamentPaymentState.succeeded
    assert refunded == 2345
    assert entry_count == 0


@pytest.mark.parametrize("desired_email", ["current@example.net", None])
async def test_unbound_uncertain_create_retains_latest_receipt_sync_obligation(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    desired_email: str | None,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    provider.create_error = TimeoutError("accepted create response was lost")
    _install_provider(provider)
    url = _payment_url(tournament, checkout)

    uncertain = await api_client.post(
        url, json={"receipt_email": "receipt-a@example.net"}
    )
    assert uncertain.status_code == 200, uncertain.text
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    assert payment.provider_payment_id is None

    provider.create_error = None
    provider.retrieve_error = TimeoutError("provider lookup result unknown")
    changed = await api_client.post(url, json={"receipt_email": desired_email})

    assert changed.status_code == 200, changed.text
    assert changed.json()["receipt_email"] == desired_email
    await db_session.refresh(payment)
    assert payment.provider_payment_id is None
    assert payment.receipt_email == desired_email
    assert payment.receipt_sync_pending is True

    # Later provider truth must bind the intent and converge it to the newest
    # destination, including an explicit clear, before discharging the marker.
    provider.retrieve_error = None
    provider.retrieved_intent = replace(provider.intent, status="succeeded")
    reconciled = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)

    assert reconciled == 1
    assert payment.state is TournamentPaymentState.succeeded
    assert payment.provider_payment_id == provider.intent.id
    assert provider.receipt_updates[-1] == (provider.intent.id, desired_email)
    assert payment.receipt_sync_pending is False


@pytest.mark.parametrize("closed_by", ["stale_authority", "collection_disabled"])
async def test_not_found_does_not_erase_an_uncertain_create_obligation(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    closed_by: str,
) -> None:
    payer, tournament, checkout = await _paid_checkout(
        api_client, db_session, monkeypatch
    )
    provider = FakePaymentProvider()
    provider.create_error = TimeoutError("create response was lost")
    _install_provider(provider)
    url = _payment_url(tournament, checkout)

    uncertain = await api_client.post(url, json={})
    assert uncertain.status_code == 200, uncertain.text
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    assert payment is not None
    assert stored is not None
    assert payment.provider_payment_id is None
    assert payment.provider_status == "create_uncertain"

    if closed_by == "stale_authority":
        stored.created_at = datetime.now(UTC) - timedelta(minutes=20)
        stored.expires_at = datetime.now(UTC) - timedelta(minutes=10)
        expected_checkout_status = TournamentCheckoutStatus.expired
    else:
        monkeypatch.setenv("TOURNAMENT_PAYMENT_COLLECTION_ENABLED", "false")
        expected_checkout_status = TournamentCheckoutStatus.cancelled
    await db_session.commit()
    provider.create_error = None
    provider.retrieve_error = PaymentProviderNotFoundError()
    creates_before_search = len(provider.creates)

    absent = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)
    await db_session.refresh(stored)

    assert absent == 1
    assert payment.provider_payment_id is None
    assert payment.provider_status == "create_uncertain"
    assert payment.state is TournamentPaymentState.preparing
    assert stored.status is expected_checkout_status
    assert len(provider.creates) == creates_before_search

    # NotFound from metadata search can be eventual consistency. Once the
    # accepted intent appears, bind it, but closed authority means full refund
    # and no admission regardless of which gate closed in the meantime.
    provider.retrieve_error = None
    provider.retrieved_intent = replace(provider.intent, status="succeeded")
    found = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)

    entry_count = await db_session.scalar(
        text(
            "SELECT count(*) FROM tournament_entry_members "
            "WHERE player_id = :player_id AND left_at IS NULL"
        ),
        {"player_id": payer.player_id},
    )
    refunded = await db_session.scalar(
        text(
            "SELECT coalesce(sum(amount_cents), 0) "
            "FROM tournament_refund_obligations WHERE payment_id = :payment_id"
        ),
        {"payment_id": payment.id},
    )
    assert found == 1
    assert payment.provider_payment_id == provider.intent.id
    assert payment.state is TournamentPaymentState.succeeded
    assert entry_count == 0
    assert refunded == 2345


async def test_legacy_bound_expired_payment_remains_sweepable_for_late_success(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    payer, tournament, checkout = await _paid_checkout(
        api_client, db_session, monkeypatch
    )
    provider = FakePaymentProvider()
    _install_provider(provider)
    prepared = await api_client.post(_payment_url(tournament, checkout), json={})
    assert prepared.status_code == 200, prepared.text
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert stored is not None
    assert payment is not None
    assert payment.provider_payment_id == provider.intent.id
    stored.status = TournamentCheckoutStatus.expired
    stored.created_at = datetime.now(UTC) - timedelta(minutes=20)
    stored.expires_at = datetime.now(UTC) - timedelta(minutes=10)
    payment.state = TournamentPaymentState.expired
    provider.intent = replace(provider.intent, status="succeeded")
    await db_session.commit()

    reconciled = await reconcile_stuck_payments(db_session, provider)

    assert reconciled == 1
    entry_count = await db_session.scalar(
        text(
            "SELECT count(*) FROM tournament_entry_members "
            "WHERE player_id = :player_id AND left_at IS NULL"
        ),
        {"player_id": payer.player_id},
    )
    refunded = await db_session.scalar(
        text(
            "SELECT coalesce(sum(amount_cents), 0) "
            "FROM tournament_refund_obligations WHERE payment_id = :payment_id"
        ),
        {"payment_id": payment.id},
    )
    assert entry_count == 0
    assert refunded == 2345


async def test_closed_gate_reconciles_uncertain_create_before_deciding_cancellation(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    provider.create_error = TimeoutError("provider result unknown")
    _install_provider(provider)
    url = _payment_url(tournament, checkout)

    uncertain = await api_client.post(url, json={})
    assert uncertain.status_code == 200
    assert uncertain.json()["payment_state"] == "preparing"

    # A timeout does not prove absence: model the provider having accepted the
    # idempotent create even though Fortymm did not receive its response.
    provider.create_error = None
    provider.retrieved_intent = provider.intent
    monkeypatch.setenv("TOURNAMENT_PAYMENT_COLLECTION_ENABLED", "false")
    resumed = await api_client.post(url, json={})
    checkout_read = await api_client.get(
        f"/v1/tournaments/{tournament.id}/checkouts/{checkout['id']}"
    )

    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["payment_state"] == "ready"
    assert resumed.json()["client_secret"] == provider.intent.client_secret
    assert checkout_read.json()["status"] == "active"
    assert checkout_read.json()["payment_state"] == "ready"
    assert provider.retrievals
    assert len(provider.creates) == 1


async def test_unknown_create_result_stays_preparing_then_retrieves_by_stable_identity(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    provider.create_error = TimeoutError("provider response was lost")
    _install_provider(provider)
    url = _payment_url(tournament, checkout)

    uncertain = await api_client.post(url, json={})
    assert uncertain.status_code == 200, uncertain.text
    assert uncertain.json()["payment_state"] == "preparing"
    assert uncertain.json()["client_secret"] is None
    assert uncertain.json()["receipt_email"] is None
    assert len(provider.creates) == 1
    idempotency_key = provider.creates[0]["idempotency_key"]

    persisted = await api_client.get(
        f"/v1/tournaments/{tournament.id}/checkouts/{checkout['id']}"
    )
    assert persisted.status_code == 200
    assert persisted.json()["payment_state"] == "preparing"

    provider.create_error = None
    provider.retrieved_intent = provider.intent
    async with make_client() as another_device:
        another_device.cookies.update(api_client.cookies)
        reconciled = await another_device.post(url, json={})

    assert reconciled.status_code == 200, reconciled.text
    assert reconciled.json()["payment_state"] == "ready"
    assert reconciled.json()["client_secret"] == provider.intent.client_secret
    assert len(provider.creates) == 1
    assert provider.creates[0]["idempotency_key"] == idempotency_key
    assert provider.retrievals


async def test_crash_after_obligation_commit_retries_idempotent_create(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    provider.create_error = RuntimeError("process died before provider I/O")
    _install_provider(provider)
    url = _payment_url(tournament, checkout)

    with pytest.raises(RuntimeError, match="process died"):
        await api_client.post(url, json={})

    assert len(provider.creates) == 1
    original_key = provider.creates[0]["idempotency_key"]
    provider.create_error = None
    provider.retrieve_error = PaymentProviderNotFoundError()

    recovered = await api_client.post(url, json={})

    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["payment_state"] == "ready"
    assert len(provider.creates) == 2
    assert provider.creates[1]["idempotency_key"] == original_key


async def test_reconciliation_sweep_recovers_create_not_sent_before_process_crash(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    provider.create_error = RuntimeError("process died before provider I/O")
    _install_provider(provider)

    with pytest.raises(RuntimeError, match="process died"):
        await api_client.post(_payment_url(tournament, checkout), json={})

    original_key = provider.creates[0]["idempotency_key"]
    provider.create_error = None
    provider.retrieve_error = PaymentProviderNotFoundError()

    reconciled = await reconcile_stuck_payments(db_session, provider)
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )

    assert reconciled == 1
    assert payment is not None
    assert payment.state is TournamentPaymentState.ready
    assert payment.provider_payment_id == provider.intent.id
    assert len(provider.creates) == 2
    assert provider.creates[1]["idempotency_key"] == original_key


async def test_reconciliation_sweep_closes_checkout_but_preserves_uncertain_create(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    provider.create_error = TimeoutError("provider result unknown")
    _install_provider(provider)
    payment_url = _payment_url(tournament, checkout)

    uncertain = await api_client.post(payment_url, json={})
    assert uncertain.status_code == 200
    assert uncertain.json()["payment_state"] == "preparing"
    creates_before_sweep = len(provider.creates)

    provider.create_error = None
    provider.retrieve_error = PaymentProviderNotFoundError()
    monkeypatch.setenv("TOURNAMENT_PAYMENT_COLLECTION_ENABLED", "false")

    reconciled = await reconcile_stuck_payments(db_session, provider)
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    checkout_read = await api_client.get(
        f"/v1/tournaments/{tournament.id}/checkouts/{checkout['id']}"
    )

    assert reconciled == 1
    assert payment is not None
    assert payment.state is TournamentPaymentState.preparing
    assert payment.provider_status == "create_uncertain"
    assert payment.provider_payment_id is None
    assert checkout_read.json()["status"] == "cancelled"
    assert len(provider.creates) == creates_before_sweep

    # Cancellation releases capacity rather than merely changing presentation.
    monkeypatch.setenv("TOURNAMENT_PAYMENT_COLLECTION_ENABLED", "true")
    async with make_client() as next_player_client:
        await start_session(next_player_client, db_session)
        replacement = await next_player_client.post(
            f"/v1/tournaments/{tournament.id}/checkouts",
            json={
                "request_id": str(uuid.uuid4()),
                "event_ids": [checkout["lines"][0]["event_id"]],
            },
        )
    assert replacement.status_code == 201, replacement.text


@pytest.mark.parametrize(
    "starting_state",
    [TournamentPaymentState.ready, TournamentPaymentState.action_required],
)
async def test_reconciliation_sweep_refreshes_remotely_mutable_payment_states(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    starting_state: TournamentPaymentState,
) -> None:
    _, _, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    _install_provider(provider)
    prepared = await api_client.post(
        f"/v1/tournaments/{checkout['tournament_id']}/checkouts/{checkout['id']}/payment",
        json={},
    )
    assert prepared.status_code == 200, prepared.text
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    payment.state = starting_state
    provider.intent = replace(provider.intent, status="processing")
    await db_session.commit()

    reconciled = await reconcile_stuck_payments(db_session, provider)
    await db_session.refresh(payment)

    assert reconciled == 1
    assert payment.state is TournamentPaymentState.checking
    assert provider.retrievals == [payment.durable_identity]


@pytest.mark.parametrize(
    ("stale_reason", "expected_status"),
    [
        ("expired", "expired"),
        ("generation", "invalidated"),
        ("merchant", "invalidated"),
        ("registration_closed", "invalidated"),
    ],
)
async def test_prepare_closes_stale_checkout_before_provider_obligation(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    stale_reason: str,
    expected_status: str,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    assert stored is not None
    if stale_reason == "expired":
        stored.created_at = datetime.now(UTC) - timedelta(minutes=20)
        stored.expires_at = datetime.now(UTC) - timedelta(minutes=10)
    elif stale_reason == "generation":
        tournament.registration_generation += 1
    elif stale_reason == "merchant":
        replacement = await make_user(
            db_session, f"replacement-merchant-{uuid.uuid4().hex[:8]}"
        )
        stored.merchant_account_id = replacement.id
    else:
        tournament.registration_open = False
    await db_session.commit()
    provider = FakePaymentProvider()
    _install_provider(provider)

    refused = await api_client.post(_payment_url(tournament, checkout), json={})
    checkout_read = await api_client.get(
        f"/v1/tournaments/{tournament.id}/checkouts/{checkout['id']}"
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )

    assert refused.status_code == 404
    assert checkout_read.status_code == 200
    assert checkout_read.json()["status"] == expected_status
    assert payment is None
    assert provider.creates == []


@pytest.mark.parametrize(
    ("stale_reason", "expected_checkout_status", "expected_payment_state"),
    [
        ("expired", "expired", TournamentPaymentState.expired),
        ("generation", "invalidated", TournamentPaymentState.canceled),
        ("registration_closed", "invalidated", TournamentPaymentState.canceled),
        ("merchant_owner", "invalidated", TournamentPaymentState.canceled),
    ],
)
async def test_prepare_never_creates_for_stale_checkout_with_unbound_obligation(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    stale_reason: str,
    expected_checkout_status: str,
    expected_payment_state: TournamentPaymentState,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    provider.create_error = RuntimeError("process stopped after obligation commit")
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    with pytest.raises(RuntimeError, match="obligation commit"):
        await api_client.post(url, json={})

    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    assert payment is not None
    assert payment.provider_payment_id is None
    assert stored is not None
    if stale_reason == "expired":
        stored.created_at = datetime.now(UTC) - timedelta(minutes=20)
        stored.expires_at = datetime.now(UTC) - timedelta(minutes=10)
    elif stale_reason == "generation":
        tournament.registration_generation += 1
    elif stale_reason == "registration_closed":
        tournament.registration_open = False
    else:
        replacement = await make_user(
            db_session, f"replacement-owner-{uuid.uuid4().hex[:8]}"
        )
        await transfer_ownership(
            db_session,
            tournament.id,
            actor_id=tournament.owner_account_id,
            account_id=replacement.id,
        )
        # Isolate merchant authority from the transfer's eager materialization.
        stored.status = TournamentCheckoutStatus.active
    await db_session.commit()
    provider.create_error = None
    provider.retrieve_error = PaymentProviderNotFoundError()
    original_receipt = payment.receipt_email
    provider_operations_before_discovery = (
        len(provider.creates),
        len(provider.retrievals),
        len(provider.receipt_updates),
    )

    materialized = await api_client.post(url, json={})
    checkout_read = await api_client.get(
        f"/v1/tournaments/{tournament.id}/checkouts/{checkout['id']}"
    )

    assert materialized.status_code == 200, materialized.text
    assert materialized.json()["payment_state"] == expected_payment_state.value
    assert materialized.json()["client_secret"] is None
    assert checkout_read.status_code == 200
    assert checkout_read.json()["status"] == expected_checkout_status
    assert (
        len(provider.creates),
        len(provider.retrievals),
        len(provider.receipt_updates),
    ) == provider_operations_before_discovery
    await db_session.refresh(payment)
    assert payment.state is expected_payment_state
    assert payment.receipt_email == original_receipt

    recovered = await api_client.post(
        url, json={"receipt_email": "too-late@example.net"}
    )

    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["payment_state"] == expected_payment_state.value
    assert recovered.json()["client_secret"] is None
    assert (
        len(provider.creates),
        len(provider.retrievals),
        len(provider.receipt_updates),
    ) == provider_operations_before_discovery
    await db_session.refresh(payment)
    assert payment.state is expected_payment_state
    assert payment.receipt_email == original_receipt


@pytest.mark.parametrize(
    ("stale_reason", "expected_checkout_status", "expected_payment_state"),
    [
        ("expired", TournamentCheckoutStatus.expired, TournamentPaymentState.expired),
        (
            "generation",
            TournamentCheckoutStatus.invalidated,
            TournamentPaymentState.canceled,
        ),
    ],
)
async def test_reconciliation_never_creates_for_stale_unbound_obligation(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    stale_reason: str,
    expected_checkout_status: TournamentCheckoutStatus,
    expected_payment_state: TournamentPaymentState,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    provider.create_error = RuntimeError("process stopped after obligation commit")
    _install_provider(provider)
    with pytest.raises(RuntimeError, match="obligation commit"):
        await api_client.post(_payment_url(tournament, checkout), json={})

    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    assert payment is not None
    assert payment.provider_payment_id is None
    assert stored is not None
    if stale_reason == "expired":
        stored.created_at = datetime.now(UTC) - timedelta(minutes=20)
        stored.expires_at = datetime.now(UTC) - timedelta(minutes=10)
    else:
        tournament.registration_generation += 1
    await db_session.commit()
    provider.create_error = None
    provider.retrieve_error = PaymentProviderNotFoundError()
    creates_before_sweep = len(provider.creates)

    reconciled = await reconcile_stuck_payments(db_session, provider)

    assert reconciled == 1
    assert len(provider.creates) == creates_before_sweep
    await db_session.refresh(stored)
    await db_session.refresh(payment)
    assert stored.status is expected_checkout_status
    assert payment.state is expected_payment_state


async def test_first_prepare_revalidates_authority_after_provider_create_returns(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
) -> None:
    payer, tournament, checkout = await _paid_checkout(
        api_client, db_session, monkeypatch
    )

    class BlockingCreateProvider(FakePaymentProvider):
        def __init__(self) -> None:
            super().__init__()
            self.create_entered = asyncio.Event()
            self.release_create = asyncio.Event()

        async def create_payment_intent(self, request: object) -> FakeProviderIntent:
            intent = await super().create_payment_intent(request)
            self.create_entered.set()
            await self.release_create.wait()
            return intent

    provider = BlockingCreateProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    checkout_id = uuid.UUID(checkout["id"])
    preparing = asyncio.create_task(api_client.post(url, json={}))
    make_session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        await asyncio.wait_for(provider.create_entered.wait(), timeout=5)
        async with make_session() as concurrent_change:
            current = await concurrent_change.get(Tournament, tournament.id)
            assert current is not None
            current.registration_open = False
            await concurrent_change.commit()
    finally:
        provider.release_create.set()
    response = await preparing

    assert response.status_code == 404
    assert provider.intent.client_secret not in response.text
    async with make_session() as observer:
        payment = await observer.scalar(
            select(TournamentPayment).where(
                TournamentPayment.checkout_id == checkout_id
            )
        )
        assert payment is not None
        assert payment.provider_payment_id == provider.intent.id
        assert payment.state is TournamentPaymentState.ready

    # Losing payer-facing authority must not discard provider evidence. A later
    # capture is still swept and fully refunded rather than granting admission.
    provider.intent = replace(provider.intent, status="succeeded")
    reconciled = await reconcile_stuck_payments(db_session, provider)
    refunded = await db_session.scalar(
        text(
            "SELECT coalesce(sum(amount_cents), 0) "
            "FROM tournament_refund_obligations WHERE payment_id = :payment_id"
        ),
        {"payment_id": payment.id},
    )
    entry_count = await db_session.scalar(
        text(
            "SELECT count(*) FROM tournament_entry_members "
            "WHERE player_id = :player_id AND left_at IS NULL"
        ),
        {"player_id": payer.player_id},
    )
    assert reconciled == 1
    assert refunded == 2345
    assert entry_count == 0


async def test_first_prepare_revalidates_authority_after_final_receipt_sync(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)

    class BlockingFirstReceiptProvider(FakePaymentProvider):
        def __init__(self) -> None:
            super().__init__()
            self.update_entered = asyncio.Event()
            self.release_update = asyncio.Event()

        async def update_payment_intent_receipt(
            self, provider_payment_id: str, receipt_email: str | None
        ) -> FakeProviderIntent:
            intent = await super().update_payment_intent_receipt(
                provider_payment_id, receipt_email
            )
            self.update_entered.set()
            await self.release_update.wait()
            return intent

    provider = BlockingFirstReceiptProvider()
    _install_provider(provider)
    make_session = async_sessionmaker(engine, expire_on_commit=False)

    async def independent_session() -> AsyncIterator[AsyncSession]:
        async with make_session() as session:
            yield session

    fastapi_app.dependency_overrides[get_session] = independent_session
    preparing = asyncio.create_task(
        api_client.post(
            _payment_url(tournament, checkout),
            json={"receipt_email": "receipt@example.net"},
        )
    )
    try:
        await asyncio.wait_for(provider.update_entered.wait(), timeout=5)
        async with make_session() as concurrent_change:
            current = await concurrent_change.get(Tournament, tournament.id)
            assert current is not None
            current.registration_open = False
            await concurrent_change.commit()
    finally:
        provider.release_update.set()
    response = await preparing

    assert response.status_code == 404
    assert provider.intent.client_secret not in response.text
    async with make_session() as observer:
        payment = await observer.scalar(
            select(TournamentPayment).where(
                TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
            )
        )
        assert payment is not None
        assert payment.provider_payment_id == provider.intent.id
        assert payment.state in {
            TournamentPaymentState.ready,
            TournamentPaymentState.action_required,
            TournamentPaymentState.checking,
        }


async def test_collection_disabled_recovery_revalidates_authority_after_retrieval(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    provider.create_error = TimeoutError("provider result unknown")
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    uncertain = await api_client.post(
        url, json={"receipt_email": "recover@example.net"}
    )
    assert uncertain.status_code == 200, uncertain.text
    provider.create_error = None
    provider.retrieved_intent = provider.intent
    monkeypatch.setenv("TOURNAMENT_PAYMENT_COLLECTION_ENABLED", "false")
    retrieve_entered = asyncio.Event()
    release_retrieve = asyncio.Event()
    original_retrieve = provider.retrieve_payment_intent

    async def blocking_retrieve(durable_identity: str) -> FakeProviderIntent:
        retrieve_entered.set()
        await release_retrieve.wait()
        return await original_retrieve(durable_identity)

    monkeypatch.setattr(provider, "retrieve_payment_intent", blocking_retrieve)
    make_session = async_sessionmaker(engine, expire_on_commit=False)

    async def independent_session() -> AsyncIterator[AsyncSession]:
        async with make_session() as session:
            yield session

    fastapi_app.dependency_overrides[get_session] = independent_session
    recovering = asyncio.create_task(api_client.post(url, json={}))
    try:
        await asyncio.wait_for(retrieve_entered.wait(), timeout=5)
        async with make_session() as concurrent_change:
            current = await concurrent_change.get(Tournament, tournament.id)
            assert current is not None
            current.registration_open = False
            await concurrent_change.commit()
    finally:
        release_retrieve.set()
    response = await recovering

    assert response.status_code == 404
    assert provider.intent.client_secret not in response.text
    async with make_session() as observer:
        payment = await observer.scalar(
            select(TournamentPayment).where(
                TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
            )
        )
        assert payment is not None
        assert payment.provider_payment_id == provider.intent.id
        assert payment.state in {
            TournamentPaymentState.ready,
            TournamentPaymentState.action_required,
            TournamentPaymentState.checking,
        }


@pytest.mark.parametrize("operation", ["prepare_missing_secret", "status_read"])
@pytest.mark.parametrize(
    "terminal_state",
    [
        TournamentPaymentState.succeeded,
        TournamentPaymentState.canceled,
        TournamentPaymentState.failed,
    ],
)
async def test_not_found_lookup_cannot_regress_concurrent_terminal_webhook(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
    operation: str,
    terminal_state: TournamentPaymentState,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = BlockingNotFoundProvider()
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    assert (await api_client.post(url, json={})).status_code == 200
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    if operation == "prepare_missing_secret":
        payment.client_secret = None
        await db_session.commit()

    make_session = async_sessionmaker(engine, expire_on_commit=False)

    async def independent_session() -> AsyncIterator[AsyncSession]:
        async with make_session() as session:
            yield session

    fastapi_app.dependency_overrides[get_session] = independent_session
    provider.block_retrieval = True
    request = (
        api_client.post(url, json={})
        if operation == "prepare_missing_secret"
        else api_client.get(url)
    )
    reading = asyncio.create_task(request)
    try:
        await asyncio.wait_for(provider.retrieve_entered.wait(), timeout=5)
        await _commit_terminal_webhook(api_client, provider, terminal_state)
    finally:
        provider.release_retrieve.set()
    response = await reading

    assert response.status_code == 200, response.text
    assert response.json()["payment_state"] == terminal_state.value
    assert response.json()["client_secret"] is None
    assert provider.intent.client_secret not in response.text
    async with make_session() as observer:
        persisted = await observer.get(TournamentPayment, payment.id)
        assert persisted is not None
        assert persisted.state is terminal_state


@pytest.mark.parametrize(
    "terminal_state",
    [
        TournamentPaymentState.succeeded,
        TournamentPaymentState.canceled,
        TournamentPaymentState.failed,
    ],
)
async def test_collection_disabled_not_found_cannot_regress_terminal_webhook(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
    terminal_state: TournamentPaymentState,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = BlockingNotFoundProvider()
    provider.create_error = TimeoutError("provider result unknown")
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    uncertain = await api_client.post(url, json={})
    assert uncertain.status_code == 200, uncertain.text
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    assert payment.provider_payment_id is None

    make_session = async_sessionmaker(engine, expire_on_commit=False)

    async def independent_session() -> AsyncIterator[AsyncSession]:
        async with make_session() as session:
            yield session

    fastapi_app.dependency_overrides[get_session] = independent_session
    provider.create_error = None
    provider.block_retrieval = True
    monkeypatch.setenv("TOURNAMENT_PAYMENT_COLLECTION_ENABLED", "false")
    recovering = asyncio.create_task(api_client.post(url, json={}))
    try:
        await asyncio.wait_for(provider.retrieve_entered.wait(), timeout=5)
        await _commit_terminal_webhook(api_client, provider, terminal_state)
    finally:
        provider.release_retrieve.set()
    response = await recovering

    assert response.status_code == 200, response.text
    expected_state = (
        TournamentPaymentState.preparing
        if terminal_state is TournamentPaymentState.failed
        else terminal_state
    )
    assert response.json()["payment_state"] == expected_state.value
    assert response.json()["client_secret"] is None
    async with make_session() as observer:
        persisted = await observer.get(TournamentPayment, payment.id)
        assert persisted is not None
        assert persisted.state is expected_state
        if terminal_state is TournamentPaymentState.failed:
            assert persisted.provider_payment_id is None
            assert persisted.attention_notified_state == "provider_mismatch"


async def test_collection_disabled_not_found_keeps_concurrently_bound_intent_sweepable(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
) -> None:
    payer, tournament, checkout = await _paid_checkout(
        api_client, db_session, monkeypatch
    )
    provider = BlockingNotFoundProvider()
    provider.create_error = TimeoutError("provider result unknown")
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    uncertain = await api_client.post(url, json={})
    assert uncertain.status_code == 200, uncertain.text
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    assert payment.provider_payment_id is None
    payment_id = payment.id
    entrant_player_id = payer.player_id

    make_session = async_sessionmaker(engine, expire_on_commit=False)

    async def independent_session() -> AsyncIterator[AsyncSession]:
        async with make_session() as session:
            yield session

    fastapi_app.dependency_overrides[get_session] = independent_session
    provider.create_error = None
    provider.block_retrieval = True
    monkeypatch.setenv("TOURNAMENT_PAYMENT_COLLECTION_ENABLED", "false")
    recovering = asyncio.create_task(api_client.post(url, json={}))
    try:
        await asyncio.wait_for(provider.retrieve_entered.wait(), timeout=5)
        async with make_session() as concurrent_change:
            concurrent_payment = await concurrent_change.get(
                TournamentPayment, payment_id
            )
            concurrent_tournament = await concurrent_change.get(
                Tournament, tournament.id
            )
            assert concurrent_payment is not None
            assert concurrent_tournament is not None
            concurrent_payment.provider_payment_id = provider.intent.id
            concurrent_payment.provider_status = (
                ProviderPaymentStatus.requires_payment_method.value
            )
            concurrent_payment.client_secret = provider.intent.client_secret
            concurrent_payment.state = TournamentPaymentState.ready
            concurrent_tournament.registration_open = False
            await concurrent_change.commit()
    finally:
        provider.release_retrieve.set()
    response = await recovering

    assert response.status_code == 404, response.text
    assert provider.intent.client_secret not in response.text
    async with make_session() as observer:
        persisted = await observer.get(TournamentPayment, payment_id)
        assert persisted is not None
        assert persisted.provider_payment_id == provider.intent.id
        assert persisted.state in {
            TournamentPaymentState.ready,
            TournamentPaymentState.action_required,
            TournamentPaymentState.checking,
        }

    provider.block_retrieval = False
    provider.intent = replace(provider.intent, status="succeeded")
    db_session.expire_all()
    reconciled = await reconcile_stuck_payments(db_session, provider)
    refunded = await db_session.scalar(
        text(
            "SELECT coalesce(sum(amount_cents), 0) "
            "FROM tournament_refund_obligations WHERE payment_id = :payment_id"
        ),
        {"payment_id": payment_id},
    )
    entry_count = await db_session.scalar(
        text(
            "SELECT count(*) FROM tournament_entry_members "
            "WHERE player_id = :player_id AND left_at IS NULL"
        ),
        {"player_id": entrant_player_id},
    )
    assert reconciled == 1
    assert refunded == 2345
    assert entry_count == 0


async def test_verified_success_recovers_a_locally_canceled_unbound_create(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    payer, tournament, checkout = await _paid_checkout(
        api_client, db_session, monkeypatch
    )
    provider = BlockingNotFoundProvider()
    provider.create_error = TimeoutError("provider result unknown")
    _install_provider(provider)
    url = _payment_url(tournament, checkout)

    uncertain = await api_client.post(url, json={})
    assert uncertain.status_code == 200, uncertain.text
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    stored = await db_session.get(TournamentCheckout, uuid.UUID(checkout["id"]))
    assert payment is not None
    assert stored is not None
    assert payment.provider_payment_id is None
    payment.state = TournamentPaymentState.canceled
    stored.status = TournamentCheckoutStatus.cancelled
    stored.cancelled_at = datetime.now(UTC)
    await db_session.commit()

    provider.webhook_intent = _production_intent(
        provider, ProviderPaymentStatus.succeeded
    )
    webhook = await api_client.post(
        "/v1/webhooks/stripe",
        content="evt_late_success_after_local_cancel",
        headers={"stripe-signature": "test-valid-signature"},
    )
    await db_session.refresh(payment)

    assert webhook.status_code == 200, webhook.text
    assert payment.provider_payment_id == provider.intent.id
    assert payment.state is TournamentPaymentState.succeeded
    entry_count = await db_session.scalar(
        text(
            "SELECT count(*) FROM tournament_entry_members "
            "WHERE player_id = :player_id AND left_at IS NULL"
        ),
        {"player_id": payer.player_id},
    )
    refunded = await db_session.scalar(
        text(
            "SELECT coalesce(sum(amount_cents), 0) "
            "FROM tournament_refund_obligations WHERE payment_id = :payment_id"
        ),
        {"payment_id": payment.id},
    )
    assert entry_count == 0
    assert refunded == 2345


@pytest.mark.parametrize("bound", [True, False])
@pytest.mark.parametrize(
    "terminal_state",
    [
        TournamentPaymentState.succeeded,
        TournamentPaymentState.canceled,
        TournamentPaymentState.failed,
    ],
)
async def test_reconciliation_not_found_cannot_regress_terminal_webhook(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
    bound: bool,
    terminal_state: TournamentPaymentState,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = BlockingNotFoundProvider()
    if not bound:
        provider.create_error = TimeoutError("provider result unknown")
    _install_provider(provider)
    url = _payment_url(tournament, checkout)
    initial = await api_client.post(url, json={})
    assert initial.status_code == 200, initial.text
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == uuid.UUID(checkout["id"])
        )
    )
    assert payment is not None
    assert (payment.provider_payment_id is not None) is bound

    make_session = async_sessionmaker(engine, expire_on_commit=False)

    async def independent_session() -> AsyncIterator[AsyncSession]:
        async with make_session() as session:
            yield session

    fastapi_app.dependency_overrides[get_session] = independent_session
    provider.create_error = None
    provider.block_retrieval = True
    if not bound:
        monkeypatch.setenv("TOURNAMENT_PAYMENT_COLLECTION_ENABLED", "false")
    async with make_session() as sweep_session:
        sweeping = asyncio.create_task(
            reconcile_stuck_payments(sweep_session, provider)
        )
        try:
            await asyncio.wait_for(provider.retrieve_entered.wait(), timeout=5)
            await _commit_terminal_webhook(api_client, provider, terminal_state)
        finally:
            provider.release_retrieve.set()
        await sweeping

    async with make_session() as observer:
        persisted = await observer.get(TournamentPayment, payment.id)
        assert persisted is not None
        expected_state = (
            TournamentPaymentState.preparing
            if not bound and terminal_state is TournamentPaymentState.failed
            else terminal_state
        )
        assert persisted.state is expected_state
        if not bound and terminal_state is TournamentPaymentState.failed:
            assert persisted.provider_payment_id is None
            assert persisted.attention_notified_state == "provider_mismatch"


async def test_first_prepare_cannot_commit_obligation_after_concurrent_cancellation(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch,
) -> None:
    _, tournament, checkout = await _paid_checkout(api_client, db_session, monkeypatch)
    provider = FakePaymentProvider()
    _install_provider(provider)
    checkout_id = uuid.UUID(checkout["id"])
    preparing_pid = await db_session.scalar(text("SELECT pg_backend_pid()"))
    make_session = async_sessionmaker(engine, expire_on_commit=False)

    async with make_session() as gatekeeper, make_session() as observer:
        terminal = await gatekeeper.scalar(
            select(TournamentCheckout)
            .where(TournamentCheckout.id == checkout_id)
            .with_for_update(of=TournamentCheckout)
        )
        assert terminal is not None
        terminal.status = TournamentCheckoutStatus.cancelled
        terminal.cancelled_at = datetime.now(UTC)
        await gatekeeper.flush()
        gatekeeper_pid = await gatekeeper.scalar(text("SELECT pg_backend_pid()"))

        preparing = asyncio.create_task(
            api_client.post(_payment_url(tournament, checkout), json={})
        )
        try:
            async with asyncio.timeout(5):
                while gatekeeper_pid not in (
                    await observer.scalar(
                        text("SELECT pg_blocking_pids(:pid)"),
                        {"pid": preparing_pid},
                    )
                ):
                    if preparing.done():
                        response = await preparing
                        pytest.fail(
                            "payment preparation did not serialize obligation "
                            f"creation with checkout cancellation: {response.text}"
                        )
                    await asyncio.sleep(0.01)
            await gatekeeper.commit()
            response = await preparing
        finally:
            if not preparing.done():
                preparing.cancel()
                await asyncio.gather(preparing, return_exceptions=True)

    payment = await db_session.scalar(
        select(TournamentPayment).where(TournamentPayment.checkout_id == checkout_id)
    )
    assert response.status_code == 404
    assert payment is None
    assert provider.creates == []
