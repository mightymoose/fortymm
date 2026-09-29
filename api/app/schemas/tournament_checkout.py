import uuid
from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.session import BoundedEmailStr


class TournamentCheckoutState(StrEnum):
    active = "active"
    cancelled = "cancelled"
    expired = "expired"
    invalidated = "invalidated"
    completed = "completed"


class TournamentCheckoutPaymentState(StrEnum):
    unavailable = "unavailable"
    preparing = "preparing"
    ready = "ready"
    checking = "checking"
    action_required = "action_required"
    succeeded = "succeeded"
    failed = "failed"
    expired = "expired"
    cancelled = "cancelled"
    #: A quarantined payment (#1809): shown to the player in a neutral tone
    #: with the support reference, never lumped in with an ordinary decline.
    needs_review = "needs_review"


class TournamentCheckoutCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: uuid.UUID
    # A checkout is a human-scale tournament selection, not an unbounded bulk
    # API. Keep the collection well below PostgreSQL/asyncpg's bind-parameter
    # ceiling before it is expanded into ``IN (...)`` queries.
    event_ids: list[uuid.UUID] = Field(min_length=1, max_length=100)

    @field_validator("event_ids")
    @classmethod
    def _events_are_distinct(cls, event_ids: list[uuid.UUID]) -> list[uuid.UUID]:
        if len(set(event_ids)) != len(event_ids):
            raise ValueError("Each event may be selected only once.")
        return event_ids


class TournamentCheckoutLineRead(BaseModel):
    event_id: uuid.UUID
    event_name: str
    price_cents: int


class TournamentCheckoutRead(BaseModel):
    id: uuid.UUID
    request_id: uuid.UUID
    tournament_id: uuid.UUID
    registration_generation: int
    status: TournamentCheckoutState
    payment_state: TournamentCheckoutPaymentState
    currency: str
    total_cents: int
    created_at: datetime
    expires_at: datetime
    remaining_seconds: int = Field(ge=0)
    lines: list[TournamentCheckoutLineRead]


class TournamentCheckoutRefusal(BaseModel):
    code: str
    message: str
    event_id: uuid.UUID | None = None


class TournamentCheckoutRefusalResponse(BaseModel):
    """The FastAPI ``HTTPException`` envelope for a checkout conflict."""

    detail: TournamentCheckoutRefusal


class TournamentCheckoutReceiptAddressUpdate(BaseModel):
    """``PATCH .../checkouts/{checkout_id}`` (#1809), payer-only. ``null``
    clears the receipt address. A blank/whitespace-only string is treated the
    same as ``null`` rather than refused — the field means "no receipt email"
    either way, and a player backspacing the field to empty should not have
    to send an explicit ``null`` for that to take."""

    model_config = ConfigDict(extra="forbid")

    receipt_address: BoundedEmailStr | None = None

    @field_validator("receipt_address", mode="before")
    @classmethod
    def _blank_is_null(cls, value: object) -> object:
        if isinstance(value, str):
            stripped = value.strip()
            return stripped or None
        return value


class TournamentCheckoutReceiptAddressRead(BaseModel):
    """The payer-only response to the receipt-address PATCH. Never anywhere
    else: the plain checkout/payment reads stay merchant-visible too, and the
    address is payer-only (#1809 constraint)."""

    receipt_address: str | None


class OpenTournamentCheckout(BaseModel):
    """One row of ``GET /v1/me/checkouts/open`` (#1809) — never the client
    secret, and only the fields the app-wide open-checkout bar needs."""

    checkout_id: uuid.UUID
    tournament_id: uuid.UUID
    tournament_name: str
    expires_at: datetime
    payment_state: TournamentCheckoutPaymentState
    total_cents: int
