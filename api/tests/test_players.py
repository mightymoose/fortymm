from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.leagues import get_default_league
from app.models import (
    Match,
    MatchGame,
    MatchGameScore,
    MatchResult,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    RatingHistory,
    RatingHistorySource,
    User,
    UserLeagueRating,
)
from tests._helpers import make_client, make_user, start_session

# A fixed anchor so recency-ordering assertions don't depend on wall-clock time.
BASE_TIME = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)


async def _record_match(
    db_session: AsyncSession,
    *players: User,
    created_at: datetime,
) -> Match:
    """Persist a singles match between ``players`` stamped with an explicit
    ``created_at`` so recency-ordering tests stay deterministic."""
    settings = MatchSettings(team_size=1, best_of=5, affects_rating=False)
    league = await get_default_league(db_session)
    match = Match(
        match_settings=settings,
        league=league,
        created_by_user_id=players[0].id,
        status=MatchStatus.completed,
        created_at=created_at,
    )
    for side_number, player in enumerate(players, start=1):
        side = MatchSide(match=match, side_number=side_number)
        side.players.append(MatchSidePlayer(match=match, user=player))
    db_session.add(match)
    await db_session.commit()
    return match


def _usernames(response) -> list[str]:
    return [player["username"] for player in response.json()]


def _rating_for(response, username: str):
    for player in response.json():
        if player["username"] == username:
            return player["rating"]
    raise KeyError(username)


# ----- recent opponents ----------------------------------------------------


async def test_recent_opponents_requires_a_session(api_client: AsyncClient):
    response = await api_client.get("/v1/players/recent")
    assert response.status_code == 401


