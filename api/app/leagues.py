import uuid

from fastapi import HTTPException
from sqlalchemy import and_, func, select
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
from app.schemas.player import PlayerLeague


async def get_default_league(db: AsyncSession) -> League | None:
    result = await db.execute(
        select(League)
        .where(League.is_default.is_(True))
        .options(selectinload(League.rating_strategy))
    )
    return result.scalar_one_or_none()


async def _load_league(db: AsyncSession, league_id: uuid.UUID) -> League | None:
    return (
        await db.execute(
            select(League)
            .where(League.id == league_id)
            .options(selectinload(League.rating_strategy))
        )
    ).scalar_one_or_none()


async def _default_league_or_500(db: AsyncSession) -> League:
    default = await get_default_league(db)
    if default is None:
        raise HTTPException(status_code=500, detail="No default league configured.")
    return default


# ---------------------------------------------------------------------------
# TWO resolvers, and they must stay two. The difference is not an oversight to
# be tidied away — it is the whole distinction between a league that IDENTIFIES
# something and a league that is a LENS on something (ADR-0915).
#
# * `resolve_league` — STRICT. For callers where the league is part of the thing
#   being addressed: the roster's ladder (`/v1/players`), the opponent picker's
#   ratings (`/players/recent`, `/players/search`), the league a match is created
#   ON (`matches.py`). Naming a league that does not exist there is a real error
#   and the honest answer is a 404 — silently substituting the default would
#   serve confidently WRONG data (a roster ranked by the wrong ladder, a match
#   created on a league the caller never asked for) with no signal that anything
#   went astray.
#
# * `resolve_league_or_default` — DEGRADING. For the player-profile surfaces
#   ONLY, where `?league=<id>` is a VIEW PREFERENCE and not the resource:
#   `/players/{id}` addresses a *player*; the league is merely the lens the
#   rating half of the page is seen through. A stale bookmark to a league that
#   has since been deleted (or that the player has left) must not tell the user
#   "player not found" — the player exists and is fine. It degrades to the
#   default ladder, exactly as the web client's `.catch()` on the `league` search
#   param already does for a *mangled* id (ADR-0915, docs/designs/player-details.md).
#
# Do NOT "unify" these by loosening `resolve_league`. Doing so converts a loud
# client bug into invisible wrong data on every surface above. `player_id` stays
# strict on the profile too: that IS the resource, and its 404 is correct.
# ---------------------------------------------------------------------------


async def resolve_league(db: AsyncSession, league_id: uuid.UUID | None) -> League:
    """Resolve a league by id, falling back to the default when none is named.
    Raises 404 if a specific id is supplied but missing, 500 if no default is
    configured.

    The STRICT resolver — an unknown id is an error. Profile surfaces want
    `resolve_league_or_default` instead; see the note above for why the two
    exist side by side.
    """
    if league_id is not None:
        league = await _load_league(db, league_id)
        if league is None:
            raise HTTPException(status_code=404, detail="League not found.")
        return league
    return await _default_league_or_500(db)


async def resolve_league_or_default(
    db: AsyncSession, league_id: uuid.UUID | None
) -> League:
    """Resolve a league by id, degrading to the default when the id names NO
    league — never raising 404 for it. Raises 500 only if no default league is
    configured.

    The DEGRADING resolver, for the player-profile surfaces, where the league is
    a lens on the player rather than the resource being addressed: an unknown
    (deleted, or never-existed) `?league=` shows the default ladder instead of
    accusing an existing player of not existing. See the note above before
    changing or reusing this — it is deliberately NOT what the roster, the
    opponent picker or match creation use.
    """
    if league_id is not None:
        league = await _load_league(db, league_id)
        if league is not None:
            return league
    return await _default_league_or_500(db)


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


async def player_leagues(db: AsyncSession, user_id: uuid.UUID) -> list[PlayerLeague]:
    """Every league the user belongs to, each carrying THEIR rating on it — the
    profile's Leagues card / league switcher (ADR-0915).

    ONE round trip, whatever the number of memberships: the rating is outer-joined
    onto the membership rather than fetched per league, so a player in twenty
    ladders costs the same query as a player in one. A member with no rating row
    on a ladder (a manual-strategy league awaiting its import) outer-joins to
    ``None`` rather than dropping out of the list — belonging to a league and
    holding a rating in it are different facts, and the card must still show the
    league.

    Membership is the source of truth, exactly as in ``count_league_memberships``
    — so ``len(player_leagues(...)) == count_league_memberships(...)`` always, and
    the Leagues card can never disagree with ``career.league_count`` sitting next
    to it on the same page.

    The default league sorts first (it is the one the page falls back to when the
    caller names none), then alphabetically — a stable order, so the card does not
    reshuffle between requests.
    """
    rows = (
        await db.execute(
            select(
                League.id,
                League.name,
                League.is_default,
                UserLeagueRating.rating_value,
            )
            .join(LeagueMembership, LeagueMembership.league_id == League.id)
            .outerjoin(
                UserLeagueRating,
                and_(
                    UserLeagueRating.league_id == League.id,
                    UserLeagueRating.user_id == user_id,
                ),
            )
            .where(LeagueMembership.user_id == user_id)
            .order_by(League.is_default.desc(), League.name)
        )
    ).all()
    return [
        PlayerLeague(id=id_, name=name, is_default=is_default, rating=rating)
        for id_, name, is_default, rating in rows
    ]


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
