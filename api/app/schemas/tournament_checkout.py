import uuid
from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TournamentCheckoutState(StrEnum):
    active = "active"
    cancelled = "cancelled"
    expired = "expired"
    invalidated = "invalidated"


class TournamentCheckoutPaymentState(StrEnum):
    unavailable = "unavailable"


class TournamentCheckoutCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: uuid.UUID
    event_ids: list[uuid.UUID] = Field(min_length=1)

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
