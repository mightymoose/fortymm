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


class TournamentCheckoutPaymentState(StrEnum):
    unavailable = "unavailable"
    preparing = "preparing"
    ready = "ready"
    checking = "checking"
    action_required = "action_required"
    succeeded = "succeeded"
    failed = "failed"
    expired = "expired"
    canceled = "canceled"


class TournamentPaymentLineOutcomeState(StrEnum):
    confirmed = "confirmed"
    refund_pending = "refund_pending"


class CheckoutAttentionKind(StrEnum):
    needs_review = "needs_review"
    checking = "checking"
    active = "active"


class CheckoutAttentionItem(BaseModel):
    checkout_id: uuid.UUID
    tournament_id: uuid.UUID
    tournament_name: str
    kind: CheckoutAttentionKind
    payment_state: TournamentCheckoutPaymentState
    expires_at: datetime
    remaining_seconds: int = Field(ge=0)
    support_reference: str | None
    href: str


class ActionableCheckoutsRead(BaseModel):
    items: list[CheckoutAttentionItem]


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
    tournament_name: str
    registration_generation: int
    status: TournamentCheckoutState
    payment_state: TournamentCheckoutPaymentState
    currency: str
    total_cents: int
    created_at: datetime
    expires_at: datetime
    remaining_seconds: int = Field(ge=0)
    lines: list[TournamentCheckoutLineRead]


class TournamentPaymentPrepare(BaseModel):
    model_config = ConfigDict(extra="forbid")

    receipt_email: BoundedEmailStr | None = None


class TournamentPaymentRead(BaseModel):
    checkout_id: uuid.UUID
    payment_state: TournamentCheckoutPaymentState
    client_secret: str | None
    receipt_email: str | None
    receipt_editable: bool
    support_reference: str | None = None
    lines: list["TournamentPaymentLineRead"] = []


class TournamentPaymentLineRead(BaseModel):
    event_id: uuid.UUID
    amount_cents: int
    outcome: TournamentPaymentLineOutcomeState | None
    refund_amount_cents: int


class TournamentCheckoutRefusal(BaseModel):
    code: str
    message: str
    event_id: uuid.UUID | None = None


class TournamentCheckoutRefusalResponse(BaseModel):
    """The FastAPI ``HTTPException`` envelope for a checkout conflict."""

    detail: TournamentCheckoutRefusal


class TournamentPaymentProblemRead(BaseModel):
    support_reference: str
    state: str
    checkout_id: uuid.UUID


class TournamentPaymentProblemList(BaseModel):
    items: list[TournamentPaymentProblemRead]
