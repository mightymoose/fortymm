"""Narrow external payment-provider port and the production Stripe adapter."""

import asyncio
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Protocol, cast

from app.config import get_settings


class ProviderPaymentStatus(StrEnum):
    requires_payment_method = "requires_payment_method"
    requires_confirmation = "requires_confirmation"
    requires_action = "requires_action"
    processing = "processing"
    requires_capture = "requires_capture"
    canceled = "canceled"
    succeeded = "succeeded"


@dataclass(frozen=True)
class PaymentIntentCreate:
    amount_cents: int
    currency: str
    merchant_account_id: str
    payment_method_types: list[str]
    save_payment_method: bool
    idempotency_key: str
    receipt_email: str | None


@dataclass(frozen=True)
class ProviderPaymentIntent:
    id: str
    client_secret: str
    status: ProviderPaymentStatus
    amount_cents: int
    currency: str
    merchant_account_id: str
    livemode: bool
    durable_identity: str


@dataclass(frozen=True)
class ProviderPaymentEvent:
    id: str
    type: str
    created_at: datetime
    payment: ProviderPaymentIntent


class PaymentProvider(Protocol):
    async def create_payment_intent(
        self, request: PaymentIntentCreate
    ) -> ProviderPaymentIntent: ...

    async def retrieve_payment_intent(
        self, durable_identity: str
    ) -> ProviderPaymentIntent: ...

    async def update_payment_intent_receipt(
        self, provider_payment_id: str, receipt_email: str | None
    ) -> ProviderPaymentIntent: ...

    async def verify_webhook(
        self, payload: bytes, signature: str | None
    ) -> ProviderPaymentEvent: ...


class PaymentProviderUncertainError(Exception):
    """The provider may have accepted work but no authoritative result arrived."""


class PaymentProviderNotFoundError(Exception):
    """No provider object exists for the supplied durable identity."""


class PaymentProviderSignatureError(Exception):
    """Webhook bytes did not authenticate as provider evidence."""


def _stripe_field(resource: object, name: str) -> object:
    """Read one runtime-validated field from Stripe's mapping-like resources.

    ``stripe.StripeObject`` provides fields dynamically and therefore does not
    satisfy a runtime-checkable data protocol on Python 3.13. It is a Mapping,
    while small adapter tests and compatible SDK resources may use attributes.
    Normalize both shapes here and validate each value at the actual boundary.
    """
    if isinstance(resource, Mapping):
        mapping = cast(Mapping[str, object], resource)
        try:
            return mapping[name]
        except KeyError as error:
            raise ValueError(f"Stripe resource is missing {name}.") from error
    try:
        value: object = getattr(resource, name)
    except AttributeError as error:
        raise ValueError(f"Stripe resource is missing {name}.") from error
    return value


