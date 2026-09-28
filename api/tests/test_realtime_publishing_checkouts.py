"""Who gets hinted when a checkout or its payment changes (#1809).

The ``checkout.changed`` hint drives two client surfaces: the app-wide
open-checkout bar (``GET /v1/me/checkouts/open``) and the checkout panel
itself. Both are scoped to exactly one account — the checkout's PAYER — so
every test below names the payer, who must be hinted, and a signed-in
bystander with no stake in the checkout at all, who must be hinted zero
times. An implementation that broadcast to the tournament owner, or to every
connected user, passes nothing here.

Observed at the broker via :mod:`tests._realtime` (never over the socket —
see that module for why, and for how "zero hints" is made an assertion
rather than a hopeful sleep).
"""

import uuid

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import TournamentPayment, User
from app.payments.fake_provider import FakePaymentProvider
from app.realtime import EventKind, RealtimeBroker
from app.schemas.tournament_checkout import TournamentCheckoutCreate
from app.tournament_checkouts import start_checkout
from app.tournament_entries import enter_event
from app.tournament_payments import prepare_or_resume_payment, reconcile_payment
from tests._helpers import make_user, paid_tournament, start_session
from tests._realtime import watch_hints


def _name(stem: str) -> str:
    return f"{stem}-{uuid.uuid4().hex[:8]}"


def _setup_stripe(monkeypatch, *, owner: User) -> None:
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_fake")
    monkeypatch.setenv("STRIPE_PUBLISHABLE_KEY", "pk_test_fake")
    monkeypatch.setenv("STRIPE_ACCOUNT_ID", "acct_fake_platform")
    monkeypatch.setenv("STRIPE_WEBHOOK_SIGNING_SECRETS", "whsec_test")
    monkeypatch.delenv("ENVIRONMENT", raising=False)


async def test_starting_a_checkout_hints_only_the_payer(
    api_client: AsyncClient,
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
    monkeypatch,
) -> None:
    payer = await start_session(api_client, db_session)
    owner = await make_user(db_session, _name("merchant"))
    bystander = await make_user(db_session, _name("bystander"))
    tournament, (event,) = await paid_tournament(db_session, owner=owner)
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))

    async with watch_hints(realtime_broker, payer.id, bystander.id) as watch:
        created = await api_client.post(
            f"/v1/tournaments/{tournament.id}/checkouts",
            json={"request_id": str(uuid.uuid4()), "event_ids": [str(event.id)]},
        )
        assert created.status_code == 201
        hints = await watch.collect()

    assert hints[payer.id] == [EventKind.checkout_changed]
    assert hints[bystander.id] == []


async def test_cancelling_a_checkout_hints_only_the_payer(
    api_client: AsyncClient,
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
    monkeypatch,
) -> None:
    payer = await start_session(api_client, db_session)
    owner = await make_user(db_session, _name("merchant"))
    bystander = await make_user(db_session, _name("bystander"))
    tournament, (event,) = await paid_tournament(db_session, owner=owner)
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    created = await api_client.post(
        f"/v1/tournaments/{tournament.id}/checkouts",
        json={"request_id": str(uuid.uuid4()), "event_ids": [str(event.id)]},
    )
    checkout_id = created.json()["id"]

    async with watch_hints(realtime_broker, payer.id, bystander.id) as watch:
        cancelled = await api_client.delete(
            f"/v1/tournaments/{tournament.id}/checkouts/{checkout_id}"
        )
        assert cancelled.status_code == 200
        hints = await watch.collect()

    assert hints[payer.id] == [EventKind.checkout_changed]
    assert hints[bystander.id] == []


