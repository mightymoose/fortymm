"""Unit tests for the FastAPI-free player-search service.

Constructs `search_players_by_username` directly against `db_session`, so the
shared query the MCP tool and HTTP endpoint both call is covered without a
request. The HTTP wire contract is tested separately in `test_players.py`.
"""

from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.leagues import get_default_league, seed_user_league_rating
from app.models import (
    League,
    RatingHistory,
    RatingHistorySource,
    User,
    UserLeagueRating,
)
from app.player_search import search_players_by_username
from tests._helpers import make_user


def _provenance(user: User, league: League, rating_value: float) -> RatingHistory:
    """A ``manual`` rating-history row — the cheapest production shape that
    carries provenance, so ``is_rated_member()`` treats the seeded number as an
    actual rating (see ``test_players._provenance``)."""
    return RatingHistory(
        league_id=league.id,
        user_id=user.id,
        match_id=None,
        rating_strategy_id=league.rating_strategy_id,
        rating_value=rating_value,
        rating_state={"rating": rating_value, "rd": 200.0, "volatility": 0.06},
        previous_rating_value=None,
        source=RatingHistorySource.manual,
        created_at=datetime(2024, 1, 1, tzinfo=UTC),
    )


async def test_finds_a_registered_player_by_a_name_fragment(db_session: AsyncSession):
    caller = await make_user(db_session, "caller")
    await make_user(db_session, "Ada.Lovelace")
    await make_user(db_session, "grace.hopper")

    results = await search_players_by_username(
        db_session, query="ADA", current_user_id=caller.id
    )

    assert [player.username for player in results] == ["Ada.Lovelace"]


async def test_excludes_the_caller(db_session: AsyncSession):
    caller = await make_user(db_session, "ada.caller")
    await make_user(db_session, "ada.other")

    results = await search_players_by_username(
        db_session, query="ada", current_user_id=caller.id
    )

    usernames = [player.username for player in results]
    assert "ada.caller" not in usernames
    assert usernames == ["ada.other"]


async def test_excludes_tombstoned_users(db_session: AsyncSession):
    caller = await make_user(db_session, "caller")
    survivor = await make_user(db_session, "match.survivor")
    ghost = await make_user(db_session, "match.ghost")
    ghost.merged_into_user_id = survivor.id
    await db_session.commit()

    results = await search_players_by_username(
        db_session, query="match.", current_user_id=caller.id
    )

    assert [player.username for player in results] == ["match.survivor"]


async def test_respects_the_limit(db_session: AsyncSession):
    caller = await make_user(db_session, "caller")
    for i in range(15):
        await make_user(db_session, f"player{i:02d}")

    capped = await search_players_by_username(
        db_session, query="player", current_user_id=caller.id, limit=3
    )

    assert len(capped) == 3
    # Alphabetical order, so the cap takes the first three.
    assert [player.username for player in capped] == [
        "player00",
        "player01",
        "player02",
    ]


async def test_blank_query_matches_nothing(db_session: AsyncSession):
    caller = await make_user(db_session, "caller")
    await make_user(db_session, "ada.lovelace")

    results = await search_players_by_username(
        db_session, query="   ", current_user_id=caller.id
    )

    assert results == []


async def test_surfaces_the_default_league_rating(db_session: AsyncSession):
    caller = await make_user(db_session, "caller")
    rival = await make_user(db_session, "ratedrival")
    freshface = await make_user(db_session, "freshface")

    league = await get_default_league(db_session)
    db_session.add(
        UserLeagueRating(
            league_id=league.id,
            user_id=rival.id,
            rating_strategy_id=league.rating_strategy_id,
            rating_value=1750.0,
            rating_state={"rating": 1750.0, "rd": 200.0, "volatility": 0.06},
        )
    )
    db_session.add(_provenance(rival, league, 1750.0))
    # A brand-new member is seeded a 1500 row; the service must still report them
    # Unrated rather than handing back the league's prior.
    seed_user_league_rating(db_session, league.id, freshface.id, league.rating_strategy)
    await db_session.commit()

    results = await search_players_by_username(
        db_session, query="a", current_user_id=caller.id
    )
    by_name = {player.username: player.rating for player in results}

    assert by_name["ratedrival"] == 1750.0
    assert by_name["freshface"] is None
