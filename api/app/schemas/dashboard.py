import uuid
from datetime import datetime

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


class DashboardResponse(BaseModel):
    score_banner: DashboardScoreBanner | None
    next_match: DashboardNextMatch | None
    recent_results: list[DashboardRecentResult]
