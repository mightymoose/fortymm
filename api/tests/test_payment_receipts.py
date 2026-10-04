"""Behavioral tests for the itemized payment receipt (#1810)."""

import uuid
from decimal import Decimal

import pytest
from httpx import AsyncClient
from rq import Queue
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app import email
from app.config import get_settings
from app.main import app as fastapi_app
from app.models import (
    NotificationPreference,
    TournamentCheckout,
    TournamentPayment,
    User,
)
from app.payments.dependencies import get_payment_provider
from app.payments.fake_provider import FakePaymentProvider
from app.tournament_payments import reconcile_payment
from tests._helpers import opponent_session, paid_tournament, start_session
from tests.test_tournament_payments import _setup


async def _paid_checkout(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    *,
    succeed: bool = True,
    receipt_address: str | None = None,
) -> tuple[User, User, FakePaymentProvider, TournamentPayment]:
    """Sign the payer in on ``api_client`` and take a two-event checkout to
    payment (and, by default, to verified success) through the HTTP surface."""
    payer = await start_session(api_client, db_session)
    owner = await make_merchant(db_session)
    _tournament, (first, second) = await paid_tournament(
        db_session, owner=owner, fees=(Decimal("20.00"), Decimal("15.50"))
    )
    _setup(monkeypatch, owner=owner)
    provider = FakePaymentProvider()
    fastapi_app.dependency_overrides[get_payment_provider] = lambda: provider
    checkouts = f"/v1/tournaments/{_tournament.id}/checkouts"
    created = await api_client.post(
        checkouts,
        json={
            "request_id": str(uuid.uuid4()),
            "event_ids": [str(first.id), str(second.id)],
        },
    )
    assert created.status_code == 201
    prepared = await api_client.post(f"{checkouts}/{created.json()['id']}/payment")
    assert prepared.status_code == 201
    payment = await db_session.scalar(
        select(TournamentPayment).where(TournamentPayment.id == prepared.json()["id"])
    )
    assert payment is not None
    if receipt_address is not None:
        saved = await api_client.patch(
            f"{checkouts}/{created.json()['id']}",
            json={"receipt_address": receipt_address},
        )
        assert saved.status_code == 200
    if succeed:
        provider.set_status(
            payment.provider_payment_intent_id,
            status="succeeded",
            amount_received=payment.amount_cents,
        )
        await reconcile_payment(
            db_session,
            payment_id=payment.id,
            provider=provider,
            settings=get_settings(),
        )
        await db_session.refresh(payment)
    return payer, owner, provider, payment


async def make_merchant(db_session: AsyncSession) -> User:
    from tests._helpers import make_user

    return await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")


async def test_payer_reads_an_itemized_receipt_for_a_succeeded_payment(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch
    )

    response = await api_client.get(f"/v1/payments/{payment.id}/receipt")

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == str(payment.id)
    assert body["reference"] == payment.reference
    assert body["amount_cents"] == 3550
    assert body["currency"] == "USD"
    assert sorted((line["price_cents"], line["outcome"]) for line in body["lines"]) == [
        (1550, "admitted"),
        (2000, "admitted"),
    ]
    assert all(line["event_name"] for line in body["lines"])


async def test_a_stranger_gets_not_found_for_a_receipt(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch
    )

    async with opponent_session(db_session, "stranger") as (stranger, _user):
        response = await stranger.get(f"/v1/payments/{payment.id}/receipt")

    assert response.status_code == 404


async def test_a_payment_that_has_not_succeeded_has_no_receipt(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, succeed=False
    )

    response = await api_client.get(f"/v1/payments/{payment.id}/receipt")

    assert response.status_code == 404


async def test_verified_success_enqueues_one_receipt_email_job_with_only_the_payment_id(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    fake_email_queue: Queue,
) -> None:
    # Record the enqueue without running the job, so the payload is inspectable.
    fake_email_queue._is_async = True

    _payer, _owner, provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address="receipts@example.com"
    )
    # A replay of the same success (status read, duplicate webhook) is a no-op.
    await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, settings=get_settings()
    )

    jobs = fake_email_queue.get_jobs()
    assert [(job.func_name, job.args, job.kwargs) for job in jobs] == [
        ("app.tournament_payments.send_payment_receipt_email", (str(payment.id),), {})
    ]
    assert "receipts@example.com" not in repr(jobs[0].__dict__)


class _SentEmails:
    """Records what would leave through SMTP, at the ``app.email._deliver`` seam."""

    def __init__(self) -> None:
        self.sent: list[dict[str, str]] = []

    def __call__(self, **kwargs: str) -> None:
        self.sent.append(kwargs)


