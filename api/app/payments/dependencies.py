"""Construction of the one ``PaymentProvider`` this process talks Stripe through."""

from app.config import Settings, get_settings
from app.payments.provider import PaymentProvider, StripePaymentProvider

_cached: tuple[str, PaymentProvider] | None = None


def get_payment_provider(settings: Settings | None = None) -> PaymentProvider:
    """Build (or reuse) the ``StripePaymentProvider`` for the configured secret
    key. Cached by key value — tests that ``monkeypatch.setenv`` a different
    key still get a fresh client, but repeated calls in one process (or one
    request) reuse the same ``stripe.StripeClient`` rather than opening a new
    HTTP connection pool per call.
    """
    global _cached
    resolved = settings or get_settings()
    key = resolved.stripe_secret_key
    if _cached is not None and _cached[0] == key:
        return _cached[1]
    provider = StripePaymentProvider(key)
    _cached = (key, provider)
    return provider


def reset_payment_provider_cache() -> None:
    """Test-only: force the next ``get_payment_provider`` to rebuild, so a
    test that overrides ``app.dependency_overrides[get_payment_provider]``
    with a fake never observes a previously cached real client."""
    global _cached
    _cached = None
