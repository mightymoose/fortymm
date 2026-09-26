import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, StringConstraints

from app.models import TournamentPaymentErrorCode
from app.models.tournament_payment import PaymentCurrency
from app.schemas.tournament_checkout import TournamentCheckoutPaymentState

#: ``PAY-`` plus 8 Crockford base32 characters (#1816).
PaymentReference = Annotated[
    str, StringConstraints(pattern=r"^PAY-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$")
]


class TournamentPaymentRead(BaseModel):
    """The payer's (or merchant's) view of a payment. Never carries the Stripe
    client secret — only :class:`TournamentPaymentPrepared` does, and only the
    prepare/resume operation returns that (#1816 constraint).

    ``payment_state`` is the same field, with the same values, as the checkout
    read's ``payment_state``."""

    id: uuid.UUID
    checkout_id: uuid.UUID
    reference: PaymentReference
    payment_state: TournamentCheckoutPaymentState
    last_error_code: TournamentPaymentErrorCode | None
    amount_cents: int
    currency: PaymentCurrency
    created_at: datetime


class TournamentPaymentPrepared(TournamentPaymentRead):
    """The prepare/resume response — the ONE place the Stripe client secret is
    ever returned. ``None`` when the create outcome was uncertain (Fortymm
    state ``preparing``): the client has nothing to confirm yet and must
    resume (call this operation again) shortly."""

    client_secret: str | None