async def _run_receipt_job(engine: AsyncEngine, payment: TournamentPayment) -> None:
    from app.tournament_payments import _execute_receipt_email

    await _execute_receipt_email(
        async_sessionmaker(engine, expire_on_commit=False), payment.id
    )


async def test_the_receipt_job_sends_a_combined_email_with_the_email_cell_on(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    engine: AsyncEngine,
) -> None:
    payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address="receipts@example.com"
    )
    db_session.add(
        NotificationPreference(
            user_id=payer.id, category="tournament", channel="email", enabled=True
        )
    )
    await db_session.commit()
    sent = _SentEmails()
    monkeypatch.setattr(email, "_deliver", sent)

    await _run_receipt_job(engine, payment)

    assert len(sent.sent) == 1
    message = sent.sent[0]
    assert message["to_email"] == "receipts@example.com"
    assert "entered" in message["subject"].lower()
    for expected in ("$20.00", "$15.50", "$35.50", payment.reference):
        assert expected in message["body"]
    assert f"/payments/{payment.id}/receipt" in message["body"]


async def test_the_receipt_job_sends_a_receipt_only_email_with_the_email_cell_off(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    engine: AsyncEngine,
) -> None:
    payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address="receipts@example.com"
    )
    db_session.add(
        NotificationPreference(
            user_id=payer.id, category="tournament", channel="email", enabled=False
        )
    )
    await db_session.commit()
    sent = _SentEmails()
    monkeypatch.setattr(email, "_deliver", sent)

    await _run_receipt_job(engine, payment)

    assert len(sent.sent) == 1
    assert sent.sent[0]["to_email"] == "receipts@example.com"
    assert "entered" not in sent.sent[0]["subject"].lower()
    assert payment.reference in sent.sent[0]["subject"]


async def test_the_receipt_job_sends_nothing_when_the_address_is_gone(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    engine: AsyncEngine,
) -> None:
    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address="receipts@example.com"
    )
    payment.receipt_address = None
    await db_session.commit()
    sent = _SentEmails()
    monkeypatch.setattr(email, "_deliver", sent)

    await _run_receipt_job(engine, payment)

    assert sent.sent == []


async def test_a_payment_with_no_receipt_address_enqueues_no_email_job(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    fake_email_queue: Queue,
) -> None:
    fake_email_queue._is_async = True

    await _paid_checkout(api_client, db_session, monkeypatch)

    assert fake_email_queue.get_jobs() == []


async def test_only_the_payer_sees_the_receipt_address_on_the_receipt(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.tournament_payments import read_payment_receipt

    _payer, owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address="receipts@example.com"
    )

    as_payer = await api_client.get(f"/v1/payments/{payment.id}/receipt")
    as_merchant = await read_payment_receipt(
        db_session, payment_id=payment.id, actor=owner
    )

    assert as_payer.json()["receipt_address"] == "receipts@example.com"
    assert as_merchant.receipt_address is None


async def test_the_payer_erases_the_receipt_address_everywhere_it_is_stored(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address="receipts@example.com"
    )

    response = await api_client.delete(f"/v1/payments/{payment.id}/receipt-address")

    assert response.status_code == 204
    await db_session.refresh(payment)
    checkout = await db_session.get(TournamentCheckout, payment.checkout_id)
    assert checkout is not None
    await db_session.refresh(checkout)
    assert payment.receipt_address is None
    assert checkout.receipt_address is None
    assert payment.receipt_address_erased_at is not None
    receipt = await api_client.get(f"/v1/payments/{payment.id}/receipt")
    assert receipt.json()["receipt_address"] is None


async def test_neither_a_stranger_nor_the_merchant_can_erase_the_address(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.tournament_payment_errors import PaymentNotFoundError
    from app.tournament_payments import erase_payment_receipt_address

    _payer, owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address="receipts@example.com"
    )

    async with opponent_session(db_session, "stranger") as (stranger, _user):
        response = await stranger.delete(f"/v1/payments/{payment.id}/receipt-address")
    with pytest.raises(PaymentNotFoundError):
        await erase_payment_receipt_address(
            db_session, payment_id=payment.id, actor=owner
        )

    assert response.status_code == 404
    await db_session.refresh(payment)
    assert payment.receipt_address == "receipts@example.com"
    assert payment.receipt_address_erased_at is None


async def test_erasing_the_account_erases_its_receipt_addresses(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.identity_lifecycle import erase_account

    payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address="receipts@example.com"
    )

    await erase_account(db_session, payer.id)
    await db_session.commit()

    await db_session.refresh(payment)
    assert payment.receipt_address is None
    assert payment.receipt_address_erased_at is not None
    checkout = await db_session.get(TournamentCheckout, payment.checkout_id)
    assert checkout is not None
    await db_session.refresh(checkout)
    assert checkout.receipt_address is None


