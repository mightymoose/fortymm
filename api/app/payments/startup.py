"""The startup refusal that keeps ``STRIPE_ACCOUNT_ID`` honest (#1816).

Mirrors ``app.config._require_google_key``'s stance — a misconfigured deploy
dies at boot, not at its first webhook — but this check needs a network call
(retrieving the account that owns the configured key), so it cannot live on
the ``Settings`` model itself; it runs from ``app.main``'s ``lifespan``.
"""

import asyncio

from app.config import Settings
from app.payments.provider import PaymentProvider, ProviderRetrievalFailed

_ACCOUNT_CHECK_TIMEOUT_S = 15.0


class StripeAccountMismatch(Exception):
    pass


async def verify_stripe_account(settings: Settings, provider: PaymentProvider) -> None:
    """Refuse to finish starting when ``STRIPE_ACCOUNT_ID`` names a different
    account than the one that owns ``STRIPE_SECRET_KEY``. A no-op when Stripe
    is unconfigured (empty secret key) — card payments are simply unavailable,
    not a boot failure, matching how the rest of #1816 fails closed rather
    than fails loudly for an unconfigured merchant.
    """
    if not settings.stripe_secret_key:
        return
    if not settings.stripe_account_id:
        raise StripeAccountMismatch(
            "STRIPE_SECRET_KEY is set but STRIPE_ACCOUNT_ID is not — refusing "
            "to start without knowing which account the key is expected to "
            "own."
        )
    try:
        # Bounded, so a slow Stripe fails the boot quickly instead of stalling
        # readiness behind the SDK's long default timeout and retries.
        actual_account_id = await asyncio.wait_for(
            provider.retrieve_account_id(), timeout=_ACCOUNT_CHECK_TIMEOUT_S
        )
    except (ProviderRetrievalFailed, TimeoutError) as error:
        raise StripeAccountMismatch(
            f"Could not verify STRIPE_ACCOUNT_ID against Stripe: {error}"
        ) from error
    if actual_account_id != settings.stripe_account_id:
        raise StripeAccountMismatch(
            f"STRIPE_ACCOUNT_ID={settings.stripe_account_id!r} does not match "
            f"the account that owns the configured Stripe key "
            f"({actual_account_id!r})."
        )
