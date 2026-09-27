"""Behavioral tests for Stripe card payments on a tournament checkout (#1816)."""

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
import stripe
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.config import get_settings
from app.db import get_session
from app.main import app as fastapi_app
from app.models import (
    Tournament,
    TournamentCheckout,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentPayment,
    TournamentPaymentLineOutcome,
    TournamentPaymentProviderEvent,
    TournamentPaymentRefundObligation,
    TournamentPaymentRefundReason,
    TournamentPaymentStatus,
    User,
)
from app.payments.dependencies import get_payment_provider
from app.payments.fake_provider import FakePaymentProvider
from app.payments.provider import ProviderWebhookEvent
from app.schemas.tournament_checkout import (
    TournamentCheckoutCreate,
    TournamentCheckoutPaymentState,
    TournamentCheckoutState,
)
from app.tournament_checkouts import cancel_checkout, read_checkout, start_checkout
from app.tournament_entries import admit_to_event
from app.tournament_errors import RecordedPlayDeletionError
from app.tournament_events import delete_event
from app.tournament_payment_errors import (
    PaymentNotFoundError,
    PaymentNotReadyError,
    PaymentProviderUnavailableError,
)
from app.tournament_payments import (
    prepare_or_resume_payment,
    read_payment_status,
    reconcile_payment,
    record_and_reconcile_provider_event,
)
from app.tournament_registration import set_registration_open
from tests._helpers import make_raw_client, make_user, paid_tournament


async def _checkout_for(
    db: AsyncSession, *, tournament: Tournament, event: TournamentEvent, payer: User
) -> uuid.UUID:
    read = await start_checkout(
        db,
        tournament_id=tournament.id,
        actor=payer,
        request=TournamentCheckoutCreate(request_id=uuid.uuid4(), event_ids=[event.id]),
        client_ip=f"203.0.113.{uuid.uuid4().int % 200 + 1}",
    )
    return read.id


def _setup(monkeypatch: pytest.MonkeyPatch, *, owner: User) -> None:
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_fake")
    monkeypatch.setenv("STRIPE_ACCOUNT_ID", "acct_fake_platform")
    monkeypatch.setenv("STRIPE_WEBHOOK_SIGNING_SECRETS", "whsec_test_default")
    monkeypatch.delenv("ENVIRONMENT", raising=False)


async def _entered_player_ids(db: AsyncSession, event_id: uuid.UUID) -> list[uuid.UUID]:
    return list(
        await db.scalars(
            select(TournamentEntry.user_id).where(
                TournamentEntry.event_id == event_id,
                TournamentEntry.status == TournamentEntryStatus.entered,
            )
        )
    )


