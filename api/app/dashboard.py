import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db import get_session
from app.matches import _side_win_counts
from app.models import (
    Match,
    MatchGame,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    User,
)
from app.schemas.dashboard import (
    DashboardNextMatch,
    DashboardRecentResult,
    DashboardResponse,
    DashboardScoreBanner,
)
from app.sessions import get_current_user

router = APIRouter(prefix="/v1")

RECENT_RESULTS_LIMIT = 5


def _opponent_username(
    match: Match, current_user_id: uuid.UUID
) -> str | None:
    for side in match.sides:
        for player in side.players:
            if player.user_id != current_user_id:
                return player.user.username
    return None


def _my_side_number(match: Match, current_user_id: uuid.UUID) -> int | None:
    for side in match.sides:
        if any(p.user_id == current_user_id for p in side.players):
            return side.side_number
    return None


async def _matches_for_user(
    db: AsyncSession,
    current_user_id: uuid.UUID,
    *,
    status_: MatchStatus,
    limit: int,
):
    me_in_match = (
        select(MatchSidePlayer.id)
        .where(
            MatchSidePlayer.match_id == Match.id,
            MatchSidePlayer.user_id == current_user_id,
        )
        .exists()
    )
    result = await db.execute(
        select(Match)
        .where(me_in_match, Match.status == status_)
        .options(
            selectinload(Match.match_settings),
            selectinload(Match.sides)
            .selectinload(MatchSide.players)
            .selectinload(MatchSidePlayer.user),
            selectinload(Match.games).selectinload(MatchGame.score),
        )
        .order_by(
            Match.updated_at.desc()
            if status_ == MatchStatus.completed
            else Match.created_at.desc()
        )
        .limit(limit)
    )
    return list(result.scalars().all())


@router.get("/dashboard", response_model=DashboardResponse)
async def get_dashboard(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> DashboardResponse:
    in_progress = await _matches_for_user(
        db, current_user.id, status_=MatchStatus.in_progress, limit=1
    )
    pending = await _matches_for_user(
        db, current_user.id, status_=MatchStatus.pending, limit=1
    )
    completed = await _matches_for_user(
        db,
        current_user.id,
        status_=MatchStatus.completed,
        limit=RECENT_RESULTS_LIMIT,
    )

    score_banner: DashboardScoreBanner | None = None
    if in_progress:
        match = in_progress[0]
        current_game = next(
            (g for g in match.games if g.score is None), None
        )
        if current_game is not None:
            score_banner = DashboardScoreBanner(
                match_id=match.id,
                opponent_username=_opponent_username(match, current_user.id),
                current_game_id=current_game.id,
            )

    next_match: DashboardNextMatch | None = None
    if pending:
        match = pending[0]
        next_match = DashboardNextMatch(
            match_id=match.id,
            opponent_username=_opponent_username(match, current_user.id),
            best_of=match.match_settings.best_of,
            created_at=match.created_at,
        )

    recent_results: list[DashboardRecentResult] = []
    for match in completed:
        my_number = _my_side_number(match, current_user.id)
        side_wins = _side_win_counts(match)
        my_games_won = side_wins.get(my_number or 0, 0)
        opp_games_won = sum(
            wins
            for number, wins in side_wins.items()
            if number != my_number
        )
        # is_win is well-defined: completed matches always have two sides.
        is_win = my_games_won > opp_games_won
        recent_results.append(
            DashboardRecentResult(
                match_id=match.id,
                opponent_username=_opponent_username(match, current_user.id),
                is_win=is_win,
                my_games_won=my_games_won,
                opponent_games_won=opp_games_won,
                completed_at=match.updated_at,
            )
        )

    return DashboardResponse(
        score_banner=score_banner,
        next_match=next_match,
        recent_results=recent_results,
    )


