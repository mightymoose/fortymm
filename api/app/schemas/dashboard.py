import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.schemas.rating import RatingChange

# The actionable bucket a match falls in for the current user, in priority
# order: a rated result the opponent proposed that is awaiting our review
# (``review``) outranks a match we still need to score (``score``). Passive
# states — a result we proposed awaiting the opponent, or a pending/scheduled
# match — are never rows; they only feed ``waiting_count``.
AttentionKind = Literal["review", "score"]


class DashboardAttentionItem(BaseModel):
    """One actionable row in the dashboard's "Needs your attention" panel,
    classified server-side and current-user-aware (see ``dashboard.py``). Rows
    carry only routing data — opponent handle and the action — never scores."""

    match_id: uuid.UUID
    opponent_username: str | None
    kind: AttentionKind
    # ``score`` rows split rated-above-unrated by this flag (the FE derives the
    # primary-button priority from ``kind`` + ``affects_rating``). It is always
    # True for ``review`` (only arises on rated matches).
    affects_rating: bool
    # The next un-scored game for a ``score`` row, used to deep-link straight to
    # the scoring page. ``None`` when the board is already decided but unposted
    # (the FE routes to match detail to post the result instead), and always
    # ``None`` for ``review`` rows (which route to match detail).
    current_game_number: int | None
    # The absolute instant the standing result auto-finalizes if the opponent
    # never acts (``submitted_at`` + the settings' retirement window). ``None``
    # when there's no standing result or the window is unset — so it's populated
    # on ``review``/``dispute`` rows (a result is standing) and ``None`` on
    # ``score`` rows (nothing posted yet). The FE shows a countdown when present.
    retirement_deadline: datetime | None = None


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
    # What the player's last rated match DID to them — the "+12 last match" chip.
    #
    # ``None`` means THERE IS NO MOVE TO REPORT, and the client must render nothing
    # (no chip, no arrow, no tone) rather than a zero. Two ways to get there, and
    # neither is "unknown":
    #
    # * their last rated match was their FIRST — it ESTABLISHED this rating instead
    #   of moving it. They were Unrated going in, so there is no earlier number to
    #   measure from. Reporting the 1500 their league-join seeded them with as a
    #   ``before`` is what told a brand-new player they had just LOST 232 points of
    #   a rating they never held (#952).
    # * no rated match at all lies behind the current value (an admin ``manual``
    #   override or an ``import`` moved it).
    #
    # Sourced from ``latest_rated_match_change`` → ``RatingChange.delta``, a computed
    # field: the number cannot be stored next to a ``before`` that contradicts it.
    # Do not "simplify" this back to a ``float`` with a ``0.0`` default — a zero
    # claims a rated match moved the rating by nothing, which is a different (and
    # false) statement.
    delta: float | None
    peak: float
    percentile: int | None
    # The rating changes of the last 30 days, oldest-first — and NOT the ``initial``
    # seed row, which is the prior the league hands out on join, not a rating anyone
    # held. So a player one rated match old has a ONE-POINT spark (their result), not
    # a two-point line sloping out of 1500.
    spark_data: list[float]
    streak: DashboardStreak | None
    stats: list[DashboardRatingStat]


class DashboardResponse(BaseModel):
    # The current user's most-urgent actionable matches, pre-ranked by attention
    # priority (§5 of the PRD), capped server-side (``ATTENTION_BANNERS_LIMIT``)
    # since the panel only renders the top few as rows. Not the full set — use
    # ``attention_total_count`` for the true total and the footer overflow.
    attention: list[DashboardAttentionItem]
    # Total actionable matches for the current user (in_progress the user hasn't
    # accepted), counted independently of the ``attention`` cap so the footer's
    # "+N more need attention" stays accurate however many there are.
    attention_total_count: int
    # Count of matches that need *someone else's* move (a result we proposed
    # awaiting the opponent's acceptance, plus pending/scheduled matches). Shown
    # as footer text only — never a row.
    waiting_count: int
    recent_results: list[DashboardRecentResult]
    rating: DashboardRating | None = None
    # Total completed matches the current user participated in. The guest
    # persistence banner uses this to reference history concretely ("Your N
    # matches…") and to stay hidden until the user has any history at all.
    completed_match_count: int
