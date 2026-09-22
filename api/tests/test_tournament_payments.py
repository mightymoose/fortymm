"""Behavioral contract for preparing and resuming a checkout payment.

The HTTP operation is the public seam.  ``FakePaymentProvider`` stands in only for
the external processor boundary; the tests deliberately do not mock Fortymm's own
payment or persistence modules.
"""

import asyncio
import uuid
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
from app.payment_provider import PaymentProviderNotFoundError, get_payment_provider
from app.tournament_event_stages import mint_stages
from app.tournament_payment_reconciliation import reconcile_stuck_payments
from tests._helpers import make_client, make_user, start_session


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


async def test_reconciliation_sweep_cancels_absent_intent_when_collection_is_disabled(
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
    assert payment.state is TournamentPaymentState.canceled
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
    else:
        tournament.registration_generation += 1
    await db_session.commit()
    provider.create_error = None
    provider.retrieve_error = PaymentProviderNotFoundError()
    creates_before_retry = len(provider.creates)

    refused = await api_client.post(url, json={})
    checkout_read = await api_client.get(
        f"/v1/tournaments/{tournament.id}/checkouts/{checkout['id']}"
    )

    assert refused.status_code == 404
    assert checkout_read.status_code == 200
    assert checkout_read.json()["status"] == expected_checkout_status
    assert len(provider.creates) == creates_before_retry
    await db_session.refresh(payment)
    assert payment.state is expected_payment_state

    replacement = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={
            "request_id": str(uuid.uuid4()),
            "event_ids": [checkout["lines"][0]["event_id"]],
        },
    )
    assert replacement.status_code == 201, replacement.text


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
