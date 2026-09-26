"""Behavioral tests for Stripe card payments on a tournament checkout (#1816)."""

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
import stripe
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.db import get_session
from app.leagues import get_default_league
from app.main import app as fastapi_app
from app.models import (
    DrawType,
    EventFormat,
    Tournament,
    TournamentCheckout,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentPayment,
    TournamentPaymentLineOutcome,
    TournamentPaymentProviderCreateState,
    TournamentPaymentProviderEvent,
    TournamentPaymentRefundObligation,
    TournamentPaymentRefundReason,
    TournamentPaymentStatus,
    TournamentStatus,
    User,
)
from app.payments.dependencies import get_payment_provider
from app.payments.fake_provider import FakePaymentProvider
from app.schemas.tournament_checkout import (
    TournamentCheckoutCreate,
    TournamentCheckoutPaymentState,
    TournamentCheckoutState,
)
from app.tournament_checkouts import cancel_checkout, read_checkout, start_checkout
from app.tournament_entries import admit_to_event
from app.tournament_errors import RecordedPlayDeletionError
from app.tournament_event_stages import mint_stages
from app.tournament_events import delete_event
from app.tournament_payment_errors import (
    PaymentNotFoundError,
    PaymentNotReadyError,
    PaymentProviderUnavailableError,
)
from app.tournament_payments import (
    IncomingProviderEvent,
    prepare_or_resume_payment,
    read_payment_status,
    reconcile_payment,
    record_and_reconcile_provider_event,
)
from app.tournament_registration import set_registration_open
from tests._helpers import make_raw_client, make_user


async def _paid_tournament(
    db: AsyncSession,
    *,
    owner: User,
    fees: tuple[Decimal, ...] = (Decimal("20.00"),),
    capacities: tuple[int | None, ...] | None = None,
) -> tuple[Tournament, list[TournamentEvent]]:
    league = await get_default_league(db)
    assert league is not None
    tournament = Tournament(
        name="Payment Tournament",
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
            name=f"Event {index}",
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
    return tournament, events


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


async def test_happy_path_prepare_then_webhook_success_admits_exactly_once(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await _paid_tournament(db_session, owner=owner)
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
    )
    assert prepared.status is TournamentCheckoutPaymentState.ready
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
        db_session, payment_id=payment.id, provider=provider
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
        db_session, payment_id=payment.id, provider=provider
    )
    assert again is not None
    assert again.status is TournamentPaymentStatus.succeeded
    assert await _entered_player_ids(db_session, event.id) == [payer.primary_player.id]


async def test_declined_card_reports_ready_with_safe_error_code(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await _paid_tournament(db_session, owner=owner)
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
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(TournamentPayment.checkout_id == checkout_id)
    )
    assert payment is not None
    provider.set_status(
        payment.provider_payment_intent_id,
        status="requires_payment_method",
        last_payment_error_code="card_declined",
    )
    reconciled = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider
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
    )
    assert status_read.status is TournamentCheckoutPaymentState.ready
    assert status_read.last_error == "card_declined"

    # A raw, non-allowlisted Stripe decline code never reaches the response.
    provider.set_status(
        payment.provider_payment_intent_id,
        status="requires_payment_method",
        last_payment_error_code="some_internal_stripe_detail",
    )
    reconciled_again = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider
    )
    assert reconciled_again is not None
    assert reconciled_again.last_error_code == "card_error"


