"""Contract tests for parsing Stripe responses at the provider boundary."""

from types import SimpleNamespace

import pytest
import stripe

from app.payment_provider import (
    PaymentIntentCreate,
    PaymentProviderCancellationRejectedError,
    PaymentProviderUncertainError,
    StripePaymentProvider,
)


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


async def test_cancel_parses_real_dynamic_stripe_object(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_boundary")
    monkeypatch.setattr(
        stripe.PaymentIntent, "cancel", lambda _intent_id: _stripe_object_intent()
    )

    intent = await StripePaymentProvider().cancel_payment_intent("pi_boundary_test")

    assert intent.id == "pi_real_stripe_object"
    assert intent.status == "requires_action"
    assert intent.durable_identity == "fortymm:checkout:test:payment:v1"


async def test_cancel_translates_uncertain_connection_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_boundary")

    def connection_failure(_intent_id: str) -> object:
        raise stripe.APIConnectionError("connection lost after request")

    monkeypatch.setattr(stripe.PaymentIntent, "cancel", connection_failure)

    with pytest.raises(PaymentProviderUncertainError):
        await StripePaymentProvider().cancel_payment_intent("pi_boundary_test")


@pytest.mark.parametrize(
    "provider_error_type",
    [
        pytest.param(stripe.RateLimitError, id="rate-limit"),
        pytest.param(stripe.APIError, id="api-error"),
    ],
)
@pytest.mark.parametrize("operation", ["create", "retrieve", "update", "cancel"])
async def test_retryable_stripe_failures_have_one_uncertain_boundary_contract(
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
    provider_error_type: type[Exception],
) -> None:
    """Every transient SDK failure must leave its payment obligation retryable."""
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_boundary")
    provider_error = provider_error_type("temporary Stripe failure")

    def transient_failure(*_args: object, **_kwargs: object) -> object:
        raise provider_error

    stripe_method = {
        "create": "create",
        "retrieve": "search",
        "update": "modify",
        "cancel": "cancel",
    }[operation]
    monkeypatch.setattr(stripe.PaymentIntent, stripe_method, transient_failure)
    provider = StripePaymentProvider()

    with pytest.raises(PaymentProviderUncertainError):
        if operation == "create":
            await provider.create_payment_intent(_request())
        elif operation == "retrieve":
            await provider.retrieve_payment_intent(_request().idempotency_key)
        elif operation == "update":
            await provider.update_payment_intent_receipt(
                "pi_boundary_test", "payer@example.net"
            )
        else:
            await provider.cancel_payment_intent("pi_boundary_test")


@pytest.mark.parametrize(
    "provider_error",
    [
        TimeoutError("receipt update timed out after submission"),
        stripe.APIConnectionError("connection lost after receipt update"),
    ],
)
async def test_receipt_update_translates_uncertain_transport_failure(
    monkeypatch: pytest.MonkeyPatch,
    provider_error: Exception,
) -> None:
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_boundary")

    def uncertain_update(_intent_id: str, *, receipt_email: str) -> object:  # noqa: ARG001 -- provider boundary shape
        raise provider_error

    monkeypatch.setattr(stripe.PaymentIntent, "modify", uncertain_update)

    with pytest.raises(PaymentProviderUncertainError):
        await StripePaymentProvider().update_payment_intent_receipt(
            "pi_boundary_test", "payer@example.net"
        )


async def test_cancel_translates_non_cancelable_provider_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_boundary")

    def cancellation_rejected(_intent_id: str) -> object:
        raise stripe.InvalidRequestError("intent cannot be canceled", "intent")

    monkeypatch.setattr(stripe.PaymentIntent, "cancel", cancellation_rejected)

    with pytest.raises(PaymentProviderCancellationRejectedError):
        await StripePaymentProvider().cancel_payment_intent("pi_boundary_test")
