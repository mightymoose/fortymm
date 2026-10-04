import uuid
from datetime import datetime
from enum import StrEnum
from typing import Annotated

from pydantic import BaseModel, StringConstraints

from app.models import TournamentPaymentErrorCode
from app.models.tournament_payment import PaymentCurrency
from app.schemas.tournament_checkout import TournamentCheckoutPaymentState

#: ``PAY-`` plus 8 Crockford base32 characters (#1816).
PaymentReference = Annotated[
    str, StringConstraints(pattern=r"^PAY-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$")
]


class PaymentLineOutcome(StrEnum):
    """The public-facing per-event outcome (#1809) — a closed set narrower
    than the model's own :class:`~app.models.TournamentPaymentLineOutcome`:
    the internal ``refund_due`` spelling, and every refund REASON code, stay
    server-side. ``refund_pending`` is the one word the player ever sees for
    "this line did not admit and is owed money back"."""

    pending = "pending"
    admitted = "admitted"
    refund_pending = "refund_pending"


class TournamentPaymentLineRead(BaseModel):
    """One event of a payment and its own admission outcome — mirrors
    :class:`~app.schemas.tournament_checkout.TournamentCheckoutLineRead`'s
    shape, plus the ``outcome`` a checkout line does not have."""

    event_id: uuid.UUID
    event_name: str
    price_cents: int
    outcome: PaymentLineOutcome


class TournamentPaymentRead(BaseModel):
    """The payer's (or merchant's) view of a payment. Never carries the Stripe
    client secret — only :class:`TournamentPaymentPrepared` does, and only the
    prepare/resume operation returns that (#1816 constraint).

    ``payment_state`` is the same field, with the same values, as the checkout
    read's ``payment_state``. ``lines`` is ordered the same way the checkout
    read's own ``lines`` is — by event id."""

    id: uuid.UUID
    checkout_id: uuid.UUID
    reference: PaymentReference
    payment_state: TournamentCheckoutPaymentState
    last_error_code: TournamentPaymentErrorCode | None
    amount_cents: int
    currency: PaymentCurrency
    created_at: datetime
    lines: list[TournamentPaymentLineRead]


class TournamentPaymentReceiptRead(TournamentPaymentRead):
    """The itemized receipt page's payload (#1810): the payment read, only ever
    returned for a ``succeeded`` payment.

    ``receipt_address`` is the payment's snapshot, and it is payer-only: the
    merchant account reads this same response and always sees ``None`` here."""

    receipt_address: str | None


class TournamentPaymentSummary(BaseModel):
    """One succeeded payment in the payer's list for a tournament (#1810): enough
    to name it and link to its receipt page."""

    id: uuid.UUID
    reference: PaymentReference
    amount_cents: int
    created_at: datetime
    event_names: list[str]


class TournamentPaymentPrepared(TournamentPaymentRead):
    """The prepare/resume response — the ONE place the Stripe client secret is
    ever returned. ``None`` when the create outcome was uncertain (Fortymm
    state ``preparing``): the client has nothing to confirm yet and must
    resume (call this operation again) shortly.

    ``publishable_key`` and ``receipt_address`` are payer-only (#1809): this
    is the only payment response the payer's own client ever sees, so both
    ride along here rather than on the merchant-visible plain read."""

    client_secret: str | None
    publishable_key: str
    #: The checkout's current receipt address, or ``None``. Never on
    #: :class:`TournamentPaymentRead` — that response is also the merchant's,
    #: and the address is payer-only (#1809 constraint).
    receipt_address: str | None
