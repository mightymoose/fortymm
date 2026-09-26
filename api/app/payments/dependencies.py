"""Construction of the one ``PaymentProvider`` this process talks Stripe through."""

from functools import lru_cache

from app.config import Settings, get_settings
from app.payments.provider import PaymentProvider, StripePaymentProvider


@lru_cache(maxsize=4)
def _provider_for(secret_key: str) -> StripePaymentProvider:
    return StripePaymentProvider(secret_key)


def get_payment_provider(settings: Settings | None = None) -> PaymentProvider:
    """Build (or reuse) the ``StripePaymentProvider`` for the configured secret
    key. Cached by key value, so a test that sets a different key still gets a
    fresh client, while repeated calls reuse one ``stripe.StripeClient`` and
    its connection pool."""
    return _provider_for((settings or get_settings()).stripe_secret_key)