async def test_the_payer_lists_their_succeeded_payments_in_a_tournament(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch
    )

    response = await api_client.get(f"/v1/tournaments/{payment.tournament_id}/payments")

    assert response.status_code == 200
    [row] = response.json()
    assert row["id"] == str(payment.id)
    assert row["reference"] == payment.reference
    assert row["amount_cents"] == 3550
    assert sorted(row["event_names"]) == ["Event 1", "Event 2"]

    async with opponent_session(db_session, "stranger") as (stranger, _user):
        others = await stranger.get(f"/v1/tournaments/{payment.tournament_id}/payments")
    assert others.status_code == 200
    assert others.json() == []


async def test_the_combined_email_never_says_entered_for_a_refund_pending_line(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    engine: AsyncEngine,
) -> None:
    from sqlalchemy import update

    from app.models import TournamentPaymentLine, TournamentPaymentLineOutcome

    payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address="receipts@example.com"
    )
    first_line = await db_session.scalar(
        select(TournamentPaymentLine)
        .where(TournamentPaymentLine.payment_id == payment.id)
        .order_by(TournamentPaymentLine.event_id)
        .limit(1)
    )
    assert first_line is not None
    await db_session.execute(
        update(TournamentPaymentLine)
        .where(TournamentPaymentLine.id == first_line.id)
        .values(outcome=TournamentPaymentLineOutcome.refund_due, entry_id=None)
    )
    db_session.add(
        NotificationPreference(
            user_id=payer.id, category="tournament", channel="email", enabled=True
        )
    )
    await db_session.commit()
    sent = _SentEmails()
    monkeypatch.setattr(email, "_deliver", sent)

    await _run_receipt_job(engine, payment)

    [message] = sent.sent
    assert "entered" not in message["subject"].lower()
    assert "Not admitted — refund pending" in message["body"]
    assert "Entry confirmed" in message["body"]


async def test_deactivating_an_account_keeps_its_receipt_address(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.identity_lifecycle import deactivate_account, reactivate_account

    payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address="receipts@example.com"
    )

    await deactivate_account(db_session, payer.id)
    await reactivate_account(db_session, payer.id)
    await db_session.commit()

    await db_session.refresh(payment)
    assert payment.receipt_address == "receipts@example.com"
    assert payment.receipt_address_erased_at is None


async def test_erasing_the_survivor_of_a_merge_erases_the_transferred_payments_address(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.identity_lifecycle import erase_account
    from tests._helpers import make_user

    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address="receipts@example.com"
    )
    survivor = await make_user(db_session, f"survivor-{uuid.uuid4().hex[:8]}")
    # What an account merge does: the payment moves to the survivor, and the
    # checkout keeps the source account as its payer.
    payment.payer_account_id = survivor.id
    await db_session.commit()

    await erase_account(db_session, survivor.id)
    await db_session.commit()

    await db_session.refresh(payment)
    checkout = await db_session.get(TournamentCheckout, payment.checkout_id)
    assert checkout is not None
    await db_session.refresh(checkout)
    assert (checkout.receipt_address, payment.receipt_address) == (None, None)
    assert payment.receipt_address_erased_at is not None


async def test_an_erasure_cannot_complete_while_the_receipt_email_is_being_sent(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    engine: AsyncEngine,
    postgres_url: str,
) -> None:
    """The job reads the address and then talks to SMTP. If an erasure could
    commit in between, the email would go to an address already reported erased.
    So the job keeps a read lock on the payment row until the send returns. A
    separate connection tries the erasure from inside the send."""
    import asyncio
    import threading

    from sqlalchemy.exc import DBAPIError
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    from app.receipt_addresses import erase_receipt_address

    _payer, _owner, _provider, payment = await _paid_checkout(
        api_client, db_session, monkeypatch, receipt_address="receipts@example.com"
    )
    outcome: list[str] = []

    def try_to_erase_during_the_send(**_kwargs: str) -> None:
        async def attempt() -> None:
            other = create_async_engine(postgres_url, poolclass=NullPool)
            try:
                async with AsyncSession(other) as session:
                    await session.execute(text("SET LOCAL lock_timeout = '400ms'"))
                    await erase_receipt_address(
                        session, checkout_id=payment.checkout_id
                    )
                    await session.commit()
                outcome.append("erased")
            except DBAPIError:
                outcome.append("blocked")
            finally:
                await other.dispose()

        worker = threading.Thread(target=lambda: asyncio.run(attempt()))
        worker.start()
        worker.join()

    monkeypatch.setattr(email, "_deliver", try_to_erase_during_the_send)

    await _run_receipt_job(engine, payment)

    assert outcome == ["blocked"]
