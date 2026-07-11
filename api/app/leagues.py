import uuid

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import (
    League,
    LeagueMembership,
    RatingHistory,
    RatingHistorySource,
    RatingStrategy,
    UserLeagueRating,
)


async def get_default_league(db: AsyncSession) -> League | None:
    result = await db.execute(
        select(League)
        .where(League.is_default.is_(True))
        .options(selectinload(League.rating_strategy))
    )
    return result.scalar_one_or_none()


async def resolve_league(db: AsyncSession, league_id: uuid.UUID | None) -> League:
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
        raise HTTPException(status_code=500, detail="No default league configured.")
    return default


async def count_league_memberships(db: AsyncSession, user_id: uuid.UUID) -> int:
    """How many leagues the user belongs to — the profile's "2 leagues" line.

    Counted from ``league_memberships``, not from the leagues they happen to have
    played a match in: belonging to a ladder and having played on it are
    different facts, and a player joins the default league before their first
    match. So this is ``>= 1`` for every real user.
    """
    return (
        await db.execute(
            select(func.count(LeagueMembership.id)).where(
                LeagueMembership.user_id == user_id
            )
        )
    ).scalar_one()


def seed_user_league_rating(
    db: AsyncSession,
    league_id: uuid.UUID,
    user_id: uuid.UUID,
    strategy: RatingStrategy,
) -> UserLeagueRating:
    """Seed a member's current rating row and, for strategies that supply an
    initial rating, an ``initial`` rating-history event recording that
    baseline.

    The history event matters because per-match views read a player's
    pre-match rating from ``rating_history`` (not ``user_league_ratings``); a
    seeded value with no matching history row reads as "Unrated" until the
    player's first rated match. Manual-strategy leagues get a null rating row
    and no event — their baseline arrives via import.

    Adds rows to the session without flushing or committing; the caller owns
    the surrounding transaction.
    """
    rating = UserLeagueRating.seed_for_strategy(league_id, user_id, strategy)
    db.add(rating)
    if strategy.initial_rating_value is not None and strategy.initial_state is not None:
        db.add(
            RatingHistory(
                league_id=league_id,
                user_id=user_id,
                match_id=None,
                rating_strategy_id=strategy.id,
                rating_value=strategy.initial_rating_value,
                rating_state=dict(strategy.initial_state),
                previous_rating_value=None,
                source=RatingHistorySource.initial,
            )
        )
    return rating


async def add_user_to_default_league(db: AsyncSession, user_id: uuid.UUID) -> None:
    """Add the user to the default league and seed their rating row.

    Does not commit; the caller controls the surrounding transaction. Seeding
    eagerly (rather than on first match) means new users appear on
    leaderboards and in player search from day one. Manual-strategy leagues
    get a null rating row, waiting for an external import to fill it in.
    """
    default = await get_default_league(db)
    if default is None:
        raise RuntimeError("No default league configured. Run scripts/seed_leagues.py.")
    db.add(LeagueMembership(league_id=default.id, user_id=user_id))
    seed_user_league_rating(db, default.id, user_id, default.rating_strategy)
