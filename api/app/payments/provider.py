"""The one seam every Stripe network call crosses (#1816).

``PaymentProvider`` is a small ``Protocol`` (create / retrieve / cancel a
PaymentIntent, plus the startup account check) that every payment operation
in ``app.payments`` calls through. Webhook signature verification lives here
too (:func:`verify_webhook_event`), so nothing outside this module ever
``import stripe``. ``StripePaymentProvider`` is the real adapter.
``FakePaymentProvider`` (in ``app.payments.fake_provider``, imported only by
tests) implements the same Protocol in memory.

Every Stripe object this module hands back has already been parsed into a
Pydantic model (see ``.claude/rules/parse-at-boundaries.md``) — nothing downstream
holds a raw ``stripe.StripeObject``.
"""

from enum import StrEnum
from typing import Protocol

import stripe
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

#: Pinned per #1816's constraint ("set ``api_version`` on the server client").
STRIPE_API_VERSION = "2026-08-26.dahlia"


class ProviderIntentStatus(StrEnum):
    """Stripe's closed PaymentIntent status set for the pinned API version.
    A value outside it fails parsing at this boundary instead of leaking a
    string Fortymm never mapped."""

    REQUIRES_PAYMENT_METHOD = "requires_payment_method"
    REQUIRES_CONFIRMATION = "requires_confirmation"
    REQUIRES_ACTION = "requires_action"
    PROCESSING = "processing"
    REQUIRES_CAPTURE = "requires_capture"
    CANCELED = "canceled"
    SUCCEEDED = "succeeded"


class ProviderPaymentIntent(BaseModel):
    """The fields Fortymm trusts off a Stripe PaymentIntent — parsed once,
    uniformly, whether the raw object came back from a create/retrieve/cancel
    call or as a webhook's ``event.data.object`` (both are Stripe
    ``StripeObject``s and both answer ``.to_dict()``)."""

    model_config = ConfigDict(extra="ignore")

    id: str
    status: ProviderIntentStatus
    amount: int
    currency: str
    livemode: bool
    client_secret: str | None = None
    amount_received: int = 0
    metadata: dict[str, str] = Field(default_factory=dict)
    last_payment_error_code: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _flatten_last_payment_error(cls, data: object) -> object:
        if isinstance(data, dict) and data.get("last_payment_error_code") is None:
            last_error = data.get("last_payment_error")
            if isinstance(last_error, dict):
                data = {**data, "last_payment_error_code": last_error.get("code")}
        return data

    @property
    def metadata_payment_id(self) -> str | None:
        return self.metadata.get("payment_id")


class ProviderIntentCreated(BaseModel):
    """The create call unambiguously produced (or already existed as) this
    PaymentIntent."""

    intent: ProviderPaymentIntent


class ProviderCreateUncertain(BaseModel):
    """The create call's outcome could not be determined — a timeout or a
    connection error. The caller must assume NEITHER that the PaymentIntent
    was created NOR that it was not; it reports Fortymm state ``preparing``
    and a later resume retries the SAME idempotency key, which Stripe
    guarantees is safe to repeat."""


ProviderCreateOutcome = ProviderIntentCreated | ProviderCreateUncertain


class ProviderRetrievalFailed(Exception):
    """A retrieve or cancel call produced no PaymentIntent. Reconcile decides
    what this means; this module only reports which of the two kinds of
    failure happened."""


class ProviderUnavailable(ProviderRetrievalFailed):
    """Stripe could not be reached, or failed on its side (a connection error,
    a 5xx, a rate limit). This says nothing about the PaymentIntent, so it is
    never a reason to quarantine a payment on its own."""


class ProviderRefused(ProviderRetrievalFailed):
    """Stripe answered and refused the request, for example because the
    PaymentIntent does not exist on the payee account. Quarantine records this
    as "amount unverified"."""


#: The Stripe errors that say "Stripe could not be reached or failed on its
#: side". They say nothing about the PaymentIntent itself.
_STRIPE_UNAVAILABLE: tuple[type[stripe.StripeError], ...] = (
    stripe.APIConnectionError,
    stripe.APIError,
    stripe.RateLimitError,
)

