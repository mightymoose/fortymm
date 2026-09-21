"""Transport-neutral refusals for combined checkout holds."""

import uuid
from enum import StrEnum


class CheckoutRefusal(StrEnum):
    merchant_unavailable = "merchant_unavailable"
    registration_closed = "registration_closed"
    event_not_found = "event_not_found"
    event_unavailable = "event_unavailable"
    event_ineligible = "event_ineligible"
    event_full = "event_full"
    event_free = "event_free"
    price_too_low = "price_too_low"
    already_entered = "already_entered"
    active_checkout_conflict = "active_checkout_conflict"
    request_payload_conflict = "request_payload_conflict"


class CheckoutRefusedError(Exception):
    def __init__(
        self,
        refusal: CheckoutRefusal,
        message: str,
        *,
        event_id: uuid.UUID | None = None,
    ) -> None:
        super().__init__(message)
        self.refusal = refusal
        self.event_id = event_id


class CheckoutNotFoundError(Exception):
    pass


class CheckoutRateLimitedError(Exception):
    pass


class CheckoutRateLimitUnavailableError(Exception):
    """The shared checkout admission budget cannot currently be checked."""
