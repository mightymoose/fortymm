import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator, model_validator

from app.models.match import MatchStatus
from app.schemas.rating import RatingChange

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

    ``league_id`` is optional: when omitted the server binds the match to the
    default league (see ``app.leagues.get_default_league``).
    """

    opponent_user_id: uuid.UUID | None = None
    league_id: uuid.UUID | None = None
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


class MatchLeague(BaseModel):
    id: uuid.UUID
    name: str


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
    rating_change: RatingChange | None = None


class MatchDetailsScore(BaseModel):
    id: uuid.UUID
    side_1_points: int
    side_2_points: int
    winner_side_number: int


class MatchDetailsGame(BaseModel):
    id: uuid.UUID
    game_number: int
    score: MatchDetailsScore | None


class MatchDetailsCurrentGame(BaseModel):
    id: uuid.UUID
    game_number: int


class MatchDetailsFormResult(BaseModel):
    """One past completed match for the Players & form recent-results list.

    Counts are framed from the cited *player's* perspective, not from a
    side number in the past match."""

    match_id: uuid.UUID
    is_win: bool
    player_games_won: int
    opponent_games_won: int
    opponent_username: str | None
    completed_at: datetime


class MatchDetailsPlayerForm(BaseModel):
    """A player's previous-5 results, attached by ``user_id`` so the FE can
    map it onto whichever side carries that user.

    All `*_before` fields are anchored to this match's `created_at` — they
    describe the player's rating + record going into this match, not after."""

    user_id: uuid.UUID
    recent_results: list[MatchDetailsFormResult]
    # Rating in this match's league as of just before this match. Null when
    # the player has no prior rating in the league.
    rating_before: float | None = None
    # Chronological rating values (oldest first) preceding this match in this
    # match's league. Capped at ~10 — enough for a sparkline, small enough
    # to keep the BFF cheap.
    rating_history: list[float] = Field(default_factory=list)
    career_matches_before: int = 0
    career_wins_before: int = 0


class MatchDetailsH2HMeeting(BaseModel):
    """One past meeting between the two players in *this* match. Game counts
    are aligned to this match's side numbers so the FE doesn't need to
    re-map per row."""

    match_id: uuid.UUID
    completed_at: datetime
    side_1_games_won: int
    side_2_games_won: int
    winner_side_number: int | None


class MatchDetailsH2H(BaseModel):
    """Head-to-head between this match's two singles players. Wins are
    counted against this match's side numbers (not the side numbers of the
    historical matches)."""

    total_meetings: int
    side_1_wins: int
    side_2_wins: int
    recent_meetings: list[MatchDetailsH2HMeeting]


class MatchDetails(BaseModel):
    id: uuid.UUID
    status: MatchStatus
    status_label: str
    league: MatchLeague
    best_of: int
    games_to_win: int
    team_size: int
    affects_rating: bool
    created_at: datetime
    # Perspective-neutral so non-participants can read this payload; the FE
    # picks a viewing angle from each side's ``is_current_user_side``.
    sides: list[MatchDetailsSide]
    games: list[MatchDetailsGame]
    current_game: MatchDetailsCurrentGame | None
    can_score: bool
    recent_form: list[MatchDetailsPlayerForm] = Field(default_factory=list)
    head_to_head: MatchDetailsH2H | None = None


# ----- list (BFF for /matches) ---------------------------------------------


class MatchListRow(BaseModel):
    id: uuid.UUID
    status: MatchStatus
    status_label: str
    league: MatchLeague
    sides: list[MatchDetailsSide]
    best_of: int
    created_at: datetime
    current_game_id: uuid.UUID | None
    can_score: bool


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
    def _table_tennis_rules(self) -> "MatchGameScoreWrite":
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
