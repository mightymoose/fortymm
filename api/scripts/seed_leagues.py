"""Seed (or update) the default league.

Idempotent: re-runs locate the row by ``is_default=true`` and overwrite its
``name``, ``description``, and ``visibility`` from the constants below.
Editing the constants and redeploying is the supported way to rename or
re-describe the default league. Safe to run on every container boot.
"""

import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db import get_engine
from app.leagues import get_default_league
from app.models import League, LeagueVisibility, RatingStrategy
from app.ratings import RatingStrategyKey

DEFAULT_LEAGUE_NAME = "FortyMM"
DEFAULT_LEAGUE_DESCRIPTION = "The headline FortyMM league."
DEFAULT_LEAGUE_VISIBILITY = LeagueVisibility.public
DEFAULT_LEAGUE_RATING_STRATEGY_KEY = RatingStrategyKey.glicko2


async def upsert_default_league(db: AsyncSession) -> str:
    """Insert or update the default league in ``db``.

    Returns ``"created"`` or ``"updated"`` for caller logging. Caller commits.
    """
    strategy = (
        await db.execute(
            select(RatingStrategy).where(
                RatingStrategy.key == DEFAULT_LEAGUE_RATING_STRATEGY_KEY
            )
        )
    ).scalar_one()

    existing = await get_default_league(db)
    if existing is None:
        db.add(
            League(
                name=DEFAULT_LEAGUE_NAME,
                description=DEFAULT_LEAGUE_DESCRIPTION,
                visibility=DEFAULT_LEAGUE_VISIBILITY,
                is_default=True,
                rating_strategy_id=strategy.id,
            )
        )
        return "created"
    existing.name = DEFAULT_LEAGUE_NAME
    existing.description = DEFAULT_LEAGUE_DESCRIPTION
    existing.visibility = DEFAULT_LEAGUE_VISIBILITY
    existing.rating_strategy_id = strategy.id
    return "updated"


async def seed() -> None:
    engine = get_engine()
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with sessionmaker() as db:
        action = await upsert_default_league(db)
        await db.commit()
        print(f"Seed complete: default league {action} ({DEFAULT_LEAGUE_NAME}).")


if __name__ == "__main__":
    asyncio.run(seed())
