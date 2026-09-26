"""The one seam every Stripe network call crosses (#1816).

``PaymentProvider`` is a small ``Protocol`` (create / retrieve / cancel a
PaymentIntent, plus the startup account check) that every payment operation
in ``app.payments`` calls through — never ``import stripe`` anywhere else in
the codebase. ``StripePaymentProvider`` is the real adapter; ``FakePaymentProvider``
(in ``app.payments.fake_provider``, imported only by tests) implements the same
Protocol in memory.

Every Stripe object this module hands back has already been parsed into a
Pydantic model (see ``.claude/rules/parse-at-boundaries.md``) — nothing downstream
holds a raw ``stripe.StripeObject``.
"""

from typing import Protocol

import stripe
from pydantic import BaseModel, ConfigDict, Field, model_validator

#: Pinned per #1816's constraint ("set ``api_version`` on the server client").
STRIPE_API_VERSION = "2026-08-26.dahlia"


class ProviderPaymentIntent(BaseModel):
    """The fields Fortymm trusts off a Stripe PaymentIntent — parsed once,
    uniformly, whether the raw object came back from a create/retrieve/cancel
    call or as a webhook's ``event.data.object`` (both are Stripe
    ``StripeObject``s and both answer ``.to_dict()``)."""

    model_config = ConfigDict(extra="ignore")

    id: str
    status: str
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


def _retrieval_failure(error: stripe.StripeError) -> ProviderRetrievalFailed:
    # An authentication failure is about Fortymm's own key, not about the
    # PaymentIntent, so it must not quarantine a payment either.
    if isinstance(
        error,
        (
            stripe.APIConnectionError,
            stripe.APIError,
            stripe.RateLimitError,
            stripe.AuthenticationError,
        ),
    ):
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
    to_dict = getattr(raw, "to_dict", None)
    payload: object = to_dict() if callable(to_dict) else raw
    return ProviderPaymentIntent.model_validate(payload)


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
        except (stripe.APIConnectionError, stripe.APIError, stripe.RateLimitError):
            # Ambiguous by construction (#1816): a timeout or a 5xx does not
            # tell us whether Stripe committed the create. Never retry with a
            # NEW idempotency key here — that could double-create.
            return ProviderCreateUncertain()
        return ProviderIntentCreated(intent=_parse_intent(raw))

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
