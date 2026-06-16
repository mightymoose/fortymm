import uuid
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.attention import attention_priority, list_attention_kind
from app.db import get_session
from app.matches import (
    current_game_number,
    match_eager_options,
    opponent_username,
    participant_filter,
    side_win_counts,
)
from app.matches import (
    my_side as resolve_my_side,
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
    AttentionKind,
    DashboardAttentionItem,
    DashboardRating,
    DashboardRatingStat,
    DashboardRecentResult,
    DashboardResponse,
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
    # Open matches the user participates in are pulled in full (signatures + sides
    # are needed to classify each into an attention bucket); completed matches
    # feed the recent-results table. The attention panel is bounded by the user's
    # *open* matches — a handful even for an active player — so loading them all
    # and ranking in Python is safe.
    in_progress_q = (
        participant_filter(select(Match), current_user.id)
        .where(Match.status == MatchStatus.in_progress)
        .options(*match_eager_options())
        .order_by(Match.updated_at.asc())
    )
    disputed_q = (
        participant_filter(select(Match), current_user.id)
        .where(Match.status == MatchStatus.disputed)
        .options(*match_eager_options())
        .order_by(Match.updated_at.asc())
    )
    completed_q = (
        participant_filter(select(Match), current_user.id)
        .where(Match.status == MatchStatus.completed)
        .options(*match_eager_options())
        .order_by(Match.updated_at.desc())
        .limit(RECENT_RESULTS_LIMIT)
    )
    # Pending/scheduled matches are always "waiting on others" (O3 default), so
    # we only need their count, not their rows.
    pending_count_q = participant_filter(
        select(func.count(Match.id)), current_user.id
    ).where(Match.status == MatchStatus.pending)

    in_progress = (await db.execute(in_progress_q)).scalars().all()
    disputed = (await db.execute(disputed_q)).scalars().all()
    completed = (await db.execute(completed_q)).scalars().all()
    pending_count = int((await db.execute(pending_count_q)).scalar_one())

    # When completed_q didn't hit its LIMIT, we already have the exact count
    # and can skip the extra round-trip; only the user-with-history case pays
    # for a separate COUNT.
    if len(completed) < RECENT_RESULTS_LIMIT:
        completed_match_count = len(completed)
    else:
        completed_count_q = participant_filter(
            select(func.count(Match.id)), current_user.id
        ).where(Match.status == MatchStatus.completed)
        completed_match_count = int((await db.execute(completed_count_q)).scalar_one())

    rating_changes = await _load_my_rating_changes(
        db, current_user.id, [m.id for m in completed]
    )

    attention, waiting_count = _build_attention(
        in_progress, disputed, pending_count, current_user.id
    )
    recent_results = [
        _build_recent_result(match, current_user.id, rating_changes.get(match.id))
        for match in completed
    ]
    rating = await _build_rating(db, current_user.id, completed_match_count)

    return DashboardResponse(
        attention=attention,
        waiting_count=waiting_count,
        recent_results=recent_results,
        rating=rating,
        completed_match_count=completed_match_count,
    )


async def _load_my_rating_changes(
    db: AsyncSession,
    user_id: uuid.UUID,
    match_ids: Sequence[uuid.UUID],
) -> dict[uuid.UUID, RatingChange]:
    if not match_ids:
        return {}
    rows = (
        (
            await db.execute(
                select(RatingHistory).where(
                    RatingHistory.match_id.in_(match_ids),
                    RatingHistory.user_id == user_id,
                )
            )
        )
        .scalars()
        .all()
    )
    changes: dict[uuid.UUID, RatingChange] = {}
    for row in rows:
        assert row.match_id is not None  # IN-filtered to non-null match_ids
        changes[row.match_id] = RatingChange.from_history(row)
    return changes


def _build_attention(
    in_progress: Sequence[Match],
    disputed: Sequence[Match],
    pending_count: int,
    current_user_id: uuid.UUID,
) -> tuple[list[DashboardAttentionItem], int]:
    """Classify the user's open matches into priority-ranked attention rows plus
    a count of matches waiting on someone else.

    Current-user-aware: the poster and the reviewer of the same posted result
    classify differently — the poster has signed, so the match is "waiting on
    opponent" (footer) for them, while the reviewer hasn't signed and gets a
    ``review`` row. Pending/scheduled matches (``pending_count``) and our own
    posted-and-awaiting results are folded into ``waiting_count``; they never
    render as rows. Classification + ranking come from the shared
    ``app.attention`` module so this panel and the matches-list Attention filter
    never disagree about who owes a move.
    """
    # (priority, sort_ts, item) — sorted by priority then oldest-first so a
    # long-stalled match floats to the top of its bucket.
    ranked: list[tuple[int, datetime, DashboardAttentionItem]] = []
    waiting = pending_count

    for match in (*disputed, *in_progress):
        kind = list_attention_kind(match, current_user_id)
        # Passive "waiting" buckets are footer-only here; ``waiting_others``
        # (pending) never reaches this loop — those matches are counted, not
        # loaded — so only ``waiting_opponent`` (our posted-and-awaiting result)
        # folds in.
        if kind == "waiting_opponent" or kind == "waiting_others":
            waiting += 1
            continue
        if kind is None:
            continue
        # kind is now narrowed to AttentionKind (dispute / review / score).
        ranked.append(
            (
                attention_priority(kind, match.match_settings.affects_rating),
                match.updated_at,
                _attention_item(match, current_user_id, kind),
            )
        )

    ranked.sort(key=lambda row: (row[0], row[1]))
    return [item for _, _, item in ranked], waiting


def _attention_item(
    match: Match, current_user_id: uuid.UUID, kind: AttentionKind
) -> DashboardAttentionItem:
    return DashboardAttentionItem(
        match_id=match.id,
        opponent_username=opponent_username(match, current_user_id),
        kind=kind,
        affects_rating=match.match_settings.affects_rating,
        # Only ``score`` rows deep-link to the scoring page; review/dispute rows
        # route to match detail and carry no game number.
        current_game_number=current_game_number(match) if kind == "score" else None,
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
        wins for number, wins in side_wins.items() if number != mine.side_number
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
    db: AsyncSession, user_id: uuid.UUID, completed_match_count: int
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

    current = rating_row.rating_value
    league_id = rating_row.league_id
    spark, delta = await _spark_and_delta(db, user_id, league_id)
    peak = await _league_peak_rating(db, user_id, league_id, current)
    # A user who has never completed a match sits at the seed rating (1500, RD
    # 350) — fully unrated. Ranking them against league peers reads as a
    # concrete claim ("Top 92%") about a player the system can't place yet, so
    # suppress the percentile until they've actually played. (#382)
    percentile = (
        None
        if completed_match_count == 0
        else await _league_percentile(db, league_id, current)
    )
    streak = await _current_streak(db, user_id)

    return DashboardRating(
        league_id=league_id,
        league_name=rating_row.league.name,
        strategy_key=strategy.key,
        current=current,
        delta=delta,
        peak=peak,
        percentile=percentile,
        spark_data=spark,
        streak=streak,
        stats=_strategy_stats(strategy.key, rating_row.rating_state or {}),
    )


async def _resolve_user_rating(
    db: AsyncSession, user_id: uuid.UUID
) -> UserLeagueRating | None:
    # Default league first; if the user has no row there, fall back to the
    # oldest rating row so we still light up something. Eager-load the league
    # and strategy so the caller can read is_automatic without an extra round
    # trip.
    options = (
        selectinload(UserLeagueRating.league).selectinload(League.rating_strategy),
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
    return round(int(at_or_below) / int(total) * 100)


async def _spark_and_delta(
    db: AsyncSession, user_id: uuid.UUID, league_id: uuid.UUID
) -> tuple[list[float], float]:
    """Pull the most-recent history rows once, then derive both the sparkline
    (last 30 days, oldest-first) and the last-match delta from them. Ordering
    DESC + reversing avoids the latent bug where ``LIMIT 30 ORDER BY ASC``
    would silently truncate today's points on a power user with >30 events in
    the window."""
    cutoff = datetime.now(UTC) - timedelta(days=SPARK_WINDOW_DAYS)
    rows = (
        await db.execute(
            select(
                RatingHistory.rating_value,
                RatingHistory.previous_rating_value,
                RatingHistory.created_at,
            )
            .where(
                RatingHistory.user_id == user_id,
                RatingHistory.league_id == league_id,
            )
            .order_by(RatingHistory.created_at.desc())
            .limit(SPARK_MAX_POINTS)
        )
    ).all()
    if not rows:
        return [], 0.0
    latest = rows[0]
    delta = (
        latest.rating_value - latest.previous_rating_value
        if latest.previous_rating_value is not None
        else 0.0
    )
    spark = [float(r.rating_value) for r in reversed(rows) if r.created_at >= cutoff]
    return spark, delta


async def _current_streak(
    db: AsyncSession, user_id: uuid.UUID
) -> DashboardStreak | None:
    """Walk the user's completed matches newest-first, counting consecutive
    wins or losses from the top. Returns None if the user has no completed
    matches."""
    rows = (
        (
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
        )
        .scalars()
        .all()
    )
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


def _strategy_stats(
    strategy_key: str, state: dict[str, object]
) -> list[DashboardRatingStat]:
    """Strategy-specific tiles for the rating card's stats grid.

    Keeps the API contract generic — the frontend renders whatever labels
    come back without needing to know which fields a given strategy carries.
    """
    if strategy_key == "glicko2":
        rd = _as_float(state.get("rd"))
        volatility = _as_float(state.get("volatility"))
        return [
            DashboardRatingStat(
                label="RD",
                value=str(round(rd)) if rd is not None else "—",
            ),
            DashboardRatingStat(
                label="Volatility",
                value=f"{volatility:.3f}" if volatility is not None else "—",
            ),
        ]
    return []


def _as_float(value: object) -> float | None:
    # Excludes bool (which is an int subclass) — Glicko-2 state never carries
    # booleans, but coercing True → 1.0 silently would be a bad surprise.
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None
