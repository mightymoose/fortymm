import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.schemas.rating import RatingChange

# The actionable bucket a match falls in for the current user, in priority
# order: a disputed match reopened for correction (``dispute``) outranks a
# rated result the opponent posted and is awaiting our review (``review``),
# which outranks a match we still need to score (``score``). Passive states —
# a result we posted awaiting the opponent, or a pending/scheduled match — are
# never rows; they only feed ``waiting_count``.
AttentionKind = Literal["dispute", "review", "score"]


class DashboardAttentionItem(BaseModel):
    """One actionable row in the dashboard's "Needs your attention" panel,
    classified server-side and current-user-aware (see ``dashboard.py``). Rows
    carry only routing data — opponent handle and the action — never scores."""

    match_id: uuid.UUID
    opponent_username: str | None
    kind: AttentionKind
    # ``score`` rows split rated-above-unrated by this flag (the FE derives the
    # primary-button priority from ``kind`` + ``affects_rating``). It is always
    # True for ``review``/``dispute`` (both only arise on rated matches).
    affects_rating: bool
    # The next un-scored game for a ``score`` row, used to deep-link straight to
    # the scoring page. ``None`` when the board is already decided but unposted
    # (the FE routes to match detail to post the result instead), and always
    # ``None`` for ``review``/``dispute`` rows (which route to match detail).
    current_game_number: int | None


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
    # Every actionable match for the current user, pre-ranked by attention
    # priority (§5 of the PRD). The FE renders the top 3 as rows and rolls the
    # remainder into the footer's overflow count.
    attention: list[DashboardAttentionItem]
    # Count of matches that need *someone else's* move (a result we posted
    # awaiting the opponent's sign-off, plus pending/scheduled matches). Shown
    # as footer text only — never a row.
    waiting_count: int
    recent_results: list[DashboardRecentResult]
    rating: DashboardRating | None = None
    # Total completed matches the current user participated in. The guest
    # persistence banner uses this to reference history concretely ("Your N
    # matches…") and to stay hidden until the user has any history at all.
    completed_match_count: int
