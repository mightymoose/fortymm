"""Coverage for the rating system: strategies, calculator math, validation,
and the match-completion hook."""
import uuid

import jsonschema
import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    League,
    LeagueVisibility,
    RatingHistory,
    RatingHistorySource,
    RatingStrategy,
    UserLeagueRating,
)
from app.ratings import (
    STRATEGIES,
    get_calculator,
    state_rating_value,
    validate_state,
)
from app.ratings.glicko2 import CALCULATOR as GLICKO2
from tests._helpers import make_user, start_session


# ----- strategy seeding ----------------------------------------------------


async def test_rating_strategies_are_seeded(
    rating_strategies: dict[str, RatingStrategy],
):
    """The conftest fixture mirrors the migration's seed inserts. Two
    canonical strategies are present and shaped correctly."""
    assert set(rating_strategies) == {"glicko2", "manual"}

    glicko2 = rating_strategies["glicko2"]
    assert glicko2.is_automatic is True
    assert glicko2.initial_rating_value == 1500.0
    assert glicko2.initial_state == {"rating": 1500.0, "rd": 350.0, "volatility": 0.06}

    manual = rating_strategies["manual"]
    assert manual.is_automatic is False
    assert manual.initial_state is None
    assert manual.initial_rating_value is None


def test_registry_only_contains_automatic_strategies():
    """``manual`` has no calculator — the hook treats it as a no-op."""
    assert "glicko2" in STRATEGIES
    assert "manual" not in STRATEGIES
    assert get_calculator("manual") is None


# ----- Glicko-2 calculator -------------------------------------------------


def test_glicko2_winner_gains_loser_loses():
    """Two evenly-rated default players: the winner gains, the loser loses
    a roughly symmetric amount, and both RDs shrink (we learned something)."""
    initial = {"rating": 1500.0, "rd": 350.0, "volatility": 0.06}
    new_winner, new_loser = GLICKO2.update_singles(initial, dict(initial))

    assert new_winner["rating"] > 1500.0
    assert new_loser["rating"] < 1500.0
    assert new_winner["rd"] < initial["rd"]
    assert new_loser["rd"] < initial["rd"]
    # Symmetric matchup → symmetric magnitude.
    assert abs((new_winner["rating"] - 1500) + (new_loser["rating"] - 1500)) < 0.01


def test_glicko2_upset_moves_more_than_expected_win():
    """Beating a much higher-rated opponent shifts ratings further than
    beating a peer — the Glicko-2 information gain is larger."""
    initial = {"rating": 1500.0, "rd": 200.0, "volatility": 0.06}
    expected_winner, _ = GLICKO2.update_singles(initial, dict(initial))
    upset_winner, _ = GLICKO2.update_singles(
        {"rating": 1300.0, "rd": 200.0, "volatility": 0.06},
        {"rating": 1700.0, "rd": 200.0, "volatility": 0.06},
    )
    assert (upset_winner["rating"] - 1300.0) > (expected_winner["rating"] - 1500.0)


def test_state_rating_value_reads_the_rating_key():
    assert state_rating_value({"rating": 1234.5, "rd": 100.0}) == 1234.5


# ----- validation ----------------------------------------------------------


def test_validate_state_accepts_initial_states(
    rating_strategies: dict[str, RatingStrategy],
):
    glicko2 = rating_strategies["glicko2"]
    validate_state(glicko2.initial_state, glicko2)  # type: ignore[arg-type]
    # Manual schema accepts a bare {rating} payload.
    validate_state({"rating": 1750.0}, rating_strategies["manual"])


def test_validate_state_rejects_missing_required_key(
    rating_strategies: dict[str, RatingStrategy],
):
    with pytest.raises(jsonschema.ValidationError):
        validate_state({"rating": 1500.0}, rating_strategies["glicko2"])


def test_validate_state_rejects_extra_keys(
    rating_strategies: dict[str, RatingStrategy],
):
    with pytest.raises(jsonschema.ValidationError):
        validate_state(
            {"rating": 1500.0, "rd": 350.0, "volatility": 0.06, "extra": 1},
            rating_strategies["glicko2"],
        )


# ----- hook: end-to-end through the score endpoint -------------------------


async def _score_to_completion(
    client: AsyncClient, opponent_id: uuid.UUID, best_of: int = 1
) -> dict:
    create = await client.post(
        "/v1/matches",
        json={
            "opponent_user_id": str(opponent_id),
            "best_of": best_of,
            "rated": True,
        },
    )
    assert create.status_code == 201
    match = create.json()
    score = await client.post(
        f"/v1/matches/{match['id']}/games/{match['games'][0]['id']}/scores",
        json={"side_1_points": 11, "side_2_points": 4},
    )
    assert score.status_code == 201
    return score.json()


async def test_completing_a_rated_match_writes_rating_history(
    api_client: AsyncClient,
    db_session: AsyncSession,
    default_league: League,
):
    me = await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    body = await _score_to_completion(api_client, opp.id)

    # Two history rows, one per player, both linked to this match.
    rows = (
        await db_session.execute(
            select(RatingHistory).where(RatingHistory.match_id == uuid.UUID(body["id"]))
        )
    ).scalars().all()
    assert len(rows) == 2
    by_user = {row.user_id: row for row in rows}
    winner = by_user[me.id]
    loser = by_user[opp.id]

    assert winner.source == RatingHistorySource.match
    assert loser.source == RatingHistorySource.match
    assert winner.previous_rating_value == 1500.0
    assert loser.previous_rating_value == 1500.0
    assert winner.rating_value > 1500.0
    assert loser.rating_value < 1500.0
    assert winner.rating_strategy_id == default_league.rating_strategy_id

    # Current rating rows are upserted in lockstep.
    ratings = (
        await db_session.execute(select(UserLeagueRating))
    ).scalars().all()
    assert {r.user_id for r in ratings} == {me.id, opp.id}
    assert {r.league_id for r in ratings} == {default_league.id}


