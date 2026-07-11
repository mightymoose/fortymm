from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.leagues import get_default_league
from app.models import (
    League,
    LeagueMembership,
    LeagueVisibility,
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
from app.players import PERCENTILE_MIN_RATED_PLAYERS
from app.ratings.stats import STREAK_SCAN_LIMIT, Streak, best_win_streak
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
    league: League | None = None,
    games: Sequence[tuple[int, int]] | None = None,
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
    even though it is decided.

    ``league`` defaults to the default league; pass another to play the match on
    a different ladder (the profile's rating facts are league-scoped).

    ``games`` seeds per-game scores as ``(winner_points, loser_points)`` pairs —
    the rows career's games-won share is computed from. Omitted, the match is
    decided but has no scored games, which is the shape most W-L assertions want.

    A completed match is stamped with ``completed_at`` (mirroring
    ``Match.mark_completed``): the streak scan orders by it, so a NULL there
    would make a streak's *length* — not merely its ordering — undefined."""
    settings = MatchSettings(team_size=1, best_of=5, affects_rating=affects_rating)
    league = league or await get_default_league(db_session)
    completed = status == MatchStatus.completed
    match = Match(
        match_settings=settings,
        league=league,
        created_by_user_id=winner.id,
        status=status,
        created_at=created_at,
        updated_at=created_at,
        completed_at=created_at if completed else None,
    )
    side1 = MatchSide(match=match, side_number=1, won=True if completed else None)
    side1.players.append(MatchSidePlayer(match=match, user=winner))
    side2 = MatchSide(match=match, side_number=2, won=False if completed else None)
    side2.players.append(MatchSidePlayer(match=match, user=loser))
    for game_number, (winner_points, loser_points) in enumerate(games or [], start=1):
        game = MatchGame(match=match, game_number=game_number)
        game.score = MatchGameScore(
            side_1_points=winner_points, side_2_points=loser_points
        )
        match.games.append(game)
    if signed_by is not None:
        result = MatchResult(submitted_by_user_id=signed_by.id, games=[])
        match.results.append(result)
    db_session.add(match)
    await db_session.commit()
    return match


async def _rate(
    db_session: AsyncSession,
    user: User,
    rating_value: float | None,
    league: League | None = None,
) -> None:
    """Attach a ``UserLeagueRating`` to ``user`` (default league unless another
    is named — a rating belongs to exactly one ladder). A ``None``
    ``rating_value`` models a player who has a rating row but has never
    finished a rated match (unranked)."""
    league = league or await get_default_league(db_session)
    db_session.add(
        UserLeagueRating(
            league_id=league.id,
            user_id=user.id,
            rating_strategy_id=league.rating_strategy_id,
            rating_value=rating_value,
        )
    )
    await db_session.commit()


async def _join_league(
    db_session: AsyncSession, user: User, league: League | None = None
) -> None:
    """Enrol ``user`` in a league. ``make_user`` builds a bare row, so a test
    that cares about `career.league_count` has to state the memberships it
    means — the API's own signup path (``add_user_to_default_league``) joins
    every real user to the default league."""
    league = league or await get_default_league(db_session)
    db_session.add(LeagueMembership(league_id=league.id, user_id=user.id))
    await db_session.commit()


async def _record_results(
    db_session: AsyncSession,
    target: User,
    rival: User,
    results: str,
    *,
    start: datetime = BASE_TIME,
) -> None:
    """Seed one completed match per character of ``results`` (``W``/``L``, from
    ``target``'s perspective), OLDEST FIRST, one match per day from ``start``.

    Bulk, single-commit: the best-streak test needs a history longer than the
    100-match scan cap, and a commit per match makes that test crawl.
    """
    league = await get_default_league(db_session)
    for offset, outcome in enumerate(results):
        target_won = outcome == "W"
        at = start + timedelta(days=offset)
        match = Match(
            match_settings=MatchSettings(team_size=1, best_of=5, affects_rating=False),
            league=league,
            created_by_user_id=target.id,
            status=MatchStatus.completed,
            created_at=at,
            updated_at=at,
            completed_at=at,
        )
        mine = MatchSide(match=match, side_number=1, won=target_won)
        mine.players.append(MatchSidePlayer(match=match, user=target))
        theirs = MatchSide(match=match, side_number=2, won=not target_won)
        theirs.players.append(MatchSidePlayer(match=match, user=rival))
        db_session.add(match)
    await db_session.commit()


async def _record_rating_change(
    db_session: AsyncSession,
    user: User,
    match: Match,
    *,
    before: float,
    after: float,
    league: League | None = None,
) -> None:
    """Seed the ``RatingHistory`` row a rated match writes when it completes —
    the audit row the profile's per-row Δ column is read from. ``league``
    defaults to the default league; it must name the league the match was played
    on, since a rating change belongs to one ladder."""
    league = league or await get_default_league(db_session)
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


# ---------------------------------------------------------------------------
# The hero's standing block: member_since / rating_delta / peak / rank_of /
# percentile, plus the ten-result form window.
# ---------------------------------------------------------------------------


async def _rated_cohort(
    db_session: AsyncSession, prefix: str, count: int
) -> list[User]:
    """Seed ``count`` rated players in the default league in ONE commit — the
    ladder population the hero's ``rank_of`` counts and the percentile gate is
    measured against. Ratings ascend from 1400 and stay well below any rating a
    test gives its headline player, so the target keeps rank 1."""
    league = await get_default_league(db_session)
    users = [User(username=f"{prefix}{i}") for i in range(count)]
    db_session.add_all(users)
    await db_session.flush()
    db_session.add_all(
        [
            UserLeagueRating(
                league_id=league.id,
                user_id=user.id,
                rating_strategy_id=league.rating_strategy_id,
                rating_value=1400.0 + i,
            )
            for i, user in enumerate(users)
        ]
    )
    await db_session.commit()
    return users


async def test_get_player_reports_when_the_player_joined(
    api_client: AsyncClient, db_session: AsyncSession
):
    """``member_since`` is the PLAYER's ``created_at`` — the hero's "Member
    since March 2025" line — not the age of their history.

    The match is created deliberately far away from the account, so the obvious
    mutant (reading the first/last match's ``created_at``, or stamping "now")
    reports a different instant and reds."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "since.target")
    rival = await make_user(db_session, "since.rival")
    await _record_match_with_winner(
        db_session, target, rival, created_at=BASE_TIME + timedelta(days=400)
    )

    body = (await api_client.get(f"/v1/players/{target.id}")).json()
    assert datetime.fromisoformat(body["member_since"]) == target.created_at


async def test_get_player_rating_delta_is_the_most_recent_rated_match(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The hero's Δ chip carries the rating change from the player's most recent
    RATED match — not their first one, and not their most recent match.

    Three matches: an older rated win (+24), a newer rated loss (-12), and a
    newest match that is decided but UNRATED (so it writes no history row and
    moved no rating). The chip must read the rated loss:

    * a mutant reading the OLDEST rated match reports +24;
    * a mutant reading the most recent match *of any kind* finds no history row
      for the unrated one and reports ``null``;
    * a mutant summing the history reports +12.

    And it is the same change the newest rated row shows in its own Δ column —
    the hero and the Recent-matches card cannot disagree."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "delta.hero")
    rival = await make_user(db_session, "delta.rival")
    await _rate(db_session, target, 1512.0)

    older = await _record_match_with_winner(
        db_session, target, rival, created_at=BASE_TIME, affects_rating=True
    )
    await _record_rating_change(db_session, target, older, before=1500.0, after=1524.0)
    newer = await _record_match_with_winner(
        db_session,
        rival,
        target,
        created_at=BASE_TIME + timedelta(days=1),
        affects_rating=True,
    )
    await _record_rating_change(db_session, target, newer, before=1524.0, after=1512.0)
    # Newest of all — decided, but unrated, so it moved no rating at all.
    await _record_match_with_winner(
        db_session,
        target,
        rival,
        created_at=BASE_TIME + timedelta(days=2),
        affects_rating=False,
    )

    body = (await api_client.get(f"/v1/players/{target.id}")).json()
    assert body["rating_delta"] == {"before": 1524.0, "after": 1512.0, "delta": -12.0}
    # The hero agrees with the newest rated row of the Recent-matches card.
    rows = {item["id"]: item for item in body["matches"]["items"]}
    assert rows[str(newer.id)]["rating_change"] == body["rating_delta"]


async def test_get_player_rating_delta_is_null_never_zero_without_a_rated_match(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A player who has never finished a RATED match has NO rating change —
    ``null``, never ``0``. A zero would claim a rated match moved their rating by
    nothing, which is a different (and false) statement from "no rated match has
    ever been played".

    The player here has decided matches (1-1), so a mutant that keys the chip off
    "has any completed match" and defaults the delta to zero reds."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "nodelta.target")
    rival = await make_user(db_session, "nodelta.rival")
    await _record_match_with_winner(
        db_session, target, rival, created_at=BASE_TIME, affects_rating=False
    )
    await _record_match_with_winner(
        db_session,
        rival,
        target,
        created_at=BASE_TIME + timedelta(days=1),
        affects_rating=False,
    )

    body = (await api_client.get(f"/v1/players/{target.id}")).json()
    assert body["wins"] == 1
    assert body["losses"] == 1
    assert body["rating_delta"] is None


async def test_get_player_peak_is_the_highest_rating_ever_held(
    api_client: AsyncClient, db_session: AsyncSession
):
    """``peak`` is the highest rating the player has EVER held in this league
    (CONTEXT.md, "Peak rating") — read off the rating timeline, so it survives a
    subsequent slide.

    The player climbed to 1600 and then fell back to 1480: peak is 1600, and a
    mutant that echoes the current rating (or the latest history row) reports
    1480 and reds."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "peak.target")
    rival = await make_user(db_session, "peak.rival")
    await _rate(db_session, target, 1480.0)

    climb = await _record_match_with_winner(
        db_session, target, rival, created_at=BASE_TIME, affects_rating=True
    )
    await _record_rating_change(db_session, target, climb, before=1500.0, after=1600.0)
    slide = await _record_match_with_winner(
        db_session,
        rival,
        target,
        created_at=BASE_TIME + timedelta(days=1),
        affects_rating=True,
    )
    await _record_rating_change(db_session, target, slide, before=1600.0, after=1480.0)

    body = (await api_client.get(f"/v1/players/{target.id}")).json()
    assert body["rating"] == 1480.0
    assert body["peak"] == 1600.0


async def test_get_player_standing_is_scoped_to_the_requested_league(
    api_client: AsyncClient, db_session: AsyncSession
):
    """``rating_delta`` and ``peak`` are LEAGUE-SCOPED facts, like ``rating``
    and ``rank`` (CONTEXT.md, "Career" — rating, rank, peak and confidence are
    all about one ladder). A profile scoped to the default league must not read
    a rating the player earned on a different one.

    The player is mid-table here (1520, peaked at 1520) and a star in a side
    league (1950, and a NEWER rated match there). Both cross-league guards are
    load-bearing and this pins them:

    * drop the league filter from ``latest_rated_match_change`` and the newer
      side-league match wins the ordering → the hero reports +50;
    * drop it from ``league_peak_rating`` and the side league's 1950 becomes the
      "highest rating ever held" → the hero reports a peak this player has never
      reached on this ladder.

    Without this test both filters are deletable with the suite still green."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "scoped.target")
    rival = await make_user(db_session, "scoped.rival")
    home_league = await get_default_league(db_session)
    assert home_league is not None
    side_league = League(
        name="Side League",
        description="Another ladder entirely.",
        visibility=LeagueVisibility.private,
        is_default=False,
        rating_strategy_id=home_league.rating_strategy_id,
    )
    db_session.add(side_league)
    await db_session.commit()
    await db_session.refresh(side_league)

    # On the default ladder: one rated win, 1500 → 1520.
    await _rate(db_session, target, 1520.0)
    home = await _record_match_with_winner(
        db_session, target, rival, created_at=BASE_TIME, affects_rating=True
    )
    await _record_rating_change(db_session, target, home, before=1500.0, after=1520.0)

    # On the side ladder: a NEWER rated win, and a far higher rating.
    away = await _record_match_with_winner(
        db_session,
        target,
        rival,
        created_at=BASE_TIME + timedelta(days=1),
        affects_rating=True,
        league=side_league,
    )
    await _record_rating_change(
        db_session, target, away, before=1900.0, after=1950.0, league=side_league
    )

    # The profile with no `league_id` is scoped to the default league.
    body = (await api_client.get(f"/v1/players/{target.id}")).json()
    assert body["rating"] == 1520.0
    # The side league's match is newer AND bigger — and belongs to another ladder.
    assert body["rating_delta"] == {"before": 1500.0, "after": 1520.0, "delta": 20.0}
    # The ceiling of THIS ladder — never the 1950 held on the other one.
    assert body["peak"] == 1520.0


async def test_get_player_unrated_has_no_standing_at_all(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A player who has never finished a rated match has no rating — and so no
    rank, no ladder to be ranked on, no peak, no percentile and no Δ. Every
    standing field is ``null``.

    The seed rating (1500) is the trap: a mutant that reports a peak of 1500 for
    a player who has never been rated presents the starting value as an
    achievement, and reds here."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "unrated.target")
    rival = await make_user(db_session, "unrated.rival")
    # Rated peers exist, so a non-null `rank_of` can't be excused as "no ladder".
    await _rate(db_session, rival, 1600.0)
    await _record_match_with_winner(
        db_session, target, rival, created_at=BASE_TIME, affects_rating=False
    )

    body = (await api_client.get(f"/v1/players/{target.id}")).json()
    assert body["rating"] is None
    assert body["rank"] is None
    assert body["rank_of"] is None
    assert body["peak"] is None
    assert body["percentile"] is None
    assert body["rating_delta"] is None


async def test_get_player_rank_of_is_the_size_of_the_rated_ladder(
    api_client: AsyncClient, db_session: AsyncSession
):
    """``rank_of`` is the DENOMINATOR of the hero's "#2 of 4" — the size of the
    exact population the rank is drawn from: non-merged, RATED members of this
    league.

    Six users exist here, but only four are on the ladder: three rated players
    plus the viewer (who joined the default league when their session was minted,
    which seeds them a rating row and so a rung of their own). The two the ladder
    refuses are a tombstoned (merged-away) ghost — which, admitted, would also
    push the target from rank 2 to 3 — and a member whose rating row has never
    been scored. So ``rank_of`` is 4: not 6 (counting every user), not 5 (letting
    either of those two in).

    ``rank <= rank_of`` is the invariant that makes the pair honest."""
    await start_session(api_client, db_session)
    top = await make_user(db_session, "ladder.top")
    target = await make_user(db_session, "ladder.target")
    bottom = await make_user(db_session, "ladder.bottom")
    ratingless = await make_user(db_session, "ladder.ratingless")
    ghost = await make_user(db_session, "ladder.ghost")
    await _rate(db_session, top, 1700.0)
    await _rate(db_session, target, 1600.0)
    await _rate(db_session, bottom, 1500.0)
    # A rating row that has never been scored — on the roster, off the ladder.
    await _rate(db_session, ratingless, None)
    # Outrates everyone, but it's a tombstone: not a player, not a rank.
    await _rate(db_session, ghost, 3000.0)
    ghost.merged_into_user_id = top.id
    await db_session.commit()

    body = (await api_client.get(f"/v1/players/{target.id}")).json()
    assert body["rank"] == 2
    # top + target + bottom + the viewer = four rungs. The ghost and the
    # rating-less member are the two the ladder refuses.
    assert body["rank_of"] == 4
    assert body["rank"] <= body["rank_of"]


async def test_get_player_withholds_percentile_until_the_ladder_is_big_enough(
    api_client: AsyncClient, db_session: AsyncSession
):
    """ "Top N%" is withheld while the league is too small for it to mean
    anything: in a tiny league the top player's "top 2%" only ever restates
    "you are first", dressed up as a statistic.

    One rated player below the floor and the percentile is ``null`` — while
    ``rank`` and ``rank_of`` (which do not pretend to be statistics) stay
    populated, so this is a withheld percentile, not a broken hero. Add the
    player that tips the ladder to exactly ``PERCENTILE_MIN_RATED_PLAYERS`` and
    the real number appears.

    The floor is read from the constant, not hardcoded: the number is provisional
    and this test must follow it. A mutant that drops the gate reds on the first
    half; one that never emits a percentile reds on the second."""
    # The viewer occupies a rung too — minting their session joins them to the
    # default league, which seeds them a rating row.
    await start_session(api_client, db_session)
    target = await make_user(db_session, "pct.target")
    await _rate(db_session, target, 1700.0)
    # viewer + target + peers == one short of the floor.
    await _rated_cohort(db_session, "pct.peer", PERCENTILE_MIN_RATED_PLAYERS - 3)

    body = (await api_client.get(f"/v1/players/{target.id}")).json()
    assert body["rank"] == 1
    assert body["rank_of"] == PERCENTILE_MIN_RATED_PLAYERS - 1
    assert body["percentile"] is None

    # One more rated player and the ladder is exactly at the floor.
    await _rated_cohort(db_session, "pct.tipper", 1)

    body = (await api_client.get(f"/v1/players/{target.id}")).json()
    assert body["rank_of"] == PERCENTILE_MIN_RATED_PLAYERS
    # The strongest of fifty reads "Top 2%" — a real number off the real ladder,
    # not a placeholder.
    assert body["percentile"] == 2


async def test_get_player_form_is_ten_results_long(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The profile is where a player is actually studied, so ``form`` is a TEN-
    result window (newest first), not five.

    Twelve decided matches — seven wins, then five losses — so the string is
    pinned at both ends: a five-wide window reports "LLLLL" and reds, and an
    uncapped one reports twelve characters and reds."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "form.target")
    rival = await make_user(db_session, "form.rival")
    for day in range(7):
        await _record_match_with_winner(
            db_session, target, rival, created_at=BASE_TIME + timedelta(days=day)
        )
    for day in range(7, 12):
        await _record_match_with_winner(
            db_session, rival, target, created_at=BASE_TIME + timedelta(days=day)
        )

    body = (await api_client.get(f"/v1/players/{target.id}")).json()
    assert body["wins"] == 7
    assert body["losses"] == 5
    # Newest-first: the five losses, then five of the seven wins. The two oldest
    # wins fall outside the window.
    assert body["form"] == "LLLLLWWWWW"


async def test_list_players_roster_serves_the_same_ten_result_form(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The roster still behaves after the window widened. ``form`` is ONE shared
    field on ``PlayerSummary``, so `/players` now receives the same ten results
    the profile does and slices the first five for its dots column — a deliberate
    trade, and the reason there is no second, roster-width form field.

    This pins that trade from the roster's side: a "fix" that re-narrows the
    roster's form server-side (or adds a separate five-wide field for it) reds
    here. The rest of the row is asserted alongside it so a regression in the
    roster's shape can't hide behind the form string."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "roster.form")
    rival = await make_user(db_session, "roster.rival")
    await _rate(db_session, target, 1600.0)
    for day in range(7):
        await _record_match_with_winner(
            db_session, target, rival, created_at=BASE_TIME + timedelta(days=day)
        )
    for day in range(7, 12):
        await _record_match_with_winner(
            db_session, rival, target, created_at=BASE_TIME + timedelta(days=day)
        )

    response = await api_client.get("/v1/players", params={"q": "roster.form"})
    assert response.status_code == 200
    items = response.json()["items"]
    assert len(items) == 1
    row = items[0]
    assert row["form"] == "LLLLLWWWWW"
    assert row["wins"] == 7
    assert row["losses"] == 5
    assert row["rank"] == 1
    # The hero's standing fields are profile-only — they must NOT have leaked
    # onto the shared summary the roster serializes.
    assert "member_since" not in row
    assert "rank_of" not in row
    assert "peak" not in row


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


# ----- career (cross-league) ------------------------------------------------


def test_best_win_streak_finds_the_longest_run_wherever_it_sits():
    """The fold itself: the longest winning run may sit anywhere in the history
    — at the head, buried in the middle, or at the very tail — and losses break
    it. Pins the two off-by-ones an endpoint test whose best run happens to be at
    one end would miss."""
    # Newest-first: a 2-run at the head, a 4-run buried behind it.
    assert best_win_streak(_results("WWLWWWWL")) == Streak(kind="W", n=4)
    # …and one at the very tail, with nothing after it to close the run.
    assert best_win_streak(_results("LWWW")) == Streak(kind="W", n=3)
    # Ties keep the first-seen length, not a doubled one.
    assert best_win_streak(_results("WWLWW")) == Streak(kind="W", n=2)
    assert best_win_streak(_results("LLL")) is None
    assert best_win_streak([]) is None


def _results(outcomes: str) -> list[bool]:
    """``"WLW"`` → ``[True, False, True]`` — the newest-first won-flag sequence
    ``completed_results`` returns."""
    return [outcome == "W" for outcome in outcomes]


async def test_get_player_career_counts_only_decided_matches_not_the_history(
    api_client: AsyncClient, db_session: AsyncSession
):
    """``career.decided`` counts matches with a WIN OR A LOSS. ``match_total``
    counts the all-inclusive history. They sit on the same page and they differ
    on purpose (CONTEXT.md, "Career"; ADR-0915).

    Six matches: three decided (two wins, a loss), one still in play, one not
    started, one voided. So ``decided`` is 3 while ``match_total`` is 6 — and a
    mutant that reaches for ``match_total`` (or lets a voided / in-play match
    into the count) reds, because ``wins + losses`` would no longer add up to
    ``decided`` either."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "career.target")
    rival = await make_user(db_session, "career.rival")
    await _record_match_with_winner(db_session, target, rival, created_at=BASE_TIME)
    await _record_match_with_winner(
        db_session, target, rival, created_at=BASE_TIME + timedelta(days=1)
    )
    await _record_match_with_winner(
        db_session, rival, target, created_at=BASE_TIME + timedelta(days=2)
    )
    # In play, not started, and voided: history, but nobody's career.
    await _record_match_with_winner(
        db_session,
        target,
        rival,
        created_at=BASE_TIME + timedelta(days=3),
        status=MatchStatus.in_progress,
    )
    await _record_match_with_winner(
        db_session,
        target,
        rival,
        created_at=BASE_TIME + timedelta(days=4),
        status=MatchStatus.pending,
    )
    await _record_match_with_winner(
        db_session,
        target,
        rival,
        created_at=BASE_TIME + timedelta(days=5),
        status=MatchStatus.voided,
    )

    body = (await api_client.get(f"/v1/players/{target.id}")).json()
    career = body["career"]
    assert career["decided"] == 3
    assert career["wins"] == 2
    assert career["losses"] == 1
    assert career["wins"] + career["losses"] == career["decided"]
    # A share, never a percent string and never a rounded integer.
    assert career["win_rate"] == 2 / 3
    # The whole history — three more matches than the career counts.
    assert body["match_total"] == 6
    assert career["decided"] < body["match_total"]


async def test_get_player_career_is_cross_league_while_the_rating_is_not(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The defining property (ADR-0915): asking for the same player in two
    different leagues returns two different RATINGS and the SAME CAREER.

    The target is mid-table at home (1520) and a star in a side league (1950),
    and their decided matches are split across both ladders: two wins at home, a
    loss away. Career must report all three regardless of which league was asked
    for — so a league-scoped career reds twice over (3 becomes 2 or 1, and the
    two responses stop agreeing), and a career that quietly followed the requested
    league would make ``career`` differ between the two calls, which the block
    equality forbids."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "xleague.target")
    rival = await make_user(db_session, "xleague.rival")
    home_league = await get_default_league(db_session)
    assert home_league is not None
    side_league = League(
        name="Side League",
        description="Another ladder entirely.",
        visibility=LeagueVisibility.private,
        is_default=False,
        rating_strategy_id=home_league.rating_strategy_id,
    )
    db_session.add(side_league)
    await db_session.commit()
    await db_session.refresh(side_league)

    await _join_league(db_session, target, home_league)
    await _join_league(db_session, target, side_league)
    await _rate(db_session, target, 1520.0, league=home_league)
    await _rate(db_session, target, 1950.0, league=side_league)

    # Two wins on the home ladder…
    await _record_match_with_winner(db_session, target, rival, created_at=BASE_TIME)
    await _record_match_with_winner(
        db_session, target, rival, created_at=BASE_TIME + timedelta(days=1)
    )
    # …and a loss on the other one.
    await _record_match_with_winner(
        db_session,
        rival,
        target,
        created_at=BASE_TIME + timedelta(days=2),
        league=side_league,
    )

    home = (await api_client.get(f"/v1/players/{target.id}")).json()
    away = (
        await api_client.get(f"/v1/players/{target.id}?league_id={side_league.id}")
    ).json()

    # The rating half of the page is a fact about the ladder — it moves.
    assert home["rating"] == 1520.0
    assert away["rating"] == 1950.0
    assert home["rating"] != away["rating"]

    # The career half is a fact about the person — it does not.
    assert home["career"] == away["career"]
    assert home["career"]["decided"] == 3
    assert home["career"]["wins"] == 2
    assert home["career"]["losses"] == 1
    # Both memberships, on either request.
    assert home["career"]["league_count"] == 2


async def test_get_player_career_games_won_is_a_share_of_games_not_of_matches(
    api_client: AsyncClient, db_session: AsyncSession
):
    """``games_won_pct`` is the share of individual GAMES the player took across
    their decided matches (CONTEXT.md, "Games won") — not a second spelling of
    the match win rate.

    A 3-2 win and a 0-3 loss: an even 1-1 in the W-L column (``win_rate`` 0.5),
    but only three of the eight games played (0.375). Any mutant that reports the
    match win rate reds. A live match's already-scored games (two more the target
    took) are seeded too: count them and the share climbs to 0.5 — i.e. straight
    back onto the win rate — so the "decided matches only" gate is load-bearing
    here, not decorative.

    Both numbers are SHARES in [0, 1]: 0.375, never 37.5."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "games.target")
    rival = await make_user(db_session, "games.rival")
    # Won 3-2: five games, the target took three.
    await _record_match_with_winner(
        db_session,
        target,
        rival,
        created_at=BASE_TIME,
        games=[(11, 9), (9, 11), (11, 7), (8, 11), (11, 6)],
    )
    # Lost 0-3: three games, the target took none.
    await _record_match_with_winner(
        db_session,
        rival,
        target,
        created_at=BASE_TIME + timedelta(days=1),
        games=[(11, 5), (11, 7), (11, 9)],
    )
    # In play: two games already on the board, both the target's. Not career.
    await _record_match_with_winner(
        db_session,
        target,
        rival,
        created_at=BASE_TIME + timedelta(days=2),
        status=MatchStatus.in_progress,
        games=[(11, 4), (11, 6)],
    )

    career = (await api_client.get(f"/v1/players/{target.id}")).json()["career"]
    assert career["wins"] == 1
    assert career["losses"] == 1
    assert career["win_rate"] == 0.5
    # Three of the eight games in the two DECIDED matches.
    assert career["games_won_pct"] == 0.375
    assert career["games_won_pct"] != career["win_rate"]


async def test_get_player_career_best_streak_outlives_the_current_run_and_the_scan_cap(
    api_client: AsyncClient, db_session: AsyncSession
):
    """``best_streak`` is the longest WINNING run the player has ever put
    together (CONTEXT.md, "Streak") — an all-time fact, so neither the run they
    happen to be on nor the streak scan's window may truncate it.

    The history is five wins and then a losing run LONGER than
    ``STREAK_SCAN_LIMIT``, so the winning run sits entirely outside the
    hundred-match window the dashboard's current-streak read scans. Two mutants
    die here:

    * best streak returning the *current* one → ``{"kind": "L", ...}``;
    * best streak folding a capped scan (``limit=STREAK_SCAN_LIMIT``) → it sees
      only losses and reports ``null``.

    The current streak is asserted uncapped too: fold the same capped scan and it
    reports 100, not 105."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "streak.target")
    rival = await make_user(db_session, "streak.rival")
    losing_run = STREAK_SCAN_LIMIT + 5
    # Oldest first: the wins, then a very long slump.
    await _record_results(db_session, target, rival, "W" * 5 + "L" * losing_run)

    career = (await api_client.get(f"/v1/players/{target.id}")).json()["career"]
    assert career["decided"] == 5 + losing_run
    assert career["wins"] == 5
    assert career["losses"] == losing_run
    assert career["current_streak"] == {"kind": "L", "n": losing_run}
    # Buried more than STREAK_SCAN_LIMIT matches back — and still their best.
    assert career["best_streak"] == {"kind": "W", "n": 5}


async def test_get_player_career_best_streak_is_null_for_a_player_who_never_won(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A best streak is a *winning* run, so a player who has only ever lost has
    none — ``null``, not a zero-length ``{"kind": "L", "n": 3}`` (which would
    report their worst run as their best) and not ``{"kind": "W", "n": 0}``
    (which the Streak invariant forbids).

    They do have a current streak: three losses is a run they are very much on."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "winless.target")
    rival = await make_user(db_session, "winless.rival")
    await _record_results(db_session, target, rival, "LLL")

    career = (await api_client.get(f"/v1/players/{target.id}")).json()["career"]
    assert career["decided"] == 3
    assert career["wins"] == 0
    assert career["current_streak"] == {"kind": "L", "n": 3}
    assert career["best_streak"] is None
    # Decided three matches and won none of them: an honest 0.0, unlike the
    # `null` a player with nothing decided gets.
    assert career["win_rate"] == 0.0


async def test_get_player_career_is_present_and_empty_for_a_player_with_no_matches(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A player who has never finished a match still HAS a career block — every
    rate is ``null`` (0/0 is undefined; a 0.0 win rate would claim they win none
    of the matches they play), both streaks are ``null``, and the league count is
    still 1, because they belong to the default league whether or not they have
    ever played in it.

    The viewer is used as the subject precisely because minting their session is
    what joins them to the default league — a `league_count` derived from the
    leagues they have *played* in would read 0 here and reds."""
    viewer = await start_session(api_client, db_session)

    career = (await api_client.get(f"/v1/players/{viewer.id}")).json()["career"]
    assert career == {
        "decided": 0,
        "wins": 0,
        "losses": 0,
        "win_rate": None,
        "games_won_pct": None,
        "current_streak": None,
        "best_streak": None,
        "league_count": 1,
    }
