from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.matches import (
    participant_filter,
    current_unscored_game,
    match_eager_options,
    my_side as resolve_my_side,
    opponent_username,
    side_win_counts,
)
from app.models import Match, MatchStatus, User
from app.schemas.dashboard import (
    DashboardNextMatch,
    DashboardRecentResult,
    DashboardResponse,
    DashboardScoreBanner,
)
from app.sessions import get_current_user

router = APIRouter(prefix="/v1")

RECENT_RESULTS_LIMIT = 5


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

    score_banner = _build_score_banner(in_progress, current_user.id)
    next_match = _build_next_match(pending, current_user.id)
    recent_results = [
        _build_recent_result(match, current_user.id) for match in completed
    ]

    return DashboardResponse(
        score_banner=score_banner,
        next_match=next_match,
        recent_results=recent_results,
    )


def _build_score_banner(
    in_progress: list[Match], current_user_id
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
    pending: list[Match], current_user_id
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


def _build_recent_result(match: Match, current_user_id) -> DashboardRecentResult:
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
    )