async def test_preparing_a_payment_hints_only_the_payer(
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
    monkeypatch,
) -> None:
    owner = await make_user(db_session, _name("merchant"))
    payer = await make_user(db_session, _name("payer"))
    bystander = await make_user(db_session, _name("bystander"))
    tournament, (event,) = await paid_tournament(db_session, owner=owner)
    _setup_stripe(monkeypatch, owner=owner)
    checkout_read = await start_checkout(
        db_session,
        tournament_id=tournament.id,
        actor=payer,
        request=TournamentCheckoutCreate(request_id=uuid.uuid4(), event_ids=[event.id]),
        client_ip="203.0.113.5",
    )
    provider = FakePaymentProvider()

    async with watch_hints(realtime_broker, payer.id, bystander.id) as watch:
        prepared = await prepare_or_resume_payment(
            db_session,
            tournament_id=tournament.id,
            checkout_id=checkout_read.id,
            actor=payer,
            provider=provider,
            settings=get_settings(),
        )
        assert prepared.client_secret is not None
        hints = await watch.collect()

    # Two real state changes in one prepare call, each its own commit: the
    # payment row's creation (``unavailable`` -> ``preparing``), then the
    # provider create's ``preparing`` -> ``ready``. Both are genuine and the
    # hint is idempotent-to-receive, so two hints is correct, not a bug.
    assert hints[payer.id] == [EventKind.checkout_changed, EventKind.checkout_changed]
    assert hints[bystander.id] == []


async def test_a_reconciled_success_hints_only_the_payer(
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
    monkeypatch,
) -> None:
    owner = await make_user(db_session, _name("merchant"))
    payer = await make_user(db_session, _name("payer"))
    bystander = await make_user(db_session, _name("bystander"))
    tournament, (event,) = await paid_tournament(db_session, owner=owner)
    _setup_stripe(monkeypatch, owner=owner)
    checkout_read = await start_checkout(
        db_session,
        tournament_id=tournament.id,
        actor=payer,
        request=TournamentCheckoutCreate(request_id=uuid.uuid4(), event_ids=[event.id]),
        client_ip="203.0.113.6",
    )
    provider = FakePaymentProvider()
    await prepare_or_resume_payment(
        db_session,
        tournament_id=tournament.id,
        checkout_id=checkout_read.id,
        actor=payer,
        provider=provider,
        settings=get_settings(),
    )
    payment = await db_session.scalar(
        select(TournamentPayment).where(
            TournamentPayment.checkout_id == checkout_read.id
        )
    )
    assert payment is not None
    assert payment.provider_payment_intent_id is not None
    provider.set_status(
        payment.provider_payment_intent_id,
        status="succeeded",
        amount_received=payment.amount_cents,
    )

    async with watch_hints(realtime_broker, payer.id, bystander.id) as watch:
        reconciled = await reconcile_payment(
            db_session,
            payment_id=payment.id,
            provider=provider,
            settings=get_settings(),
        )
        assert reconciled is not None
        hints = await watch.collect()

    assert hints[payer.id] == [EventKind.checkout_changed]
    assert hints[bystander.id] == []


async def test_director_invalidation_hints_only_the_payer(
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
    monkeypatch,
) -> None:
    """A director entering the paid-event player directly invalidates that
    player's open checkout (#1816) — the payer, and only the payer, is
    hinted; the director is not."""
    owner = await make_user(db_session, _name("merchant"))
    payer = await make_user(db_session, _name("payer"))
    bystander = await make_user(db_session, _name("bystander"))
    tournament, (event,) = await paid_tournament(db_session, owner=owner)
    monkeypatch.setenv("TOURNAMENT_PAYMENT_MERCHANT_ACCOUNT_ID", str(owner.id))
    await start_checkout(
        db_session,
        tournament_id=tournament.id,
        actor=payer,
        request=TournamentCheckoutCreate(request_id=uuid.uuid4(), event_ids=[event.id]),
        client_ip="203.0.113.7",
    )

    async with watch_hints(realtime_broker, payer.id, owner.id, bystander.id) as watch:
        await enter_event(
            db_session,
            tournament_id=tournament.id,
            event_id=event.id,
            actor=owner,
            user_id=payer.primary_player.id,
        )
        hints = await watch.collect()

    assert hints[payer.id] == [EventKind.checkout_changed]
    assert hints[owner.id] == []
    assert hints[bystander.id] == []