async def test_recent_opponents_orders_by_most_recent_match(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    ana = await make_user(db_session, "ana")
    bo = await make_user(db_session, "bo")
    cy = await make_user(db_session, "cy")

    # Played ana longest ago, then cy, then bo most recently.
    await _record_match(db_session, me, ana, created_at=BASE_TIME - timedelta(days=3))
    await _record_match(db_session, me, cy, created_at=BASE_TIME - timedelta(days=2))
    await _record_match(db_session, me, bo, created_at=BASE_TIME - timedelta(days=1))

    response = await api_client.get("/v1/players/recent")
    assert response.status_code == 200
    assert _usernames(response) == ["bo", "cy", "ana"]


async def test_recent_opponents_breaks_recency_ties_alphabetically(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    # Inserted out of alphabetical order, all sharing one timestamp, so a
    # missing tiebreaker would let Postgres return them in any order.
    cy = await make_user(db_session, "cy")
    ana = await make_user(db_session, "ana")
    bo = await make_user(db_session, "bo")

    await _record_match(db_session, me, cy, created_at=BASE_TIME)
    await _record_match(db_session, me, ana, created_at=BASE_TIME)
    await _record_match(db_session, me, bo, created_at=BASE_TIME)

    response = await api_client.get("/v1/players/recent")
    assert response.status_code == 200
    assert _usernames(response) == ["ana", "bo", "cy"]


async def test_recent_opponents_dedupes_repeated_opponents(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    ana = await make_user(db_session, "ana")
    bo = await make_user(db_session, "bo")

    # ana appears twice; her most recent match is newer than the bo match.
    await _record_match(db_session, me, ana, created_at=BASE_TIME - timedelta(days=5))
    await _record_match(db_session, me, bo, created_at=BASE_TIME - timedelta(days=3))
    await _record_match(db_session, me, ana, created_at=BASE_TIME - timedelta(days=1))

    response = await api_client.get("/v1/players/recent")
    assert response.status_code == 200
    assert _usernames(response) == ["ana", "bo"]


async def test_recent_opponents_excludes_never_played_users(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    rival = await make_user(db_session, "rival")
    await make_user(db_session, "zoe")
    await make_user(db_session, "amy")

    await _record_match(db_session, me, rival, created_at=BASE_TIME)

    response = await api_client.get("/v1/players/recent")
    assert response.status_code == 200
    # Only the actual opponent — strangers are no longer backfilled (#167).
    assert _usernames(response) == ["rival"]


async def test_recent_opponents_for_a_new_player_is_empty(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    db_session.add_all(
        [User(username="charlie"), User(username="alice"), User(username="bob")]
    )
    await db_session.commit()

    response = await api_client.get("/v1/players/recent")
    assert response.status_code == 200
    # No match history at all → empty, not a roster of strangers (#167). The
    # picker steers the new user to search/solo instead.
    assert response.json() == []


async def test_recent_opponents_excludes_the_current_user(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    rival = await make_user(db_session, "rival")
    await _record_match(db_session, me, rival, created_at=BASE_TIME)

    response = await api_client.get("/v1/players/recent")
    assert response.status_code == 200
    assert me.username not in _usernames(response)


async def test_recent_opponents_excludes_merged_ghost_opponents(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    ghost = await make_user(db_session, "ghost")
    survivor = await make_user(db_session, "survivor")
    await _record_match(db_session, me, ghost, created_at=BASE_TIME)

    # ``ghost`` was folded into another account: a tombstone, not a real user.
    ghost.merged_into_user_id = survivor.id
    await db_session.commit()

    response = await api_client.get("/v1/players/recent")
    assert response.status_code == 200
    # The tombstoned opponent must not surface as a selectable player, even
    # though it leads the recency ordering.
    assert "ghost" not in _usernames(response)


async def test_recent_opponents_is_empty_without_other_users(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)

    response = await api_client.get("/v1/players/recent")
    assert response.status_code == 200
    assert response.json() == []


async def test_recent_opponents_respects_the_limit(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    for offset, name in enumerate(("ana", "bo", "cy", "di")):
        opponent = await make_user(db_session, name)
        await _record_match(
            db_session, me, opponent, created_at=BASE_TIME - timedelta(days=offset)
        )

    response = await api_client.get("/v1/players/recent", params={"limit": 2})
    assert response.status_code == 200
    assert len(response.json()) == 2

    # The default fits the six-chip grid.
    default_response = await api_client.get("/v1/players/recent")
    assert len(default_response.json()) == 4

    assert (
        await api_client.get("/v1/players/recent", params={"limit": 0})
    ).status_code == 422


# ----- player search -------------------------------------------------------


async def test_search_requires_a_session(api_client: AsyncClient):
    response = await api_client.get("/v1/players/search", params={"q": "a"})
    assert response.status_code == 401


async def test_search_requires_a_query(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    response = await api_client.get("/v1/players/search")
    assert response.status_code == 422


async def test_search_matches_substring_case_insensitively(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    await make_user(db_session, "Ada.Lovelace")
    await make_user(db_session, "grace.hopper")

    response = await api_client.get("/v1/players/search", params={"q": "ADA"})
    assert response.status_code == 200
    assert _usernames(response) == ["Ada.Lovelace"]

    mid = await api_client.get("/v1/players/search", params={"q": "hop"})
    assert _usernames(mid) == ["grace.hopper"]


async def test_search_excludes_the_current_user(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)

    response = await api_client.get("/v1/players/search", params={"q": me.username})
    assert response.status_code == 200
    assert me.username not in _usernames(response)


async def test_search_with_a_blank_query_matches_nothing(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    await make_user(db_session, "ada.lovelace")

    response = await api_client.get("/v1/players/search", params={"q": "   "})
    assert response.status_code == 200
    assert response.json() == []


async def test_search_with_no_match_returns_empty(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    await make_user(db_session, "ada.lovelace")

    response = await api_client.get("/v1/players/search", params={"q": "nobody-here"})
    assert response.status_code == 200
    assert response.json() == []


async def test_search_caps_the_result_count(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    for i in range(15):
        await make_user(db_session, f"player{i:02d}")

    capped = await api_client.get("/v1/players/search", params={"q": "player"})
    assert capped.status_code == 200
    assert len(capped.json()) == 10  # SEARCH_DEFAULT_LIMIT

    smaller = await api_client.get(
        "/v1/players/search", params={"q": "player", "limit": 3}
    )
    assert len(smaller.json()) == 3


async def test_search_escapes_like_wildcards(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    await make_user(db_session, "alice")
    await make_user(db_session, "bob")

    # A bare "%" must match a literal percent sign, not every username.
    response = await api_client.get("/v1/players/search", params={"q": "%"})
    assert response.status_code == 200
    assert response.json() == []


async def test_search_orders_results_alphabetically(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    await make_user(db_session, "match.charlie")
    await make_user(db_session, "match.alice")
    await make_user(db_session, "match.bob")

    response = await api_client.get("/v1/players/search", params={"q": "match."})
    assert _usernames(response) == [
        "match.alice",
        "match.bob",
        "match.charlie",
    ]


# ----- rating field --------------------------------------------------------


async def test_search_includes_rating_for_default_league(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    rival = await make_user(db_session, "ratedrival")
    await make_user(db_session, "freshface")

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
    await db_session.commit()

    response = await api_client.get("/v1/players/search", params={"q": "face"})
    assert response.status_code == 200
    assert _rating_for(response, "freshface") is None

    response = await api_client.get("/v1/players/search", params={"q": "rival"})
    assert _rating_for(response, "ratedrival") == 1750.0


# ---------------------------------------------------------------------------
# /v1/players list + per-player profile + per-player matches
# ---------------------------------------------------------------------------


async def _record_match_with_winner(
    db_session: AsyncSession,
    winner: User,
    loser: User,
    *,
    created_at: datetime,
    status: MatchStatus = MatchStatus.completed,
    signed_by: User | None = None,
    affects_rating: bool = False,
) -> Match:
    """Persist a singles match with explicit winner/loser so W-L and form
    assertions are deterministic. Same shape as `_record_match` but flips
    `MatchSide.won` on the right side. ``won`` is stamped only for completed
    matches, mirroring the API: since #485 it's written at the moment a match
    becomes final, never while one is still in progress.

    ``signed_by`` seeds a standing (unaccepted) ``MatchResult`` submitted by
    that user — a posted-but-unaccepted result — so an ``in_progress`` match
    can be put in the "Awaiting acceptance" bucket (#364). Awaiting is now
    derived from "the match has any result row", so no acceptor is stamped.

    ``affects_rating`` marks the match rated — the precondition for a row to
    carry a rating change. Seed the change itself with ``_record_rating_change``:
    the two are separate because an unrated match must report NO rating change
    even though it is decided."""
    settings = MatchSettings(team_size=1, best_of=5, affects_rating=affects_rating)
    league = await get_default_league(db_session)
    match = Match(
        match_settings=settings,
        league=league,
        created_by_user_id=winner.id,
        status=status,
        created_at=created_at,
        updated_at=created_at,
    )
    completed = status == MatchStatus.completed
    side1 = MatchSide(match=match, side_number=1, won=True if completed else None)
    side1.players.append(MatchSidePlayer(match=match, user=winner))
    side2 = MatchSide(match=match, side_number=2, won=False if completed else None)
    side2.players.append(MatchSidePlayer(match=match, user=loser))
    if signed_by is not None:
        result = MatchResult(submitted_by_user_id=signed_by.id, games=[])
        match.results.append(result)
    db_session.add(match)
    await db_session.commit()
    return match


async def _rate(
    db_session: AsyncSession, user: User, rating_value: float | None
) -> None:
    """Attach a default-league ``UserLeagueRating`` to ``user``. A ``None``
    ``rating_value`` models a player who has a rating row but has never
    finished a rated match (unranked)."""
    league = await get_default_league(db_session)
    db_session.add(
        UserLeagueRating(
            league_id=league.id,
            user_id=user.id,
            rating_strategy_id=league.rating_strategy_id,
            rating_value=rating_value,
        )
    )
    await db_session.commit()


async def _record_rating_change(
    db_session: AsyncSession,
    user: User,
    match: Match,
    *,
    before: float,
    after: float,
) -> None:
    """Seed the ``RatingHistory`` row a rated match writes when it completes —
    the audit row the profile's per-row Δ column is read from."""
    league = await get_default_league(db_session)
    db_session.add(
        RatingHistory(
            league_id=league.id,
            user_id=user.id,
            match_id=match.id,
            rating_strategy_id=league.rating_strategy_id,
            rating_value=after,
            rating_state={"rating": after, "rd": 200.0, "volatility": 0.06},
            previous_rating_value=before,
            source=RatingHistorySource.match,
        )
    )
    await db_session.commit()


def _rank_for(items: list[dict], username: str):
    for player in items:
        if player["username"] == username:
            return player["rank"]
    raise KeyError(username)


async def test_list_players_rank_is_none_for_unrated_player(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A player with no rating (never finished a rated match) has no rank —
    no rating, no ladder position."""
    await start_session(api_client, db_session)
    rated = await make_user(db_session, "rank.rated")
    unrated = await make_user(db_session, "rank.unrated")
    await _rate(db_session, rated, 1600.0)
    # `unrated` gets no rating row at all → absent from the rank population.
    assert unrated is not None

    response = await api_client.get("/v1/players", params={"q": "rank."})
    assert response.status_code == 200
    items = response.json()["items"]
    assert _rank_for(items, "rank.rated") == 1
    assert _rank_for(items, "rank.unrated") is None


async def test_list_players_rank_ties_share_and_next_rank_skips(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Standard competition ranking: two players tied on rating share a rank
    and the next-lower player's rank SKIPS the shared slot (…, 1, 1, 3)."""
    await start_session(api_client, db_session)
    top_a = await make_user(db_session, "tie.aaa")
    top_b = await make_user(db_session, "tie.bbb")
    lower = await make_user(db_session, "tie.ccc")
    await _rate(db_session, top_a, 1800.0)
    await _rate(db_session, top_b, 1800.0)
    await _rate(db_session, lower, 1500.0)

    response = await api_client.get("/v1/players", params={"q": "tie."})
    assert response.status_code == 200
    items = response.json()["items"]
    assert _rank_for(items, "tie.aaa") == 1
    assert _rank_for(items, "tie.bbb") == 1
    # The tie consumes ranks 1 and 2, so the next player is rank 3, not 2.
    assert _rank_for(items, "tie.ccc") == 3


async def test_list_players_rank_is_global_across_filter_and_pagination(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The #841 regression guard: a player's rank is a GLOBAL ladder fact,
    identical whether the row is fetched unfiltered, under a ``q`` search that
    hides higher-rated players, or on page 2 — never the row's index on the
    current page."""
    await start_session(api_client, db_session)
    # A descending ladder; ``mid`` sits at global rank 3.
    top = await make_user(db_session, "glob.top")
    second = await make_user(db_session, "glob.second")
    mid = await make_user(db_session, "glob.mid")
    fourth = await make_user(db_session, "glob.fourth")
    fifth = await make_user(db_session, "glob.fifth")
    await _rate(db_session, top, 2000.0)
    await _rate(db_session, second, 1900.0)
    await _rate(db_session, mid, 1800.0)
    await _rate(db_session, fourth, 1700.0)
    await _rate(db_session, fifth, 1600.0)

    # Unfiltered: mid is globally rank 3.
    unfiltered = await api_client.get("/v1/players", params={"page_size": 100})
    assert unfiltered.status_code == 200
    assert _rank_for(unfiltered.json()["items"], "glob.mid") == 3

    # Under a search filter that excludes the two higher-rated players, mid
    # would be row 1 of the results — its rank must still be 3.
    filtered = await api_client.get("/v1/players", params={"q": "glob.mid"})
    assert _rank_for(filtered.json()["items"], "glob.mid") == 3

    # On page 2 (page_size 1, ordered by rating desc), mid is the only row —
    # its rank must be 3, not the page-relative index 1.
    page3 = await api_client.get(
        "/v1/players", params={"q": "glob.", "page": 3, "page_size": 1}
    )
    page3_items = page3.json()["items"]
    assert len(page3_items) == 1
    assert page3_items[0]["username"] == "glob.mid"
    assert page3_items[0]["rank"] == 3


async def test_list_players_rank_ignores_merged_ghost(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A tombstoned (merged-away) high-rated user must NOT be part of the rank
    population — otherwise it would push every real player one rank down."""
    await start_session(api_client, db_session)
    ghost = await make_user(db_session, "ghost.top")
    survivor = await make_user(db_session, "ghost.survivor")
    real_top = await make_user(db_session, "real.top")
    real_second = await make_user(db_session, "real.second")
    # The ghost outrates everyone, but it's a tombstone.
    await _rate(db_session, ghost, 3000.0)
    await _rate(db_session, real_top, 2000.0)
    await _rate(db_session, real_second, 1500.0)

    ghost.merged_into_user_id = survivor.id
    await db_session.commit()

    response = await api_client.get("/v1/players", params={"page_size": 100})
    assert response.status_code == 200
    items = response.json()["items"]
    # The ghost is excluded, so the real top is rank 1 (not 2).
    assert _rank_for(items, "real.top") == 1
    assert _rank_for(items, "real.second") == 2


async def test_list_players_requires_a_session(api_client: AsyncClient):
    async with make_client() as client:
        response = await client.get("/v1/players")
    assert response.status_code == 401
    assert api_client is not None


async def test_list_players_returns_paginated_summary(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Each item carries id/username/rating/wins/losses/form. Pagination
    envelope reports page, page_size, total."""
    await start_session(api_client, db_session)
    alice = await make_user(db_session, "alice")
    bob = await make_user(db_session, "bob")
    await _record_match_with_winner(db_session, alice, bob, created_at=BASE_TIME)

    response = await api_client.get("/v1/players", params={"page_size": 50})
    assert response.status_code == 200
    body = response.json()
    assert body["page"] == 1
    assert body["page_size"] == 50
    assert body["total"] >= 2
    usernames = {p["username"] for p in body["items"]}
    assert {"alice", "bob"}.issubset(usernames)
    alice_row = next(p for p in body["items"] if p["username"] == "alice")
    bob_row = next(p for p in body["items"] if p["username"] == "bob")
    assert alice_row["wins"] == 1 and alice_row["losses"] == 0
    assert alice_row["form"] == "W"
    assert bob_row["wins"] == 0 and bob_row["losses"] == 1
    assert bob_row["form"] == "L"


async def test_list_players_filters_by_username_substring(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    await make_user(db_session, "vinh.player")
    await make_user(db_session, "rio.player")
    await make_user(db_session, "unrelated")

    response = await api_client.get("/v1/players", params={"q": "player"})
    assert response.status_code == 200
    usernames = {p["username"] for p in response.json()["items"]}
    assert usernames == {"vinh.player", "rio.player"}


async def test_list_players_sorts_by_rating_descending_with_nulls_last(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The /players list orders by rating so the top of the roster is the
    most-skilled. Unrated players are sorted last so the leaderboard never
    starts with NULL."""
    await start_session(api_client, db_session)
    league = await get_default_league(db_session)
    high = await make_user(db_session, "rated.high")
    low = await make_user(db_session, "rated.low")
    unrated = await make_user(db_session, "rated.none")
    db_session.add_all(
        [
            UserLeagueRating(
                league_id=league.id,
                user_id=high.id,
                rating_strategy_id=league.rating_strategy_id,
                rating_value=2000.0,
            ),
            UserLeagueRating(
                league_id=league.id,
                user_id=low.id,
                rating_strategy_id=league.rating_strategy_id,
                rating_value=1500.0,
            ),
        ]
    )
    await db_session.commit()

    response = await api_client.get("/v1/players", params={"q": "rated."})
    usernames = [p["username"] for p in response.json()["items"]]
    assert usernames == ["rated.high", "rated.low", "rated.none"]
    assert unrated is not None  # silences unused warning


async def test_list_players_pagination_respects_page_and_page_size(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    for i in range(7):
        await make_user(db_session, f"pager.{i:02d}")

    page1 = await api_client.get(
        "/v1/players", params={"q": "pager.", "page": 1, "page_size": 3}
    )
    page2 = await api_client.get(
        "/v1/players", params={"q": "pager.", "page": 2, "page_size": 3}
    )
    assert page1.status_code == 200
    assert page2.status_code == 200
    assert len(page1.json()["items"]) == 3
    assert len(page2.json()["items"]) == 3
    assert page1.json()["total"] == 7
    page1_ids = {p["id"] for p in page1.json()["items"]}
    page2_ids = {p["id"] for p in page2.json()["items"]}
    assert page1_ids.isdisjoint(page2_ids)


async def test_get_player_returns_summary_with_embedded_matches(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The profile bundle includes the hero summary PLUS the first page
    of matches inline so the FE paints in one round trip."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "the.player")
    opponent = await make_user(db_session, "an.opponent")
    await _record_match_with_winner(db_session, target, opponent, created_at=BASE_TIME)
    await _record_match_with_winner(
        db_session, opponent, target, created_at=BASE_TIME + timedelta(days=1)
    )

    response = await api_client.get(f"/v1/players/{target.id}")
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == str(target.id)
    assert body["username"] == "the.player"
    assert body["wins"] == 1
    assert body["losses"] == 1
    # Form is newest-first → most recent L, then W.
    assert body["form"] == "LW"
    # Matches bundle: page 1 with both matches (newest-first by created_at).
    assert body["matches"]["page"] == 1
    assert body["matches"]["total"] == 2
    assert body["matches"]["items"][0]["result"] == "L"
    assert body["matches"]["items"][0]["opponent"]["username"] == "an.opponent"
    assert body["matches"]["items"][1]["result"] == "W"


async def test_get_player_voided_match_reports_no_result(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A voided match "contributes nothing" (ADR-0013 / the "Voided match"
    glossary entry): the profile match table must show NO win and NO loss for
    it, agreeing with the hero's career W-L.

    Regression for the self-play-collision void that flipped ``Match.status`` to
    ``voided`` but left ``MatchSide.won`` stamped. The status-gated hero read
    "W-L 0-0" while the ungated match table derived a phantom LOSS from
    ``won is False`` — the page contradicted itself. Voiding now clears the
    decision, so the table shows the match (kept as a record) with ``result:
    null``. FAILS before ``void_match`` nulls ``won`` (the item reports "L")."""
    from app.match_voiding import void_match

    await start_session(api_client, db_session)
    survivor = await make_user(db_session, "survivor")
    ghost = await make_user(db_session, "ghost")
    # A completed match the survivor LOST — the shape a rated self-play collision
    # carries before it is voided (won stamped on both sides).
    match = await _record_match_with_winner(
        db_session, ghost, survivor, created_at=BASE_TIME
    )

    # Void it — the operation the self-play-collision merge performs.
    await void_match(db_session, match)
    await db_session.commit()

    response = await api_client.get(f"/v1/players/{survivor.id}")
    assert response.status_code == 200
    body = response.json()
    # The voided match is kept as a record — it still appears in history.
    items = body["matches"]["items"]
    assert len(items) == 1
    assert items[0]["status"] == "voided"
    # No phantom W/L: the pre-fix code reported "L" here.
    assert items[0]["result"] is None
    # And the hero agrees — a voided match counts toward neither.
    assert body["wins"] == 0
    assert body["losses"] == 0


async def test_get_player_embeds_only_the_six_most_recent_matches(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The profile is an OVERVIEW (ADR-0915): the bundle embeds a six-row
    "Recent matches" window, not a 25-row page of the table. The full paginated
    history lives at its own route, served by `/v1/players/{id}/matches` — which
    keeps its 25-per-page default.

    FAILS before the change: the bundle embedded page 1 of 25, so all eight
    matches came back."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "six.target")
    rival = await make_user(db_session, "six.rival")
    matches = [
        await _record_match_with_winner(
            db_session, target, rival, created_at=BASE_TIME + timedelta(days=day)
        )
        for day in range(8)
    ]

    response = await api_client.get(f"/v1/players/{target.id}")
    assert response.status_code == 200
    body = response.json()

    items = body["matches"]["items"]
    assert len(items) == 6
    assert body["matches"]["page_size"] == 6
    # The six MOST RECENT, newest-first — days 7..2, not the oldest six.
    assert [item["id"] for item in items] == [
        str(match.id) for match in reversed(matches[2:])
    ]
    # The window is a window onto the whole history: the envelope still counts
    # every match, so the "View all N" link can't understate it.
    assert body["matches"]["total"] == 8
    assert body["match_total"] == 8

    # ...and the standalone history endpoint is untouched: still 25 a page, so
    # all eight rows come back in one page.
    full = await api_client.get(f"/v1/players/{target.id}/matches")
    assert full.status_code == 200
    assert full.json()["page_size"] == 25
    assert len(full.json()["items"]) == 8


async def test_get_player_match_total_counts_the_all_inclusive_history(
    api_client: AsyncClient, db_session: AsyncSession
):
    """``match_total`` counts EVERY match the player is a side of — any status,
    rated or not, matches still in play included (ADR-0008 / ADR-0915). It is
    deliberately NOT ``wins + losses``: career counts only *decided* matches, so
    the two numbers differ whenever a match is in play, and reconciling them
    reintroduces the bug.

    Two decided matches (1-1) plus one still in progress → the hero says 2
    decided, the "View all N matches" link says 3."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "total.target")
    rival = await make_user(db_session, "total.rival")
    await _record_match_with_winner(db_session, target, rival, created_at=BASE_TIME)
    await _record_match_with_winner(
        db_session, rival, target, created_at=BASE_TIME + timedelta(days=1)
    )
    # Still being played — decided by nobody, so it is neither a win nor a loss.
    await _record_match_with_winner(
        db_session,
        target,
        rival,
        created_at=BASE_TIME + timedelta(days=2),
        status=MatchStatus.in_progress,
    )

    response = await api_client.get(f"/v1/players/{target.id}")
    assert response.status_code == 200
    body = response.json()

    assert body["wins"] == 1
    assert body["losses"] == 1
    assert body["match_total"] == 3
    # The point of the field: it EXCEEDS the decided count while a match is live.
    assert body["match_total"] > body["wins"] + body["losses"]
    assert body["matches"]["total"] == body["match_total"]


async def test_get_player_match_row_carries_the_rating_the_match_moved(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A decided, rated row carries the rating THAT match moved for THIS player
    — the row's Δ column — read from the match's ``rating_history`` row and
    flipped to the headline player (the winner gained what the loser lost)."""
    await start_session(api_client, db_session)
    winner = await make_user(db_session, "delta.winner")
    loser = await make_user(db_session, "delta.loser")
    match = await _record_match_with_winner(
        db_session, winner, loser, created_at=BASE_TIME, affects_rating=True
    )
    await _record_rating_change(db_session, winner, match, before=1500.0, after=1524.0)
    await _record_rating_change(db_session, loser, match, before=1500.0, after=1476.0)

    won = (await api_client.get(f"/v1/players/{winner.id}")).json()
    assert won["matches"]["items"][0]["rating_change"] == {
        "before": 1500.0,
        "after": 1524.0,
        "delta": 24.0,
    }

    # The same match, the other player's perspective: the loss, not the win.
    lost = (await api_client.get(f"/v1/players/{loser.id}")).json()
    assert lost["matches"]["items"][0]["rating_change"] == {
        "before": 1500.0,
        "after": 1476.0,
        "delta": -24.0,
    }


async def test_get_player_rating_change_is_null_when_undecided_or_unrated(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A row reports NO rating change — ``null``, never a zero — unless the
    match is both DECIDED and RATED. The FE renders ``—`` for null; a ``+0``
    would claim the match was rated and moved nothing.

    Covers all three shapes on one profile: a rated decided win (a real delta),
    an unrated decided win (no delta — an unrated match moves no rating), and a
    rated match still in play (no delta yet)."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "null.target")
    rival = await make_user(db_session, "null.rival")

    rated = await _record_match_with_winner(
        db_session, target, rival, created_at=BASE_TIME, affects_rating=True
    )
    await _record_rating_change(db_session, target, rated, before=1500.0, after=1512.0)
    unrated = await _record_match_with_winner(
        db_session,
        target,
        rival,
        created_at=BASE_TIME + timedelta(days=1),
        affects_rating=False,
    )
    live = await _record_match_with_winner(
        db_session,
        target,
        rival,
        created_at=BASE_TIME + timedelta(days=2),
        status=MatchStatus.in_progress,
        affects_rating=True,
    )

    body = (await api_client.get(f"/v1/players/{target.id}")).json()
    rows = {item["id"]: item for item in body["matches"]["items"]}

    assert rows[str(rated.id)]["rating_change"]["delta"] == 12.0
    # A WON but unrated match: `—`, not `+0`.
    assert rows[str(unrated.id)]["result"] == "W"
    assert rows[str(unrated.id)]["rating_change"] is None
    # Undecided: the match hasn't moved anyone's rating yet.
    assert rows[str(live.id)]["result"] is None
    assert rows[str(live.id)]["rating_change"] is None


async def test_get_player_unrated_match_reports_no_rating_change_even_with_history(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The ``affects_rating`` arm of the Δ gate does real work: a DECIDED but
    UNRATED match reports no rating change EVEN IF a ``rating_history`` row
    exists for it.

    Today no such row can exist — result_acceptance returns early for unrated
    matches, recompute filters on ``affects_rating``, and voiding deletes the
    rows — so every other test here passes with the ``affects_rating`` arm
    deleted (the row's mere absence does the work). That invariant lives in
    three modules the profile doesn't own. This test pins the guard itself: it
    seeds the state those modules currently forbid and demands the profile still
    render `—`, so "simplifying" the gate away reds here instead of silently
    surfacing a `+0` on an unrated row the day the invariant slips."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "stray.target")
    rival = await make_user(db_session, "stray.rival")
    unrated = await _record_match_with_winner(
        db_session, target, rival, created_at=BASE_TIME, affects_rating=False
    )
    # The row that must not happen — and must not be believed if it does.
    await _record_rating_change(
        db_session, target, unrated, before=1500.0, after=1524.0
    )

    body = (await api_client.get(f"/v1/players/{target.id}")).json()
    row = body["matches"]["items"][0]
    assert row["id"] == str(unrated.id)
    # Decided — so only `affects_rating` can be withholding the delta.
    assert row["result"] == "W"
    assert row["rating_change"] is None


async def test_get_player_voided_match_reports_no_rating_change(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Voiding a rated match "contributes nothing" (ADR-0013): its rating is
    reversed and its history rows deleted, so the row it leaves behind in the
    profile reports no rating change — not the delta it once moved."""
    from app.match_voiding import void_match

    await start_session(api_client, db_session)
    target = await make_user(db_session, "void.target")
    rival = await make_user(db_session, "void.rival")
    match = await _record_match_with_winner(
        db_session, target, rival, created_at=BASE_TIME, affects_rating=True
    )
    await _record_rating_change(db_session, target, match, before=1500.0, after=1524.0)

    await void_match(db_session, match)
    await db_session.commit()

    body = (await api_client.get(f"/v1/players/{target.id}")).json()
    row = body["matches"]["items"][0]
    assert row["status"] == "voided"
    assert row["rating_change"] is None


async def test_get_player_requires_a_session(
    api_client: AsyncClient, db_session: AsyncSession
):
    target = await make_user(db_session, "needs.auth")
    async with make_client() as client:
        response = await client.get(f"/v1/players/{target.id}")
    assert response.status_code == 401
    assert api_client is not None


async def test_get_player_404_when_missing(
    api_client: AsyncClient, db_session: AsyncSession
):
    import uuid as _uuid

    await start_session(api_client, db_session)
    response = await api_client.get(f"/v1/players/{_uuid.uuid4()}")
    assert response.status_code == 404


async def test_list_player_matches_returns_perspective_paginated(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Matches are returned newest-first with the headline player's W/L plus
    the opponent flattened (no need to find-my-side on the client)."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "match.target")
    rival_a = await make_user(db_session, "rival.a")
    rival_b = await make_user(db_session, "rival.b")
    await _record_match_with_winner(db_session, target, rival_a, created_at=BASE_TIME)
    await _record_match_with_winner(
        db_session, rival_b, target, created_at=BASE_TIME + timedelta(days=1)
    )

    response = await api_client.get(f"/v1/players/{target.id}/matches")
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    items = body["items"]
    # Newest-first: the loss to rival.b first, then the win over rival.a.
    assert items[0]["result"] == "L"
    assert items[0]["opponent"]["username"] == "rival.b"
    assert items[1]["result"] == "W"
    assert items[1]["opponent"]["username"] == "rival.a"


async def test_list_player_matches_reports_per_game_scores_under_games(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A row's per-game scores arrive under ``games`` — a match is a best-of-N
    run of *games*, never "sets" (CONTEXT.md, "Game") — and each one is flipped
    into the headline player's perspective (``mine``/``theirs``), so the FE
    never has to find-my-side."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "scored.target")
    rival = await make_user(db_session, "scored.rival")
    # target lost, so `_record_match_with_winner` puts them on side 2: their
    # points are `side_2_points`, and the row must report them as `mine`.
    match = await _record_match_with_winner(
        db_session, rival, target, created_at=BASE_TIME
    )
    game = MatchGame(match_id=match.id, game_number=1)
    game.score = MatchGameScore(side_1_points=11, side_2_points=7)
    db_session.add(game)
    await db_session.commit()

    response = await api_client.get(f"/v1/players/{target.id}/matches")
    assert response.status_code == 200
    row = response.json()["items"][0]
    assert row["games"] == [{"mine": 7, "theirs": 11}]
    # The old misnomer is gone from the wire, not merely aliased.
    assert "sets" not in row


async def test_list_player_matches_result_hidden_while_awaiting_acceptance(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A rated match awaiting confirmation has no official outcome yet —
    ``side.won`` is only stamped when /confirmation completes the match
    (#485). The W/L row stays null while ``status`` is ``in_progress`` so a
    profile never shows a WIN/LOSS for an unratified claim."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "awaiting.target")
    rival = await make_user(db_session, "awaiting.rival")
    # Post-/results, pre-/confirmation: status in_progress, won unset —
    # ``_record_match_with_winner`` leaves won as None for non-completed.
    await _record_match_with_winner(
        db_session,
        target,
        rival,
        created_at=BASE_TIME,
        status=MatchStatus.in_progress,
    )

    response = await api_client.get(f"/v1/players/{target.id}/matches")
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    row = body["items"][0]
    assert row["status"] == "in_progress"
    assert row["result"] is None
    # No signature posted yet → genuinely live, not awaiting confirmation.
    assert row["awaiting_acceptance"] is False


async def test_list_player_matches_flags_awaiting_acceptance(
    api_client: AsyncClient, db_session: AsyncSession
):
    """An ``in_progress`` match with a posted-but-unaccepted result (at least
    one signature) reports ``awaiting_acceptance: true`` so the profile chip
    can distinguish it from a genuinely-live match — both sit at
    ``in_progress`` (#364). A true-live match (no signature) and a completed
    match both report false."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "await.flag.target")
    rival = await make_user(db_session, "await.flag.rival")

    # Awaiting: in_progress with a signature from the result-poster.
    await _record_match_with_winner(
        db_session,
        target,
        rival,
        created_at=BASE_TIME + timedelta(days=2),
        status=MatchStatus.in_progress,
        signed_by=target,
    )
    # True-live: in_progress, no signature.
    await _record_match_with_winner(
        db_session,
        target,
        rival,
        created_at=BASE_TIME + timedelta(days=1),
        status=MatchStatus.in_progress,
    )
    # Completed: never awaiting.
    await _record_match_with_winner(db_session, target, rival, created_at=BASE_TIME)

    response = await api_client.get(f"/v1/players/{target.id}/matches")
    assert response.status_code == 200
    items = response.json()["items"]
    assert len(items) == 3
    # Newest-first: awaiting, then live, then completed.
    assert items[0]["status"] == "in_progress"
    assert items[0]["awaiting_acceptance"] is True
    assert items[1]["status"] == "in_progress"
    assert items[1]["awaiting_acceptance"] is False
    assert items[2]["status"] == "completed"
    assert items[2]["awaiting_acceptance"] is False


async def test_list_player_matches_excludes_other_players_matches(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    me = await make_user(db_session, "scoped.me")
    them = await make_user(db_session, "scoped.them")
    other = await make_user(db_session, "scoped.other")
    await _record_match_with_winner(db_session, me, them, created_at=BASE_TIME)
    # Match that doesn't involve `me` — must not appear in /me/matches.
    await _record_match_with_winner(
        db_session, them, other, created_at=BASE_TIME + timedelta(hours=1)
    )

    response = await api_client.get(f"/v1/players/{me.id}/matches")
    assert response.json()["total"] == 1


async def test_list_player_matches_404_when_player_missing(
    api_client: AsyncClient, db_session: AsyncSession
):
    import uuid as _uuid

    await start_session(api_client, db_session)
    response = await api_client.get(f"/v1/players/{_uuid.uuid4()}/matches")
    assert response.status_code == 404


async def test_list_player_matches_requires_a_session(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The matches endpoint backs page 2+ of the authed profile page, so it
    requires a session like the rest of `/players`."""
    target = await make_user(db_session, "needs.auth.matches")
    async with make_client() as client:
        response = await client.get(f"/v1/players/{target.id}/matches")
    assert response.status_code == 401
    assert api_client is not None
