"""Transport-neutral refusals for tournament payments (#1816)."""


class PaymentNotFoundError(Exception):
    """No payment exists for this checkout, or the caller may not see it
    (neither the payer nor the configured merchant account) — always a 404,
    never a 403, so a stranger learns nothing about whether a payment exists."""


class PaymentNotReadyError(Exception):
    """The checkout cannot be turned into a payment yet (it is not the
    payer's own active checkout)."""


class PaymentProviderUnavailableError(Exception):
    """Stripe could not be reached while reconciling a payment. Nothing
    changed: the payment keeps its last known state, and a later status read,
    resume or webhook retry reconciles it."""
