import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator, model_validator

from app.models.match import MatchStatus

# Match lengths the client offers. All odd so one side can always reach a
# strict majority of games; the DB additionally enforces "odd and >= 1".
ALLOWED_BEST_OF = (1, 3, 5, 7)

# Maps the internal status enum to the label the BFF sends to clients.
STATUS_LABELS: dict[MatchStatus, str] = {
    MatchStatus.pending: "Scheduled",
    MatchStatus.in_progress: "Live",
    MatchStatus.completed: "Final",
    MatchStatus.disputed: "Disputed",
    MatchStatus.voided: "Voided",
}


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


# ----- details (BFF for /matches/$id and the scoring routes) ---------------


class MatchDetailsPlayer(BaseModel):
    user_id: uuid.UUID
    username: str
    is_current_user: bool


class MatchDetailsSide(BaseModel):
    side_number: int
    players: list[MatchDetailsPlayer]
    games_won: int
    won: bool | None
    is_current_user_side: bool


class MatchDetailsScore(BaseModel):
    id: uuid.UUID
    my_points: int
    opponent_points: int
    is_my_win: bool


class MatchDetailsGame(BaseModel):
    id: uuid.UUID
    game_number: int
    score: MatchDetailsScore | None


class MatchDetailsCurrentGame(BaseModel):
    id: uuid.UUID
    game_number: int


class MatchDetails(BaseModel):
    id: uuid.UUID
    status: MatchStatus
    status_label: str
    best_of: int
    games_to_win: int
    team_size: int
    affects_rating: bool
    created_at: datetime
    my_side: MatchDetailsSide
    opponent_side: MatchDetailsSide | None
    games: list[MatchDetailsGame]
    current_game: MatchDetailsCurrentGame | None
    can_score: bool


# ----- list (BFF for /matches) ---------------------------------------------


class MatchListRow(BaseModel):
    id: uuid.UUID
    status: MatchStatus
    status_label: str
    opponent_username: str | None
    opponent_user_id: uuid.UUID | None
    my_games_won: int
    opponent_games_won: int
    is_win: bool | None
    best_of: int
    created_at: datetime
    current_game_id: uuid.UUID | None


class MatchListResponse(BaseModel):
    items: list[MatchListRow]
    page: int
    page_size: int
    total: int
    status_counts: dict[MatchStatus, int]


# ----- score write (POST/PUT body) -----------------------------------------


class MatchGameScoreWrite(BaseModel):
    side_1_points: int = Field(ge=0, le=99)
    side_2_points: int = Field(ge=0, le=99)

    @model_validator(mode="after")
    def _table_tennis_rules(self):
        a, b = self.side_1_points, self.side_2_points
        if a == b:
            raise ValueError("A game cannot end in a tie.")
        winner, loser = max(a, b), min(a, b)
        if winner < 11:
            raise ValueError("The winning side must reach at least 11 points.")
        if winner == 11 and loser > 9:
            raise ValueError(
                f"At 10–10 the game enters deuce; the winner must lead by 2. "
                f"{winner}–{loser} is not a legal final score."
            )
        if winner > 11:
            if loser < 10:
                raise ValueError(
                    f"A game can only go past 11 points after both sides reach 10. "
                    f"{winner}–{loser} is not a legal final score."
                )
            if winner - loser != 2:
                raise ValueError(
                    f"In a deuce game the winner leads by exactly 2 points. "
                    f"{winner}–{loser} is not a legal final score."
                )
        return self
