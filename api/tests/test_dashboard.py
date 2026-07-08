import uuid
from datetime import UTC, datetime

from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dashboard import _league_percentile
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
from tests._helpers import (
    accept_standing_result,
    make_client,
    make_user,
    opponent_session,
    start_session,
)


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
    assert body["attention"] == []
    assert body["attention_total_count"] == 0
    assert body["waiting_count"] == 0
    assert body["recent_results"] == []
    assert body["completed_match_count"] == 0
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


async def test_dashboard_returns_score_attention_for_in_progress_match(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)
    await api_client.post(
        f"/v1/matches/{match['id']}/games/1/scores/new",
        json={"side_1_points": 11, "side_2_points": 4},
    )

    body = (await api_client.get("/v1/dashboard")).json()
    assert len(body["attention"]) == 1
    item = body["attention"][0]
    assert item["match_id"] == match["id"]
    assert item["opponent_username"] == "rival"
    assert item["kind"] == "score"
    assert item["affects_rating"] is True
    # Game rows are created lazily; the dashboard deeplinks by game number.
    assert item["current_game_number"] == 2
    # Nothing is waiting on the opponent yet.
    assert body["waiting_count"] == 0
    assert body["attention_total_count"] == 1
    assert body["recent_results"] == []


async def test_dashboard_orders_score_items_oldest_first(
    api_client: AsyncClient, db_session: AsyncSession
):
    # Variant D: back-to-back tournament play means a player can have two (or
    # more) matches sitting in_progress at once. The panel stacks them, but
    # only if the API returns them in priority order — within the score bucket,
    # oldest first, since the one waiting longest is the most urgent to score.
    await start_session(api_client, db_session)
    opp_a = await make_user(db_session, "rival_a")
    opp_b = await make_user(db_session, "rival_b")
    opp_c = await make_user(db_session, "rival_c")
    match_a = await _create_match(api_client, opp_a.id, best_of=5)
    match_b = await _create_match(api_client, opp_b.id, best_of=5)
    match_c = await _create_match(api_client, opp_c.id, best_of=5)

    body = (await api_client.get("/v1/dashboard")).json()
    assert [i["match_id"] for i in body["attention"]] == [
        match_a["id"],
        match_b["id"],
        match_c["id"],
    ]
    assert [i["opponent_username"] for i in body["attention"]] == [
        "rival_a",
        "rival_b",
        "rival_c",
    ]
    assert all(i["kind"] == "score" for i in body["attention"])


