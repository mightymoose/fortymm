"""Payment-provider evidence is the only authority that can grant paid entry.

These tests exercise the two public reconciliation seams: Stripe's raw signed
webhook and the payer's payment-status read.  The double replaces only the
external provider port; Fortymm persistence and admission remain real.
"""

import json
import uuid
from dataclasses import asdict, dataclass, is_dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.leagues import get_default_league
from app.main import app as fastapi_app
from app.models import (
    DrawType,
    EventFormat,
    Tournament,
    TournamentCheckout,
    TournamentEntry,
    TournamentEntryRegistration,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentStatus,
    User,
)
from app.payment_provider import get_payment_provider
from app.tournament_event_stages import mint_stages
from tests._helpers import make_user, start_session

try:
    from app.payment_provider import PaymentProviderSignatureError
except ImportError:  # The red test defines the provider contract production must add.

    class PaymentProviderSignatureError(Exception):
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

    def __init__(self) -> None:
        self.creates: list[dict[str, Any]] = []
        self.events: dict[str, FakeProviderEvent] = {}
        self.intent: FakeProviderIntent | None = None

    async def create_payment_intent(self, request: object) -> FakeProviderIntent:
        if is_dataclass(request) and not isinstance(request, type):
            recorded = asdict(request)
        elif hasattr(request, "model_dump"):
            recorded = request.model_dump()
        else:
            recorded = vars(request)
        self.creates.append(recorded)
        self.intent = FakeProviderIntent(
            id="pi_reconcile_1770",
            client_secret="pi_reconcile_1770_secret",
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
        assert self.intent is not None
        return self.intent

    async def update_payment_intent_receipt(
        self, provider_payment_id: str, receipt_email: str | None
    ) -> FakeProviderIntent:
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
            "SELECT checkout_line_id, amount_cents "
            "FROM tournament_refund_obligations ORDER BY checkout_line_id NULLS LAST"
        )
    )
    return [(row.checkout_line_id, row.amount_cents) for row in result]


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
