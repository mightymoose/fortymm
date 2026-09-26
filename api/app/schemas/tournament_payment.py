import uuid
from datetime import datetime

from pydantic import BaseModel

from app.schemas.tournament_checkout import TournamentCheckoutPaymentState


class TournamentPaymentRead(BaseModel):
    """The payer's (or merchant's) view of a payment. Never carries the Stripe
    client secret — only :class:`TournamentPaymentPrepared` does, and only the
    prepare/resume operation returns that (#1816 constraint)."""

    id: uuid.UUID
    checkout_id: uuid.UUID
    reference: str
    status: TournamentCheckoutPaymentState
    last_error: str | None
    amount_cents: int
    currency: str
    created_at: datetime


class TournamentPaymentPrepared(TournamentPaymentRead):
    """The prepare/resume response — the ONE place the Stripe client secret is
    ever returned. ``None`` when the create outcome was uncertain (Fortymm
    state ``preparing``): the client has nothing to confirm yet and must
    resume (call this operation again) shortly."""

    client_secret: str | None