async def test_match_details_response_carries_rating_change(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    body = await _score_to_completion(api_client, opp.id)

    my_side = next(s for s in body["sides"] if s["is_current_user_side"])
    opp_side = next(s for s in body["sides"] if not s["is_current_user_side"])
    my_change = my_side["rating_change"]
    opp_change = opp_side["rating_change"]
    assert my_change is not None
    assert opp_change is not None
    assert my_change["before"] == 1500.0
    assert my_change["after"] > 1500.0
    assert my_change["delta"] == pytest.approx(my_change["after"] - 1500.0)
    assert opp_change["delta"] < 0


async def test_unrated_match_does_not_move_ratings(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    create = await api_client.post(
        "/v1/matches",
        json={
            "opponent_user_id": str(opp.id),
            "best_of": 1,
            "rated": False,
        },
    )
    match = create.json()
    score = await api_client.post(
        f"/v1/matches/{match['id']}/games/{match['games'][0]['id']}/scores",
        json={"side_1_points": 11, "side_2_points": 4},
    )
    body = score.json()
    for side in body["sides"]:
        assert side["rating_change"] is None

    # The session user has an `initial` seed row from joining the league, but
    # an unrated match must not produce any `match`-sourced history.
    rows = (
        await db_session.execute(
            select(RatingHistory).where(
                RatingHistory.source == RatingHistorySource.match
            )
        )
    ).scalars().all()
    assert rows == []


async def test_manual_strategy_league_skips_rating_updates(
    api_client: AsyncClient,
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """Replace the default league's strategy with ``manual`` and confirm the
    hook quietly skips. New members still get rating rows on join (the league
    membership hook eagerly seeds them), but with the strategy's null
    ``initial_state`` — to be filled by a later external import."""
    default = (
        await db_session.execute(
            select(League).where(League.is_default.is_(True))
        )
    ).scalar_one()
    default.rating_strategy_id = rating_strategies["manual"].id
    await db_session.commit()

    me = await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    body = await _score_to_completion(api_client, opp.id)
    my_side = next(s for s in body["sides"] if s["is_current_user_side"])
    assert my_side["rating_change"] is None

    rows = (await db_session.execute(select(RatingHistory))).scalars().all()
    assert rows == []

    # `me` joined the (now manual) default league via the session hook → has a
    # row but with the manual strategy's null initial state. `rival` was
    # created via ``make_user`` which doesn't route through league membership,
    # so they have no row at all.
    ratings = (
        await db_session.execute(select(UserLeagueRating))
    ).scalars().all()
    assert len(ratings) == 1
    assert ratings[0].user_id == me.id
    assert ratings[0].rating_value is None
    assert ratings[0].rating_state is None


async def test_rating_update_is_idempotent_across_score_edits(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Editing a score on an already-completed match doesn't write a second
    set of history rows. Re-application across edits is its own feature
    (tied to dispute/void flows) and explicitly out of scope for v1."""
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    body = await _score_to_completion(api_client, opp.id)
    score_id = body["games"][0]["score"]["id"]

    edited = await api_client.put(
        f"/v1/matches/{body['id']}/games/{body['games'][0]['id']}/scores/{score_id}",
        json={"side_1_points": 11, "side_2_points": 5},
    )
    assert edited.status_code == 200

    rows = (
        await db_session.execute(
            select(RatingHistory).where(RatingHistory.match_id == uuid.UUID(body["id"]))
        )
    ).scalars().all()
    assert len(rows) == 2  # still just the original pair


async def test_new_session_seeds_rating_for_default_league(
    api_client: AsyncClient,
    db_session: AsyncSession,
    default_league: League,
):
    """Starting a session creates the user, attaches them to the default
    league, and seeds a rating row with the strategy's initial values — so
    new players have a visible rating from day one without having to play
    a match first."""
    me = await start_session(api_client, db_session)

    rating = (
        await db_session.execute(
            select(UserLeagueRating).where(
                UserLeagueRating.user_id == me.id,
                UserLeagueRating.league_id == default_league.id,
            )
        )
    ).scalar_one()
    assert rating.rating_value == 1500.0
    assert rating.rating_state == {"rating": 1500.0, "rd": 350.0, "volatility": 0.06}


async def test_manual_history_row_with_null_match_round_trips(
    db_session: AsyncSession,
    default_league: League,
    rating_strategies: dict[str, RatingStrategy],
):
    """A manual override / external import path can write a history row with
    no match link and a non-null ``created_by_user_id`` + ``note``."""
    admin = await make_user(db_session, "admin")
    player = await make_user(db_session, "player")

    row = RatingHistory(
        league_id=default_league.id,
        user_id=player.id,
        match_id=None,
        rating_strategy_id=rating_strategies["manual"].id,
        rating_value=1850.0,
        rating_state={"rating": 1850.0},
        previous_rating_value=None,
        source=RatingHistorySource.import_,
        note="USATT 2026-04 batch",
        created_by_user_id=admin.id,
    )
    db_session.add(row)
    await db_session.commit()

    reloaded = (
        await db_session.execute(
            select(RatingHistory).where(RatingHistory.user_id == player.id)
        )
    ).scalar_one()
    assert reloaded.match_id is None
    assert reloaded.source == RatingHistorySource.import_
    assert reloaded.note == "USATT 2026-04 batch"
    assert reloaded.created_by_user_id == admin.id
