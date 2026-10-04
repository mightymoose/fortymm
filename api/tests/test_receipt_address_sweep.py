"""The daily receipt-address cleanup (#1810)."""

import logging
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.models import (
    Tournament,
    TournamentCheckout,
    TournamentEvent,
    TournamentPayment,
    TournamentPaymentRefundObligation,
    TournamentPaymentRefundReason,
    TournamentPaymentStatus,
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


async def _archived_quarantine(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    *,
    amount_unverified: bool,
) -> TournamentPayment:
    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address=ADDRESS
    )
    payment.status = TournamentPaymentStatus.quarantined
    payment.amount_unverified = amount_unverified
    # Only verified success snapshots the address (``_admit``), so a quarantined
    # payment never holds one. The checkout still does.
    payment.receipt_address = None
    tournament = await _tournament_of(db_session, payment)
    tournament.status = TournamentStatus.archived
    await db_session.commit()
    return payment


async def test_a_zero_capture_quarantine_owes_nothing_so_it_does_not_block_cleanup(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payment = await _archived_quarantine(
        api_client, db_session, monkeypatch, amount_unverified=False
    )

    assert await sweep_receipt_addresses(db_session, now=await _in_days(31)) == 1
    assert (await _address_state(db_session, payment))[:2] == (None, None)


async def test_an_unverified_amount_may_owe_money_so_it_keeps_the_address(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payment = await _archived_quarantine(
        api_client, db_session, monkeypatch, amount_unverified=True
    )

    assert await sweep_receipt_addresses(db_session, now=await _in_days(400)) == 0
    assert (await _address_state(db_session, payment))[0] == ADDRESS


async def test_a_refund_recorded_after_the_check_still_keeps_the_address(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The sweep's tournament check reads without a lock, so reconciliation can
    record a refund between that check and the erase. The erase rechecks under
    the payment's own lock."""
    from app import receipt_address_sweep

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

    async def stale_all_clear(*_args: object, **_kwargs: object) -> bool:
        return True

    monkeypatch.setattr(
        receipt_address_sweep, "_payments_are_resolved", stale_all_clear
    )

    assert await sweep_receipt_addresses(db_session, now=await _in_days(400)) == 0
    assert (await _address_state(db_session, payment))[:2] == (ADDRESS, ADDRESS)


async def test_the_sweep_and_account_erasure_lock_checkouts_in_id_order(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import uuid

    from app import receipt_address_sweep, receipt_addresses
    from app.identity_lifecycle import erase_account

    payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address=ADDRESS
    )
    tournament = await _tournament_of(db_session, payment)
    tournament.status = TournamentStatus.archived
    first = await db_session.get(TournamentCheckout, payment.checkout_id)
    assert first is not None
    # More addressed checkouts of the same payer and tournament, with random ids.
    for _ in range(5):
        db_session.add(
            TournamentCheckout(
                id=uuid.uuid4(),
                request_id=uuid.uuid4(),
                tournament_id=payment.tournament_id,
                payer_account_id=payer.id,
                entrant_player_id=first.entrant_player_id,
                merchant_account_id=first.merchant_account_id,
                total_cents=first.total_cents,
                registration_generation=0,
                status="cancelled",
                expires_at=datetime.now(UTC) + timedelta(minutes=10),
                receipt_address=ADDRESS,
            )
        )
    await db_session.commit()
    visited: list[uuid.UUID] = []
    real_erase = receipt_addresses.erase_receipt_address

    async def spy(db: AsyncSession, **kwargs: object) -> bool:
        visited.append(kwargs["checkout_id"])  # type: ignore[arg-type]
        return await real_erase(db, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(receipt_address_sweep, "erase_receipt_address", spy)
    monkeypatch.setattr(receipt_addresses, "erase_receipt_address", spy)

    await sweep_receipt_addresses(db_session, now=await _in_days(31))
    assert len(visited) == 6
    assert visited == sorted(visited)

    visited.clear()
    await erase_account(db_session, payer.id)
    assert visited == sorted(visited)


@pytest.mark.parametrize(
    "unsettled",
    [
        TournamentPaymentStatus.preparing,
        TournamentPaymentStatus.ready,
        TournamentPaymentStatus.action_required,
        TournamentPaymentStatus.checking,
        TournamentPaymentStatus.expired,
        TournamentPaymentStatus.cancel_requested,
    ],
)
async def test_a_payment_that_may_still_capture_money_keeps_the_address(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    unsettled: TournamentPaymentStatus,
) -> None:
    """Financial resolution means every payment is terminal. A payment that is not
    can still succeed after the sweep: a cancel is best-effort, a processing
    payment is Stripe's to finish, and an expired one is deliberately not
    terminal. Its late success would snapshot an erased address."""
    payment = await _archived_quarantine(
        api_client, db_session, monkeypatch, amount_unverified=False
    )
    payment.status = unsettled
    await db_session.commit()

    assert await sweep_receipt_addresses(db_session, now=await _in_days(400)) == 0
    assert (await _address_state(db_session, payment))[0] == ADDRESS


async def test_the_sweep_holds_the_tournament_lock_while_it_checks_and_erases(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    engine: AsyncEngine,
) -> None:
    """Reconciliation takes the tournament lock before it records a refund. The
    sweep takes the same lock before it reads the tournament-wide predicate, so
    no refund can land between the check and the erasures of a partial sweep."""
    import asyncio

    from app.tournament_authority import lock_tournament

    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address=ADDRESS
    )
    tournament = await _tournament_of(db_session, payment)
    tournament.status = TournamentStatus.archived
    await db_session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    async with sessions() as gatekeeper:
        await lock_tournament(gatekeeper, payment.tournament_id)  # held
        async with sessions() as sweeper:
            sweep = asyncio.create_task(
                sweep_receipt_addresses(sweeper, now=await _in_days(31))
            )
            await asyncio.sleep(0.5)
            assert not sweep.done(), "the sweep did not wait for the tournament lock"
            await gatekeeper.rollback()
            assert await asyncio.wait_for(sweep, timeout=10) == 1


async def test_an_erased_checkout_refuses_a_new_address_but_still_clears(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A checkout without a succeeded payment has no payment tombstone, and the
    payer may still PATCH its address. Without its own erasure state, the same
    PATCH would write the erased address back after the sweep or an account
    erasure (including one that was waiting on the lock)."""
    from app.receipt_addresses import erase_receipt_address

    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, succeed=False, receipt_address=ADDRESS
    )
    await erase_receipt_address(db_session, checkout_id=payment.checkout_id)
    await db_session.commit()
    path = f"/v1/tournaments/{payment.tournament_id}/checkouts/{payment.checkout_id}"

    refused = await api_client.patch(
        path, json={"receipt_address": "again@example.com"}
    )
    cleared = await api_client.patch(path, json={"receipt_address": None})

    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "receipt_address_erased"
    assert cleared.status_code == 200
    checkout = await db_session.get(TournamentCheckout, payment.checkout_id)
    assert checkout is not None
    await db_session.refresh(checkout)
    assert checkout.receipt_address is None


async def test_the_database_refuses_an_address_beside_a_checkout_tombstone(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The previous release's PATCH writes the address without knowing the
    tombstone. In a rolling deploy it can resume after an erase commits, so the
    database itself must refuse the pair."""
    from sqlalchemy.exc import IntegrityError

    from app.receipt_addresses import erase_receipt_address

    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, succeed=False, receipt_address=ADDRESS
    )
    await erase_receipt_address(db_session, checkout_id=payment.checkout_id)
    await db_session.commit()

    with pytest.raises(IntegrityError):
        await db_session.execute(
            text(
                "UPDATE tournament_checkouts SET receipt_address = 'old@example.com' "
                "WHERE id = :id"
            ),
            {"id": payment.checkout_id},
        )
    await db_session.rollback()


async def test_a_late_success_carries_the_checkout_erasure_onto_the_payment(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.config import get_settings
    from app.receipt_addresses import erase_receipt_address
    from app.tournament_payments import reconcile_payment

    _payer, _owner, provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, succeed=False, receipt_address=ADDRESS
    )
    await erase_receipt_address(db_session, checkout_id=payment.checkout_id)
    await db_session.commit()

    provider.set_status(
        payment.provider_payment_intent_id,
        status="succeeded",
        amount_received=payment.amount_cents,
    )
    await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, settings=get_settings()
    )

    await db_session.refresh(payment)
    assert payment.status is TournamentPaymentStatus.succeeded
    assert payment.receipt_address is None
    assert payment.receipt_address_erased_at is not None
