import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import League, LeagueMembership, LeagueVisibility, User
from scripts import seed_leagues
from tests._helpers import start_session


async def test_default_league_unique_partial_index(
    db_session: AsyncSession, default_league: League
):
    """At most one league row may have ``is_default=true``."""
    db_session.add(
        League(
            name="Pretender",
            description="Tries to also be default.",
            visibility=LeagueVisibility.public,
            is_default=True,
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


async def test_membership_unique_per_pair(
    db_session: AsyncSession, default_league: League
):
    user = User(username="dupe-member")
    db_session.add(user)
    await db_session.flush()
    db_session.add_all(
        [
            LeagueMembership(league_id=default_league.id, user_id=user.id),
            LeagueMembership(league_id=default_league.id, user_id=user.id),
        ]
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


async def test_session_creates_default_league_membership(
    api_client: AsyncClient,
    db_session: AsyncSession,
    default_league: League,
):
    await start_session(api_client, db_session)

    memberships = (
        await db_session.execute(select(LeagueMembership))
    ).scalars().all()
    assert len(memberships) == 1
    assert memberships[0].league_id == default_league.id


async def test_seed_creates_default_when_missing(
    db_session: AsyncSession, default_league: League
):
    # Wipe the autouse default so the seed has to create one.
    await db_session.delete(default_league)
    await db_session.commit()

    action = await seed_leagues.upsert_default_league(db_session)
    await db_session.commit()
    assert action == "created"

    leagues = (await db_session.execute(select(League))).scalars().all()
    assert len(leagues) == 1
    assert leagues[0].name == seed_leagues.DEFAULT_LEAGUE_NAME
    assert leagues[0].is_default is True
    assert leagues[0].visibility == seed_leagues.DEFAULT_LEAGUE_VISIBILITY


async def test_seed_updates_existing_default_in_place(
    db_session: AsyncSession, default_league: League
):
    original_id = default_league.id
    # Pre-condition: the autouse fixture inserts with description != seed value.
    assert default_league.description != seed_leagues.DEFAULT_LEAGUE_DESCRIPTION

    action = await seed_leagues.upsert_default_league(db_session)
    await db_session.commit()
    assert action == "updated"

    leagues = (await db_session.execute(select(League))).scalars().all()
    assert len(leagues) == 1
    assert leagues[0].id == original_id
    assert leagues[0].name == seed_leagues.DEFAULT_LEAGUE_NAME
    assert leagues[0].description == seed_leagues.DEFAULT_LEAGUE_DESCRIPTION
