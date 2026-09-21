"""Typed JSON boundary for itemized tournament payment receipts."""

import uuid
from typing import Literal, TypedDict

from pydantic import BaseModel, ConfigDict, TypeAdapter

ReceiptOutcomeKind = Literal["confirmed", "refund_pending"]


class TournamentReceiptOutcomeJson(TypedDict):
    event_id: str
    event_name: str
    outcome: ReceiptOutcomeKind


class TournamentReceiptOutcome(BaseModel):
    """One admission result after validating the persisted JSONB value."""

    model_config = ConfigDict(extra="forbid")

    event_id: uuid.UUID
    event_name: str
    outcome: ReceiptOutcomeKind

    def to_json(self) -> TournamentReceiptOutcomeJson:
        return {
            "event_id": str(self.event_id),
            "event_name": self.event_name,
            "outcome": self.outcome,
        }


_OUTCOMES = TypeAdapter(list[TournamentReceiptOutcome])


def parse_receipt_outcomes(value: object) -> list[TournamentReceiptOutcome]:
    """Parse untrusted JSONB before receipt rendering uses its fields."""
    return _OUTCOMES.validate_python(value)
