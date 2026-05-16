import uuid
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db import get_session
from app.matches import (
    participant_filter,
    current_unscored_game,
    match_eager_options,
    my_side as resolve_my_side,
    opponent_username,
    side_win_counts,
)
from app.models import (
    League,
    Match,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    RatingHistory,
    User,
    UserLeagueRating,
)
from app.schemas.dashboard import (
    DashboardNextMatch,
    DashboardRating,
    DashboardRecentResult,
    DashboardResponse,
    DashboardScoreBanner,
    DashboardStreak,
)
from app.schemas.rating import RatingChange
from app.sessions import get_current_user

router = APIRouter(prefix="/v1")

RECENT_RESULTS_LIMIT = 5
SPARK_WINDOW_DAYS = 30
SPARK_MAX_POINTS = 30
STREAK_SCAN_LIMIT = 100


@router.get("/dashboard", response_model=DashboardResponse)
async def get_dashboard(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> DashboardResponse:
    # One query pulls every match the user participates in across the three
    # statuses we surface; per-status bucketing happens in Python below. The
    # dashboard always shows at most 1 + 1 + 5 = 7 matches, so the bound is
    # safe even for an active user with thousands of completed matches.
    pending_q = (
        participant_filter(select(Match), current_user.id)
        .where(Match.status == MatchStatus.pending)
        .options(*match_eager_options())
        .order_by(Match.created_at.desc())
        .limit(1)
    )
    in_progress_q = (
        participant_filter(select(Match), current_user.id)
        .where(Match.status == MatchStatus.in_progress)
        .options(*match_eager_options())
        .order_by(Match.created_at.desc())
        .limit(1)
    )
    completed_q = (
        participant_filter(select(Match), current_user.id)
        .where(Match.status == MatchStatus.completed)
        .options(*match_eager_options())
        .order_by(Match.updated_at.desc())
        .limit(RECENT_RESULTS_LIMIT)
    )

    pending = (await db.execute(pending_q)).scalars().all()
    in_progress = (await db.execute(in_progress_q)).scalars().all()
    completed = (await db.execute(completed_q)).scalars().all()

    rating_changes = await _load_my_rating_changes(
        db, current_user.id, [m.id for m in completed]
    )

    score_banner = _build_score_banner(in_progress, current_user.id)
    next_match = _build_next_match(pending, current_user.id)
    recent_results = [
        _build_recent_result(match, current_user.id, rating_changes.get(match.id))
        for match in completed
    ]
    rating = await _build_rating(db, current_user.id)

    return DashboardResponse(
        score_banner=score_banner,
        next_match=next_match,
        recent_results=recent_results,
        rating=rating,
    )


async def _load_my_rating_changes(
    db: AsyncSession,
    user_id: uuid.UUID,
    match_ids: Sequence[uuid.UUID],
) -> dict[uuid.UUID, RatingChange]:
    if not match_ids:
        return {}
    rows = (
        await db.execute(
            select(RatingHistory).where(
                RatingHistory.match_id.in_(match_ids),
                RatingHistory.user_id == user_id,
            )
        )
    ).scalars().all()
    return {row.match_id: RatingChange.from_history(row) for row in rows}


def _build_score_banner(
    in_progress: list[Match], current_user_id: uuid.UUID
) -> DashboardScoreBanner | None:
    if not in_progress:
        return None
    match = in_progress[0]
    current_game = current_unscored_game(match)
    if current_game is None:
        return None
    return DashboardScoreBanner(
        match_id=match.id,
        opponent_username=opponent_username(match, current_user_id),
        current_game_id=current_game.id,
    )


def _build_next_match(
    pending: list[Match], current_user_id: uuid.UUID
) -> DashboardNextMatch | None:
    if not pending:
        return None
    match = pending[0]
    return DashboardNextMatch(
        match_id=match.id,
        opponent_username=opponent_username(match, current_user_id),
        best_of=match.match_settings.best_of,
        created_at=match.created_at,
    )


def _build_recent_result(
    match: Match,
    current_user_id: uuid.UUID,
    my_rating_change: RatingChange | None,
) -> DashboardRecentResult:
    mine = resolve_my_side(match, current_user_id)
    assert mine is not None  # query filters to participants
    side_wins = side_win_counts(match)
    my_games_won = side_wins.get(mine.side_number, 0)
    opp_games_won = sum(
        wins
        for number, wins in side_wins.items()
        if number != mine.side_number
    )
    return DashboardRecentResult(
        match_id=match.id,
        opponent_username=opponent_username(match, current_user_id),
        is_win=my_games_won > opp_games_won,
        my_games_won=my_games_won,
        opponent_games_won=opp_games_won,
        completed_at=match.updated_at,
        my_rating_change=my_rating_change,
    )


async def _build_rating(
    db: AsyncSession, user_id: uuid.UUID
) -> DashboardRating | None:
    """Resolve the user's headline rating row.

    Picks the default league's rating if there is one, otherwise the oldest
    rated row. Manual-strategy leagues and unrated rows (rating_value=None)
    return None — the widget stays hidden until the league is actually scoring
    you.
    """
    rating_row = await _resolve_user_rating(db, user_id)
    if rating_row is None or rating_row.rating_value is None:
        return None
    strategy = rating_row.league.rating_strategy
    if not strategy.is_automatic:
        return None

    state = rating_row.rating_state or {}
    rd = _coerce_float(state.get("rd"))
    volatility = _coerce_float(state.get("volatility"))

    current = rating_row.rating_value
    league_id = rating_row.league_id
    peak = await _league_peak_rating(db, user_id, league_id, current)
    percentile = await _league_percentile(db, league_id, current)
    spark = await _spark_data(db, user_id, league_id)
    delta = await _last_delta(db, user_id, league_id)
    streak = await _current_streak(db, user_id)

    return DashboardRating(
        league_id=rating_row.league_id,
        league_name=rating_row.league.name,
        strategy_key=strategy.key,
        current=current,
        delta=delta,
        rd=rd,
        volatility=volatility,
        peak=peak,
        percentile=percentile,
        spark_data=spark,
        streak=streak,
    )


async def _resolve_user_rating(
    db: AsyncSession, user_id: uuid.UUID
) -> UserLeagueRating | None:
    # Default league first; if the user has no row there, fall back to the
    # oldest rating row so we still light up something. Eager-load the league
    # and strategy so the caller can read is_automatic without an extra round
    # trip.
    options = (
        selectinload(UserLeagueRating.league).selectinload(
            League.rating_strategy
        ),
    )
    default = (
        await db.execute(
            select(UserLeagueRating)
            .join(League, League.id == UserLeagueRating.league_id)
            .where(
                UserLeagueRating.user_id == user_id,
                League.is_default.is_(True),
            )
            .options(*options)
            .limit(1)
        )
    ).scalar_one_or_none()
    if default is not None:
        return default
    return (
        await db.execute(
            select(UserLeagueRating)
            .where(UserLeagueRating.user_id == user_id)
            .options(*options)
            .order_by(UserLeagueRating.created_at.asc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def _league_peak_rating(
    db: AsyncSession,
    user_id: uuid.UUID,
    league_id: uuid.UUID,
    current: float,
) -> float:
    history_peak = (
        await db.execute(
            select(func.max(RatingHistory.rating_value)).where(
                RatingHistory.league_id == league_id,
                RatingHistory.user_id == user_id,
            )
        )
    ).scalar()
    if history_peak is None:
        return current
    return max(current, history_peak)


async def _league_percentile(
    db: AsyncSession, league_id: uuid.UUID, my_rating: float
) -> int | None:
    """Percentile rank within the league: the share of rated members the user
    is at or above. Returns None for leagues of one — nothing to compare to."""
    total, at_or_below = (
        await db.execute(
            select(
                func.count(UserLeagueRating.id),
                func.count(UserLeagueRating.id).filter(
                    UserLeagueRating.rating_value <= my_rating
                ),
            ).where(
                UserLeagueRating.league_id == league_id,
                UserLeagueRating.rating_value.is_not(None),
            )
        )
    ).one()
    if total <= 1:
        return None
    return round(at_or_below / total * 100)


async def _spark_data(
    db: AsyncSession, user_id: uuid.UUID, league_id: uuid.UUID
) -> list[float]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=SPARK_WINDOW_DAYS)
    rows = (
        await db.execute(
            select(RatingHistory.rating_value)
            .where(
                RatingHistory.user_id == user_id,
                RatingHistory.league_id == league_id,
                RatingHistory.created_at >= cutoff,
            )
            .order_by(RatingHistory.created_at.asc())
            .limit(SPARK_MAX_POINTS)
        )
    ).scalars().all()
    return [float(v) for v in rows]


async def _last_delta(
    db: AsyncSession, user_id: uuid.UUID, league_id: uuid.UUID
) -> float:
    latest = (
        await db.execute(
            select(RatingHistory)
            .where(
                RatingHistory.user_id == user_id,
                RatingHistory.league_id == league_id,
            )
            .order_by(RatingHistory.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if latest is None:
        return 0.0
    return RatingChange.from_history(latest).delta


async def _current_streak(
    db: AsyncSession, user_id: uuid.UUID
) -> DashboardStreak | None:
    """Walk the user's completed matches newest-first, counting consecutive
    wins or losses from the top. Returns None if the user has no completed
    matches."""
    rows = (
        await db.execute(
            select(MatchSide.won)
            .join(Match, Match.id == MatchSide.match_id)
            .join(
                MatchSidePlayer,
                MatchSidePlayer.match_side_id == MatchSide.id,
            )
            .where(
                MatchSidePlayer.user_id == user_id,
                Match.status == MatchStatus.completed,
                MatchSide.won.is_not(None),
            )
            .order_by(Match.updated_at.desc())
            .limit(STREAK_SCAN_LIMIT)
        )
    ).scalars().all()
    if not rows:
        return None
    head_kind: Literal["W", "L"] = "W" if rows[0] else "L"
    n = 1
    for won in rows[1:]:
        kind: Literal["W", "L"] = "W" if won else "L"
        if kind != head_kind:
            break
        n += 1
    return DashboardStreak(kind=head_kind, n=n)


def _coerce_float(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None
