"""An in-memory ``PaymentProvider`` fake, so tests never touch the network.

Scripted per test via ``queue_outcome`` / ``set_status`` rather than a real
Stripe sandbox — the webhook-signature path is still exercised for real
(``tests/test_tournament_payments.py`` signs fixtures with the real SDK
verification, per #1816's acceptance criteria), only the PaymentIntent
lifecycle itself is faked.
"""

import uuid
from dataclasses import dataclass, field

from app.payments.provider import (
    ProviderCreateOutcome,
    ProviderCreateUncertain,
    ProviderIntentCreated,
    ProviderPaymentIntent,
    ProviderRetrievalFailed,
)


@dataclass
class _FakeIntentState:
    payee_account: str | None
    intent: ProviderPaymentIntent


@dataclass
class FakePaymentProvider:
    """Keyed on idempotency key (create) and PaymentIntent id (retrieve/cancel),
    exactly like Stripe's own idempotency guarantee: replaying a ``create``
    with the same key returns the same intent rather than making a second one.
    """

    account_id: str = "acct_fake_platform"
    #: Populated by a test before calling ``create_payment_intent`` to force the
    #: NEXT create to report an uncertain outcome (a timeout).
    force_uncertain_once: bool = False
    _by_idempotency_key: dict[str, _FakeIntentState] = field(default_factory=dict)
    _by_intent_id: dict[str, _FakeIntentState] = field(default_factory=dict)
    retrieval_failures: set[str] = field(default_factory=set)
    retrieval_wrong_account: set[str] = field(default_factory=set)

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
        if self.force_uncertain_once:
            self.force_uncertain_once = False
            return ProviderCreateUncertain()
        existing = self._by_idempotency_key.get(idempotency_key)
        if existing is not None:
            return ProviderIntentCreated(intent=existing.intent)
        intent = ProviderPaymentIntent(
            id=f"pi_fake_{uuid.uuid4().hex[:24]}",
            status="requires_payment_method",
            amount=amount_cents,
            currency=currency,
            livemode=False,
            client_secret=f"secret_{uuid.uuid4().hex}",
            amount_received=0,
            metadata=metadata,
        )
        state = _FakeIntentState(payee_account=payee_account, intent=intent)
        self._by_idempotency_key[idempotency_key] = state
        self._by_intent_id[intent.id] = state
        return ProviderIntentCreated(intent=intent)

    def _state_or_raise(
        self, *, payee_account: str | None, payment_intent_id: str
    ) -> _FakeIntentState:
        if payment_intent_id in self.retrieval_failures:
            raise ProviderRetrievalFailed("fake retrieval failure")
        state = self._by_intent_id.get(payment_intent_id)
        if state is None:
            raise ProviderRetrievalFailed("no such fake payment intent")
        if payment_intent_id in self.retrieval_wrong_account:
            raise ProviderRetrievalFailed("fake: intent belongs to another account")
        return state

    async def retrieve_payment_intent(
        self, *, payee_account: str | None, payment_intent_id: str
    ) -> ProviderPaymentIntent:
        return self._state_or_raise(
            payee_account=payee_account, payment_intent_id=payment_intent_id
        ).intent

    async def cancel_payment_intent(
        self, *, payee_account: str | None, payment_intent_id: str
    ) -> ProviderPaymentIntent:
        state = self._state_or_raise(
            payee_account=payee_account, payment_intent_id=payment_intent_id
        )
        state.intent = state.intent.model_copy(update={"status": "canceled"})
        self._by_intent_id[payment_intent_id] = state
        return state.intent

    async def retrieve_account_id(self) -> str:
        return self.account_id

    # ----- test-only scripting helpers --------------------------------

    def set_status(
        self,
        payment_intent_id: str,
        *,
        status: str,
        amount_received: int | None = None,
        last_payment_error_code: str | None = None,
    ) -> ProviderPaymentIntent:
        """Move a fake PaymentIntent to a new status, as if the cardholder
        (or Stripe's fraud/3DS pipeline) had acted on it."""
        state = self._by_intent_id[payment_intent_id]
        updates: dict[str, object] = {"status": status}
        if amount_received is not None:
            updates["amount_received"] = amount_received
        updates["last_payment_error_code"] = last_payment_error_code
        state.intent = state.intent.model_copy(update=updates)
        self._by_intent_id[payment_intent_id] = state
        return state.intent

    def corrupt_amount(
        self, payment_intent_id: str, amount: int
    ) -> ProviderPaymentIntent:
        """Test-only: make Stripe's retrieved intent report a DIFFERENT
        ``amount`` than what Fortymm billed — simulating a forged, stale or
        cross-account event that reconcile must quarantine."""
        state = self._by_intent_id[payment_intent_id]
        state.intent = state.intent.model_copy(update={"amount": amount})
        self._by_intent_id[payment_intent_id] = state
        return state.intent

    def intent_for(self, payment_intent_id: str) -> ProviderPaymentIntent:
        return self._by_intent_id[payment_intent_id].intent