async def test_duplicate_prepare_reuses_the_same_payment_intent(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await _paid_tournament(db_session, owner=owner)
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
    )
    second = await prepare_or_resume_payment(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
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
    assert (
        payments[0].provider_create_state
        is TournamentPaymentProviderCreateState.created
    )


async def test_unauthorized_caller_gets_not_found_for_status_and_secret(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    stranger = await make_user(db_session, f"stranger-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await _paid_tournament(db_session, owner=owner)
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
    )

    with pytest.raises(PaymentNotFoundError):
        await read_payment_status(
            db_session,
            tournament_id=tournament.id,
            checkout_id=checkout_id,
            actor=stranger,
            provider=provider,
        )
    with pytest.raises(PaymentNotFoundError):
        await prepare_or_resume_payment(
            db_session,
            tournament_id=tournament.id,
            checkout_id=checkout_id,
            actor=stranger,
            provider=provider,
        )

    # The merchant account MAY read status (never the secret — that response
    # shape has no such field at all).
    merchant_read = await read_payment_status(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=owner,
        provider=provider,
    )
    assert merchant_read.id is not None


async def test_amount_mismatch_quarantines_with_the_retrieved_amount(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await _paid_tournament(db_session, owner=owner)
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
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(TournamentPayment.checkout_id == checkout_id)
    )
    assert payment is not None
    # Simulate Stripe reporting a captured amount that does not match what
    # this checkout billed — a corrupted/forged/mismatched intent.
    provider.set_status(
        payment.provider_payment_intent_id, status="succeeded", amount_received=999
    )
    provider.corrupt_amount(payment.provider_payment_intent_id, 999)

    reconciled = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider
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


async def _prepared_payment(
    db: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    *,
    provider: FakePaymentProvider,
    capacities: tuple[int | None, ...] | None = None,
) -> tuple[User, User, Tournament, TournamentEvent, uuid.UUID, TournamentPayment]:
    owner = await make_user(db, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await _paid_tournament(
        db, owner=owner, capacities=capacities
    )
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


async def test_refused_retrieval_quarantines_with_amount_unverified_and_no_obligation(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Stripe answers that the PaymentIntent is not on the payee account: no
    verified captured amount exists, so quarantine records no obligation."""
    provider = FakePaymentProvider()
    *_, payment = await _prepared_payment(db_session, monkeypatch, provider=provider)
    provider.retrieval_wrong_account.add(payment.provider_payment_intent_id)

    reconciled = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider
    )
    assert reconciled is not None
    assert reconciled.status is TournamentPaymentStatus.quarantined
    assert reconciled.amount_unverified is True
    assert await _obligations(db_session, payment.id) == []


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
        await reconcile_payment(db_session, payment_id=payment.id, provider=provider)
    status_read = await read_payment_status(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
    )
    assert status_read.status is TournamentCheckoutPaymentState.ready

    provider.retrieval_failures.clear()
    provider.set_status(
        payment.provider_payment_intent_id, status="succeeded", amount_received=2000
    )
    reconciled = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider
    )
    assert reconciled is not None
    assert reconciled.status is TournamentPaymentStatus.succeeded
    assert await _entered_player_ids(db_session, event.id) == [payer.primary_player.id]


async def test_late_success_admits_after_the_checkout_has_expired(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Expiry alone does not forfeit an otherwise-valid entry (#1816)."""
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await _paid_tournament(db_session, owner=owner)
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
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(TournamentPayment.checkout_id == checkout_id)
    )
    assert payment is not None

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
        db_session, payment_id=payment.id, provider=provider
    )
    assert reconciled is not None
    assert reconciled.status is TournamentPaymentStatus.succeeded
    assert await _entered_player_ids(db_session, event.id) == [payer.primary_player.id]


async def test_late_success_records_refund_when_capacity_has_filled(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    other_player = await make_user(db_session, f"other-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await _paid_tournament(
        db_session, owner=owner, capacities=(1,)
    )
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
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(TournamentPayment.checkout_id == checkout_id)
    )
    assert payment is not None

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
        db_session, payment_id=payment.id, provider=provider
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
        tournament, (event,) = await _paid_tournament(seed_session, owner=owner)
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

    payload = json.dumps(
        {
            "id": "evt_test_1",
            "type": "payment_intent.succeeded",
            "livemode": False,
            "account": None,
            "data": {
                "object": {
                    "id": intent_id,
                    "metadata": {"payment_id": str(payment_id)},
                }
            },
        }
    )
    signature = stripe.WebhookSignature.generate_signature_header(payload, secret)

    async def _override_session():
        async with make_session() as session:
            yield session

    fastapi_app.dependency_overrides[get_session] = _override_session
    fastapi_app.dependency_overrides[get_payment_provider] = lambda: provider
    try:
        async with make_raw_client() as client:
            first = await client.post(
                "/v1/webhooks/stripe",
                content=payload,
                headers={
                    "stripe-signature": signature,
                    "content-type": "application/json",
                },
            )
            assert first.status_code == 200

            second = await client.post(
                "/v1/webhooks/stripe",
                content=payload,
                headers={
                    "stripe-signature": signature,
                    "content-type": "application/json",
                },
            )
            assert second.status_code == 200

            bad = await client.post(
                "/v1/webhooks/stripe",
                content=payload,
                headers={
                    "stripe-signature": "t=1,v1=deadbeef",
                    "content-type": "application/json",
                },
            )
            assert bad.status_code == 400
    finally:
        fastapi_app.dependency_overrides.clear()

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
        tournament, (event,) = await _paid_tournament(seed_session, owner=owner)
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
                session, payment_id=payment_id, provider=provider
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
    tournament, (event,) = await _paid_tournament(db_session, owner=owner)
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
    tournament, (event,) = await _paid_tournament(db_session, owner=owner)
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
        db_session, payment_id=payment_id, provider=provider
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
    tournament, (event,) = await _paid_tournament(db_session, owner=owner)
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
        db_session, payment_id=payment.id, provider=provider
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
        db_session, payment_id=payment.id, provider=provider
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
    tournament, (event,) = await _paid_tournament(db_session, owner=owner)
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
    )
    assert prepared.status is TournamentCheckoutPaymentState.preparing
    assert prepared.client_secret is None

    status_read = await read_payment_status(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
    )
    assert status_read.status is TournamentCheckoutPaymentState.ready
    payment = await db_session.get(TournamentPayment, prepared.id)
    assert payment is not None
    assert payment.provider_create_state is TournamentPaymentProviderCreateState.created

    resumed = await prepare_or_resume_payment(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_id,
        actor=payer,
        provider=provider,
    )
    assert resumed.client_secret is not None


async def test_an_expired_checkout_cannot_start_a_new_payment(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner = await make_user(db_session, f"merchant-{uuid.uuid4().hex[:8]}")
    payer = await make_user(db_session, f"payer-{uuid.uuid4().hex[:8]}")
    tournament, (event,) = await _paid_tournament(db_session, owner=owner)
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
        )


def _signed_event(
    *, event_id: str, intent_id: str, payment_id: uuid.UUID, livemode: bool, secret: str
) -> tuple[str, str]:
    payload = json.dumps(
        {
            "id": event_id,
            "type": "payment_intent.succeeded",
            "livemode": livemode,
            "account": None,
            "data": {
                "object": {"id": intent_id, "metadata": {"payment_id": str(payment_id)}}
            },
        }
    )
    return payload, stripe.WebhookSignature.generate_signature_header(payload, secret)


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

    async def _override_session():
        async with make_session() as session:
            yield session

    fastapi_app.dependency_overrides[get_session] = _override_session
    fastapi_app.dependency_overrides[get_payment_provider] = lambda: provider
    try:
        async with make_raw_client() as client:
            response = await client.post(
                "/v1/webhooks/stripe",
                content=payload,
                headers={"stripe-signature": signature},
            )
            assert response.status_code == 200
            missing = await client.post("/v1/webhooks/stripe", content=payload)
            assert missing.status_code == 400
    finally:
        fastapi_app.dependency_overrides.clear()

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

    async def _override_session():
        async with make_session() as session:
            yield session

    fastapi_app.dependency_overrides[get_session] = _override_session
    fastapi_app.dependency_overrides[get_payment_provider] = lambda: provider
    headers = {"stripe-signature": signature}
    try:
        async with make_raw_client() as client:
            provider.retrieval_failures.add(intent_id)
            unavailable = await client.post(
                "/v1/webhooks/stripe", content=payload, headers=headers
            )
            assert unavailable.status_code == 503
            provider.retrieval_failures.clear()
            retried = await client.post(
                "/v1/webhooks/stripe", content=payload, headers=headers
            )
            assert retried.status_code == 200
    finally:
        fastapi_app.dependency_overrides.clear()

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
    source_event = IncomingProviderEvent(
        id=f"evt_{uuid.uuid4().hex}",
        type="payment_intent.succeeded",
        livemode=False,
        account=event_account,
        payment_intent_id=intent_id,
    )

    reconciled = await reconcile_payment(
        db_session, payment_id=payment.id, provider=provider, source_event=source_event
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
        raw={
            "id": event_id,
            "type": "payment_intent.processing",
            "livemode": False,
            "data": {
                "object": {
                    "id": payment.provider_payment_intent_id,
                    "client_secret": "pi_secret_must_not_persist",
                }
            },
        },
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
