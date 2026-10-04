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
    User,
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


async def test_the_database_carries_a_checkout_tombstone_onto_an_n_minus_1_late_success(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """During a rolling deploy the previous release can finish a late success
    after a new pod erased the checkout. Its ``_admit`` copies only the
    checkout's address, so the database must add the tombstone."""
    from app.receipt_addresses import erase_receipt_address

    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, succeed=False, receipt_address=ADDRESS
    )
    await erase_receipt_address(db_session, checkout_id=payment.checkout_id)
    await db_session.commit()

    # Exactly what the previous release writes when it records the success.
    await db_session.execute(
        text(
            "UPDATE tournament_payments SET status = 'succeeded', "
            "receipt_address = NULL WHERE id = :id"
        ),
        {"id": payment.id},
    )
    await db_session.commit()

    await db_session.refresh(payment)
    assert payment.receipt_address is None
    assert payment.receipt_address_erased_at is not None


async def test_the_database_erases_receipt_addresses_for_an_n_minus_1_account_erasure(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """After a rollback, the previous release's ``erase_account`` knows nothing
    about receipt addresses, and the account is then too erased for the new
    release to repair. So the erase itself must reach them."""
    payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address=ADDRESS
    )

    from app import identity_lifecycle

    async def previous_release_knows_nothing_of_receipts(
        *_args: object, **_kw: object
    ) -> None:
        return None

    # The previous release's erase_account is this one without the receipt step.
    monkeypatch.setattr(
        identity_lifecycle,
        "erase_receipt_addresses_of_account",
        previous_release_knows_nothing_of_receipts,
    )
    await identity_lifecycle.erase_account(db_session, payer.id)
    await db_session.commit()

    await db_session.refresh(payment)
    checkout = await db_session.get(TournamentCheckout, payment.checkout_id)
    assert checkout is not None
    await db_session.refresh(checkout)
    assert (checkout.receipt_address, payment.receipt_address) == (None, None)
    assert payment.receipt_address_erased_at is not None
    assert checkout.receipt_address_erased_at is not None


async def test_the_account_erasure_trigger_locks_checkouts_before_payments(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    engine: AsyncEngine,
) -> None:
    """``erase_receipt_address`` and the daily sweep lock a checkout, then its
    payment. The accounts trigger runs the same two tables for the same rows, so
    it must keep that order, or an overlapping sweep and erasure deadlock. With
    another session holding the checkout, the trigger must be waiting on it and
    must not yet hold the payment."""
    import asyncio

    from sqlalchemy.exc import DBAPIError

    payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address=ADDRESS
    )
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    shape = (
        "UPDATE accounts SET erased_at = now(), deactivated_at = now(), email = NULL, "
        "display_name = 'Erased account', confirmed_at = NULL, last_seen_at = NULL, "
        "agent_access_linked_at = NULL, agent_access_revoked_at = NULL WHERE id = :id"
    )

    async def erase_the_account() -> None:
        async with sessions() as eraser:
            await eraser.execute(text(shape), {"id": payer.id})
            # The credentials check is deferred to commit, so remove them after.
            for table, column in (
                ("account_session_tokens", "user_id"),
                ("login_identities", "account_id"),
            ):
                await eraser.execute(
                    text(f"DELETE FROM {table} WHERE {column} = :id"), {"id": payer.id}
                )
            await eraser.commit()

    async with sessions() as holder, sessions() as probe:
        await holder.execute(
            text("SELECT id FROM tournament_checkouts WHERE id = :id FOR UPDATE"),
            {"id": payment.checkout_id},
        )
        eraser_task = asyncio.create_task(erase_the_account())
        await asyncio.sleep(0.5)
        assert not eraser_task.done(), "the trigger did not wait for the checkout"
        # The payment row must still be free: the trigger is queued behind the checkout.
        try:
            await probe.execute(
                text(
                    "SELECT id FROM tournament_payments "
                    "WHERE id = :id FOR UPDATE NOWAIT"
                ),
                {"id": payment.id},
            )
            payment_free = True
        except DBAPIError:
            payment_free = False
        await probe.rollback()
        await holder.rollback()
        await asyncio.wait_for(eraser_task, timeout=10)

    assert payment_free, "the trigger locked the payment before the checkout"


