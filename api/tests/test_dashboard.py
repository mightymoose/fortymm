import uuid
from datetime import UTC

from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    League,
    LeagueMembership,
    Match,
    MatchStatus,
    RatingHistory,
    RatingHistorySource,
    RatingStrategy,
    UserLeagueRating,
)
from tests._helpers import make_client, make_user, start_session


async def _create_match(client: AsyncClient, opponent_id, best_of: int = 5) -> dict:
    response = await client.post(
        "/v1/matches",
        json={
            "opponent_user_id": str(opponent_id),
            "best_of": best_of,
            "rated": True,
        },
    )
    assert response.status_code == 201
    return response.json()


async def test_dashboard_requires_a_session(api_client: AsyncClient):
    response = await api_client.get("/v1/dashboard")
    assert response.status_code == 401


async def test_dashboard_empty_when_user_has_no_matches(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    response = await api_client.get("/v1/dashboard")
    assert response.status_code == 200
    body = response.json()
    assert body["score_banners"] == []
    assert body["next_match"] is None
    assert body["recent_results"] == []
    # A fresh signup is auto-joined to the default Glicko-2 league with
    # initial state, so the rating widget lights up immediately with peak ==
    # current, a null streak, and a sparkline holding the lone seed point.
    rating = body["rating"]
    assert rating is not None
    assert rating["league_name"] == "FortyMM"
    assert rating["strategy_key"] == "glicko2"
    assert rating["current"] == 1500.0
    assert rating["delta"] == 0.0
    assert rating["peak"] == 1500.0
    assert rating["percentile"] is None  # alone in the league
    assert rating["spark_data"] == [1500.0]  # the initial seed event
    assert rating["streak"] is None
    assert rating["stats"] == [
        {"label": "RD", "value": "350"},
        {"label": "Volatility", "value": "0.060"},
    ]


async def test_dashboard_returns_score_banner_for_in_progress_match(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)
    after_g1 = (
        await api_client.post(
            f"/v1/matches/{match['id']}/games/{match['games'][0]['id']}/scores",
            json={"side_1_points": 11, "side_2_points": 4},
        )
    ).json()

    body = (await api_client.get("/v1/dashboard")).json()
    assert len(body["score_banners"]) == 1
    banner = body["score_banners"][0]
    assert banner["match_id"] == match["id"]
    assert banner["opponent_username"] == "rival"
    assert banner["current_game_id"] == after_g1["current_game"]["id"]
    # An in-progress match is not "pending" so the next_match slot is empty.
    assert body["next_match"] is None
    assert body["recent_results"] == []


async def test_dashboard_returns_multiple_banners_oldest_first(
    api_client: AsyncClient, db_session: AsyncSession
):
    # Variant D: back-to-back tournament play means a player can have two (or
    # more) matches sitting in_progress at once. The frontend stacks them, but
    # only if the API returns them in priority order — oldest first, since the
    # one that's been waiting longest is the most urgent to score.
    await start_session(api_client, db_session)
    opp_a = await make_user(db_session, "rival_a")
    opp_b = await make_user(db_session, "rival_b")
    opp_c = await make_user(db_session, "rival_c")
    match_a = await _create_match(api_client, opp_a.id, best_of=5)
    match_b = await _create_match(api_client, opp_b.id, best_of=5)
    match_c = await _create_match(api_client, opp_c.id, best_of=5)

    body = (await api_client.get("/v1/dashboard")).json()
    assert [b["match_id"] for b in body["score_banners"]] == [
        match_a["id"],
        match_b["id"],
        match_c["id"],
    ]
    assert [b["opponent_username"] for b in body["score_banners"]] == [
        "rival_a",
        "rival_b",
        "rival_c",
    ]


async def test_dashboard_returns_next_match_for_pending_match(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    created = await _create_match(api_client, opp.id, best_of=5)
    # Backfill to pending — the API no longer creates pending rows.
    db_match = await db_session.get(Match, uuid.UUID(created["id"]))
    assert db_match is not None
    db_match.status = MatchStatus.pending
    await db_session.commit()

    body = (await api_client.get("/v1/dashboard")).json()
    assert body["score_banners"] == []
    assert body["next_match"]["match_id"] == created["id"]
    assert body["next_match"]["opponent_username"] == "rival"
    assert body["next_match"]["best_of"] == 5


async def test_dashboard_returns_recent_results_for_completed_matches(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=1)
    await api_client.post(
        f"/v1/matches/{match['id']}/games/{match['games'][0]['id']}/scores",
        json={"side_1_points": 11, "side_2_points": 4},
    )

    body = (await api_client.get("/v1/dashboard")).json()
    assert len(body["recent_results"]) == 1
    result = body["recent_results"][0]
    assert result["match_id"] == match["id"]
    assert result["opponent_username"] == "rival"
    assert result["is_win"] is True
    assert result["my_games_won"] == 1
    assert result["opponent_games_won"] == 0
    change = result["my_rating_change"]
    assert change is not None
    assert change["before"] == 1500.0
    assert change["after"] > 1500.0
    assert change["delta"] > 0


async def test_dashboard_scoped_to_current_user(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    async with make_client() as other_client:
        await start_session(other_client, db_session)
        bystander = await make_user(db_session, "bystander")
        # A match between Bob and a bystander should not show up for Alice.
        await _create_match(other_client, bystander.id)

    body = (await api_client.get("/v1/dashboard")).json()
    assert body["score_banners"] == []
    assert body["next_match"] is None
    assert body["recent_results"] == []
    # Alice has her own seeded league row but no completed matches of her own
    # — the rating starts at the initial Glicko-2 values, untouched by Bob's
    # match.
    assert body["rating"]["current"] == 1500.0
    assert body["rating"]["streak"] is None


async def _play_match(
    client: AsyncClient,
    opponent_id,
    *,
    i_win: bool,
    best_of: int = 1,
) -> dict:
    match = await _create_match(client, opponent_id, best_of=best_of)
    s1, s2 = (11, 4) if i_win else (4, 11)
    await client.post(
        f"/v1/matches/{match['id']}/games/{match['games'][0]['id']}/scores",
        json={"side_1_points": s1, "side_2_points": s2},
    )
    return match


async def test_dashboard_rating_reflects_completed_match(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    await _play_match(api_client, opp.id, i_win=True)

    rating = (await api_client.get("/v1/dashboard")).json()["rating"]
    # Glicko-2 lifts the winner above 1500 and tightens RD.
    assert rating["current"] > 1500.0
    assert rating["delta"] > 0
    assert rating["peak"] == rating["current"]
    # Seed point first, then the post-match value.
    assert rating["spark_data"] == [1500.0, rating["current"]]
    assert rating["streak"] == {"kind": "W", "n": 1}
    rd_stat = next(s for s in rating["stats"] if s["label"] == "RD")
    assert int(rd_stat["value"]) < 350


async def test_dashboard_streak_counts_consecutive_results(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    # W, W, L — streak should be the most-recent L of length 1.
    await _play_match(api_client, opp.id, i_win=True)
    await _play_match(api_client, opp.id, i_win=True)
    await _play_match(api_client, opp.id, i_win=False)

    rating = (await api_client.get("/v1/dashboard")).json()["rating"]
    assert rating["streak"] == {"kind": "L", "n": 1}
    # The seed event plus three match results.
    assert len(rating["spark_data"]) == 4


async def test_dashboard_rating_peak_holds_after_loss(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    await _play_match(api_client, opp.id, i_win=True)
    rating_after_win = (await api_client.get("/v1/dashboard")).json()["rating"]
    peak_after_win = rating_after_win["current"]

    await _play_match(api_client, opp.id, i_win=False)
    rating_after_loss = (await api_client.get("/v1/dashboard")).json()["rating"]

    assert rating_after_loss["current"] < peak_after_win
    assert rating_after_loss["peak"] == peak_after_win
    assert rating_after_loss["delta"] < 0


async def test_dashboard_rating_percentile_against_league_peers(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A user mid-pack against 4 other rated members should land at the
    bottom of the leaderboard until they actually beat someone."""
    me = await start_session(api_client, db_session)
    default_league = (
        await db_session.execute(select(League).where(League.is_default.is_(True)))
    ).scalar_one()
    # Seed 4 peers at varying ratings without playing any matches against me.
    for name, value in [
        ("low", 1200.0),
        ("mid_low", 1400.0),
        ("mid_high", 1600.0),
        ("high", 1800.0),
    ]:
        peer = await make_user(db_session, name)
        db_session.add(LeagueMembership(league_id=default_league.id, user_id=peer.id))
        db_session.add(
            UserLeagueRating(
                league_id=default_league.id,
                user_id=peer.id,
                rating_value=value,
                rating_state={"rating": value, "rd": 200.0, "volatility": 0.06},
            )
        )
    await db_session.commit()
    _ = me

    rating = (await api_client.get("/v1/dashboard")).json()["rating"]
    # I'm at 1500 among 1200/1400/1500/1600/1800: 3rd of 5 — 60th percentile.
    assert rating["percentile"] == 60


async def test_dashboard_sparkline_returns_most_recent_points(
    api_client: AsyncClient, db_session: AsyncSession
):
    """When the user has more rating-history rows than SPARK_MAX_POINTS in
    the 30-day window, the sparkline should be the *most recent* points in
    chronological order — not the oldest 30."""
    from datetime import datetime, timedelta

    me = await start_session(api_client, db_session)
    default_league = (
        await db_session.execute(select(League).where(League.is_default.is_(True)))
    ).scalar_one()
    strategy = (
        await db_session.execute(
            select(RatingStrategy).where(RatingStrategy.key == "glicko2")
        )
    ).scalar_one()
    # The signup seed event sits before any match, so push it back behind the
    # 40 rows below; otherwise it would be the most-recent point and skew the
    # truncation this test is checking.
    now = datetime.now(UTC)
    await db_session.execute(
        text(
            "UPDATE rating_history SET created_at = :ts "
            "WHERE user_id = :uid AND source = 'initial'"
        ),
        {"ts": now - timedelta(hours=41), "uid": me.id},
    )
    # 40 history rows spaced 1 hour apart, all within the 30-day window;
    # rating climbs monotonically so we can read the order off the values.
    for i in range(40):
        db_session.add(
            RatingHistory(
                league_id=default_league.id,
                user_id=me.id,
                rating_strategy_id=strategy.id,
                rating_value=1500.0 + i,
                rating_state={
                    "rating": 1500.0 + i,
                    "rd": 200.0,
                    "volatility": 0.06,
                },
                previous_rating_value=1500.0 + i - 1 if i > 0 else None,
                source=RatingHistorySource.match,
                created_at=now - timedelta(hours=40 - i),
            )
        )
    await db_session.commit()

    spark = (await api_client.get("/v1/dashboard")).json()["rating"]["spark_data"]
    # 30 most-recent values (1510..1539), oldest first.
    assert spark == [float(v) for v in range(1510, 1540)]


async def test_dashboard_rating_is_null_for_manual_league(
    api_client: AsyncClient, db_session: AsyncSession
):
    # Move the seeded league over to the manual strategy and null the user's
    # rating row — the widget should disappear instead of showing a stale 1500.
    manual = (
        await db_session.execute(
            select(RatingStrategy).where(RatingStrategy.key == "manual")
        )
    ).scalar_one()
    default = (
        await db_session.execute(select(League).where(League.is_default.is_(True)))
    ).scalar_one()
    default.rating_strategy_id = manual.id
    await db_session.commit()

    await start_session(api_client, db_session)
    body = (await api_client.get("/v1/dashboard")).json()
    assert body["rating"] is None