#: A create whose outcome is unknown: Stripe was unavailable, or another
#: request with the same idempotency key is still in flight.
_STRIPE_CREATE_UNCERTAIN: tuple[type[stripe.StripeError], ...] = (
    *_STRIPE_UNAVAILABLE,
    stripe.IdempotencyError,
)


def _retrieval_failure(error: stripe.StripeError) -> ProviderRetrievalFailed:
    # An authentication failure is about Fortymm's own key, not about the
    # PaymentIntent, so it must not quarantine a payment either.
    if isinstance(error, (*_STRIPE_UNAVAILABLE, stripe.AuthenticationError)):
        return ProviderUnavailable(str(error))
    return ProviderRefused(str(error))


class PaymentProvider(Protocol):
    """Every Stripe call a payment operation makes, parameterized by the
    payee account (``None`` means the platform account) so Stripe Connect
    (#1819) is additive rather than a redesign."""

    async def create_payment_intent(
        self,
        *,
        payee_account: str | None,
        amount_cents: int,
        currency: str,
        idempotency_key: str,
        metadata: dict[str, str],
        statement_descriptor_suffix: str,
    ) -> ProviderCreateOutcome: ...

    async def retrieve_payment_intent(
        self, *, payee_account: str | None, payment_intent_id: str
    ) -> ProviderPaymentIntent: ...

    async def cancel_payment_intent(
        self, *, payee_account: str | None, payment_intent_id: str
    ) -> ProviderPaymentIntent: ...

    async def retrieve_account_id(self) -> str:
        """The Stripe ``acct_…`` id that owns the configured secret key —
        used only by the startup check (``app.payments.startup``)."""
        ...


def _parse_intent(raw: object) -> ProviderPaymentIntent:
    """Parse a Stripe response. A response Fortymm cannot parse is treated as
    Stripe failing on its side: it proves nothing about the PaymentIntent, so
    it must never quarantine a payment."""
    to_dict = getattr(raw, "to_dict", None)
    payload: object = to_dict() if callable(to_dict) else raw
    try:
        return ProviderPaymentIntent.model_validate(payload)
    except ValidationError as error:
        raise ProviderUnavailable(f"unparseable PaymentIntent: {error}") from error


class StripePaymentProvider:
    """The real adapter, backed by ``stripe.StripeClient``.

    A connected-account call (Stripe Connect, #1819) sets ``Stripe-Account``
    per request rather than at client construction, since one process serves
    every payee — today only the platform account, ``payee_account is None``.
    """

    def __init__(self, secret_key: str) -> None:
        self._secret_key = secret_key
        self._client = stripe.StripeClient(
            api_key=secret_key, stripe_version=STRIPE_API_VERSION
        )

    def _options(
        self, payee_account: str | None, *, idempotency_key: str | None = None
    ) -> stripe.RequestOptions:
        options: stripe.RequestOptions = {}
        if idempotency_key is not None:
            options["idempotency_key"] = idempotency_key
        if payee_account:
            options["stripe_account"] = payee_account
        return options

    async def create_payment_intent(
        self,
        *,
        payee_account: str | None,
        amount_cents: int,
        currency: str,
        idempotency_key: str,
        metadata: dict[str, str],
        statement_descriptor_suffix: str,
    ) -> ProviderCreateOutcome:
        try:
            raw = await self._client.v1.payment_intents.create_async(
                {
                    "amount": amount_cents,
                    "currency": currency,
                    "payment_method_types": ["card"],
                    "capture_method": "automatic",
                    "statement_descriptor_suffix": statement_descriptor_suffix,
                    "metadata": metadata,
                },
                options=self._options(payee_account, idempotency_key=idempotency_key),
            )
        except _STRIPE_CREATE_UNCERTAIN:
            # Ambiguous by construction (#1816): a timeout or a 5xx does not
            # tell us whether Stripe committed the create. An idempotency
            # conflict means another request with the same key is still in
            # flight. Never retry with a NEW idempotency key here, because
            # that could double-create.
            return ProviderCreateUncertain()
        try:
            return ProviderIntentCreated(intent=_parse_intent(raw))
        except ProviderUnavailable:
            return ProviderCreateUncertain()

    async def retrieve_payment_intent(
        self, *, payee_account: str | None, payment_intent_id: str
    ) -> ProviderPaymentIntent:
        try:
            raw = await self._client.v1.payment_intents.retrieve_async(
                payment_intent_id, options=self._options(payee_account)
            )
        except stripe.StripeError as error:
            raise _retrieval_failure(error) from error
        return _parse_intent(raw)

    async def cancel_payment_intent(
        self, *, payee_account: str | None, payment_intent_id: str
    ) -> ProviderPaymentIntent:
        try:
            raw = await self._client.v1.payment_intents.cancel_async(
                payment_intent_id, options=self._options(payee_account)
            )
        except stripe.StripeError as error:
            raise _retrieval_failure(error) from error
        return _parse_intent(raw)

    async def retrieve_account_id(self) -> str:
        try:
            # The legacy classmethod form (rather than ``StripeClient.v1``,
            # which has no singular ``account`` sub-service) is Stripe's
            # supported way to ask "which account does this key belong to" —
            # ``GET /v1/account`` with no id.
            account = await stripe.Account.retrieve_async(
                api_key=self._secret_key, stripe_version=STRIPE_API_VERSION
            )
        except stripe.StripeError as error:
            raise ProviderRetrievalFailed(str(error)) from error
        return account.id


