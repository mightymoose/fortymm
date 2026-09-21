"""Payer-visible recovery surfaces for tournament checkout payments.

The two seams are intentionally public: ``GET /v1/dashboard`` supplies the
three most urgent payment actions for the dashboard, while ``GET /v1/checkouts``
is the complete actionable list behind its overflow link.  Provider state is
seeded through the already-tested payment HTTP operation; only the external
processor is doubled.
"""

from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.main import app as fastapi_app
from app.models import (
    TournamentCheckout,
    TournamentCheckoutStatus,
    TournamentPayment,
)
from app.models.tournament_payment import TournamentPaymentState
from app.payment_provider import get_payment_provider
from app.realtime import EventKind, RealtimeBroker
from tests._helpers import make_client, start_session
from tests._realtime import watch_hints
from tests.test_tournament_payments import (
    FakePaymentProvider,
    _paid_checkout,
    _payment_url,
)


async def _payment(
    client: AsyncClient,
    db: AsyncSession,
    monkeypatch,
    *,
    payer,
    state: TournamentPaymentState,
    expires_in: timedelta = timedelta(minutes=10),
    support_reference: str | None = None,
) -> tuple[dict, TournamentPayment]:
    _, tournament, checkout = await _paid_checkout(client, db, monkeypatch, payer=payer)
    provider = FakePaymentProvider()
    provider.intent = type(provider.intent)(
        id=f"pi_{checkout['id']}",
        client_secret=f"pi_{checkout['id']}_secret",
    )
    fastapi_app.dependency_overrides[get_payment_provider] = lambda: provider
    prepared = await client.post(_payment_url(tournament, checkout), json={})
    assert prepared.status_code == 200, prepared.text
    payment = await db.scalar(
        select(TournamentPayment).where(TournamentPayment.checkout_id == checkout["id"])
    )
    assert payment is not None
    payment.state = state
    payment.support_reference = support_reference
    row = await db.get(TournamentCheckout, checkout["id"])
    assert row is not None
    row.expires_at = datetime.now(UTC) + expires_in
    await db.commit()
    return checkout, payment


async def test_dashboard_returns_only_the_payers_three_most_urgent_checkouts(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    payer = await start_session(api_client, db_session)
    active_later, _ = await _payment(
        api_client,
        db_session,
        monkeypatch,
        payer=payer,
        state=TournamentPaymentState.ready,
        expires_in=timedelta(minutes=8),
    )
    checking, _ = await _payment(
        api_client,
        db_session,
        monkeypatch,
        payer=payer,
        state=TournamentPaymentState.checking,
    )
    review, _ = await _payment(
        api_client,
        db_session,
        monkeypatch,
        payer=payer,
        state=TournamentPaymentState.failed,
        support_reference="PAY-1770",
    )
    active_sooner, _ = await _payment(
        api_client,
        db_session,
        monkeypatch,
        payer=payer,
        state=TournamentPaymentState.action_required,
        expires_in=timedelta(minutes=2),
    )

    response = await api_client.get("/v1/dashboard")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["checkout_attention_total_count"] == 4
    assert [item["checkout_id"] for item in body["checkout_attention"]] == [
        review["id"],
        checking["id"],
        active_sooner["id"],
    ]
    assert [item["kind"] for item in body["checkout_attention"]] == [
        "needs_review",
        "checking",
        "active",
    ]
    assert body["checkout_attention"][0]["support_reference"] == "PAY-1770"
    assert body["checkout_attention"][2]["expires_at"]
    assert all(
        item["href"]
        == f"/tournaments/{item['tournament_id']}/checkouts/{item['checkout_id']}"
        for item in body["checkout_attention"]
    )
    assert active_later["id"] not in {
        item["checkout_id"] for item in body["checkout_attention"]
    }


async def test_fresh_checkout_is_actionable_before_payment_preparation(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    payer = await start_session(api_client, db_session)
    _, _, checkout = await _paid_checkout(
        api_client, db_session, monkeypatch, payer=payer
    )

    response = await api_client.get("/v1/checkouts")

    assert response.status_code == 200, response.text
    assert response.json()["items"] == [
        {
            "checkout_id": checkout["id"],
            "tournament_id": checkout["tournament_id"],
            "tournament_name": checkout["tournament_name"],
            "kind": "active",
            "payment_state": "unavailable",
            "expires_at": checkout["expires_at"],
            "remaining_seconds": pytest.approx(checkout["remaining_seconds"], abs=1),
            "support_reference": None,
            "href": (
                f"/tournaments/{checkout['tournament_id']}/checkouts/{checkout['id']}"
            ),
        }
    ]


async def test_actionable_checkouts_are_payer_only_and_exclude_terminal_history(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
) -> None:
    payer = await start_session(api_client, db_session)
    actionable, _ = await _payment(
        api_client,
        db_session,
        monkeypatch,
        payer=payer,
        state=TournamentPaymentState.ready,
    )
    terminal_ids: list[str] = []
    for state, checkout_status in (
        (TournamentPaymentState.succeeded, TournamentCheckoutStatus.active),
        (TournamentPaymentState.canceled, TournamentCheckoutStatus.cancelled),
        (TournamentPaymentState.expired, TournamentCheckoutStatus.expired),
    ):
        checkout, _ = await _payment(
            api_client,
            db_session,
            monkeypatch,
            payer=payer,
            state=state,
        )
        row = await db_session.get(TournamentCheckout, checkout["id"])
        assert row is not None
        row.status = checkout_status
        terminal_ids.append(checkout["id"])
    await db_session.commit()

    complete = await api_client.get("/v1/checkouts")
    assert complete.status_code == 200, complete.text
    assert [item["checkout_id"] for item in complete.json()["items"]] == [
        actionable["id"]
    ]
    assert not set(terminal_ids) & {
        item["checkout_id"] for item in complete.json()["items"]
    }

    async with make_client() as other:
        await start_session(other, db_session)
        strangers = await other.get("/v1/checkouts")
    assert strangers.status_code == 200
    assert strangers.json()["items"] == []


async def test_preparing_payment_invalidates_only_the_payers_dashboard(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    realtime_broker: RealtimeBroker,
) -> None:
    payer = await start_session(api_client, db_session)
    bystander_client = make_client()
    try:
        bystander = await start_session(bystander_client, db_session)
        _, tournament, checkout = await _paid_checkout(
            api_client, db_session, monkeypatch, payer=payer
        )
        provider = FakePaymentProvider()
        fastapi_app.dependency_overrides[get_payment_provider] = lambda: provider
        async with watch_hints(realtime_broker, payer.id, bystander.id) as watch:
            prepared = await api_client.post(
                _payment_url(tournament, checkout), json={}
            )
            assert prepared.status_code == 200, prepared.text
            hints = await watch.collect()
    finally:
        await bystander_client.aclose()

    assert hints[payer.id] == [EventKind.dashboard_changed]
    assert hints[bystander.id] == []
