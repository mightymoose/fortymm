import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import League, LeagueMembership, UserLeagueRating


async def get_default_league(db: AsyncSession) -> League | None:
    result = await db.execute(
        select(League)
        .where(League.is_default.is_(True))
        .options(selectinload(League.rating_strategy))
    )
    return result.scalar_one_or_none()


async def resolve_league(
    db: AsyncSession, league_id: uuid.UUID | None
) -> League:
    """Resolve a league by id, falling back to the default. Raises 404 if a
    specific id is supplied but missing, 500 if no default is configured."""
    if league_id is not None:
        league = (
            await db.execute(
                select(League)
                .where(League.id == league_id)
                .options(selectinload(League.rating_strategy))
            )
        ).scalar_one_or_none()
        if league is None:
            raise HTTPException(status_code=404, detail="League not found.")
        return league
    default = await get_default_league(db)
    if default is None:
        raise HTTPException(
            status_code=500, detail="No default league configured."
        )
    return default


async def add_user_to_default_league(
    db: AsyncSession, user_id: uuid.UUID
) -> None:
    """Add the user to the default league and seed their rating row.

    Does not commit; the caller controls the surrounding transaction. Seeding
    eagerly (rather than on first match) means new users appear on
    leaderboards and in player search from day one. Manual-strategy leagues
    get a null rating row, waiting for an external import to fill it in.
    """
    default = await get_default_league(db)
    if default is None:
        raise RuntimeError(
            "No default league configured. Run scripts/seed_leagues.py."
        )
    db.add(LeagueMembership(league_id=default.id, user_id=user_id))
    db.add(
        UserLeagueRating.seed_for_strategy(
            default.id, user_id, default.rating_strategy
        )
    )
