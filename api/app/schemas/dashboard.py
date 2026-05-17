import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.schemas.rating import RatingChange


class DashboardScoreBanner(BaseModel):
    match_id: uuid.UUID
    opponent_username: str | None
    current_game_id: uuid.UUID


class DashboardNextMatch(BaseModel):
    match_id: uuid.UUID
    opponent_username: str | None
    best_of: int
    created_at: datetime


class DashboardRecentResult(BaseModel):
    match_id: uuid.UUID
    opponent_username: str | None
    is_win: bool
    my_games_won: int
    opponent_games_won: int
    completed_at: datetime
    my_rating_change: RatingChange | None = None


class DashboardStreak(BaseModel):
    kind: Literal["W", "L"]
    n: int


class DashboardRatingStat(BaseModel):
    """Strategy-specific tile in the rating card's stats grid.

    Pre-formatted server-side so the frontend doesn't need to know which
    fields a strategy emits (Glicko-2's ``rd``/``volatility`` vs whatever a
    future Elo/TrueSkill row carries)."""

    label: str
    value: str


class DashboardRating(BaseModel):
    """Per-league rating snapshot for the dashboard RatingCard.

    Emitted only when the user has a rated row in an automatic-strategy league
    (Glicko-2 today). Manual leagues and unrated users get ``rating: None``.
    """

    league_id: uuid.UUID
    league_name: str
    strategy_key: str
    current: float
    delta: float
    peak: float
    percentile: int | None
    spark_data: list[float]
    streak: DashboardStreak | None
    stats: list[DashboardRatingStat]


class DashboardResponse(BaseModel):
    score_banners: list[DashboardScoreBanner]
    next_match: DashboardNextMatch | None
    recent_results: list[DashboardRecentResult]
    rating: DashboardRating | None = None
