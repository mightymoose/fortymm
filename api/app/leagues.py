import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import League, LeagueMembership


async def get_default_league(db: AsyncSession) -> League | None:
    result = await db.execute(select(League).where(League.is_default.is_(True)))
    return result.scalar_one_or_none()


async def add_user_to_default_league(
    db: AsyncSession, user_id: uuid.UUID
) -> None:
    """Add the user to the default league.

    Does not commit; the caller controls the surrounding transaction. Callers
    invoke this on a freshly-created user, so the uniq pair never collides.
    """
    default = await get_default_league(db)
    if default is None:
        raise RuntimeError(
            "No default league configured. Run scripts/seed_leagues.py."
        )
    db.add(LeagueMembership(league_id=default.id, user_id=user_id))
