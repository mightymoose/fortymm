"""Contract tests for parsing Stripe responses at the provider boundary."""

from types import SimpleNamespace

import pytest
import stripe

from app.payment_provider import PaymentIntentCreate, StripePaymentProvider


def _request() -> PaymentIntentCreate:
    return PaymentIntentCreate(
        amount_cents=2345,
        currency="USD",
        merchant_account_id="00000000-0000-0000-0000-000000000001",
        payment_method_types=["card"],
        save_payment_method=False,
        idempotency_key="fortymm:checkout:test:payment:v1",
        receipt_email=None,
    )


def _stripe_intent(*, status: str, metadata: object) -> object:
    return SimpleNamespace(
        id="pi_boundary_test",
        client_secret="pi_boundary_test_secret",
        status=status,
        amount=2345,
        currency="usd",
        livemode=False,
        metadata=metadata,
    )


def _stripe_object_intent() -> stripe.StripeObject:
    return stripe.StripeObject.construct_from(
        {
            "id": "pi_real_stripe_object",
            "client_secret": "pi_real_stripe_object_secret",
            "status": "requires_action",
            "amount": 2345,
            "currency": "usd",
            "livemode": False,
            "metadata": {
                "fortymm_identity": "fortymm:checkout:test:payment:v1",
                "fortymm_merchant_account_id": ("00000000-0000-0000-0000-000000000001"),
            },
        },
        "sk_test_boundary",
    )


async def test_create_parses_real_dynamic_stripe_object(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_boundary")
    monkeypatch.setattr(
        stripe.PaymentIntent, "create", lambda **_kwargs: _stripe_object_intent()
    )

    intent = await StripePaymentProvider().create_payment_intent(_request())

    assert intent.id == "pi_real_stripe_object"
    assert intent.client_secret == "pi_real_stripe_object_secret"
    assert intent.status == "requires_action"
    assert intent.currency == "USD"


async def test_webhook_parses_real_dynamic_stripe_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_boundary")
    event = stripe.StripeObject.construct_from(
        {
            "id": "evt_real_stripe_object",
            "type": "payment_intent.requires_action",
            "created": 1_800_000_000,
            "data": {"object": _stripe_object_intent()},
        },
        "sk_test_boundary",
    )
    monkeypatch.setattr(
        stripe.Webhook,
        "construct_event",
        lambda *_args, **_kwargs: event,
    )

    verified = await StripePaymentProvider().verify_webhook(b"{}", "signature")

    assert verified.id == "evt_real_stripe_object"
    assert verified.payment.id == "pi_real_stripe_object"
    assert verified.payment.status == "requires_action"


async def test_create_rejects_unknown_provider_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_boundary")
    monkeypatch.setattr(
        stripe.PaymentIntent,
        "create",
        lambda **_kwargs: _stripe_intent(
            status="future_status_not_understood_by_fortymm",
            metadata={
                "fortymm_identity": "fortymm:checkout:test:payment:v1",
                "fortymm_merchant_account_id": ("00000000-0000-0000-0000-000000000001"),
            },
        ),
    )

    with pytest.raises(ValueError):
        await StripePaymentProvider().create_payment_intent(_request())


async def test_create_rejects_provider_metadata_missing_required_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_boundary")
    monkeypatch.setattr(
        stripe.PaymentIntent,
        "create",
        lambda **_kwargs: _stripe_intent(
            status="requires_payment_method",
            metadata={
                "fortymm_merchant_account_id": ("00000000-0000-0000-0000-000000000001")
            },
        ),
    )

    with pytest.raises(ValueError):
        await StripePaymentProvider().create_payment_intent(_request())


async def test_create_rejects_malformed_provider_metadata_with_boundary_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_boundary")
    monkeypatch.setattr(
        stripe.PaymentIntent,
        "create",
        lambda **_kwargs: _stripe_intent(
            status="requires_payment_method",
            metadata=["not", "a", "metadata", "mapping"],
        ),
    )

    with pytest.raises(ValueError):
        await StripePaymentProvider().create_payment_intent(_request())
