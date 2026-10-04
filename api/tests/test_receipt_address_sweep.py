"""The daily receipt-address cleanup (#1810)."""

import logging
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Tournament,
    TournamentCheckout,
    TournamentEvent,
    TournamentPayment,
    TournamentPaymentRefundObligation,
    TournamentPaymentRefundReason,
    TournamentStatus,
)
from app.receipt_address_sweep import sweep_receipt_addresses
from tests.test_payment_receipts import _paid_checkout

ADDRESS = "receipts@example.com"


async def _address_state(
    db: AsyncSession, payment: TournamentPayment
) -> tuple[str | None, str | None, bool]:
    """(checkout address, payment address, payment tombstoned)."""
    await db.refresh(payment)
    checkout = await db.get(TournamentCheckout, payment.checkout_id)
    assert checkout is not None
    await db.refresh(checkout)
    return (
        checkout.receipt_address,
        payment.receipt_address,
        payment.receipt_address_erased_at is not None,
    )


async def _tournament_of(db: AsyncSession, payment: TournamentPayment) -> Tournament:
    tournament = await db.get(Tournament, payment.tournament_id)
    assert tournament is not None
    return tournament


async def _in_days(days: int) -> datetime:
    return datetime.now(UTC) + timedelta(days=days)


async def test_an_archived_tournament_loses_its_addresses_thirty_days_after_archival(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address=ADDRESS
    )
    tournament = await _tournament_of(db_session, payment)
    tournament.status = TournamentStatus.archived
    await db_session.commit()

    early = await sweep_receipt_addresses(db_session, now=await _in_days(29))
    assert early == 0
    assert await _address_state(db_session, payment) == (ADDRESS, ADDRESS, False)

    due = await sweep_receipt_addresses(db_session, now=await _in_days(31))
    assert due == 1
    assert await _address_state(db_session, payment) == (None, None, True)

    again = await sweep_receipt_addresses(db_session, now=await _in_days(31))
    assert again == 0


async def _cancel(db: AsyncSession, events: list[TournamentEvent]) -> None:
    for event in events:
        await db.execute(
            text(
                "UPDATE tournament_events SET lifecycle_state='cancelled' WHERE id=:id"
            ),
            {"id": event.id},
        )
    await db.commit()


async def _events_of(
    db: AsyncSession, payment: TournamentPayment
) -> list[TournamentEvent]:
    return list(
        await db.scalars(
            select(TournamentEvent).where(
                TournamentEvent.tournament_id == payment.tournament_id
            )
        )
    )


async def test_a_completed_tournament_loses_its_addresses_without_archival(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address=ADDRESS
    )
    await _cancel(db_session, await _events_of(db_session, payment))

    assert await sweep_receipt_addresses(db_session, now=await _in_days(29)) == 0
    assert await sweep_receipt_addresses(db_session, now=await _in_days(31)) == 1
    assert await _address_state(db_session, payment) == (None, None, True)


async def test_a_refund_obligation_keeps_the_address_until_it_is_settled(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address=ADDRESS
    )
    tournament = await _tournament_of(db_session, payment)
    tournament.status = TournamentStatus.archived
    db_session.add(
        TournamentPaymentRefundObligation(
            payment_id=payment.id,
            event_id=None,
            amount_cents=100,
            reason=TournamentPaymentRefundReason.line_could_not_admit,
        )
    )
    await db_session.commit()

    assert await sweep_receipt_addresses(db_session, now=await _in_days(400)) == 0
    assert await _address_state(db_session, payment) == (ADDRESS, ADDRESS, False)


async def test_a_tournament_with_an_unfinished_event_keeps_its_addresses(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address=ADDRESS
    )
    events = await _events_of(db_session, payment)
    await _cancel(db_session, events[:1])

    assert await sweep_receipt_addresses(db_session, now=await _in_days(400)) == 0
    assert await _address_state(db_session, payment) == (ADDRESS, ADDRESS, False)


async def test_the_sweep_log_never_carries_an_address(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address=ADDRESS
    )
    tournament = await _tournament_of(db_session, payment)
    tournament.status = TournamentStatus.archived
    await db_session.commit()

    with caplog.at_level(logging.DEBUG):
        await sweep_receipt_addresses(db_session, now=await _in_days(31))

    assert "erased 1 addresses" in caplog.text
    assert ADDRESS not in caplog.text