async def test_dashboard_pending_match_counts_as_waiting(
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

    # Pending/scheduled matches need the *other* side's move first (O3 default),
    # so they're footer-only, never a row.
    body = (await api_client.get("/v1/dashboard")).json()
    assert body["attention"] == []
    assert body["waiting_count"] == 1


async def test_dashboard_returns_recent_results_for_completed_matches(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        post = await api_client.post(
            f"/v1/matches/{match['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                ]
            },
        )
        assert post.status_code == 201
        await accept_standing_result(opp_client, match["id"])

    body = (await api_client.get("/v1/dashboard")).json()
    assert len(body["recent_results"]) == 1
    assert body["completed_match_count"] == 1
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
    assert body["attention"] == []
    assert body["waiting_count"] == 0
    assert body["recent_results"] == []
    # Pin that completed_match_count also follows the participant filter —
    # Bob's completed match must not bleed into Alice's history total.
    assert body["completed_match_count"] == 0
    # Alice has her own seeded league row but no completed matches of her own
    # — the rating starts at the initial Glicko-2 values, untouched by Bob's
    # match.
    assert body["rating"]["current"] == 1500.0
    assert body["rating"]["streak"] is None


async def _post_result(client: AsyncClient, match_id: str, *, best_of: int = 1) -> None:
    """Propose a decided result for ``match_id`` (no acceptance). For a rated
    match this leaves it ``in_progress`` with the proposer's standing result —
    awaiting the other side's review/accept."""
    games_to_win = best_of // 2 + 1
    post = await client.post(
        f"/v1/matches/{match_id}/results",
        json={
            "games": [
                {"game_number": n, "side_1_points": 11, "side_2_points": 4}
                for n in range(1, games_to_win + 1)
            ]
        },
    )
    assert post.status_code == 201


async def test_dashboard_review_item_when_opponent_posted_result(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The opponent posts a rated result; the current user (who hasn't signed)
    sees a ``review`` row — the in-app surface for confirmation that doesn't
    depend on the push notification."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "poster") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        # The OPPONENT posts, so it's the current user's turn to review.
        await _post_result(opp_client, match["id"], best_of=1)

    body = (await api_client.get("/v1/dashboard")).json()
    assert len(body["attention"]) == 1
    item = body["attention"][0]
    assert item["match_id"] == match["id"]
    assert item["kind"] == "review"
    assert item["opponent_username"] == "poster"
    # Review rows route to match detail, never deep-link to scoring.
    assert item["current_game_number"] is None
    assert body["waiting_count"] == 0


async def test_dashboard_my_posted_result_counts_as_waiting(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The flip side of review: when *I* posted and the opponent owes the
    proposed a result, the match is waiting on them — footer count, never a row."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "reviewer") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        await _post_result(api_client, match["id"], best_of=1)

    body = (await api_client.get("/v1/dashboard")).json()
    assert body["attention"] == []
    assert body["attention_total_count"] == 0
    assert body["waiting_count"] == 1


async def test_dashboard_caps_attention_rows_but_counts_them_all(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A tournament player with more open matches than the banner cap gets the
    most-urgent ATTENTION_BANNERS_LIMIT rows, while ``attention_total_count``
    still reflects every actionable match so the footer's "+N more" is exact."""
    from app.dashboard import ATTENTION_BANNERS_LIMIT

    await start_session(api_client, db_session)
    over_cap = ATTENTION_BANNERS_LIMIT + 2
    for i in range(over_cap):
        opp = await make_user(db_session, f"rival_{i}")
        await _create_match(api_client, opp.id, best_of=5)

    body = (await api_client.get("/v1/dashboard")).json()
    assert len(body["attention"]) == ATTENTION_BANNERS_LIMIT
    assert body["attention_total_count"] == over_cap
    assert all(i["kind"] == "score" for i in body["attention"])


async def test_attention_ranks_review_above_scores_beyond_eager_cap(
    api_client: AsyncClient, db_session: AsyncSession
):
    """#838: a top-priority ``review`` must surface even when it's the
    most-recently-updated actionable match and there are more actionable matches
    than the display cap.

    The old panel eager-loaded ``ORDER BY updated_at ASC LIMIT
    ATTENTION_BANNERS_LIMIT`` and ranked only that slice, so a freshly-bumped
    ``review`` (opponent just proposed) sat at the *newest* end of the
    updated_at axis and got dropped by the LIMIT before ranking ever saw it —
    the panel showed stale lower-priority ``score`` rows. The fix loads every
    actionable match, ranks in Python, then caps for display, so the review
    both appears and outranks the scores.
    """
    from app.dashboard import ATTENTION_BANNERS_LIMIT

    await start_session(api_client, db_session)
    # More score matches than the display cap — enough that the old DB LIMIT
    # would have no room left for the newest-updated row.
    over_cap = ATTENTION_BANNERS_LIMIT + 2
    for i in range(over_cap):
        opp = await make_user(db_session, f"rival_{i}")
        await _create_match(api_client, opp.id, best_of=5)

    # One more match where the OPPONENT posts, so the current user owes a
    # review (priority 1 — above every score).
    async with opponent_session(db_session, "poster") as (opp_client, opp):
        review_match = await _create_match(api_client, opp.id, best_of=1)
        await _post_result(opp_client, review_match["id"], best_of=1)

    # Make the review match the NEWEST-updated of them all, so the old
    # ``ORDER BY updated_at ASC LIMIT`` would have excluded it before ranking.
    review_db = await db_session.get(Match, uuid.UUID(review_match["id"]))
    assert review_db is not None
    review_db.updated_at = datetime.now(UTC)
    await db_session.commit()

    body = (await api_client.get("/v1/dashboard")).json()
    # The review both survives the cap and outranks every score row.
    assert body["attention"][0]["kind"] == "review"
    assert body["attention"][0]["match_id"] == review_match["id"]
    # Every actionable match is counted (all scores + the review)...
    assert body["attention_total_count"] == ATTENTION_BANNERS_LIMIT + 3
    # ...but the display list holds only the top cap.
    assert len(body["attention"]) == ATTENTION_BANNERS_LIMIT


async def test_dashboard_attention_priority_ranking(
    api_client: AsyncClient, db_session: AsyncSession
):
    """P0-4: a review ranks above a rated score, which ranks above an unrated
    score. (The legacy ``dispute`` bucket is unreachable in the two-verb model —
    no transition leaves a match in the ``disputed`` status — so it drops out of
    the ranking entirely.)"""
    await start_session(api_client, db_session)
    # Unrated + rated score matches: nobody has posted, so they sit in the
    # score bucket; the current user is the one who'd score them.
    rated_opp = await make_user(db_session, "rated_opp")
    unrated_opp = await make_user(db_session, "unrated_opp")
    rated_score = await _create_match(api_client, rated_opp.id, best_of=5)
    unrated_create = await api_client.post(
        "/v1/matches",
        json={"opponent_user_id": str(unrated_opp.id), "best_of": 5, "rated": False},
    )
    assert unrated_create.status_code == 201
    unrated_score = unrated_create.json()

    async with opponent_session(db_session, "reviewer_opp") as (rev_client, rev_opp):
        # Review row: the opponent posts, current user must review.
        review_match = await _create_match(api_client, rev_opp.id, best_of=1)
        await _post_result(rev_client, review_match["id"], best_of=1)

        body = (await api_client.get("/v1/dashboard")).json()

    assert [(i["kind"], i["affects_rating"]) for i in body["attention"]] == [
        ("review", True),
        ("score", True),
        ("score", False),
    ]
    assert [i["match_id"] for i in body["attention"]] == [
        review_match["id"],
        rated_score["id"],
        unrated_score["id"],
    ]
    assert body["attention_total_count"] == 3
    assert body["waiting_count"] == 0


async def _play_match(
    client: AsyncClient,
    opp_client: AsyncClient,
    opp_id,
    *,
    i_win: bool,
    best_of: int = 1,
) -> dict:
    """Create a match, propose the result, and have the opponent accept — the
    full propose/accept dance. Returns the create response (the test usually
    only wants the match id)."""
    match = await _create_match(client, opp_id, best_of=best_of)
    s1, s2 = (11, 4) if i_win else (4, 11)
    games_to_win = best_of // 2 + 1
    post = await client.post(
        f"/v1/matches/{match['id']}/results",
        json={
            "games": [
                {"game_number": n, "side_1_points": s1, "side_2_points": s2}
                for n in range(1, games_to_win + 1)
            ]
        },
    )
    assert post.status_code == 201
    await accept_standing_result(opp_client, match["id"])
    return match


async def test_dashboard_rating_reflects_completed_match(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        await _play_match(api_client, opp_client, opp.id, i_win=True)

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
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        # W, W, L — streak should be the most-recent L of length 1.
        await _play_match(api_client, opp_client, opp.id, i_win=True)
        await _play_match(api_client, opp_client, opp.id, i_win=True)
        await _play_match(api_client, opp_client, opp.id, i_win=False)

    rating = (await api_client.get("/v1/dashboard")).json()["rating"]
    assert rating["streak"] == {"kind": "L", "n": 1}
    # The seed event plus three match results.
    assert len(rating["spark_data"]) == 4


async def test_dashboard_rating_peak_holds_after_loss(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        await _play_match(api_client, opp_client, opp.id, i_win=True)
        rating_after_win = (await api_client.get("/v1/dashboard")).json()["rating"]
        peak_after_win = rating_after_win["current"]

        await _play_match(api_client, opp_client, opp.id, i_win=False)
        rating_after_loss = (await api_client.get("/v1/dashboard")).json()["rating"]

    assert rating_after_loss["current"] < peak_after_win
    assert rating_after_loss["peak"] == peak_after_win
    assert rating_after_loss["delta"] < 0


async def _seed_rated_peers(db_session: AsyncSession) -> League:
    """Add 4 rated members to the default league at varying ratings, none of
    whom have played the current user. Returns the default league."""
    default_league = (
        await db_session.execute(select(League).where(League.is_default.is_(True)))
    ).scalar_one()
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
    return default_league


async def test_dashboard_no_percentile_for_unplayed_user_with_peers(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A never-played user sits at the seed rating (1500, RD 350) — fully
    unrated. Even surrounded by rated peers they must not be handed a concrete
    percentile; ranking the unrankable reads as placeholder data. (#382)"""
    await start_session(api_client, db_session)
    await _seed_rated_peers(db_session)

    body = (await api_client.get("/v1/dashboard")).json()
    assert body["completed_match_count"] == 0
    assert body["rating"]["percentile"] is None


async def test_dashboard_percentile_shown_once_user_has_played(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Once the user has completed a match they're genuinely rated, so the
    percentile against league peers comes back. (#382)"""
    await start_session(api_client, db_session)
    await _seed_rated_peers(db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        post = await api_client.post(
            f"/v1/matches/{match['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                ]
            },
        )
        assert post.status_code == 201
        await accept_standing_result(opp_client, match["id"])

    body = (await api_client.get("/v1/dashboard")).json()
    assert body["completed_match_count"] == 1
    percentile = body["rating"]["percentile"]
    assert percentile is not None
    assert 0 <= percentile <= 100


async def test_league_percentile_ranks_against_rated_members(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The "Top N%" helper itself, against peers at 1200/1400/1600/1800 plus
    self. "Top N%" counts the share at or above the rating, so a stronger
    rating reads a *smaller* percentage:
      - 1500 is 3rd of 5 (1500/1600/1800 at-or-above) → Top 60%
      - the strongest rating reads Top 20% (1 of 5), not Top 100%
      - the weakest reads Top 100% (5 of 5)."""
    me = await start_session(api_client, db_session)
    default_league = await _seed_rated_peers(db_session)

    assert await _league_percentile(db_session, default_league.id, 1500.0) == 60
    assert await _league_percentile(db_session, default_league.id, 1800.0) == 20
    assert await _league_percentile(db_session, default_league.id, 1200.0) == 100
    _ = me


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
