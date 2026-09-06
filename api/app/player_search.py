"""Username substring search backing the opponent typeahead.

FastAPI-free (no routers, no ``Depends``) so both the HTTP endpoint
(`app.players`) and the MCP ``search_players`` tool can call the SAME query
logic and never drift — the shared-services rule in ``api/CLAUDE.md``. A
stateless query, so it is a module-level function taking ``db`` rather than a
class-plus-provider.
"""

import uuid
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.leagues import resolve_league
from app.listed import is_listed_player
from app.models import Player
from app.player_summary import load_player_ratings
from app.schemas.player import PlayerRead
from app.sql import escape_like

# The typeahead caps its dropdown well below the full roster.
SEARCH_DEFAULT_LIMIT = 10


async def search_players_by_username(
    db: AsyncSession,
    *,
    query: str,
    current_user_id: uuid.UUID | None,
    league_id: uuid.UUID | None = None,
    limit: int = SEARCH_DEFAULT_LIMIT,
) -> list[PlayerRead]:
    """Candidate opponents whose username matches ``query`` (substring,
    case-insensitive, LIKE-escaped).

    Excludes the caller and tombstoned (merged-away) users, orders
    alphabetically, and caps at ``limit`` so no caller has to fetch and filter
    the whole roster. A blank ``query`` matches nothing. ``rating`` is each
    candidate's rating in the resolved league (defaulting to the default
    league), ``None`` for an Unrated player.
    """
    term = query.strip()
    if not term:
        return []

    pattern = f"%{escape_like(term)}%"
    result = await db.execute(
        select(Player)
        .where(
            Player.id != current_user_id,
            # Exclude tombstoned (merged-away) guests so ghosts never surface.
            Player.merged_into_player_id.is_(None),
            # Never-active rows stay out of opponent search (#1438) — see
            # ``app.listed.is_listed_player``.
            is_listed_player(),
            Player.username.ilike(pattern, escape="\\"),
        )
        .order_by(Player.username)
        .limit(limit)
    )
    users: Sequence[Player] = result.scalars().all()
    league = await resolve_league(db, league_id)
    ratings = await load_player_ratings(db, league.id, (user.id for user in users))
    return [
        PlayerRead(id=user.id, username=user.username, rating=ratings.get(user.id))
        for user in users
    ]