async def test_account_erasure_locks_the_receipt_checkouts_before_it_deactivates(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    engine: AsyncEngine,
) -> None:
    """Deactivation invalidates an account's active checkouts, which locks them
    one by one before the receipt step runs. Taking the whole set in id order
    first keeps an overlapping sweep from deadlocking against it."""
    from sqlalchemy.exc import DBAPIError

    from app import identity_lifecycle

    payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, succeed=False, receipt_address=ADDRESS
    )
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    real_deactivate = identity_lifecycle.deactivate_account
    held_at_deactivation: list[bool] = []

    async def probe_then_deactivate(db: AsyncSession, account_id: object) -> None:
        async with sessions() as probe:
            try:
                await probe.execute(
                    text(
                        "SELECT id FROM tournament_checkouts "
                        "WHERE id = :id FOR UPDATE NOWAIT"
                    ),
                    {"id": payment.checkout_id},
                )
                held_at_deactivation.append(False)
            except DBAPIError:
                held_at_deactivation.append(True)
            await probe.rollback()
        await real_deactivate(db, account_id)  # type: ignore[arg-type]

    monkeypatch.setattr(identity_lifecycle, "deactivate_account", probe_then_deactivate)

    await identity_lifecycle.erase_account(db_session, payer.id)
    await db_session.commit()

    assert held_at_deactivation == [True]


@pytest.mark.parametrize("deleted_by", ["this_release", "n_minus_1_sql"])
async def test_deleting_the_last_unfinished_event_restarts_the_retention_clock(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    deleted_by: str,
) -> None:
    """The events that took payment finished long ago, and one unstarted event
    kept the tournament open. Deleting it makes the tournament complete today, so
    the 30 days run from the deletion, not from the old finish."""
    from sqlalchemy import select

    from app.tournament_events import delete_event

    _payer, owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address=ADDRESS
    )
    paid_events = await _events_of(db_session, payment)
    template = paid_events[0]
    extra = TournamentEvent(
        tournament_id=payment.tournament_id,
        name="Unplayed",
        format=template.format,
        draw_settings=template.draw_settings,
        stages=template.stages,
        max_players=None,
        entry_fee=template.entry_fee,
        timezone=template.timezone,
        slot=template.slot,
        match_settings=template.match_settings,
        predicates=[],
    )
    db_session.add(extra)
    await db_session.commit()
    await _cancel(db_session, paid_events)
    # Those finishes happened 40 days ago.
    long_ago = datetime.now(UTC) - timedelta(days=40)
    await db_session.execute(text("SET LOCAL session_replication_role = replica"))
    await db_session.execute(
        text(
            "UPDATE tournament_event_lifecycle_history "
            "SET observed_at = :t, occurred_at = NULL"
        ),
        {"t": long_ago},
    )
    await db_session.commit()
    # The sweep rolls back when it skips, which expires everything loaded here.
    tournament_id, extra_id, owner_id = payment.tournament_id, extra.id, owner.id
    assert await sweep_receipt_addresses(db_session, now=await _in_days(0)) == 0

    if deleted_by == "this_release":
        owner_again = await db_session.get(User, owner_id)
        assert owner_again is not None
        await delete_event(
            db_session,
            tournament_id=tournament_id,
            event_id=extra_id,
            actor=owner_again,
        )
    else:
        # The previous release deletes the row and knows nothing of the mark.
        await db_session.execute(
            text("DELETE FROM tournament_events WHERE id = :id"), {"id": extra_id}
        )
        await db_session.commit()

    # Complete today, so nothing is due now, and it is due 30 days from today.
    assert await sweep_receipt_addresses(db_session, now=await _in_days(0)) == 0
    assert await sweep_receipt_addresses(db_session, now=await _in_days(29)) == 0
    assert await sweep_receipt_addresses(db_session, now=await _in_days(31)) == 1
    remaining = await db_session.scalar(
        select(TournamentEvent.id).where(TournamentEvent.id == extra_id)
    )
    assert remaining is None


async def test_the_retention_sweep_tombstones_checkouts_that_never_had_an_address(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A checkout with no address gets no tombstone from the erase, so once the
    retention period ended the payer could still PATCH an address onto it. The
    sweep must tombstone every checkout of an eligible tournament, and count
    only the addresses it actually removed."""
    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, succeed=False
    )
    tournament = await _tournament_of(db_session, payment)
    tournament.status = TournamentStatus.archived
    # The payment is terminal, so nothing holds the cleanup back.
    payment.status = TournamentPaymentStatus.cancelled
    await db_session.commit()
    checkout_path = (
        f"/v1/tournaments/{payment.tournament_id}/checkouts/{payment.checkout_id}"
    )

    assert await sweep_receipt_addresses(db_session, now=await _in_days(31)) == 0

    refused = await api_client.patch(
        checkout_path, json={"receipt_address": "late@example.com"}
    )
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "receipt_address_erased"
