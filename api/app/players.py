from collections.abc import Iterable

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

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


def escape_like(term: str) -> str:
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
    # Join the caller's side and the opponent's side of each shared match so
    # the database returns hydrated User rows already ordered by recency —
    # one round trip, no Python re-sort.
    opp = aliased(MatchSidePlayer)
    mine = aliased(MatchSidePlayer)
    opponents = list(
        (
            await db.execute(
                select(User)
                .join(opp, opp.user_id == User.id)
                .join(Match, Match.id == opp.match_id)
                .join(
                    mine,
                    and_(
                        mine.match_id == opp.match_id,
                        mine.user_id == current_user.id,
                    ),
                )
                .where(User.id != current_user.id)
                .group_by(User.id)
                .order_by(func.max(Match.created_at).desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )

    if len(opponents) < limit:
        played_ids = [user.id for user in opponents]
        backfill = (
            (
                await db.execute(
                    select(User)
                    .where(
                        User.id != current_user.id,
                        User.id.notin_(played_ids),
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

    pattern = f"%{escape_like(term)}%"
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
