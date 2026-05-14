import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.match import MatchStatus
from app.models.match_settings import VerificationPolicy

# Match lengths the client offers. All odd so one side can always reach a
# strict majority of games; the DB additionally enforces "odd and >= 1".
ALLOWED_BEST_OF = (1, 3, 5, 7)


class MatchCreate(BaseModel):
    """Request body for ``POST /v1/matches``.

    ``opponent_user_id`` is optional: a match created without a registered
    opponent (a guest, or "start without opponent") gets a single side and is
    always unrated, since the rating system needs two registered sides.
    """

    opponent_user_id: uuid.UUID | None = None
    best_of: int = Field(description="Total games to play; one of 1, 3, 5, 7.")
    rated: bool = True

    @field_validator("best_of")
    @classmethod
    def _best_of_allowed(cls, value: int) -> int:
        if value not in ALLOWED_BEST_OF:
            allowed = ", ".join(str(n) for n in ALLOWED_BEST_OF)
            raise ValueError(f"best_of must be one of {allowed}")
        return value


class MatchSidePlayerRead(BaseModel):
    user_id: uuid.UUID
    username: str


class MatchSideRead(BaseModel):
    side_number: int
    score: int
    won: bool | None
    players: list[MatchSidePlayerRead]


class MatchSettingsRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    team_size: int
    best_of: int
    affects_rating: bool
    verification_policy: VerificationPolicy


class MatchRead(BaseModel):
    id: uuid.UUID
    status: MatchStatus
    created_by_user_id: uuid.UUID
    created_at: datetime
    settings: MatchSettingsRead
    sides: list[MatchSideRead]
