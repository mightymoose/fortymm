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
                "fortymm_merchant_account_id": (
                    "00000000-0000-0000-0000-000000000001"
                ),
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
                "fortymm_merchant_account_id": (
                    "00000000-0000-0000-0000-000000000001"
                )
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