async def _prepared_payment(
    db: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    *,
    provider: FakePaymentProvider,
    capacities: tuple[int | None, ...] | None = None,
) -> tuple[User, User, Tournament, TournamentEvent, uuid.UUID, TournamentPayment]:
    owner = await make_user(db, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await paid_tournament(db, owner=owner, capacities=capacities)
    _setup(monkeypatch, owner=owner)
    checkout_id = await _checkout_for(
        db, tournament=tournament, event=event, payer=payer
    )
    await prepare_or_resume_payment(
        db,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    payment = await db.scalar(
        select(TournamentPayment).where(TournamentPayment.checkout_id == checkout_id)
    )
    assert payment is not None
    assert payment.provider_payment_intent_id is not None
    return owner, payer, tournament, event, checkout_id, payment


async def _obligations(
    db: AsyncSession, payment_id: uuid.UUID
) -> list[TournamentPaymentRefundObligation]:
    return list(
        await db.scalars(
            select(TournamentPaymentRefundObligation).where(
                TournamentPaymentRefundObligation.payment_id == payment_id
            )
        )
    )


def _sign(body: dict[str, object], secret: str) -> tuple[str, str]:
    payload = json.dumps(body)
    return payload, stripe.WebhookSignature.generate_signature_header(payload, secret)


def _signed_event(
    *, event_id: str, intent_id: str, payment_id: uuid.UUID, livemode: bool, secret: str
) -> tuple[str, str]:
    return _sign(
        {
            "id": event_id,
            "type": "payment_intent.succeeded",
            "livemode": livemode,
            "account": None,
            "data": {
                "object": {"id": intent_id, "metadata": {"payment_id": str(payment_id)}}
            },
        },
        secret,
    )


@contextmanager
def _app_overrides(
    session: Callable[[], AsyncIterator[AsyncSession]], provider: FakePaymentProvider
) -> Iterator[None]:
    fastapi_app.dependency_overrides[get_session] = session
    fastapi_app.dependency_overrides[get_payment_provider] = lambda: provider
    try:
        yield
    finally:
        fastapi_app.dependency_overrides.clear()


async def _post_webhook(
    make_session: async_sessionmaker[AsyncSession],
    provider: FakePaymentProvider,
    *,
    payload: str,
    headers: dict[str, str],
) -> int:
    async def _override_session() -> AsyncIterator[AsyncSession]:
        async with make_session() as session:
            yield session

    with _app_overrides(_override_session, provider):
        async with make_raw_client() as client:
            response = await client.post(
                "/v1/webhooks/stripe", content=payload, headers=headers
            )
    return response.status_code


async def test_happy_path_prepare_then_webhook_success_admits_exactly_once(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await paid_tournament(db_session, owner=owner)
    _setup(monkeypatch, owner=owner)
    checkout_id = await _checkout_for(
        db_session, tournament=tournament, event=event, payer=payer
    )

    provider = FakePaymentProvider()
    prepared = await prepare_or_resume_payment(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    assert prepared.payment_state is TournamentCheckoutPaymentState.ready
    assert prepared.client_secret is not None

    payment = await db_session.scalar(
        select(TournamentPayment).where(TournamentPayment.checkout_id == checkout_id)
    )
    assert payment is not None
    assert payment.provider_payment_intent_id is not None
    provider.set_status(
        payment.provider_payment_intent_id, status="succeeded", amount_received=2000
    )

    reconciled = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, settings=get_settings()
    )
    assert reconciled is not None
    assert reconciled.status is TournamentPaymentStatus.succeeded
    assert await _entered_player_ids(db_session, event.id) == [payer.primary_player.id]

    # The combined checkout read embeds the linked payment's mapped state.
    checkout_read = await read_checkout(
        db_session, tournament_id=tournament.id, checkout_id=checkout_id, actor=payer
    )
    assert checkout_read.payment_state is TournamentCheckoutPaymentState.succeeded
    # Admission consumed the hold. It is completed, not the player's cancel.
    assert checkout_read.status is TournamentCheckoutState.completed

    # Replaying reconcile (a duplicate webhook, or a status read racing it)
    # must not admit a second time or touch the settled row.
    again = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, settings=get_settings()
    )
    assert again is not None
    assert again.status is TournamentPaymentStatus.succeeded
    assert await _entered_player_ids(db_session, event.id) == [payer.primary_player.id]


async def test_declined_card_reports_ready_with_safe_error_code(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = FakePaymentProvider()
    _, payer, tournament, _, checkout_id, payment = await _prepared_payment(
        db_session, monkeypatch, provider=provider
    )
    provider.set_status(
        payment.provider_payment_intent_id,
        status="requires_payment_method",
        last_payment_error_code="card_declined",
    )
    reconciled = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, settings=get_settings()
    )
    assert reconciled is not None
    assert reconciled.status is TournamentPaymentStatus.ready
    assert reconciled.last_error_code == "card_declined"

    status_read = await read_payment_status(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    assert status_read.payment_state is TournamentCheckoutPaymentState.ready
    assert status_read.last_error_code == "card_declined"

    # A raw, non-allowlisted Stripe decline code never reaches the response.
    provider.set_status(
        payment.provider_payment_intent_id,
        status="requires_payment_method",
        last_payment_error_code="some_internal_stripe_detail",
    )
    reconciled_again = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, settings=get_settings()
    )
    assert reconciled_again is not None
    assert reconciled_again.last_error_code == "card_error"


async def test_duplicate_prepare_reuses_the_same_payment_intent(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await paid_tournament(db_session, owner=owner)
    _setup(monkeypatch, owner=owner)
    checkout_id = await _checkout_for(
        db_session, tournament=tournament, event=event, payer=payer
    )

    provider = FakePaymentProvider()
    first = await prepare_or_resume_payment(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    second = await prepare_or_resume_payment(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    assert first.id == second.id
    payments = list(
        await db_session.scalars(
            select(TournamentPayment).where(
                TournamentPayment.checkout_id == checkout_id
            )
        )
    )
    assert len(payments) == 1
    assert payments[0].provider_payment_intent_id is not None


async def test_unauthorized_caller_gets_not_found_for_status_and_secret(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    stranger = await make_user(db_session, f"stranger-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await paid_tournament(db_session, owner=owner)
    _setup(monkeypatch, owner=owner)
    checkout_id = await _checkout_for(
        db_session, tournament=tournament, event=event, payer=payer
    )
    provider = FakePaymentProvider()
    await prepare_or_resume_payment(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )

    with pytest.raises(PaymentNotFoundError):
        await read_payment_status(
            db_session,
            tournament_id=tournament.id,
            checkout_id=checkout_id,
            actor=stranger,
            provider=provider,
            settings=get_settings(),
        )
    with pytest.raises(PaymentNotFoundError):
        await prepare_or_resume_payment(
            db_session,
            tournament_id=tournament.id,
            checkout_id=checkout_id,
            actor=stranger,
            provider=provider,
            settings=get_settings(),
        )

    # The merchant account MAY read status (never the secret — that response
    # shape has no such field at all).
    merchant_read = await read_payment_status(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=owner,
        provider=provider,
        settings=get_settings(),
    )
    assert merchant_read.id is not None


async def test_amount_mismatch_quarantines_with_the_retrieved_amount(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = FakePaymentProvider()
    *_, event, _, payment = await _prepared_payment(
        db_session, monkeypatch, provider=provider
    )
    # Simulate Stripe reporting a captured amount that does not match what
    # this checkout billed — a corrupted/forged/mismatched intent.
    provider.set_status(
        payment.provider_payment_intent_id, status="succeeded", amount_received=999
    )
    provider.corrupt_amount(payment.provider_payment_intent_id, 999)

    reconciled = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, settings=get_settings()
    )
    assert reconciled is not None
    assert reconciled.status is TournamentPaymentStatus.quarantined
    assert reconciled.amount_unverified is False
    obligations = list(
        await db_session.scalars(
            select(TournamentPaymentRefundObligation).where(
                TournamentPaymentRefundObligation.payment_id == payment.id
            )
        )
    )
    assert len(obligations) == 1
    assert obligations[0].amount_cents == 999
    assert obligations[0].event_id is None
    assert await _entered_player_ids(db_session, event.id) == []


async def test_refused_retrieval_quarantines_with_amount_unverified_and_no_obligation(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Stripe answers that the PaymentIntent is not on the payee account: no
    verified captured amount exists, so quarantine records no obligation."""
    provider = FakePaymentProvider()
    *_, payment = await _prepared_payment(db_session, monkeypatch, provider=provider)
    provider.retrieval_wrong_account.add(payment.provider_payment_intent_id)

    reconciled = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, settings=get_settings()
    )
    assert reconciled is not None
    assert reconciled.status is TournamentPaymentStatus.quarantined
    assert reconciled.amount_unverified is True
    assert await _obligations(db_session, payment.id) == []


async def test_credentials_for_another_platform_account_do_not_quarantine(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Operations switch the Stripe key and ``STRIPE_ACCOUNT_ID`` from account A
    to account B while an A payment is still open. Stripe refuses B's key for
    A's PaymentIntent. That refusal says nothing about the payment, so it is
    temporarily unavailable, never quarantined. Restoring A settles it."""
    provider = FakePaymentProvider()
    _, payer, tournament, event, checkout_id, payment = await _prepared_payment(
        db_session, monkeypatch, provider=provider
    )
    assert payment.provider_payment_intent_id is not None
    monkeypatch.setenv("STRIPE_ACCOUNT_ID", "acct_other_platform")
    # What Stripe answers when B's key asks about A's PaymentIntent.
    provider.retrieval_wrong_account.add(payment.provider_payment_intent_id)
    provider.set_status(
        payment.provider_payment_intent_id, status="succeeded", amount_received=2000
    )

    with pytest.raises(PaymentProviderUnavailableError):
        await reconcile_payment(
            db_session,
            payment_id=payment.id,
            provider=provider,
            settings=get_settings(),
        )
    status_read = await read_payment_status(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    assert status_read.payment_state is TournamentCheckoutPaymentState.ready
    unchanged = await db_session.scalar(
        select(TournamentPayment)
        .where(TournamentPayment.id == payment.id)
        .execution_options(populate_existing=True)
    )
    assert unchanged is not None
    assert unchanged.status is TournamentPaymentStatus.ready

    monkeypatch.setenv("STRIPE_ACCOUNT_ID", "acct_fake_platform")
    provider.retrieval_wrong_account.clear()
    reconciled = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, settings=get_settings()
    )
    assert reconciled is not None
    assert reconciled.status is TournamentPaymentStatus.succeeded
    assert await _entered_player_ids(db_session, event.id) == [payer.primary_player.id]


async def test_an_uncertain_create_is_not_replayed_under_another_platform_account(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A replayed create under account B's key would open a second
    PaymentIntent on the wrong account. The payment stays ``preparing`` until
    account A's credentials return."""
    provider = FakePaymentProvider(force_uncertain_once=True)
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await paid_tournament(db_session, owner=owner)
    _setup(monkeypatch, owner=owner)
    checkout_id = await _checkout_for(
        db_session, tournament=tournament, event=event, payer=payer
    )
    await prepare_or_resume_payment(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    assert provider.create_calls == [None]

    monkeypatch.setenv("STRIPE_ACCOUNT_ID", "acct_other_platform")
    status_read = await read_payment_status(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    assert provider.create_calls == [None]
    assert status_read.payment_state is TournamentCheckoutPaymentState.preparing

    monkeypatch.setenv("STRIPE_ACCOUNT_ID", "acct_fake_platform")
    await read_payment_status(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    assert provider.create_calls == [None, None]


async def test_unreachable_stripe_leaves_the_payment_unchanged(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A network failure says nothing about the PaymentIntent. It must never
    quarantine a payment that later succeeds, and the status read answers
    with the last known state."""
    provider = FakePaymentProvider()
    _, payer, tournament, event, checkout_id, payment = await _prepared_payment(
        db_session, monkeypatch, provider=provider
    )
    provider.retrieval_failures.add(payment.provider_payment_intent_id)

    with pytest.raises(PaymentProviderUnavailableError):
        await reconcile_payment(
            db_session,
            payment_id=payment.id,
            provider=provider,
            settings=get_settings(),
        )
    status_read = await read_payment_status(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    assert status_read.payment_state is TournamentCheckoutPaymentState.ready

    provider.retrieval_failures.clear()
    provider.set_status(
        payment.provider_payment_intent_id, status="succeeded", amount_received=2000
    )
    reconciled = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, settings=get_settings()
    )
    assert reconciled is not None
    assert reconciled.status is TournamentPaymentStatus.succeeded
    assert await _entered_player_ids(db_session, event.id) == [payer.primary_player.id]


async def test_late_success_admits_after_the_checkout_has_expired(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Expiry alone does not forfeit an otherwise-valid entry (#1816)."""
    provider = FakePaymentProvider()
    _, payer, _, event, checkout_id, payment = await _prepared_payment(
        db_session, monkeypatch, provider=provider
    )

    # The checkout itself has since expired (a slow card entry) — capacity
    # and eligibility are unaffected, so a late success still admits.
    await db_session.execute(
        update(TournamentCheckout)
        .where(TournamentCheckout.id == checkout_id)
        .values(
            created_at=datetime.now(UTC) - timedelta(hours=1),
            expires_at=datetime.now(UTC) - timedelta(minutes=1),
        )
    )
    await db_session.commit()

    provider.set_status(
        payment.provider_payment_intent_id, status="succeeded", amount_received=2000
    )
    reconciled = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, settings=get_settings()
    )
    assert reconciled is not None
    assert reconciled.status is TournamentPaymentStatus.succeeded
    assert await _entered_player_ids(db_session, event.id) == [payer.primary_player.id]


async def test_late_success_records_refund_when_capacity_has_filled(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = FakePaymentProvider()
    owner, _, tournament, event, checkout_id, payment = await _prepared_payment(
        db_session, monkeypatch, provider=provider, capacities=(1,)
    )
    other_player = await make_user(db_session, f"other-{uuid.uuid4().hex[:8]}")

    # The checkout's hold expires (a slow card entry) — its slot frees up —
    # and somebody else (a director entry; a paid event's self-registration
    # arm is gated on checkout) takes the single capped slot before Stripe
    # reports success.
    await db_session.execute(
        update(TournamentCheckout)
        .where(TournamentCheckout.id == checkout_id)
        .values(
            created_at=datetime.now(UTC) - timedelta(hours=1),
            expires_at=datetime.now(UTC) - timedelta(minutes=1),
        )
    )
    await db_session.commit()
    await admit_to_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event.id,
        actor=owner,
        user_id=other_player.primary_player.id,
    )
    await db_session.commit()

    provider.set_status(
        payment.provider_payment_intent_id, status="succeeded", amount_received=2000
    )
    reconciled = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, settings=get_settings()
    )
    assert reconciled is not None
    assert reconciled.status is TournamentPaymentStatus.succeeded
    line = reconciled.lines[0]
    assert line.outcome is TournamentPaymentLineOutcome.refund_due
    obligations = list(
        await db_session.scalars(
            select(TournamentPaymentRefundObligation).where(
                TournamentPaymentRefundObligation.payment_id == payment.id
            )
        )
    )
    assert len(obligations) == 1
    assert obligations[0].event_id == event.id
    assert obligations[0].amount_cents == 2000


async def test_webhook_verifies_signature_and_replay_is_a_no_op(
    monkeypatch: pytest.MonkeyPatch, engine: AsyncEngine
) -> None:
    make_session = async_sessionmaker(engine, expire_on_commit=False)
    async with make_session() as seed_session:
        owner = await make_user(seed_session, f"merchant-{uuid.uuid4().hex[:8]}")
        payer = await make_user(seed_session, f"payer-{uuid.uuid4().hex[:8]}")
        tournament, (event,) = await paid_tournament(seed_session, owner=owner)
        _setup(monkeypatch, owner=owner)
        checkout_id = await _checkout_for(
            seed_session, tournament=tournament, event=event, payer=payer
        )
        provider = FakePaymentProvider()
        prepared = await prepare_or_resume_payment(
            seed_session,
            tournament_id=tournament.id,
            checkout_id=checkout_id,
            actor=payer,
            provider=provider,
            settings=get_settings(),
        )
        payment_id = prepared.id
        payment = await seed_session.get(TournamentPayment, payment_id)
        assert payment is not None
        intent_id = payment.provider_payment_intent_id
        assert intent_id is not None
        provider.set_status(intent_id, status="succeeded", amount_received=2000)
        player_id = payer.primary_player.id

    secret = "whsec_test_secret"
    monkeypatch.setenv("STRIPE_WEBHOOK_SIGNING_SECRETS", secret)
    payload, signature = _signed_event(
        event_id="evt_test_1",
        intent_id=intent_id,
        payment_id=payment_id,
        livemode=False,
        secret=secret,
    )
    headers = {"stripe-signature": signature, "content-type": "application/json"}

    first = await _post_webhook(
        make_session, provider, payload=payload, headers=headers
    )
    assert first == 200
    second = await _post_webhook(
        make_session, provider, payload=payload, headers=headers
    )
    assert second == 200
    bad = await _post_webhook(
        make_session,
        provider,
        payload=payload,
        headers={
            "stripe-signature": "t=1,v1=deadbeef",
            "content-type": "application/json",
        },
    )
    assert bad == 400

    async with make_session() as verify_session:
        settled = await verify_session.get(TournamentPayment, payment_id)
        assert settled is not None
        assert settled.status is TournamentPaymentStatus.succeeded
        assert await _entered_player_ids(verify_session, event.id) == [player_id]


async def _hold_the_payment_lock(session: AsyncSession, payment_id: uuid.UUID) -> None:
    """Take ``reconcile_payment``'s own row lock, uncommitted — staging the
    contention deterministically rather than hoping ``asyncio.gather``
    interleaves two sessions the damning way (api/CLAUDE.md's concurrency
    testing gotcha: the obvious ``gather``-based version stays green against a
    broken guard)."""
    await session.execute(
        select(TournamentPayment)
        .where(TournamentPayment.id == payment_id)
        .with_for_update()
    )


async def test_concurrent_reconcile_of_the_same_success_admits_exactly_once(
    monkeypatch: pytest.MonkeyPatch, engine: AsyncEngine
) -> None:
    """The payment row's ``with_for_update`` lock serializes a webhook racing
    a status read for the same success.

    Staged like ``test_two_entrants_racing_for_the_last_slot_yield_exactly_one_entry``:
    a gatekeeper session takes ``reconcile_payment``'s own lock and holds it
    open, uncommitted; two concurrent ``reconcile_payment`` calls are launched
    and asserted to *block* on it (``pytest.fail`` if either finishes early —
    an unlocked read never waits); the gatekeeper then releases and both
    proceed to see the row settled.

    **Falsified**: removing ``.with_for_update()`` from ``reconcile_payment``'s
    payment ``SELECT`` made this test red for the stated reason. The
    ``.done()`` guard below did not always catch it (both calls can still
    finish inside the 0.25s window once unblocked), but the FINAL assertion
    did, reliably: one of the two unlocked concurrent calls lost the entry's
    deferred-uniqueness race, caught its own ``already_entered`` refusal, and
    recorded a SPURIOUS refund obligation for a line that the other call had
    just successfully admitted — money Fortymm would incorrectly owe back on
    a payment that in fact fully succeeded. The lock has been restored.
    """
    make_session = async_sessionmaker(engine, expire_on_commit=False)
    async with make_session() as seed_session:
        owner = await make_user(seed_session, f"merchant-{uuid.uuid4().hex[:8]}")
        payer = await make_user(seed_session, f"payer-{uuid.uuid4().hex[:8]}")
        tournament, (event,) = await paid_tournament(seed_session, owner=owner)
        _setup(monkeypatch, owner=owner)
        checkout_id = await _checkout_for(
            seed_session, tournament=tournament, event=event, payer=payer
        )
        provider = FakePaymentProvider()
        prepared = await prepare_or_resume_payment(
            seed_session,
            tournament_id=tournament.id,
            checkout_id=checkout_id,
            actor=payer,
            provider=provider,
            settings=get_settings(),
        )
        payment_id = prepared.id
        payment = await seed_session.get(TournamentPayment, payment_id)
        assert payment is not None
        intent_id = payment.provider_payment_intent_id
        assert intent_id is not None
        provider.set_status(intent_id, status="succeeded", amount_received=2000)
        player_id = payer.primary_player.id

    async def _reconcile_once() -> TournamentPaymentStatus | None:
        async with make_session() as session:
            result = await reconcile_payment(
                session,
                payment_id=payment_id,
                provider=provider,
                settings=get_settings(),
            )
            return result.status if result is not None else None

    async with make_session() as gatekeeper:
        await _hold_the_payment_lock(gatekeeper, payment_id)
        first = asyncio.create_task(_reconcile_once())
        second = asyncio.create_task(_reconcile_once())
        # Every chance to finish — and neither can, parked on the payment
        # row's lock, before its own status/outcome check.
        await asyncio.sleep(0.25)
        if first.done() or second.done():
            pytest.fail(
                "a concurrent reconcile did not block on the payment row's "
                f"lock: it ran to completion against an uncommitted gatekeeper "
                f"(first.done()={first.done()}, second.done()={second.done()})"
            )
        await gatekeeper.commit()
        results = [await first, await second]

    assert all(status is TournamentPaymentStatus.succeeded for status in results)

    async with make_session() as verify_session:
        assert await _entered_player_ids(verify_session, event.id) == [player_id]
        obligations = list(
            await verify_session.scalars(
                select(TournamentPaymentRefundObligation).where(
                    TournamentPaymentRefundObligation.payment_id == payment_id
                )
            )
        )
        assert obligations == []


async def test_director_entry_marks_open_payment_cancel_requested_and_enqueues_cancel(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch, fake_payments_queue
) -> None:
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await paid_tournament(db_session, owner=owner)
    _setup(monkeypatch, owner=owner)
    checkout_id = await _checkout_for(
        db_session, tournament=tournament, event=event, payer=payer
    )
    provider = FakePaymentProvider()
    prepared = await prepare_or_resume_payment(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    payment_id = prepared.id

    # The director enters the payer directly (phone/offline registration)
    # while the payment is still open.
    await admit_to_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event.id,
        actor=owner,
        user_id=payer.primary_player.id,
    )
    await db_session.commit()

    payment = await db_session.get(TournamentPayment, payment_id)
    assert payment is not None
    assert payment.status is TournamentPaymentStatus.cancel_requested
    assert payment.cancel_requested_at is not None
    assert [job.args for job in fake_payments_queue.jobs] == [(str(payment_id),)]


async def test_late_success_after_director_entry_stands_and_records_refund(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch, fake_payments_queue
) -> None:
    """#1816: "If Stripe reports success after that cancel, the director
    entry stands. The line records 'already registered' with a full refund
    obligation."
    """
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await paid_tournament(db_session, owner=owner)
    _setup(monkeypatch, owner=owner)
    checkout_id = await _checkout_for(
        db_session, tournament=tournament, event=event, payer=payer
    )
    provider = FakePaymentProvider()
    prepared = await prepare_or_resume_payment(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    payment_id = prepared.id
    payment = await db_session.get(TournamentPayment, payment_id)
    assert payment is not None
    intent_id = payment.provider_payment_intent_id
    assert intent_id is not None

    await admit_to_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event.id,
        actor=owner,
        user_id=payer.primary_player.id,
    )
    await db_session.commit()

    entry_before = await db_session.scalar(
        select(TournamentEntry.id).where(
            TournamentEntry.event_id == event.id,
            TournamentEntry.user_id == payer.primary_player.id,
        )
    )
    assert entry_before is not None

    provider.set_status(intent_id, status="succeeded", amount_received=2000)
    reconciled = await reconcile_payment(
        db_session, payment_id=payment_id, provider=provider, settings=get_settings()
    )
    assert reconciled is not None
    assert reconciled.status is TournamentPaymentStatus.succeeded
    line = reconciled.lines[0]
    assert line.outcome is TournamentPaymentLineOutcome.refund_due

    # The director's entry stands — no second/duplicate entry was created.
    entry_after = await db_session.scalar(
        select(TournamentEntry.id).where(
            TournamentEntry.event_id == event.id,
            TournamentEntry.user_id == payer.primary_player.id,
        )
    )
    assert entry_after == entry_before

    obligations = list(
        await db_session.scalars(
            select(TournamentPaymentRefundObligation).where(
                TournamentPaymentRefundObligation.payment_id == payment_id
            )
        )
    )
    assert len(obligations) == 1
    assert obligations[0].event_id == event.id
    assert obligations[0].amount_cents == 2000


@pytest.mark.parametrize("other_event_full", [False, True], ids=["free", "full"])
async def test_late_success_after_director_entry_on_one_event_of_two(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    fake_payments_queue,
    other_event_full: bool,
) -> None:
    """#1816 P6 decision A: a director entry on one event of a two-event
    checkout invalidates the whole checkout. If Stripe later reports success,
    the director's line records ``superseded_by_director_entry`` with a full
    refund. The other line runs admission again: it admits when capacity is
    free, and records a full ``line_could_not_admit`` refund when it is not.
    """
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (director_event, other_event) = await paid_tournament(
        db_session,
        owner=owner,
        fees=(Decimal("20.00"), Decimal("30.00")),
        capacities=(None, 1),
    )
    _setup(monkeypatch, owner=owner)
    checkout = await start_checkout(
        db_session,
        tournament_id=tournament.id,
        actor=payer,
        request=TournamentCheckoutCreate(
            request_id=uuid.uuid4(), event_ids=[director_event.id, other_event.id]
        ),
        client_ip=f"203.0.113.{uuid.uuid4().int % 200 + 1}",
    )
    provider = FakePaymentProvider()
    prepared = await prepare_or_resume_payment(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout.id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    payment_id = prepared.id
    payment = await db_session.get(TournamentPayment, payment_id)
    assert payment is not None
    intent_id = payment.provider_payment_intent_id
    assert intent_id is not None

    await admit_to_event(
        db_session,
        tournament_id=tournament.id,
        event_id=director_event.id,
        actor=owner,
        user_id=payer.primary_player.id,
    )
    await db_session.commit()
    await db_session.refresh(payment)
    assert payment.status is TournamentPaymentStatus.cancel_requested

    other_player = await make_user(db_session, f"other-{uuid.uuid4().hex[:8]}")
    if other_event_full:
        # The invalidated checkout no longer holds the single capped slot, so
        # the director can give it to somebody else before Stripe reports.
        await admit_to_event(
            db_session,
            tournament_id=tournament.id,
            event_id=other_event.id,
            actor=owner,
            user_id=other_player.primary_player.id,
        )
        await db_session.commit()

    provider.set_status(intent_id, status="succeeded", amount_received=5000)
    reconciled = await reconcile_payment(
        db_session, payment_id=payment_id, provider=provider, settings=get_settings()
    )
    assert reconciled is not None
    assert reconciled.status is TournamentPaymentStatus.succeeded
    outcomes = {line.event_id: line.outcome for line in reconciled.lines}
    refunds = {
        (obligation.event_id, obligation.reason, obligation.amount_cents)
        for obligation in await _obligations(db_session, payment_id)
    }
    director_refund = (
        director_event.id,
        TournamentPaymentRefundReason.superseded_by_director_entry,
        2000,
    )
    assert outcomes[director_event.id] is TournamentPaymentLineOutcome.refund_due
    assert await _entered_player_ids(db_session, director_event.id) == [
        payer.primary_player.id
    ]
    if other_event_full:
        assert outcomes[other_event.id] is TournamentPaymentLineOutcome.refund_due
        assert refunds == {
            director_refund,
            (
                other_event.id,
                TournamentPaymentRefundReason.line_could_not_admit,
                3000,
            ),
        }
        assert await _entered_player_ids(db_session, other_event.id) == [
            other_player.primary_player.id
        ]
    else:
        assert outcomes[other_event.id] is TournamentPaymentLineOutcome.admitted
        assert refunds == {director_refund}
        assert await _entered_player_ids(db_session, other_event.id) == [
            payer.primary_player.id
        ]


async def test_event_with_payment_evidence_cannot_be_deleted(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#1816: deletion guards keep financial evidence — no cascade erases it.
    ``tournament_payment_lines.event_id`` carries a real ``ondelete=RESTRICT``
    foreign key (unlike a checkout line's deliberate snapshot), so this is
    also enforced at the database level; the guard turns it into the same
    clean domain refusal every other retained-history reason already gives.
    """
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await paid_tournament(db_session, owner=owner)
    _setup(monkeypatch, owner=owner)
    checkout_id = await _checkout_for(
        db_session, tournament=tournament, event=event, payer=payer
    )
    provider = FakePaymentProvider()
    await prepare_or_resume_payment(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )

    with pytest.raises(RecordedPlayDeletionError):
        await delete_event(
            db_session, tournament_id=tournament.id, event_id=event.id, actor=owner
        )

    survives = await db_session.scalar(
        select(TournamentEvent.id).where(TournamentEvent.id == event.id)
    )
    assert survives == event.id


async def test_late_success_after_the_player_cancelled_refunds_and_admits_nobody(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Cancellation (and so selection replacement, which requires it) stays
    permanent. A late success does not reverse it (#1816)."""
    provider = FakePaymentProvider()
    _, payer, tournament, event, checkout_id, payment = await _prepared_payment(
        db_session, monkeypatch, provider=provider
    )
    await cancel_checkout(
        db_session, tournament_id=tournament.id, checkout_id=checkout_id, actor=payer
    )
    provider.set_status(
        payment.provider_payment_intent_id, status="succeeded", amount_received=2000
    )

    reconciled = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, settings=get_settings()
    )
    assert reconciled is not None
    assert reconciled.status is TournamentPaymentStatus.succeeded
    assert reconciled.lines[0].outcome is TournamentPaymentLineOutcome.refund_due
    assert await _entered_player_ids(db_session, event.id) == []
    (obligation,) = await _obligations(db_session, payment.id)
    assert obligation.reason is TournamentPaymentRefundReason.checkout_superseded
    assert obligation.amount_cents == 2000
    checkout_read = await read_checkout(
        db_session, tournament_id=tournament.id, checkout_id=checkout_id, actor=payer
    )
    assert checkout_read.status is TournamentCheckoutState.cancelled


async def test_late_success_after_registration_closed_and_reopened_refunds(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Closure stays permanent: reopening the window afterwards does not let
    a payment for the closed window admit."""
    provider = FakePaymentProvider()
    owner, _, tournament, event, _, payment = await _prepared_payment(
        db_session, monkeypatch, provider=provider
    )
    await set_registration_open(
        db_session, tournament_id=tournament.id, actor=owner, is_open=False
    )
    await set_registration_open(
        db_session, tournament_id=tournament.id, actor=owner, is_open=True
    )
    provider.set_status(
        payment.provider_payment_intent_id, status="succeeded", amount_received=2000
    )

    reconciled = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, settings=get_settings()
    )
    assert reconciled is not None
    assert await _entered_player_ids(db_session, event.id) == []
    (obligation,) = await _obligations(db_session, payment.id)
    assert obligation.reason is TournamentPaymentRefundReason.checkout_superseded


async def test_status_read_replays_an_uncertain_create_with_the_same_key(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await paid_tournament(db_session, owner=owner)
    _setup(monkeypatch, owner=owner)
    checkout_id = await _checkout_for(
        db_session, tournament=tournament, event=event, payer=payer
    )
    provider = FakePaymentProvider(force_uncertain_once=True)
    prepared = await prepare_or_resume_payment(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    assert prepared.payment_state is TournamentCheckoutPaymentState.preparing
    assert prepared.client_secret is None

    status_read = await read_payment_status(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    assert status_read.payment_state is TournamentCheckoutPaymentState.ready
    payment = await db_session.get(TournamentPayment, prepared.id)
    assert payment is not None
    assert payment.provider_payment_intent_id is not None

    resumed = await prepare_or_resume_payment(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    assert resumed.client_secret is not None


async def test_an_expired_checkout_cannot_start_a_new_payment(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await paid_tournament(db_session, owner=owner)
    _setup(monkeypatch, owner=owner)
    checkout_id = await _checkout_for(
        db_session, tournament=tournament, event=event, payer=payer
    )
    await db_session.execute(
        update(TournamentCheckout)
        .where(TournamentCheckout.id == checkout_id)
        .values(
            created_at=datetime.now(UTC) - timedelta(hours=1),
            expires_at=datetime.now(UTC) - timedelta(minutes=1),
        )
    )
    await db_session.commit()

    with pytest.raises(PaymentNotReadyError):
        await prepare_or_resume_payment(
            db_session,
            tournament_id=tournament.id,
            checkout_id=checkout_id,
            actor=payer,
            provider=FakePaymentProvider(),
            settings=get_settings(),
        )


async def test_webhook_mode_mismatch_quarantines_and_admits_nobody(
    monkeypatch: pytest.MonkeyPatch, engine: AsyncEngine
) -> None:
    """An event's ``livemode`` must match the key mode (#1816). A live-mode
    event against a test key quarantines, with the amount Fortymm retrieved."""
    make_session = async_sessionmaker(engine, expire_on_commit=False)
    provider = FakePaymentProvider()
    async with make_session() as seed_session:
        *_, event, _, payment = await _prepared_payment(
            seed_session, monkeypatch, provider=provider
        )
        intent_id = payment.provider_payment_intent_id
        assert intent_id is not None
        provider.set_status(intent_id, status="succeeded", amount_received=2000)

    secret = "whsec_test_secret"
    monkeypatch.setenv("STRIPE_WEBHOOK_SIGNING_SECRETS", secret)
    payload, signature = _signed_event(
        event_id=f"evt_{uuid.uuid4().hex}",
        intent_id=intent_id,
        payment_id=payment.id,
        livemode=True,
        secret=secret,
    )

    response = await _post_webhook(
        make_session,
        provider,
        payload=payload,
        headers={"stripe-signature": signature},
    )
    assert response == 200
    missing = await _post_webhook(make_session, provider, payload=payload, headers={})
    assert missing == 400

    async with make_session() as verify_session:
        settled = await verify_session.get(TournamentPayment, payment.id)
        assert settled is not None
        assert settled.status is TournamentPaymentStatus.quarantined
        assert await _entered_player_ids(verify_session, event.id) == []
        (obligation,) = await _obligations(verify_session, payment.id)
        assert obligation.amount_cents == 2000


async def test_webhook_retries_when_stripe_is_unreachable(
    monkeypatch: pytest.MonkeyPatch, engine: AsyncEngine
) -> None:
    """An unreachable Stripe is not an acknowledgement. The endpoint answers
    503 and forgets the event, so Stripe's retry of the SAME event admits."""
    make_session = async_sessionmaker(engine, expire_on_commit=False)
    provider = FakePaymentProvider()
    async with make_session() as seed_session:
        _, payer, _, event, _, payment = await _prepared_payment(
            seed_session, monkeypatch, provider=provider
        )
        intent_id = payment.provider_payment_intent_id
        assert intent_id is not None
        provider.set_status(intent_id, status="succeeded", amount_received=2000)
        player_id = payer.primary_player.id

    secret = "whsec_test_secret"
    monkeypatch.setenv("STRIPE_WEBHOOK_SIGNING_SECRETS", secret)
    payload, signature = _signed_event(
        event_id=f"evt_{uuid.uuid4().hex}",
        intent_id=intent_id,
        payment_id=payment.id,
        livemode=False,
        secret=secret,
    )

    headers = {"stripe-signature": signature}
    provider.retrieval_failures.add(intent_id)
    unavailable = await _post_webhook(
        make_session, provider, payload=payload, headers=headers
    )
    assert unavailable == 503
    provider.retrieval_failures.clear()
    retried = await _post_webhook(
        make_session, provider, payload=payload, headers=headers
    )
    assert retried == 200

    async with make_session() as verify_session:
        settled = await verify_session.get(TournamentPayment, payment.id)
        assert settled is not None
        assert settled.status is TournamentPaymentStatus.succeeded
        assert await _entered_player_ids(verify_session, event.id) == [player_id]


@pytest.mark.parametrize(
    ("fields", "event_account"),
    [
        ({"metadata": {"payment_id": str(uuid.UUID(int=0))}}, None),
        ({"currency": "eur"}, None),
        ({}, "acct_someone_else"),
    ],
    ids=["metadata-payment-id", "currency", "event-account"],
)
async def test_identity_mismatch_quarantines_and_admits_nobody(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    fields: dict[str, object],
    event_account: str | None,
) -> None:
    provider = FakePaymentProvider()
    *_, event, _, payment = await _prepared_payment(
        db_session, monkeypatch, provider=provider
    )
    intent_id = payment.provider_payment_intent_id
    assert intent_id is not None
    provider.set_status(intent_id, status="succeeded", amount_received=2000)
    provider._update(intent_id, **fields)
    source_event = ProviderWebhookEvent.model_validate(
        {
            "id": f"evt_{uuid.uuid4().hex}",
            "type": "payment_intent.succeeded",
            "livemode": False,
            "account": event_account,
            "data": {"object": {"id": intent_id}},
        }
    )

    reconciled = await reconcile_payment(
        db_session,
        payment_id=payment.id,
        provider=provider,
        settings=get_settings(),
        source_event=source_event,
    )
    assert reconciled is not None
    assert reconciled.status is TournamentPaymentStatus.quarantined
    assert await _entered_player_ids(db_session, event.id) == []
    (obligation,) = await _obligations(db_session, payment.id)
    assert obligation.amount_cents == 2000


async def test_stored_webhook_evidence_never_keeps_the_client_secret(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = FakePaymentProvider()
    *_, payment = await _prepared_payment(db_session, monkeypatch, provider=provider)
    event_id = f"evt_{uuid.uuid4().hex}"
    await record_and_reconcile_provider_event(
        db_session,
        settings=get_settings(),
        event=ProviderWebhookEvent.model_validate(
            {
                "id": event_id,
                "type": "payment_intent.processing",
                "livemode": False,
                "data": {
                    "object": {
                        "id": payment.provider_payment_intent_id,
                        "client_secret": "pi_secret_must_not_persist",
                    }
                },
            }
        ),
        provider=provider,
    )
    stored = await db_session.scalar(
        select(TournamentPaymentProviderEvent).where(
            TournamentPaymentProviderEvent.provider_event_id == event_id
        )
    )
    assert stored is not None
    assert "client_secret" not in stored.payload["data"]["object"]
    assert stored.payment_id == payment.id


def test_payment_routes_take_no_request_body() -> None:
    """A dependency parameter is request input. The provider dependency must
    never let a caller post settings (and so a Stripe key) in the body."""
    paths = fastapi_app.openapi()["paths"]
    route = paths["/v1/tournaments/{tournament_id}/checkouts/{checkout_id}/payment"]
    assert "requestBody" not in route["get"]
    assert "requestBody" not in route["post"]


async def test_webhook_accepts_an_event_signed_with_the_second_configured_secret(
    monkeypatch: pytest.MonkeyPatch, engine: AsyncEngine
) -> None:
    """#1816: "It accepts more than one configured signing secret." The first
    secret does not verify this event. The second one does, so it admits."""
    make_session = async_sessionmaker(engine, expire_on_commit=False)
    provider = FakePaymentProvider()
    async with make_session() as seed_session:
        _, payer, _, event, _, payment = await _prepared_payment(
            seed_session, monkeypatch, provider=provider
        )
        intent_id = payment.provider_payment_intent_id
        assert intent_id is not None
        provider.set_status(intent_id, status="succeeded", amount_received=2000)
        player_id = payer.primary_player.id

    monkeypatch.setenv(
        "STRIPE_WEBHOOK_SIGNING_SECRETS", "whsec_rotated_out,whsec_current"
    )
    payload, signature = _signed_event(
        event_id=f"evt_{uuid.uuid4().hex}",
        intent_id=intent_id,
        payment_id=payment.id,
        livemode=False,
        secret="whsec_current",
    )
    status_code = await _post_webhook(
        make_session, provider, payload=payload, headers={"stripe-signature": signature}
    )
    assert status_code == 200

    async with make_session() as verify_session:
        settled = await verify_session.get(TournamentPayment, payment.id)
        assert settled is not None
        assert settled.status is TournamentPaymentStatus.succeeded
        assert await _entered_player_ids(verify_session, event.id) == [player_id]


@pytest.mark.parametrize(
    "event_body",
    [
        {"id": "evt_no_type", "livemode": False, "data": {"object": {"id": "pi_x"}}},
        {"id": "evt_no_data", "type": "payment_intent.succeeded", "livemode": False},
        {
            "id": "evt_bad_mode",
            "type": "payment_intent.succeeded",
            "livemode": "sometimes",
            "data": {"object": {"id": "pi_x"}},
        },
    ],
    ids=["missing-type", "missing-data", "non-boolean-livemode"],
)
async def test_webhook_refuses_a_malformed_signed_event_with_a_clean_400(
    monkeypatch: pytest.MonkeyPatch,
    engine: AsyncEngine,
    event_body: dict[str, object],
) -> None:
    """A correctly signed body that is not a well-formed event fails parsing
    at the webhook boundary: a 400, never a ``KeyError`` 500, and nothing is
    persisted."""
    make_session = async_sessionmaker(engine, expire_on_commit=False)
    secret = "whsec_test_secret"
    monkeypatch.setenv("STRIPE_WEBHOOK_SIGNING_SECRETS", secret)
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_fake")
    payload, signature = _sign(event_body, secret)

    status_code = await _post_webhook(
        make_session,
        FakePaymentProvider(),
        payload=payload,
        headers={"stripe-signature": signature},
    )
    assert status_code == 400
    async with make_session() as verify_session:
        stored = await verify_session.scalar(
            select(TournamentPaymentProviderEvent.id).where(
                TournamentPaymentProviderEvent.provider_event_id == event_body["id"]
            )
        )
        assert stored is None


async def test_requires_action_reports_action_required_and_resume_returns_the_secret(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A 3-D Secure challenge: Fortymm reports ``action_required``, and the
    payer's resume still returns the client secret so the browser can finish
    the challenge on the same PaymentIntent."""
    provider = FakePaymentProvider()
    _, payer, tournament, event, checkout_id, payment = await _prepared_payment(
        db_session, monkeypatch, provider=provider
    )
    provider.set_status(payment.provider_payment_intent_id, status="requires_action")

    status_read = await read_payment_status(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    assert status_read.payment_state is TournamentCheckoutPaymentState.action_required
    assert status_read.last_error_code is None

    resumed = await prepare_or_resume_payment(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    assert resumed.payment_state is TournamentCheckoutPaymentState.action_required
    assert resumed.client_secret is not None
    assert await _entered_player_ids(db_session, event.id) == []


async def test_charge_refunded_adds_evidence_and_changes_no_obligation(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#1816: ``charge.refunded`` adds to the evidence trail only. The paid
    line stays admitted, the entry stands, and no obligation is recorded."""
    provider = FakePaymentProvider()
    _, payer, _, event, _, payment = await _prepared_payment(
        db_session, monkeypatch, provider=provider
    )
    intent_id = payment.provider_payment_intent_id
    provider.set_status(intent_id, status="succeeded", amount_received=2000)
    await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, settings=get_settings()
    )

    event_id = f"evt_{uuid.uuid4().hex}"
    await record_and_reconcile_provider_event(
        db_session,
        event=ProviderWebhookEvent.model_validate(
            {
                "id": event_id,
                "type": "charge.refunded",
                "livemode": False,
                "data": {
                    "object": {
                        "id": f"ch_{uuid.uuid4().hex}",
                        "payment_intent": intent_id,
                        "amount_refunded": 2000,
                    }
                },
            }
        ),
        provider=provider,
        settings=get_settings(),
    )

    stored = await db_session.scalar(
        select(TournamentPaymentProviderEvent).where(
            TournamentPaymentProviderEvent.provider_event_id == event_id
        )
    )
    assert stored is not None
    assert stored.payment_id == payment.id
    assert stored.payload["data"]["object"]["amount_refunded"] == 2000
    settled = await db_session.get(TournamentPayment, payment.id)
    assert settled is not None
    await db_session.refresh(settled)
    assert settled.status is TournamentPaymentStatus.succeeded
    assert [line.outcome for line in settled.lines] == [
        TournamentPaymentLineOutcome.admitted
    ]
    assert await _obligations(db_session, payment.id) == []
    assert await _entered_player_ids(db_session, event.id) == [payer.primary_player.id]


async def test_charge_refunded_on_an_open_payment_admits_nobody(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The evidence-only branch holds even while the payment is still open:
    a ``charge.refunded`` event never admits, and records no obligation."""
    provider = FakePaymentProvider()
    *_, event, _, payment = await _prepared_payment(
        db_session, monkeypatch, provider=provider
    )
    intent_id = payment.provider_payment_intent_id
    provider.set_status(intent_id, status="succeeded", amount_received=2000)
    source_event = ProviderWebhookEvent.model_validate(
        {
            "id": f"evt_{uuid.uuid4().hex}",
            "type": "charge.refunded",
            "livemode": False,
            "data": {"object": {"id": "ch_x", "payment_intent": intent_id}},
        }
    )
    reconciled = await reconcile_payment(
        db_session,
        payment_id=payment.id,
        provider=provider,
        settings=get_settings(),
        source_event=source_event,
    )
    assert reconciled is not None
    assert reconciled.status is TournamentPaymentStatus.ready
    assert await _obligations(db_session, payment.id) == []
    assert await _entered_player_ids(db_session, event.id) == []


async def test_entrant_account_that_is_not_the_payer_cannot_read_or_resume(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An Account that manages the entrant Player, but did not pay, is not the
    payer. It gets the same 404 as a stranger, and never the secret."""
    from app.models import AccountPlayer

    provider = FakePaymentProvider()
    _, payer, tournament, _, checkout_id, _ = await _prepared_payment(
        db_session, monkeypatch, provider=provider
    )
    manager = await make_user(db_session, f"manager-{uuid.uuid4().hex[:8]}")
    db_session.add(
        AccountPlayer(
            account_id=manager.id, player_id=payer.primary_player.id, is_primary=False
        )
    )
    await db_session.commit()

    with pytest.raises(PaymentNotFoundError):
        await read_payment_status(
            db_session,
            tournament_id=tournament.id,
            checkout_id=checkout_id,
            actor=manager,
            provider=provider,
            settings=get_settings(),
        )
    with pytest.raises(PaymentNotFoundError):
        await prepare_or_resume_payment(
            db_session,
            tournament_id=tournament.id,
            checkout_id=checkout_id,
            actor=manager,
            provider=provider,
            settings=get_settings(),
        )


async def test_anonymous_caller_gets_401_for_status_and_secret(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = FakePaymentProvider()
    _, _, tournament, _, checkout_id, _ = await _prepared_payment(
        db_session, monkeypatch, provider=provider
    )
    path = f"/v1/tournaments/{tournament.id}/checkouts/{checkout_id}/payment"

    async def _override_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    with _app_overrides(_override_session, provider):
        async with make_raw_client() as client:
            read = await client.get(path)
            resume = await client.post(path)
    assert read.status_code == 401
    assert resume.status_code == 401
    assert "client_secret" not in resume.text


async def test_account_merge_keeps_the_payment_visible_to_the_survivor(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#1816 identity policy: the payer transfers to the surviving Account,
    so the survivor still sees its payment. The payee Fortymm account is a
    historical actor and stays as recorded."""
    from app.account_merge import merge_user

    provider = FakePaymentProvider()
    owner, payer, tournament, _, checkout_id, payment = await _prepared_payment(
        db_session, monkeypatch, provider=provider
    )
    survivor = await make_user(db_session, f"survivor-{uuid.uuid4().hex[:8]}")
    payment_id, payer_id, survivor_id = payment.id, payer.id, survivor.id

    await merge_user(db_session, from_user_id=payer_id, to_user_id=survivor_id)
    await db_session.commit()

    merged = await db_session.get(TournamentPayment, payment_id)
    assert merged is not None
    await db_session.refresh(merged)
    assert merged.payer_account_id == survivor_id
    assert merged.payee_fortymm_account_id == owner.id
    status_read = await read_payment_status(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=survivor,
        provider=provider,
        settings=get_settings(),
    )
    assert status_read.id == payment_id


@pytest.mark.parametrize(
    ("configured", "expected"),
    [("", None), ("acct_fake_platform", None), ("acct_organizer", "acct_organizer")],
    ids=["empty-means-platform", "platform-id-means-platform", "connected-payee"],
)
async def test_payee_stripe_account_comes_from_configuration(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    configured: str,
    expected: str | None,
) -> None:
    """#1816: "At launch both come from configuration. An empty payee Stripe
    account means the platform account." The row stores the payee, and the
    create call targets that same account."""
    monkeypatch.setenv("STRIPE_ACCOUNT_ID", "acct_fake_platform")
    monkeypatch.setenv("TOURNAMENT_PAYMENT_PAYEE_STRIPE_ACCOUNT", configured)
    provider = FakePaymentProvider()
    owner, *_, payment = await _prepared_payment(
        db_session, monkeypatch, provider=provider
    )
    assert payment.payee_stripe_account == expected
    # The platform account is stored concretely on every payment, even when
    # the payee is the platform itself.
    assert payment.platform_stripe_account == "acct_fake_platform"
    assert payment.payee_fortymm_account_id == owner.id
    assert provider.create_calls == [expected]


async def test_provider_create_runs_with_no_payment_row_lock_held(
    monkeypatch: pytest.MonkeyPatch, engine: AsyncEngine
) -> None:
    """#1816: "No Stripe call runs inside a transaction that holds capacity
    locks." A director entry updates the payment row while it holds the
    tournament lock, so the Stripe create must not wait on (or hold) that row.

    A gatekeeper holds the payment row lock, uncommitted. A status read that
    replays an uncertain create must still reach Stripe while the lock is
    held, and only record the result once the gatekeeper lets go."""
    make_session = async_sessionmaker(engine, expire_on_commit=False)
    provider = FakePaymentProvider(force_uncertain_once=True)
    async with make_session() as seed_session:
        owner = await make_user(seed_session, f"merchant-{uuid.uuid4().hex[:8]}")
        payer = await make_user(seed_session, f"payer-{uuid.uuid4().hex[:8]}")
        tournament, (event,) = await paid_tournament(seed_session, owner=owner)
        _setup(monkeypatch, owner=owner)
        checkout_id = await _checkout_for(
            seed_session, tournament=tournament, event=event, payer=payer
        )
        prepared = await prepare_or_resume_payment(
            seed_session,
            tournament_id=tournament.id,
            checkout_id=checkout_id,
            actor=payer,
            provider=provider,
            settings=get_settings(),
        )
        assert prepared.payment_state is TournamentCheckoutPaymentState.preparing
    assert len(provider.create_calls) == 1

    async def _read_status() -> TournamentCheckoutPaymentState:
        async with make_session() as session:
            read = await read_payment_status(
                session,
                tournament_id=tournament.id,
                checkout_id=checkout_id,
                actor=payer,
                provider=provider,
                settings=get_settings(),
            )
            return read.payment_state

    async with make_session() as gatekeeper:
        await _hold_the_payment_lock(gatekeeper, prepared.id)
        reader = asyncio.create_task(_read_status())
        for _ in range(40):
            if len(provider.create_calls) == 2:
                break
            await asyncio.sleep(0.05)
        called_while_locked = len(provider.create_calls) == 2
        await gatekeeper.commit()
        state = await reader

    assert called_while_locked, (
        "the Stripe create waited for the payment row lock: it runs inside "
        "the row-locked transaction"
    )
    assert state is TournamentCheckoutPaymentState.ready


def test_only_the_provider_seam_imports_stripe() -> None:
    """``app.payments.provider`` is the one module that talks to the Stripe
    SDK, including webhook signature verification."""
    from pathlib import Path

    import app

    root = Path(app.__file__).parent
    importers = sorted(
        str(path.relative_to(root))
        for path in root.rglob("*.py")
        if any(
            line.strip() in ("import stripe",) or line.startswith("from stripe")
            for line in path.read_text().splitlines()
        )
    )
    assert importers == ["payments/provider.py"]


def test_an_unknown_stripe_status_fails_parsing_as_unavailable() -> None:
    """A PaymentIntent status outside Stripe's closed set never reaches
    reconcile as a raw string. It is a provider failure, which leaves the
    payment unchanged rather than quarantining it."""
    from app.payments.provider import ProviderUnavailable, _parse_intent

    with pytest.raises(ProviderUnavailable):
        _parse_intent(
            {
                "id": "pi_x",
                "status": "mystery_status",
                "amount": 2000,
                "currency": "usd",
                "livemode": False,
            }
        )


async def test_a_settled_payment_for_another_event_does_not_settle_this_fee(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``SettledPayment`` names the event it paid for. Evidence for one event
    cannot admit the player to a different paid event."""
    from app.tournament_entries import SettledPayment
    from app.tournament_errors import EntryRefusal, EntryRefusedError

    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (paid, other) = await paid_tournament(
        db_session, owner=owner, fees=(Decimal("20.00"), Decimal("15.00"))
    )
    _setup(monkeypatch, owner=owner)
    with pytest.raises(EntryRefusedError) as refused:
        await admit_to_event(
            db_session,
            tournament_id=tournament.id,
            event_id=other.id,
            actor=payer,
            user_id=None,
            settled_payment=SettledPayment(event_id=paid.id),
        )
    assert refused.value.refusal is EntryRefusal.payment_required


async def test_reused_checkout_request_id_with_a_changed_selection_is_refused(
    api_client, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#1816: "A reused request ID with a changed payload is refused." The
    request ID lives on the checkout (#1793), and the payment operation takes
    none: a payment is keyed to its immutable checkout, so its amount can only
    come from that checkout. End to end, a changed selection under a reused
    request ID is refused, and the payment keeps its original checkout and
    amount."""
    from tests._helpers import start_session

    payer = await start_session(api_client, db_session)
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    tournament, (first, second) = await paid_tournament(
        db_session, owner=owner, fees=(Decimal("20.00"), Decimal("35.00"))
    )
    _setup(monkeypatch, owner=owner)
    provider = FakePaymentProvider()
    fastapi_app.dependency_overrides[get_payment_provider] = lambda: provider
    request_id = str(uuid.uuid4())
    checkouts = f"/v1/tournaments/{tournament.id}/checkouts"

    created = await api_client.post(
        checkouts, json={"request_id": request_id, "event_ids": [str(first.id)]}
    )
    assert created.status_code == 201
    checkout_id = created.json()["id"]
    payment_path = f"{checkouts}/{checkout_id}/payment"
    prepared = await api_client.post(payment_path)
    assert prepared.status_code == 201
    assert prepared.json()["amount_cents"] == 2000

    changed = await api_client.post(
        checkouts, json={"request_id": request_id, "event_ids": [str(second.id)]}
    )
    assert changed.status_code == 409
    assert changed.json()["detail"]["code"] == "request_payload_conflict"

    replayed = await api_client.post(
        checkouts, json={"request_id": request_id, "event_ids": [str(first.id)]}
    )
    assert replayed.status_code == 201
    assert replayed.json()["id"] == checkout_id
    resumed = await api_client.post(payment_path)
    assert resumed.status_code == 201
    assert resumed.json()["id"] == prepared.json()["id"]
    assert resumed.json()["amount_cents"] == 2000

    payments = list(
        await db_session.scalars(
            select(TournamentPayment).where(
                TournamentPayment.payer_account_id == payer.id
            )
        )
    )
    assert [p.amount_cents for p in payments] == [2000]
    assert len(provider.create_calls) == 1


async def test_director_entry_during_an_uncertain_create_still_cancels_the_intent(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch, fake_payments_queue
) -> None:
    """The Stripe create no longer holds the payment row, so a director entry
    can mark the payment ``cancel_requested`` before its PaymentIntent id is
    known. That first cancel job has nothing to cancel. When the replayed
    create records the id, it stages a second cancel job for it, and the
    director's cancel stays in force."""
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await paid_tournament(db_session, owner=owner)
    _setup(monkeypatch, owner=owner)
    checkout_id = await _checkout_for(
        db_session, tournament=tournament, event=event, payer=payer
    )
    provider = FakePaymentProvider(force_uncertain_once=True)
    prepared = await prepare_or_resume_payment(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    assert prepared.payment_state is TournamentCheckoutPaymentState.preparing

    await admit_to_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event.id,
        actor=owner,
        user_id=payer.primary_player.id,
    )
    await db_session.commit()
    assert len(fake_payments_queue.jobs) == 1

    status_read = await read_payment_status(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    assert status_read.payment_state is TournamentCheckoutPaymentState.cancelled
    payment = await db_session.get(TournamentPayment, prepared.id)
    assert payment is not None
    await db_session.refresh(payment)
    assert payment.status is TournamentPaymentStatus.cancel_requested
    assert payment.provider_payment_intent_id is not None
    assert [job.args for job in fake_payments_queue.jobs] == [
        (str(prepared.id),),
        (str(prepared.id),),
    ]


# ----- Codex review round on PR #1820 --------------------------------------


async def test_prepare_waits_for_a_cancellation_holding_the_tournament_lock(
    monkeypatch: pytest.MonkeyPatch, engine: AsyncEngine, fake_payments_queue
) -> None:
    """Checkout validation and the payment insert are one serialized step.

    A gatekeeper takes the tournament lock the way ``cancel_checkout`` does
    and holds it. A first prepare must wait on it. The gatekeeper then cancels
    the checkout and commits, so the prepare must refuse and create nothing.
    An unlocked check would pass the still-active checkout, insert the
    payment, and call Stripe for a checkout the payer had just cancelled."""
    from app.tournament_authority import lock_tournament

    make_session = async_sessionmaker(engine, expire_on_commit=False)
    provider = FakePaymentProvider()
    async with make_session() as seed_session:
        owner = await make_user(seed_session, f"merchant-{uuid.uuid4().hex[:8]}")
        payer = await make_user(seed_session, f"payer-{uuid.uuid4().hex[:8]}")
        tournament, (event,) = await paid_tournament(seed_session, owner=owner)
        _setup(monkeypatch, owner=owner)
        checkout_id = await _checkout_for(
            seed_session, tournament=tournament, event=event, payer=payer
        )

    async def _prepare() -> None:
        async with make_session() as session:
            await prepare_or_resume_payment(
                session,
                tournament_id=tournament.id,
                checkout_id=checkout_id,
                actor=payer,
                provider=provider,
                settings=get_settings(),
            )

    async with make_session() as gatekeeper:
        await lock_tournament(gatekeeper, tournament.id)
        preparer = asyncio.create_task(_prepare())
        await asyncio.sleep(0.5)
        waited = not preparer.done()
        await cancel_checkout(
            gatekeeper,
            tournament_id=tournament.id,
            checkout_id=checkout_id,
            actor=payer,
        )
    assert waited, "prepare did not wait for the tournament lock"
    with pytest.raises(PaymentNotReadyError):
        await preparer
    assert provider.create_calls == []
    async with make_session() as verify_session:
        assert (
            await verify_session.scalar(
                select(TournamentPayment).where(
                    TournamentPayment.checkout_id == checkout_id
                )
            )
            is None
        )


@pytest.mark.parametrize(
    "missing",
    ["STRIPE_SECRET_KEY", "STRIPE_ACCOUNT_ID", "STRIPE_WEBHOOK_SIGNING_SECRETS"],
)
async def test_prepare_fails_closed_without_a_key_or_a_webhook_secret(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch, missing: str
) -> None:
    """Without a Stripe key the create cannot authenticate. Without a webhook
    signing secret every Stripe delivery is rejected, so a payer who closes
    the page after confirming would be charged and never admitted. Both fail
    closed before the create obligation commits."""
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await paid_tournament(db_session, owner=owner)
    _setup(monkeypatch, owner=owner)
    monkeypatch.setenv(missing, "")
    checkout_id = await _checkout_for(
        db_session, tournament=tournament, event=event, payer=payer
    )
    provider = FakePaymentProvider()
    with pytest.raises(PaymentNotReadyError):
        await prepare_or_resume_payment(
            db_session,
            tournament_id=tournament.id,
            checkout_id=checkout_id,
            actor=payer,
            provider=provider,
            settings=get_settings(),
        )
    assert provider.create_calls == []
    assert (
        await db_session.scalar(
            select(TournamentPayment).where(
                TournamentPayment.checkout_id == checkout_id
            )
        )
        is None
    )


async def test_prepare_refuses_when_the_merchant_setting_changed_since_the_quote(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The quote names the merchant that authorized it. A payment for it must
    not be stamped with a different, newly configured merchant."""
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    other = await make_user(db_session, f"other-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await paid_tournament(db_session, owner=owner)
    _setup(monkeypatch, owner=owner)
    checkout_id = await _checkout_for(
        db_session, tournament=tournament, event=event, payer=payer
    )
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(other.id))
    provider = FakePaymentProvider()
    with pytest.raises(PaymentNotReadyError):
        await prepare_or_resume_payment(
            db_session,
            tournament_id=tournament.id,
            checkout_id=checkout_id,
            actor=payer,
            provider=provider,
            settings=get_settings(),
        )
    assert provider.create_calls == []


async def test_prepare_refuses_a_total_above_the_stripe_amount_limit(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Stripe refuses an amount above eight digits. Fortymm refuses before it
    commits a create obligation that no retry could ever fulfil."""
    from app.payments.provider import STRIPE_MAX_AMOUNT_CENTS

    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await paid_tournament(db_session, owner=owner)
    _setup(monkeypatch, owner=owner)
    checkout_id = await _checkout_for(
        db_session, tournament=tournament, event=event, payer=payer
    )
    await db_session.execute(
        update(TournamentCheckout)
        .where(TournamentCheckout.id == checkout_id)
        .values(total_cents=STRIPE_MAX_AMOUNT_CENTS + 1)
    )
    await db_session.commit()
    provider = FakePaymentProvider()
    with pytest.raises(PaymentNotReadyError):
        await prepare_or_resume_payment(
            db_session,
            tournament_id=tournament.id,
            checkout_id=checkout_id,
            actor=payer,
            provider=provider,
            settings=get_settings(),
        )
    assert provider.create_calls == []


async def test_a_mismatched_create_response_is_quarantined_and_keeps_its_secret(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The create response passes the same identity checks as reconcile
    before its client secret is used. A mismatch quarantines the payment and
    the payer never gets the secret."""
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await paid_tournament(db_session, owner=owner)
    _setup(monkeypatch, owner=owner)
    checkout_id = await _checkout_for(
        db_session, tournament=tournament, event=event, payer=payer
    )
    provider = FakePaymentProvider(create_amount_override=1)
    prepared = await prepare_or_resume_payment(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    assert prepared.client_secret is None
    assert prepared.payment_state is TournamentCheckoutPaymentState.failed
    payment = await db_session.get(TournamentPayment, prepared.id)
    assert payment is not None
    assert payment.status is TournamentPaymentStatus.quarantined
    assert payment.provider_payment_intent_id is not None


async def test_a_successful_retry_clears_the_earlier_decline(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A decline recorded on the first attempt must not survive a later state
    that reports no current error, and never a success."""
    provider = FakePaymentProvider()
    *_, payment = await _prepared_payment(db_session, monkeypatch, provider=provider)
    intent_id = payment.provider_payment_intent_id
    settings = get_settings()

    provider.set_status(
        intent_id,
        status="requires_payment_method",
        last_payment_error_code="card_declined",
    )
    declined = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, settings=settings
    )
    assert declined is not None
    assert declined.last_error_code == "card_declined"

    provider.set_status(intent_id, status="requires_action")
    challenged = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, settings=settings
    )
    assert challenged is not None
    assert challenged.status is TournamentPaymentStatus.action_required
    assert challenged.last_error_code is None

    provider.set_status(
        intent_id,
        status="requires_payment_method",
        last_payment_error_code="card_declined",
    )
    await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, settings=settings
    )
    provider.set_status(intent_id, status="succeeded", amount_received=2000)
    settled = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, settings=settings
    )
    assert settled is not None
    assert settled.status is TournamentPaymentStatus.succeeded
    assert settled.last_error_code is None


@pytest.mark.parametrize(
    ("code", "decline_code", "expected"),
    [
        ("card_declined", "insufficient_funds", "insufficient_funds"),
        ("card_declined", "generic_decline", "card_declined"),
        ("card_declined", None, "card_declined"),
        ("some_internal_stripe_detail", "do_not_honor", "card_error"),
    ],
    ids=["decline-code-wins", "unknown-decline-code", "code-only", "neither-safe"],
)
async def test_the_player_error_prefers_stripes_decline_code(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    code: str,
    decline_code: str | None,
    expected: str,
) -> None:
    """Stripe reports most card declines as ``code: card_declined`` and puts
    the actionable reason in ``decline_code``. A safe decline code wins."""
    from app.payments.provider import ProviderPaymentIntent

    parsed = ProviderPaymentIntent.model_validate(
        {
            "id": "pi_x",
            "status": "requires_payment_method",
            "amount": 2000,
            "currency": "usd",
            "livemode": False,
            "last_payment_error": {"code": code, "decline_code": decline_code},
        }
    )
    assert parsed.last_payment_error_code == code
    assert parsed.last_payment_decline_code == decline_code

    provider = FakePaymentProvider()
    *_, payment = await _prepared_payment(db_session, monkeypatch, provider=provider)
    provider.set_status(
        payment.provider_payment_intent_id,
        status="requires_payment_method",
        last_payment_error_code=code,
        last_payment_decline_code=decline_code,
    )
    reconciled = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, settings=get_settings()
    )
    assert reconciled is not None
    assert reconciled.last_error_code == expected


async def test_payer_cancel_cancels_the_open_payment_intent(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch, fake_payments_queue
) -> None:
    """The payer's browser may still hold the client secret. Cancelling the
    checkout cancels the PaymentIntent, as a director entry does."""
    provider = FakePaymentProvider()
    _, payer, tournament, _, checkout_id, payment = await _prepared_payment(
        db_session, monkeypatch, provider=provider
    )
    payment_id = payment.id
    await cancel_checkout(
        db_session, tournament_id=tournament.id, checkout_id=checkout_id, actor=payer
    )
    cancelled = await db_session.get(TournamentPayment, payment_id)
    assert cancelled is not None
    await db_session.refresh(cancelled)
    assert cancelled.status is TournamentPaymentStatus.cancel_requested
    assert cancelled.cancel_requested_at is not None
    assert [job.args for job in fake_payments_queue.jobs] == [(str(payment_id),)]


async def test_account_merge_cancels_a_payment_nobody_can_resume(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch, fake_payments_queue
) -> None:
    """The merge invalidates the checkout, so neither account can resume its
    open payment. The merge cancels the PaymentIntent instead of leaving it
    open, and the survivor can still read it."""
    from app.account_merge import merge_user

    provider = FakePaymentProvider()
    _, payer, tournament, _, checkout_id, payment = await _prepared_payment(
        db_session, monkeypatch, provider=provider
    )
    survivor = await make_user(db_session, f"survivor-{uuid.uuid4().hex[:8]}")
    payment_id = payment.id

    await merge_user(db_session, from_user_id=payer.id, to_user_id=survivor.id)
    await db_session.commit()

    merged = await db_session.get(TournamentPayment, payment_id)
    assert merged is not None
    await db_session.refresh(merged)
    assert merged.status is TournamentPaymentStatus.cancel_requested
    assert [job.args for job in fake_payments_queue.jobs] == [(str(payment_id),)]
    status_read = await read_payment_status(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=survivor,
        provider=provider,
        settings=get_settings(),
    )
    assert status_read.payment_state is TournamentCheckoutPaymentState.cancelled


async def test_a_replayed_webhook_finishes_a_reconcile_that_never_ran(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The process can die after the event row commits and before reconcile
    runs. Stripe's retry then hits the stored event, and must still finish the
    payment rather than acknowledge it and do nothing."""
    provider = FakePaymentProvider()
    _, payer, _, event, _, payment = await _prepared_payment(
        db_session, monkeypatch, provider=provider
    )
    intent_id = payment.provider_payment_intent_id
    provider.set_status(intent_id, status="succeeded", amount_received=2000)
    webhook_event = ProviderWebhookEvent.model_validate(
        {
            "id": f"evt_{uuid.uuid4().hex}",
            "type": "payment_intent.succeeded",
            "livemode": False,
            "data": {
                "object": {"id": intent_id, "metadata": {"payment_id": str(payment.id)}}
            },
        }
    )
    # The first delivery's row committed, then the process died.
    db_session.add(
        TournamentPaymentProviderEvent(
            provider_event_id=webhook_event.id,
            event_type=webhook_event.type,
            payment_id=payment.id,
            payload=webhook_event.evidence(),
        )
    )
    await db_session.commit()

    await record_and_reconcile_provider_event(
        db_session, event=webhook_event, provider=provider, settings=get_settings()
    )

    settled = await db_session.get(TournamentPayment, payment.id)
    assert settled is not None
    await db_session.refresh(settled)
    assert settled.status is TournamentPaymentStatus.succeeded
    assert await _entered_player_ids(db_session, event.id) == [payer.primary_player.id]


async def test_merchant_reads_follow_the_payments_own_payee_snapshot(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """After ``TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID`` changes, the account
    recorded on the payment keeps access and the new account gets none."""
    provider = FakePaymentProvider()
    owner, _, tournament, _, checkout_id, _ = await _prepared_payment(
        db_session, monkeypatch, provider=provider
    )
    newcomer = await make_user(db_session, f"newcomer-{uuid.uuid4().hex[:8]}")
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(newcomer.id))

    read = await read_payment_status(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=owner,
        provider=provider,
        settings=get_settings(),
    )
    assert read.checkout_id == checkout_id
    with pytest.raises(PaymentNotFoundError):
        await read_payment_status(
            db_session,
            tournament_id=tournament.id,
            checkout_id=checkout_id,
            actor=newcomer,
            provider=provider,
            settings=get_settings(),
        )


@pytest.mark.parametrize(
    "error",
    [stripe.AuthenticationError("revoked"), stripe.PermissionError("restricted")],
    ids=["authentication", "permission"],
)
def test_a_credentials_failure_never_quarantines_a_retrieval(
    error: stripe.StripeError,
) -> None:
    """A revoked key or a restricted key that lost a permission says nothing
    about the PaymentIntent. It is ``ProviderUnavailable``, never the
    ``ProviderRefused`` that quarantines the payment for good."""
    from app.payments.provider import ProviderUnavailable, _retrieval_failure

    assert isinstance(_retrieval_failure(error), ProviderUnavailable)


@pytest.mark.parametrize(
    "error",
    [stripe.AuthenticationError("revoked"), stripe.PermissionError("restricted")],
    ids=["authentication", "permission"],
)
async def test_a_credentials_failure_on_create_leaves_the_payment_preparing(
    error: stripe.StripeError,
) -> None:
    """A create that Stripe refuses for Fortymm's own key is translated at the
    seam, not raised as a 500. The payment stays ``preparing`` and a resume
    replays the create under the same idempotency key once the key works."""
    from types import SimpleNamespace

    from app.payments.provider import ProviderCreateUncertain, StripePaymentProvider

    async def _refuse(*args: object, **kwargs: object) -> object:
        raise error

    adapter = StripePaymentProvider("sk_test_fake")
    adapter._client = SimpleNamespace(  # type: ignore[assignment]
        v1=SimpleNamespace(payment_intents=SimpleNamespace(create_async=_refuse))
    )
    outcome = await adapter.create_payment_intent(
        payee_account=None,
        amount_cents=2000,
        currency="usd",
        idempotency_key="tournament-payment:x",
        metadata={"payment_id": "x"},
        statement_descriptor_suffix="FORTYMM1",
    )
    assert isinstance(outcome, ProviderCreateUncertain)