class StripePaymentProvider:
    """Stripe implementation; imported lazily so an unconfigured API still boots."""

    def __init__(self) -> None:
        settings = get_settings()
        self._secret_key = settings.stripe_secret_key
        self._api_version = settings.stripe_api_version
        self._webhook_secret = settings.stripe_webhook_secret

    def _require_key(self) -> None:
        if not self._secret_key:
            raise RuntimeError("STRIPE_SECRET_KEY is required for card collection.")

    @staticmethod
    def _intent(value: object) -> ProviderPaymentIntent:
        try:
            intent_id = _stripe_field(value, "id")
            client_secret = _stripe_field(value, "client_secret")
            status = _stripe_field(value, "status")
            amount = _stripe_field(value, "amount")
            currency = _stripe_field(value, "currency")
            livemode = _stripe_field(value, "livemode")
            metadata_value = _stripe_field(value, "metadata")
            if not isinstance(intent_id, str) or not intent_id:
                raise ValueError("Stripe PaymentIntent id must be a string.")
            if client_secret is not None and not isinstance(client_secret, str):
                raise ValueError("Stripe client secret must be a string.")
            if not isinstance(status, str):
                raise ValueError("Stripe PaymentIntent status must be a string.")
            if not isinstance(amount, int) or isinstance(amount, bool):
                raise ValueError("Stripe PaymentIntent amount must be an integer.")
            if not isinstance(currency, str):
                raise ValueError("Stripe PaymentIntent currency must be a string.")
            if not isinstance(livemode, bool):
                raise ValueError("Stripe PaymentIntent livemode must be boolean.")
            if not isinstance(metadata_value, Mapping):
                raise ValueError("Stripe PaymentIntent metadata must be a mapping.")
            metadata = cast(Mapping[str, object], metadata_value)
            durable_identity = metadata.get("fortymm_identity")
            if not isinstance(durable_identity, str) or not durable_identity:
                raise ValueError("Stripe PaymentIntent is missing fortymm_identity.")
            merchant = metadata.get("fortymm_merchant_account_id", "")
            if not isinstance(merchant, str):
                raise ValueError("Stripe merchant metadata must be a string.")
            return ProviderPaymentIntent(
                id=intent_id,
                client_secret=client_secret or "",
                status=ProviderPaymentStatus(status),
                amount_cents=amount,
                currency=currency.upper(),
                merchant_account_id=merchant,
                livemode=livemode,
                durable_identity=durable_identity,
            )
        except (AttributeError, TypeError) as error:
            raise ValueError("Malformed Stripe PaymentIntent response.") from error

    async def create_payment_intent(
        self, request: PaymentIntentCreate
    ) -> ProviderPaymentIntent:
        self._require_key()

        def create() -> object:
            import stripe

            stripe.api_key = self._secret_key
            stripe.api_version = self._api_version
            metadata = {
                "fortymm_identity": request.idempotency_key,
                "fortymm_merchant_account_id": request.merchant_account_id,
            }
            if request.receipt_email is None:
                return stripe.PaymentIntent.create(
                    amount=request.amount_cents,
                    currency=request.currency.lower(),
                    payment_method_types=request.payment_method_types,
                    metadata=metadata,
                    idempotency_key=request.idempotency_key,
                )
            return stripe.PaymentIntent.create(
                amount=request.amount_cents,
                currency=request.currency.lower(),
                payment_method_types=request.payment_method_types,
                metadata=metadata,
                idempotency_key=request.idempotency_key,
                receipt_email=request.receipt_email,
            )

        import stripe

        try:
            return self._intent(await asyncio.to_thread(create))
        except TimeoutError as error:
            raise PaymentProviderUncertainError from error
        except stripe.APIConnectionError as error:
            # The request may have reached Stripe even though its response did
            # not reach us. Preserve the create obligation for reconciliation.
            raise PaymentProviderUncertainError from error

    async def retrieve_payment_intent(
        self, durable_identity: str
    ) -> ProviderPaymentIntent:
        self._require_key()

        def retrieve() -> object:
            import stripe

            stripe.api_key = self._secret_key
            stripe.api_version = self._api_version
            escaped = durable_identity.replace("'", "\\'")
            result = stripe.PaymentIntent.search(
                query=f"metadata['fortymm_identity']:'{escaped}'", limit=1
            )
            if not result.data:
                raise PaymentProviderNotFoundError
            return result.data[0]

        import stripe

        try:
            return self._intent(await asyncio.to_thread(retrieve))
        except TimeoutError as error:
            raise PaymentProviderUncertainError from error
        except stripe.APIConnectionError as error:
            raise PaymentProviderUncertainError from error

    async def update_payment_intent_receipt(
        self, provider_payment_id: str, receipt_email: str | None
    ) -> ProviderPaymentIntent:
        self._require_key()

        def update() -> object:
            import stripe

            stripe.api_key = self._secret_key
            stripe.api_version = self._api_version
            return stripe.PaymentIntent.modify(
                provider_payment_id, receipt_email=receipt_email or ""
            )

        return self._intent(await asyncio.to_thread(update))

    async def verify_webhook(
        self, payload: bytes, signature: str | None
    ) -> ProviderPaymentEvent:
        if not self._webhook_secret or not signature:
            raise PaymentProviderSignatureError

        def verify() -> object:
            import stripe

            # stripe-python does not publish annotations for this verified SDK
            # boundary; _StripeEventLike immediately narrows the returned shape.
            return stripe.Webhook.construct_event(  # type: ignore[no-untyped-call]
                payload, signature, self._webhook_secret
            )

        import stripe

        try:
            event = await asyncio.to_thread(verify)
            event_id = _stripe_field(event, "id")
            event_type = _stripe_field(event, "type")
            created_value = _stripe_field(event, "created")
            if not isinstance(event_id, str) or not isinstance(event_type, str):
                raise ValueError("Stripe event identity must be strings.")
            if not isinstance(created_value, int) or isinstance(created_value, bool):
                raise ValueError("Stripe event created time must be an integer.")
            created = datetime.fromtimestamp(created_value, UTC)
            data = _stripe_field(event, "data")
            intent = _stripe_field(data, "object")
            return ProviderPaymentEvent(
                id=event_id,
                type=event_type,
                created_at=created,
                payment=self._intent(intent),
            )
        except (
            AttributeError,
            TypeError,
            stripe.SignatureVerificationError,
            ValueError,
        ) as error:
            raise PaymentProviderSignatureError from error


def get_payment_provider() -> PaymentProvider:
    return StripePaymentProvider()
