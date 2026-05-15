from collections.abc import Iterable

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Match, MatchSidePlayer, User
from app.schemas.player import PlayerRead
from app.sessions import get_current_user

router = APIRouter(prefix="/v1")

# Sizes for the two opponent-picker endpoints. The recent grid shows six
# chips; the typeahead caps its dropdown well below the full roster.
RECENT_DEFAULT_LIMIT = 6
SEARCH_DEFAULT_LIMIT = 10
MAX_LIMIT = 50


def _serialize(users: Iterable[User]) -> list[PlayerRead]:
    return [PlayerRead.model_validate(user) for user in users]


def _escape_like(term: str) -> str:
    """Escape LIKE wildcards so a query of ``%`` matches a literal percent
    sign rather than every username."""
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@router.get("/players/recent", response_model=list[PlayerRead])
async def list_recent_opponents(
    limit: int = Query(RECENT_DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[PlayerRead]:
    """Opponents to feature in the new-match picker.

    Ranked by how recently the caller last played them (most recent first).
    A player with little or no match history is backfilled with other
    registered users, alphabetically, so the list is never short or empty.
    """
    my_match_ids = select(MatchSidePlayer.match_id).where(
        MatchSidePlayer.user_id == current_user.id
    )
    recent_rows = (
        await db.execute(
            select(MatchSidePlayer.user_id)
            .join(Match, Match.id == MatchSidePlayer.match_id)
            .where(
                MatchSidePlayer.match_id.in_(my_match_ids),
                MatchSidePlayer.user_id != current_user.id,
            )
            .group_by(MatchSidePlayer.user_id)
            .order_by(func.max(Match.created_at).desc())
            .limit(limit)
        )
    ).all()
    recent_ids = [row.user_id for row in recent_rows]

    users_by_id = {
        user.id: user
        for user in (
            await db.execute(select(User).where(User.id.in_(recent_ids)))
        ).scalars()
    }
    opponents = [users_by_id[user_id] for user_id in recent_ids]

    if len(opponents) < limit:
        backfill = (
            (
                await db.execute(
                    select(User)
                    .where(
                        User.id != current_user.id,
                        User.id.notin_(recent_ids),
                    )
                    .order_by(User.username)
                    .limit(limit - len(opponents))
                )
            )
            .scalars()
            .all()
        )
        opponents.extend(backfill)

    return _serialize(opponents)


@router.get("/players/search", response_model=list[PlayerRead])
async def search_players(
    q: str = Query(..., description="Username substring to match against."),
    limit: int = Query(SEARCH_DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> list[PlayerRead]:
    """Username substring search backing the opponent typeahead.

    Case-insensitive, excludes the caller, and caps the result count so the
    client never has to fetch and filter the whole roster. An empty query
    matches nothing.
    """
    term = q.strip()
    if not term:
        return []

    pattern = f"%{_escape_like(term)}%"
    result = await db.execute(
        select(User)
        .where(
            User.id != current_user.id,
            User.username.ilike(pattern, escape="\\"),
        )
        .order_by(User.username)
        .limit(limit)
    )
    return _serialize(result.scalars().all())