#: The webhook event types #1816 acts on. Every other type is still persisted
#: and acknowledged (evidence trail), then ignored, never rejected.
HANDLED_WEBHOOK_EVENT_TYPES = frozenset(
    {
        "payment_intent.succeeded",
        "payment_intent.payment_failed",
        "payment_intent.processing",
        "payment_intent.requires_action",
        "payment_intent.canceled",
        "charge.refunded",
    }
)


class ProviderWebhookObject(BaseModel):
    """``data.object`` of a webhook event. Only the fields routing needs are
    typed. The rest ride along as evidence (``extra="allow"``) and are never
    read by business logic."""

    model_config = ConfigDict(extra="allow")

    id: str | None = None
    #: Set on a ``charge`` object: the PaymentIntent the charge belongs to.
    payment_intent: str | None = None


class ProviderWebhookData(BaseModel):
    model_config = ConfigDict(extra="allow")

    object: ProviderWebhookObject


class ProviderWebhookEvent(BaseModel):
    """A verified Stripe webhook event, parsed once at the webhook boundary.

    Deliberately NOT a trusted PaymentIntent: reconcile always retrieves the
    PaymentIntent itself, so every validated field (and quarantine's captured
    amount) comes from Fortymm's own retrieval, never from this payload."""

    model_config = ConfigDict(extra="allow")

    id: str
    type: str
    livemode: bool
    account: str | None = None
    data: ProviderWebhookData

    @property
    def payment_intent_id(self) -> str | None:
        """The PaymentIntent this event is about. A ``charge.refunded``
        event's object is a charge, so its id is a charge id."""
        if self.type == "charge.refunded":
            return self.data.object.payment_intent
        return self.data.object.id

    @property
    def is_handled(self) -> bool:
        return self.type in HANDLED_WEBHOOK_EVENT_TYPES

    def evidence(self) -> dict[str, object]:
        """The stored evidence copy. A PaymentIntent object carries its client
        secret, which only the payer's prepare or resume may return, so the
        evidence keeps everything except that field."""
        return self.model_dump(
            mode="json",
            exclude_unset=True,
            exclude={"data": {"object": {"client_secret"}}},
        )


class WebhookRejected(Exception):
    """The webhook body failed signature verification against every
    configured secret, or it is not a well-formed event."""


def verify_webhook_event(
    payload: bytes, *, signature: str | None, secrets: list[str]
) -> ProviderWebhookEvent:
    """Verify ``payload`` against each configured signing secret in turn (more
    than one may be live at once, for example while rotating a secret), then
    parse it. The raw body is verified BEFORE any JSON parsing."""
    if not signature:
        raise WebhookRejected("missing Stripe-Signature header")
    for secret in secrets:
        try:
            stripe.WebhookSignature.verify_header(
                payload, signature, secret, stripe.Webhook.DEFAULT_TOLERANCE
            )
        except (ValueError, stripe.SignatureVerificationError):
            # ``ValueError`` covers a body that is not UTF-8.
            continue
        try:
            return ProviderWebhookEvent.model_validate_json(payload)
        except ValidationError as error:
            raise WebhookRejected(f"malformed Stripe event: {error}") from error
    raise WebhookRejected("no configured secret verifies the signature")
