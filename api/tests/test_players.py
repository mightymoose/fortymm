import uuid
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.leagues import get_default_league, seed_user_league_rating
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
    RatingStrategy,
    User,
    UserLeagueRating,
)
from app.ratings.history import MAX_POINTS, downsample
from app.ratings.stats import (
    PERCENTILE_MIN_RATED_PLAYERS,
    STREAK_SCAN_LIMIT,
    Streak,
    best_win_streak,
)
from app.schemas.rating import RatingPoint
from tests._helpers import (
    accept_standing_result,
    make_client,
    make_user,
    opponent_session,
    start_session,
)

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
    # `freshface` is seeded EXACTLY as production seeds a new member on join — a
    # 1500 row and an `initial` event — so the picker's chip is a real test of the
    # rating read and not of a NULL column: the typeahead must show them Unrated,
    # not hand them the league's prior as a rating.
    seed_user_league_rating(db_session, league.id, freshface.id, league.rating_strategy)
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
    """Attach a bare ``UserLeagueRating`` SNAPSHOT to ``user`` (default league
    unless another is named — a rating belongs to exactly one ladder).

    THIS ALONE DOES NOT MAKE THEM RATED, and it is not meant to: it is precisely
    the shape production seeds a member with when they JOIN a league (a
    ``rating_value``, nothing having moved it). The read side asks whether
    anything has (``app.ratings.rated``), so a player seeded only through here
    still reads Unrated — no rating, no rank, no peak, no confidence.

    Use it where the rating's PROVENANCE is seeded separately and would be
    double-counted otherwise: the chart tests below pair it with ``_rated_win``,
    which writes the match-sourced history rows their timeline is made of. To
    hand a player a rating outright — the roster, rank and hero tests — use
    ``_earn_rating``, which writes the provenance too. A ``None``
    ``rating_value`` is the manual-strategy shape: a row awaiting its import.
    """
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


def _provenance(
    user: User,
    league: League,
    rating_value: float,
    *,
    state: dict | None = None,
    source: RatingHistorySource = RatingHistorySource.manual,
) -> RatingHistory:
    """The rating-history row that makes a seeded number an actual RATING.

    Production writes a 1500 ``UserLeagueRating`` and an ``initial`` history event
    the moment a user JOINS a league — i.e. at session-mint, before they have
    played a thing. So "has a rating row" is true of every member, and the read
    side deliberately asks a different question: has anything MOVED that row?
    (``app.ratings.rated`` — a history row whose source is not ``initial``.)

    A test that hands a player a ``rating_value`` and stops has therefore built a
    shape production never produces — a rating with no provenance — and any
    "is this player rated?" assertion written over it is vacuous. That fiction is
    exactly why this suite stayed green while the QA stack rendered a guest who had
    never played anything at 1500, peak 1500, rank #2 of 5.

    A ``manual`` override is the cheapest production shape that carries provenance:
    an admin wrote this number. Tests whose subject is the rating TIMELINE seed a
    rated match instead (``_rated_win``) — a manual row is a legitimate point on
    the chart and would move their line.
    """
    return RatingHistory(
        league_id=league.id,
        user_id=user.id,
        match_id=None,
        rating_strategy_id=league.rating_strategy_id,
        rating_value=rating_value,
        rating_state=state or {"rating": rating_value, "rd": 200.0, "volatility": 0.06},
        previous_rating_value=None,
        source=source,
        # Far enough back to be nobody's chart window: these players' ratings are
        # a premise, not a timeline.
        created_at=BASE_TIME - timedelta(days=730),
    )


async def _earn_rating(
    db_session: AsyncSession,
    user: User,
    rating_value: float,
    league: League | None = None,
) -> None:
    """Give ``user`` a rating they actually HOLD on a ladder: the
    ``UserLeagueRating`` snapshot AND the history row that moved it
    (``_provenance``). The seeding shape for every test whose player is meant to
    be rated — rating, rank, rank_of, peak, percentile, confidence."""
    league = league or await get_default_league(db_session)
    await _rate(db_session, user, rating_value, league)
    db_session.add(_provenance(user, league, rating_value))
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
    at: datetime | None = None,
) -> None:
    """Seed the ``RatingHistory`` row a rated match writes when it completes —
    the audit row the profile's per-row Δ column is read from. ``league``
    defaults to the default league; it must name the league the match was played
    on, since a rating change belongs to one ladder.

    ``at`` stamps the row's ``created_at``. In production a match row's
    ``created_at`` IS its match's ``completed_at`` (ADR-0012: the live path writes
    in the same transaction as ``mark_completed``, and the recompute stamps it
    explicitly), so a test placing a rating change in the past must move BOTH — the
    match's completion instant and the audit row — or the row it seeds is a shape
    production never produces. Omitted, the row takes the server's ``now()``, which
    is what every non-calendar test wants."""
    league = league or await get_default_league(db_session)
    row = RatingHistory(
        league_id=league.id,
        user_id=user.id,
        match_id=match.id,
        rating_strategy_id=league.rating_strategy_id,
        rating_value=after,
        rating_state={"rating": after, "rd": 200.0, "volatility": 0.06},
        previous_rating_value=before,
        source=RatingHistorySource.match,
    )
    if at is not None:
        row.created_at = at
    db_session.add(row)
    await db_session.commit()


def _rank_for(items: list[dict], username: str):
    for player in items:
        if player["username"] == username:
            return player["rank"]
    raise KeyError(username)


def _rating_for_item(items: list[dict], username: str):
    for player in items:
        if player["username"] == username:
            return player["rating"]
    raise KeyError(username)


async def test_list_players_rank_is_none_for_unrated_player(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A player with no rating (never finished a rated match) has no rank —
    no rating, no ladder position."""
    await start_session(api_client, db_session)
    rated = await make_user(db_session, "rank.rated")
    unrated = await make_user(db_session, "rank.unrated")
    await _earn_rating(db_session, rated, 1600.0)
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
    await _earn_rating(db_session, top_a, 1800.0)
    await _earn_rating(db_session, top_b, 1800.0)
    await _earn_rating(db_session, lower, 1500.0)

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
    await _earn_rating(db_session, top, 2000.0)
    await _earn_rating(db_session, second, 1900.0)
    await _earn_rating(db_session, mid, 1800.0)
    await _earn_rating(db_session, fourth, 1700.0)
    await _earn_rating(db_session, fifth, 1600.0)

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
    await _earn_rating(db_session, ghost, 3000.0)
    await _earn_rating(db_session, real_top, 2000.0)
    await _earn_rating(db_session, real_second, 1500.0)

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
    starts with NULL.

    ``rated.none`` is seeded the way PRODUCTION seeds a member who has never played
    — the league's 1500 prior, sitting in a real ``UserLeagueRating`` row — and the
    two rated players straddle it deliberately. Sort on the raw column and they
    land between ``rated.high`` and ``rated.low``: a guest who has never touched a
    bat, wedged into the ladder above a player rated 1400, showing a blank rating
    cell and no rank. The order below is only reachable if the sort key is the
    rating the row will actually RENDER."""
    await start_session(api_client, db_session)
    league = await get_default_league(db_session)
    high = await make_user(db_session, "rated.high")
    low = await make_user(db_session, "rated.low")
    unrated = await make_user(db_session, "rated.none")
    await _earn_rating(db_session, high, 2000.0)
    await _earn_rating(db_session, low, 1400.0)
    seed_user_league_rating(db_session, league.id, unrated.id, league.rating_strategy)
    await db_session.commit()

    response = await api_client.get("/v1/players", params={"q": "rated."})
    items = response.json()["items"]
    usernames = [p["username"] for p in items]
    assert usernames == ["rated.high", "rated.low", "rated.none"]
    # …and the last row is Unrated, not "1500 with no rank".
    assert _rating_for_item(items, "rated.none") is None
    assert _rank_for(items, "rated.none") is None
    assert _rating_for_item(items, "rated.low") == 1400.0


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
    flipped to the headline player (the winner gained what the loser lost).

    Both players HOLD a rating before this match (``_earn_rating``), which is what
    makes it a MOVE and gives the row a ``before`` and a delta to report. A player's
    first rated match is the other case entirely — it establishes their rating rather
    than moving it, and reports neither (#952,
    ``test_get_player_first_rated_match_establishes_the_rating_it_reports``)."""
    await start_session(api_client, db_session)
    winner = await make_user(db_session, "delta.winner")
    loser = await make_user(db_session, "delta.loser")
    await _earn_rating(db_session, winner, 1500.0)
    await _earn_rating(db_session, loser, 1500.0)
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
    rated match still in play (no delta yet).

    ``target`` already HOLDS a rating (``_earn_rating``), so the rated win below moves
    it and has a delta to report. Their first rated match would not — it would
    establish the rating instead (#952) — and that is a third kind of null, on the
    ``delta`` INSIDE a present change rather than on the change itself."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "null.target")
    rival = await make_user(db_session, "null.rival")
    await _earn_rating(db_session, target, 1500.0)

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
    db_session: AsyncSession,
    prefix: str,
    count: int,
    *,
    league: League | None = None,
    base: float = 1400.0,
) -> list[User]:
    """Seed ``count`` rated players on a ladder in ONE commit — the population
    the hero's ``rank_of`` counts and the percentile gate is measured against.

    Ratings ascend from ``base``, which defaults low enough to sit well below any
    rating a test gives its headline player, so the target keeps rank 1. Raise
    ``base`` above the target's rating to seed the opposite shape: a ladder the
    target is at the BOTTOM of.

    ``league`` defaults to the default league; pass another to build a second,
    independent ladder — a rating, a rank and a percentile are each about exactly
    one of them."""
    league = league or await get_default_league(db_session)
    assert league is not None
    users = [User(username=f"{prefix}{i}") for i in range(count)]
    db_session.add_all(users)
    await db_session.flush()
    db_session.add_all(
        [
            UserLeagueRating(
                league_id=league.id,
                user_id=user.id,
                rating_strategy_id=league.rating_strategy_id,
                rating_value=base + i,
            )
            for i, user in enumerate(users)
        ]
    )
    # Each one holds their rating, rather than merely having been handed the
    # league's seed: an unrated member is not part of the population `rank_of`
    # counts, so a cohort seeded without provenance would be a ladder of ghosts —
    # and every rank/percentile assertion measured against it would be vacuous.
    db_session.add_all(
        [_provenance(user, league, base + i) for i, user in enumerate(users)]
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

    # On the default ladder: they already HOLD 1500 (a manual override gave it to
    # them — the cheapest production shape that carries provenance), then a rated win
    # MOVES it: 1500 → 1520. Without the earlier row this match would be their first,
    # which establishes a rating rather than moving one and so reports no delta at all
    # (#952) — a different case, and not this test's subject.
    await _rate(db_session, target, 1520.0)
    db_session.add(_provenance(target, home_league, 1500.0))
    await db_session.commit()
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
    await _earn_rating(db_session, rival, 1600.0)
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
    """``rank_of`` is the DENOMINATOR of the hero's "#2 of 3" — the size of the
    exact population the rank is drawn from: non-merged, RATED members of this
    league.

    Six users exist here and only THREE are on the ladder. The three the ladder
    refuses are the interesting part:

    * a tombstoned (merged-away) ghost, which — admitted — would also push the
      target from rank 2 to 3;
    * a member whose rating row has never been scored (a manual ladder awaiting
      its import): a NULL rating;
    * THE VIEWER, who joined the default league the instant their session was
      minted and was seeded a 1500 row by it, and who has never played a match.
      A rating row is not a rating (``app.ratings.rated``). Count them and the
      league quietly grows a rung for every guest who ever loaded the site — the
      "#2 of 5" a QA pass caught the profile reporting on a ladder of two real
      players.

    So ``rank_of`` is 3: not 6 (every user), not 5, not 4 (letting the seeded
    viewer in). ``rank <= rank_of`` is the invariant that makes the pair honest."""
    await start_session(api_client, db_session)
    top = await make_user(db_session, "ladder.top")
    target = await make_user(db_session, "ladder.target")
    bottom = await make_user(db_session, "ladder.bottom")
    ratingless = await make_user(db_session, "ladder.ratingless")
    ghost = await make_user(db_session, "ladder.ghost")
    await _earn_rating(db_session, top, 1700.0)
    await _earn_rating(db_session, target, 1600.0)
    await _earn_rating(db_session, bottom, 1500.0)
    # A rating row that has never been scored — on the roster, off the ladder.
    await _rate(db_session, ratingless, None)
    # Outrates everyone, but it's a tombstone: not a player, not a rank.
    await _earn_rating(db_session, ghost, 3000.0)
    ghost.merged_into_user_id = top.id
    await db_session.commit()

    body = (await api_client.get(f"/v1/players/{target.id}")).json()
    assert body["rank"] == 2
    # top + target + bottom. The ghost, the rating-less member and the
    # never-played viewer are the three the ladder refuses.
    assert body["rank_of"] == 3
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
    # The viewer does NOT occupy a rung: minting their session joins them to the
    # default league and seeds them a 1500 row, but they have never played a rated
    # match, so they are unrated and outside the population (`app.ratings.rated`).
    # Count them and the ladder tips over the floor an entire player early.
    await start_session(api_client, db_session)
    target = await make_user(db_session, "pct.target")
    await _earn_rating(db_session, target, 1700.0)
    # target + peers == one short of the floor.
    await _rated_cohort(db_session, "pct.peer", PERCENTILE_MIN_RATED_PLAYERS - 2)

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
    await _earn_rating(db_session, target, 1600.0)
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
    await _earn_rating(db_session, target, 1520.0, league=home_league)
    await _earn_rating(db_session, target, 1950.0, league=side_league)

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


# ----- rating confidence (league-scoped) ------------------------------------


async def _rate_glicko2(
    db_session: AsyncSession,
    user: User,
    *,
    rating: float,
    rd: float,
    volatility: float = 0.06,
    league: League | None = None,
) -> None:
    """Rate ``user`` on a Glicko-2 ladder, carrying the full ``rating_state``
    blob a real rated match writes.

    ``rating_value`` mirrors ``state["rating"]``, exactly as every production
    write does (``state_rating_value``) — so these tests never exercise a
    rating/state disagreement that cannot occur.

    ``_rate`` is the weaker sibling: it leaves ``rating_state`` null, which is
    why the tests below all seed through this one — confidence is read out of the
    state, not the column.

    Carries its ``_provenance`` row like ``_earn_rating`` does, and must: a player
    holding nothing but the seed the league gave them is UNRATED, and an unrated
    player has no confidence to report — the card would be reporting the 1500/350
    prior back to them as a finding ("somewhere between 814 and 2186").
    """
    league = league or await get_default_league(db_session)
    assert league is not None
    state = {"rating": rating, "rd": rd, "volatility": volatility}
    db_session.add(
        UserLeagueRating(
            league_id=league.id,
            user_id=user.id,
            rating_strategy_id=league.rating_strategy_id,
            rating_value=rating,
            rating_state=state,
        )
    )
    db_session.add(_provenance(user, league, rating, state=state))
    await db_session.commit()


async def _confidence_for(
    api_client: AsyncClient, player: User, league: League | None = None
) -> dict | None:
    query = "" if league is None else f"?league_id={league.id}"
    response = await api_client.get(f"/v1/players/{player.id}{query}")
    assert response.status_code == 200
    body = response.json()
    confidence: dict | None = body["confidence"]
    return confidence


async def test_get_player_confidence_level_keys_off_the_deviation(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The level is one of provisional / firming_up / settled, keyed off the
    rating's DEVIATION alone (CONTEXT.md, "Rating confidence").

    Every case sits ON or ONE POINT OFF a cut point, so the ladder is pinned in
    both direction and inclusivity:

    * RD 160 reads provisional and RD 159 firming up — swap the two thresholds
      and 159 reads provisional; make the comparison strict (``>``) and 160 reads
      firming up.
    * RD 90 reads firming up and RD 89 settled — the same two mutants red on the
      lower rung.

    A single mid-band sample per level would let any of them through."""
    await start_session(api_client, db_session)
    cases = [
        (350.0, "provisional"),  # the seed RD: the system has no idea yet
        (160.0, "provisional"),  # inclusive floor
        (159.0, "firming_up"),
        (90.0, "firming_up"),  # inclusive floor
        (89.0, "settled"),
        (35.0, "settled"),
    ]
    for index, (rd, expected) in enumerate(cases):
        player = await make_user(db_session, f"conf.level.{index}")
        await _rate_glicko2(db_session, player, rating=1500.0, rd=rd)

        confidence = await _confidence_for(api_client, player)
        assert confidence is not None
        assert confidence["level"] == expected, f"RD {rd}"
        assert confidence["deviation"] == rd


async def test_get_player_confidence_interval_is_the_95_percent_band(
    api_client: AsyncClient, db_session: AsyncSession
):
    """``interval`` is the 95% interval — ``rating ± 1.96 × RD`` — the one
    rigorous number on the card and the one it puts on its face ("we think this
    player is somewhere between…").

    Two players pin it:

    * 1687 ± 1.96×100 → 1491-1883. The rating is deliberately NOT 1500, so a
      mutant centring the band on the seed rating reds; and the multiplier is
      recoverable from the width — 1.0 would give 1587-1787 and 2.0 gives
      1487-1887, both distinct from what we assert.
    * 1500 ± 1.96×137 → half-width 268.52, so the band rounds to 1231-1769 —
      whole rating points, and a truncating mutant reads 1231-1768.

    ``volatility`` rides along untouched (it is display-only: nothing about the
    level or the band is derived from it)."""
    await start_session(api_client, db_session)

    off_centre = await make_user(db_session, "conf.interval.offcentre")
    await _rate_glicko2(
        db_session, off_centre, rating=1687.0, rd=100.0, volatility=0.059
    )
    confidence = await _confidence_for(api_client, off_centre)
    assert confidence is not None
    assert confidence["interval"] == {"low": 1491.0, "high": 1883.0}
    assert confidence["deviation"] == 100.0
    assert confidence["volatility"] == 0.059
    assert confidence["level"] == "firming_up"

    fractional = await make_user(db_session, "conf.interval.fractional")
    await _rate_glicko2(db_session, fractional, rating=1500.0, rd=137.0)
    confidence = await _confidence_for(api_client, fractional)
    assert confidence is not None
    assert confidence["interval"] == {"low": 1231.0, "high": 1769.0}


async def test_get_player_confidence_is_null_for_an_unrated_player(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A player who has never finished a rated match has no rating — the hero
    already says "Unrated" — and so nothing to be confident ABOUT. The whole
    block is ``null`` and the card does not render.

    The row here is the trap, and it is deliberately the hardest version of it:
    it exists (they are on the roster), it has never been scored
    (``rating_value`` null), and it still carries the untouched SEED state —
    rating 1500 at RD 350. Read the state without first checking that there is a
    rating, and the profile confidently reports "provisional, somewhere between
    814 and 2186" for a player it is simultaneously calling Unrated: a card
    rendered about a rating that does not exist. That mutant reds here and
    nowhere else."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "conf.unrated")
    league = await get_default_league(db_session)
    assert league is not None
    db_session.add(
        UserLeagueRating(
            league_id=league.id,
            user_id=target.id,
            rating_strategy_id=league.rating_strategy_id,
            rating_value=None,
            rating_state={"rating": 1500.0, "rd": 350.0, "volatility": 0.06},
        )
    )
    await db_session.commit()

    body = (await api_client.get(f"/v1/players/{target.id}")).json()
    assert body["rating"] is None
    assert body["confidence"] is None


async def test_get_player_confidence_is_null_for_a_manually_rated_player(
    api_client: AsyncClient,
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """A manual (externally-supplied) rating has NO deviation at all — its
    ``rating_state`` is ``{"rating": …}`` and nothing else — so there is no
    confidence to report about it, and the block is ``null`` even though the
    player is very much rated.

    This is the test that proves the state is PARSED and not indexed: reach into
    the blob for ``state["rd"]`` here and it is a ``KeyError`` (a 500 on the
    profile); default it to zero and the card claims an imported USATT number is
    "settled" — the system's most confident possible read on a rating it has
    never once computed."""
    manual_league = League(
        name="USATT",
        description="Ratings imported from outside.",
        visibility=LeagueVisibility.public,
        is_default=False,
        rating_strategy_id=rating_strategies["manual"].id,
    )
    db_session.add(manual_league)
    await db_session.commit()
    await db_session.refresh(manual_league)

    await start_session(api_client, db_session)
    target = await make_user(db_session, "conf.manual")
    db_session.add(
        UserLeagueRating(
            league_id=manual_league.id,
            user_id=target.id,
            rating_strategy_id=manual_league.rating_strategy_id,
            rating_value=1600.0,
            rating_state={"rating": 1600.0},
        )
    )
    # An IMPORT is this ladder's provenance — the whole point of a manual strategy
    # is that the number arrives from outside rather than from a match here. It is
    # a rating they hold (the hero shows 1600, `is_rated_member()` says so), which
    # is what makes this test's subject — that it carries no CONFIDENCE — the thing
    # under test, rather than an accident of the player reading as Unrated.
    db_session.add(
        _provenance(
            target,
            manual_league,
            1600.0,
            state={"rating": 1600.0},
            source=RatingHistorySource.import_,
        )
    )
    await db_session.commit()

    response = await api_client.get(
        f"/v1/players/{target.id}?league_id={manual_league.id}"
    )
    assert response.status_code == 200
    body = response.json()
    # Rated — just not by us.
    assert body["rating"] == 1600.0
    assert body["confidence"] is None


async def test_get_player_confidence_is_scoped_to_the_requested_league(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Confidence describes the player's rating IN THIS LEAGUE, so it follows
    ``league_id`` like rating / rank / peak do — and unlike career (ADR-0915).

    The same player is a newcomer on the default ladder (RD 350, a wide
    provisional band) and a regular on a side ladder (RD 40, a tight settled
    one). Drop the league filter and whichever row the query happens to return
    first decides the answer: the two rows disagree on every field of the block,
    so the mutant cannot survive."""
    await start_session(api_client, db_session)
    home = await get_default_league(db_session)
    assert home is not None
    side_league = League(
        name="Tuesday Nights",
        description="Another ladder entirely.",
        visibility=LeagueVisibility.private,
        is_default=False,
        rating_strategy_id=home.rating_strategy_id,
    )
    db_session.add(side_league)
    await db_session.commit()
    await db_session.refresh(side_league)

    target = await make_user(db_session, "conf.scoped")
    await _rate_glicko2(db_session, target, rating=1500.0, rd=350.0)
    await _rate_glicko2(db_session, target, rating=1820.0, rd=40.0, league=side_league)

    default_confidence = await _confidence_for(api_client, target)
    assert default_confidence is not None
    assert default_confidence["level"] == "provisional"
    assert default_confidence["interval"] == {"low": 814.0, "high": 2186.0}

    side_confidence = await _confidence_for(api_client, target, league=side_league)
    assert side_confidence is not None
    assert side_confidence["level"] == "settled"
    assert side_confidence["interval"] == {"low": 1742.0, "high": 1898.0}


async def test_get_player_confidence_reports_no_percentage(
    api_client: AsyncClient, db_session: AsyncSession
):
    """There is deliberately NO confidence percentage (CONTEXT.md, "Rating
    confidence"): an "86%" is an arbitrary rescaling of RD onto a 0-100 axis and
    says nothing the level and the interval do not say better. The block carries
    exactly four keys, so re-adding one reds here rather than quietly reaching
    the UI."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "conf.keys")
    await _rate_glicko2(db_session, target, rating=1500.0, rd=350.0)

    confidence = await _confidence_for(api_client, target)
    assert confidence is not None
    assert set(confidence) == {"level", "deviation", "volatility", "interval"}


# ----- the league switch: the rating half follows it, career does not -------


async def _side_league(db_session: AsyncSession, name: str) -> League:
    """A second, non-default ladder — the thing that makes league scoping
    observable at all. Shares the default league's rating strategy, so any
    difference between the two responses is about the LEAGUE and never about how
    its ratings are computed."""
    home = await get_default_league(db_session)
    assert home is not None
    league = League(
        name=name,
        description="Another ladder entirely.",
        visibility=LeagueVisibility.private,
        is_default=False,
        rating_strategy_id=home.rating_strategy_id,
    )
    db_session.add(league)
    await db_session.commit()
    await db_session.refresh(league)
    return league


async def test_get_player_every_league_scoped_fact_follows_the_requested_league(
    api_client: AsyncClient, db_session: AsyncSession
):
    """THE defining test of ADR-0915, said once and completely: ask for the same
    player in two different leagues and EVERY rating-flavoured field differs,
    while `career` is byte-identical.

    The target is a big fish in a small pond at home (1520, top of the ladder,
    settled) and a minnow on a side ladder full of stronger players (1490, bottom,
    provisional, and coming off a slide from a 1600 peak). Their four decided
    matches are split across both ladders — two at home, two away — so a career
    that quietly followed the league would report the wrong number twice over.

    Each field pins a DIFFERENT league filter, and every one of them is deletable
    with the rest of the suite green unless it is pinned here:

    * `rating`    → ``_load_player_ratings``
    * `rank`      → ``_load_player_ranks``
    * `rank_of`   → ``league_rated_population``
    * `percentile`→ ``league_percentile``
    * `peak`      → ``league_peak_rating`` (the away peak is 1600 — a number the
                    player never reached at home)
    * `rating_delta` → ``latest_rated_match_change`` (the away slide is the NEWEST
                    rated match of all, so an unscoped read reports -110 at home)
    * `form`      → ``_load_form`` ("WW" at home, "LW" away; unscoped it is
                    "LWWW" on both)
    * `confidence`→ ``_player_confidence``
    * `career`    → ``player_career``, which must take NO league at all

    The viewer is a member of the default league (a session mints a guest and joins
    them, seeding a 1500 rating row) but has never played a rated match, so they are
    UNRATED and occupy no rung of the home ladder — the arithmetic below counts them
    out of its population deliberately."""
    await start_session(api_client, db_session)
    home = await get_default_league(db_session)
    assert home is not None
    away = await _side_league(db_session, "Tuesday Nights")

    target = await make_user(db_session, "switch.target")
    rival = await make_user(db_session, "switch.rival")
    await _join_league(db_session, target, home)
    await _join_league(db_session, target, away)

    # Two ladders sized so the percentile gate opens on BOTH (a small league
    # withholds it) while the populations still differ — a `rank_of` that read the
    # wrong league would be caught by the difference alone.
    home_pop = PERCENTILE_MIN_RATED_PLAYERS  # cohort + the target
    away_pop = PERCENTILE_MIN_RATED_PLAYERS + 2  # cohort + the target
    await _rated_cohort(db_session, "switch.home", home_pop - 1, base=1400.0)
    await _rated_cohort(
        db_session, "switch.away", away_pop - 1, league=away, base=1600.0
    )

    # Top of the home ladder, and settled there. Bottom of the away one, and
    # still provisional on it.
    await _rate_glicko2(db_session, target, rating=1520.0, rd=80.0, league=home)
    await _rate_glicko2(db_session, target, rating=1490.0, rd=200.0, league=away)

    # Home: two rated wins, 1500 → 1510 → 1520.
    first = await _record_match_with_winner(
        db_session, target, rival, created_at=BASE_TIME, affects_rating=True
    )
    await _record_rating_change(db_session, target, first, before=1500.0, after=1510.0)
    second = await _record_match_with_winner(
        db_session,
        target,
        rival,
        created_at=BASE_TIME + timedelta(days=1),
        affects_rating=True,
    )
    await _record_rating_change(db_session, target, second, before=1510.0, after=1520.0)

    # Away: a rated win up to a 1600 peak, then a rated loss back down to 1490 —
    # the NEWEST rated match either player has, on either ladder.
    climb = await _record_match_with_winner(
        db_session,
        target,
        rival,
        created_at=BASE_TIME + timedelta(days=2),
        affects_rating=True,
        league=away,
    )
    await _record_rating_change(
        db_session, target, climb, before=1500.0, after=1600.0, league=away
    )
    slide = await _record_match_with_winner(
        db_session,
        rival,
        target,
        created_at=BASE_TIME + timedelta(days=3),
        affects_rating=True,
        league=away,
    )
    await _record_rating_change(
        db_session, target, slide, before=1600.0, after=1490.0, league=away
    )

    at_home = (await api_client.get(f"/v1/players/{target.id}")).json()
    on_the_side = (
        await api_client.get(f"/v1/players/{target.id}?league_id={away.id}")
    ).json()

    # --- the rating half: every field is about the LADDER, so every field moves.
    assert at_home["rating"] == 1520.0
    assert on_the_side["rating"] == 1490.0

    assert at_home["rank"] == 1
    assert on_the_side["rank"] == away_pop

    assert at_home["rank_of"] == home_pop
    assert on_the_side["rank_of"] == away_pop

    # Top of one ladder, dead last on the other.
    assert at_home["percentile"] == max(1, round(100 / home_pop))
    assert on_the_side["percentile"] == 100

    assert at_home["peak"] == 1520.0
    assert on_the_side["peak"] == 1600.0

    assert at_home["rating_delta"] == {"before": 1510.0, "after": 1520.0, "delta": 10.0}
    assert on_the_side["rating_delta"] == {
        "before": 1600.0,
        "after": 1490.0,
        "delta": -110.0,
    }

    # Newest-first, and only the matches played ON that ladder.
    assert at_home["form"] == "WW"
    assert on_the_side["form"] == "LW"

    assert at_home["confidence"]["level"] == "settled"
    assert on_the_side["confidence"]["level"] == "provisional"
    assert at_home["confidence"] != on_the_side["confidence"]

    # Not one of them agreed across the two ladders.
    for field in (
        "rating",
        "rank",
        "rank_of",
        "percentile",
        "peak",
        "rating_delta",
        "form",
        "confidence",
    ):
        assert at_home[field] != on_the_side[field], field

    # --- the career half: a fact about the PERSON, so it does not move an inch.
    assert at_home["career"] == on_the_side["career"]
    assert at_home["career"]["decided"] == 4
    assert at_home["career"]["wins"] == 3
    assert at_home["career"]["losses"] == 1
    assert at_home["career"]["league_count"] == 2

    # The hero's own W-L is that same career W-L (the roster's column shares this
    # field), so it is cross-league too — and must never drift from the `career`
    # block sitting on the same page. League-scoping `_load_wl_counts` would read
    # 2-0 at home and 1-1 away, and red here.
    for side in (at_home, on_the_side):
        assert (side["wins"], side["losses"]) == (3, 1)
        assert (side["wins"], side["losses"]) == (
            side["career"]["wins"],
            side["career"]["losses"],
        )

    # --- the switcher itself: the same list either way, each row its own rating.
    assert at_home["leagues"] == on_the_side["leagues"]


async def test_get_player_leagues_lists_every_membership_with_its_rating_on_it(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The Leagues card: one row per league the player BELONGS to, each carrying
    the rating they hold ON THAT LADDER (ADR-0915) — 1520 here, 1950 there, and
    no such thing as their rating "in general".

    The default league sorts first, since it is the row the page falls back to
    when no league is named, and `is_default` is what lets the client mark it.

    The rows are read from `league_memberships`, so the card can never disagree
    with the `career.league_count` sitting next to it on the same page — a mutant
    that lists the leagues the player has PLAYED in instead would drop a league
    they have joined but not yet played on, and the length assertion reds."""
    await start_session(api_client, db_session)
    home = await get_default_league(db_session)
    assert home is not None
    away = await _side_league(db_session, "Alpha Ladder")  # sorts BEFORE "FortyMM"

    target = await make_user(db_session, "leagues.target")
    await _join_league(db_session, target, home)
    await _join_league(db_session, target, away)
    await _earn_rating(db_session, target, 1520.0, league=home)
    await _earn_rating(db_session, target, 1950.0, league=away)

    body = (await api_client.get(f"/v1/players/{target.id}")).json()

    # The default league leads, despite sorting last alphabetically.
    assert body["leagues"] == [
        {
            "id": str(home.id),
            "name": home.name,
            "is_default": True,
            "rating": 1520.0,
        },
        {
            "id": str(away.id),
            "name": "Alpha Ladder",
            "is_default": False,
            "rating": 1950.0,
        },
    ]
    assert len(body["leagues"]) == body["career"]["league_count"]


async def test_get_player_leagues_keeps_a_league_the_player_has_no_rating_in(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Belonging to a ladder and holding a rating on it are different facts. A
    member who has never finished a rated match there (or whose manual-strategy
    league is still waiting for its import) is still a MEMBER: the row stays, with
    a ``null`` rating.

    An inner join to `user_league_ratings` would silently drop the league —
    leaving a player who has joined two and reads as being in one, with the
    `career.league_count` beside it saying otherwise."""
    await start_session(api_client, db_session)
    home = await get_default_league(db_session)
    assert home is not None
    away = await _side_league(db_session, "Unrated Ladder")

    target = await make_user(db_session, "leagues.unrated")
    await _join_league(db_session, target, home)
    await _join_league(db_session, target, away)
    await _earn_rating(db_session, target, 1520.0, league=home)
    # No rating row on the side ladder at all — they have only just joined it.

    body = (await api_client.get(f"/v1/players/{target.id}")).json()
    assert [(row["name"], row["rating"]) for row in body["leagues"]] == [
        (home.name, 1520.0),
        ("Unrated Ladder", None),
    ]
    assert len(body["leagues"]) == body["career"]["league_count"] == 2


async def test_get_player_leagues_is_a_single_row_for_a_player_in_only_the_default(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Every real player is joined to the default league at sign-up and, today,
    to nothing else — so the card renders exactly one row for everyone. That is
    correct, not a bug to be optimised away by hiding the card (ADR-0915).

    The viewer here is a real signed-in user (a guest minted by the session), not
    a hand-built row: this is the shape production actually serves — and it is the
    shape that made the card lie. Joining seeds a 1500 ``UserLeagueRating``, so a
    card keyed on "has a rating row" showed this brand-new guest a 1500 on the very
    ladder whose hero, two inches up the page, correctly said Unrated. The row still
    renders (they DO belong to the league); its rating is ``null``."""
    session_user = await start_session(api_client, db_session)
    home = await get_default_league(db_session)
    assert home is not None

    body = (await api_client.get(f"/v1/players/{session_user.id}")).json()
    assert body["leagues"] == [
        {
            "id": str(home.id),
            "name": home.name,
            "is_default": True,
            # Belongs to the ladder; holds no rating on it. The seed is a prior,
            # not a rating (`app.ratings.rated`).
            "rating": None,
        }
    ]
    assert body["career"]["league_count"] == 1
    # …and the hero agrees with the card, which is the whole point of one gate.
    assert body["rating"] is None


# ----- head-to-head (viewer-aware) ------------------------------------------


async def _record_solo_match(
    db_session: AsyncSession, player: User, *, created_at: datetime
) -> Match:
    """A solo ("No opponent") match: side 2 is the player-less SENTINEL — a side
    row with zero ``match_side_players`` (CONTEXT.md, "Solo match"; api/CLAUDE.md).

    That sentinel is what the head-to-head queries have to survive: it is a real
    second side, so a naive join to it yields an "opponent" with no id and no
    username. A solo match has nobody on the other side, so it can never be a
    **meeting** — but it is still match history, and still counted by
    ``match_total``."""
    league = await get_default_league(db_session)
    match = Match(
        match_settings=MatchSettings(team_size=1, best_of=5, affects_rating=False),
        league=league,
        created_by_user_id=player.id,
        status=MatchStatus.completed,
        created_at=created_at,
        updated_at=created_at,
        completed_at=created_at,
    )
    mine = MatchSide(match=match, side_number=1, won=True)
    mine.players.append(MatchSidePlayer(match=match, user=player))
    # The sentinel. No players, on purpose — do not "fix" this.
    MatchSide(match=match, side_number=2, won=False)
    db_session.add(match)
    await db_session.commit()
    return match


def _opponent_names(records: list[dict]) -> list[str]:
    return [record["opponent"]["username"] for record in records]


async def test_get_player_head_to_head_is_written_from_the_callers_side(
    api_client: AsyncClient, db_session: AsyncSession
):
    """``versus_viewer`` is the CALLER's record against this player — "you are
    1-4 against them", not "they are 4-1 against you" (CONTEXT.md,
    "Head-to-head": the same record said from the other side is a different
    sentence, and copy must name whose side it is written from).

    The record is DELIBERATELY LOPSIDED. A 2-2 seed would read the same from
    either perspective and so could not tell a caller-side implementation from a
    player-side one; 1-4 flips to 4-1 the moment the ``won`` flag is read off the
    wrong side.

    Also pins the "decided" half of a meeting: the pair have a match still in
    play, and a match in play is not a record (CONTEXT.md, "Meeting"). Count it
    and ``meetings`` reads 6."""
    caller = await start_session(api_client, db_session)
    player = await make_user(db_session, "the.player")

    # The caller won the first meeting…
    await _record_match_with_winner(db_session, caller, player, created_at=BASE_TIME)
    # …and lost the next four, the last of them on day 4.
    for day in range(1, 5):
        await _record_match_with_winner(
            db_session, player, caller, created_at=BASE_TIME + timedelta(days=day)
        )
    # A sixth match between them is still being played — not a meeting.
    await _record_match_with_winner(
        db_session,
        player,
        caller,
        created_at=BASE_TIME + timedelta(days=9),
        status=MatchStatus.in_progress,
    )

    response = await api_client.get(f"/v1/players/{player.id}")
    assert response.status_code == 200
    versus = response.json()["head_to_head"]["versus_viewer"]

    # The caller's one win and four losses — NOT the player's four and one.
    assert versus["wins"] == 1
    assert versus["losses"] == 4
    # Derived from wins + losses, and so unable to disagree with them. Five, not
    # six: the match still in play is not a record.
    assert versus["meetings"] == 5
    # The opponent named here is the player whose profile this is — the FE
    # prefills "Start a match" from it.
    assert versus["opponent"] == {"id": str(player.id), "username": "the.player"}
    # The last DECIDED meeting (day 4), not the in-progress match on day 9.
    assert datetime.fromisoformat(versus["last_meeting"]) == BASE_TIME + timedelta(
        days=4
    )


async def test_get_player_head_to_head_varies_by_caller(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The point of ADR-0915: the SAME profile returns a DIFFERENT head-to-head
    to two different callers. This endpoint used to bind the caller as
    ``_current_user`` and throw it away — every viewer got byte-identical bytes,
    and this test is what makes that impossible to go back to (it also states the
    caching consequence: no shared cache may serve one caller's copy to another).

    One caller is 1-4 down against the player; the other is 2-0 up. Both ask for
    the same URL."""
    caller = await start_session(api_client, db_session)
    player = await make_user(db_session, "the.player")
    # The caller: one win, four losses (lopsided, so a perspective flip shows).
    await _record_results(db_session, caller, player, "WLLLL")

    async with make_client() as rival_client:
        rival = await start_session(rival_client, db_session)
        # The rival: two wins, no losses.
        await _record_results(
            db_session, rival, player, "WW", start=BASE_TIME + timedelta(days=10)
        )

        mine = (await api_client.get(f"/v1/players/{player.id}")).json()
        theirs = (await rival_client.get(f"/v1/players/{player.id}")).json()

    assert mine["head_to_head"]["versus_viewer"]["wins"] == 1
    assert mine["head_to_head"]["versus_viewer"]["losses"] == 4
    assert theirs["head_to_head"]["versus_viewer"]["wins"] == 2
    assert theirs["head_to_head"]["versus_viewer"]["losses"] == 0
    # Same player, same league, two different answers — the whole point.
    assert mine["head_to_head"] != theirs["head_to_head"]
    # …and only the viewer-aware block moved. Everything else on the page is a
    # fact about the player alone.
    assert mine["career"] == theirs["career"]
    assert mine["matches"] == theirs["matches"]


async def test_get_player_head_to_head_has_no_record_against_yourself(
    api_client: AsyncClient, db_session: AsyncSession
):
    """On your OWN profile there is no "you versus yourself": ``versus_viewer``
    is ``null`` — the one case in which it is — and the card degrades to just
    your frequent opponents (ADR-0915). A 0-0 record against yourself would
    invite the FE to offer you a match against yourself."""
    me = await start_session(api_client, db_session)
    rival = await make_user(db_session, "my.rival")
    await _record_results(db_session, me, rival, "WWL")

    body = (await api_client.get(f"/v1/players/{me.id}")).json()
    head_to_head = body["head_to_head"]

    assert head_to_head["versus_viewer"] is None
    # The rest of the card still renders — and from MY side: I am 2-1 up.
    assert _opponent_names(head_to_head["frequent_opponents"]) == ["my.rival"]
    assert head_to_head["frequent_opponents"][0]["wins"] == 2
    assert head_to_head["frequent_opponents"][0]["losses"] == 1
    assert head_to_head["frequent_opponents"][0]["meetings"] == 3


async def test_get_player_head_to_head_is_empty_not_absent_for_a_stranger(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A caller who has never played this player gets an EMPTY record, not
    ``null`` and not an error.

    This is the COMMON case, not an edge one: a guest session is minted for
    anyone who lands on a profile link, and a guest has played nobody (ADR-0915).
    The FE renders "You haven't played X yet" plus a Start-a-match CTA off
    exactly this state, so it needs the block present, the counts at zero, and
    the opponent named to prefill match creation with. ``null`` here would mean
    something else entirely — that the caller IS this player."""
    await start_session(api_client, db_session)  # a fresh guest: has played nobody
    player = await make_user(db_session, "the.player")
    other = await make_user(db_session, "someone.else")
    await _record_match_with_winner(db_session, player, other, created_at=BASE_TIME)

    response = await api_client.get(f"/v1/players/{player.id}")
    assert response.status_code == 200
    head_to_head = response.json()["head_to_head"]
    versus = head_to_head["versus_viewer"]

    assert versus is not None, "an empty record, never a missing one"
    assert versus["wins"] == 0
    assert versus["losses"] == 0
    assert versus["meetings"] == 0
    assert versus["last_meeting"] is None
    # Named, so "Start a match" can arrive at /matches/new with them picked.
    assert versus["opponent"] == {"id": str(player.id), "username": "the.player"}
    # The player's own opponents are unaffected by who is asking.
    assert _opponent_names(head_to_head["frequent_opponents"]) == ["someone.else"]


async def test_get_player_frequent_opponents_are_the_top_three_by_meetings(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The player's most-met opponents: top three by meetings, ties broken by the
    most RECENT meeting — read from the PLAYER's side, not the caller's.

    The two one-meeting opponents are the load-bearing pair. Only one of them can
    make the cut, and the one that does is the one met most recently — which is
    the alphabetically LATER of the two, so a tiebreak that fell back to the
    username (or to insertion order) picks the wrong rival and reds."""
    await start_session(api_client, db_session)
    player = await make_user(db_session, "the.player")
    most = await make_user(db_session, "most.met")
    second = await make_user(db_session, "second.met")
    old_tie = await make_user(db_session, "old.tie")
    recent_tie = await make_user(db_session, "recent.tie")

    await _record_results(db_session, player, most, "WWL", start=BASE_TIME)
    await _record_results(
        db_session, player, second, "LL", start=BASE_TIME + timedelta(days=10)
    )
    await _record_results(
        db_session, player, old_tie, "W", start=BASE_TIME + timedelta(days=20)
    )
    await _record_results(
        db_session, player, recent_tie, "L", start=BASE_TIME + timedelta(days=30)
    )

    frequent = (await api_client.get(f"/v1/players/{player.id}")).json()[
        "head_to_head"
    ]["frequent_opponents"]

    assert _opponent_names(frequent) == ["most.met", "second.met", "recent.tie"]
    # From the PLAYER's side: they are 2-1 up on their most-met opponent and
    # 0-2 down on the next. Flip the perspective and both records invert.
    assert (frequent[0]["wins"], frequent[0]["losses"]) == (2, 1)
    assert frequent[0]["meetings"] == 3
    assert (frequent[1]["wins"], frequent[1]["losses"]) == (0, 2)


async def test_get_player_frequent_opponents_count_only_decided_matches(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A meeting is a DECIDED match (CONTEXT.md): a match still in play is not a
    record, and a voided one has stopped being one.

    Seeded so the gate changes the ANSWER, not merely a count: the "busy"
    opponent has one decided meeting plus three in play and one voided, and the
    "settled" opponent two decided ones. Count the undecided matches and busy
    (5) outranks settled (2) and leads the card; count the voided one and busy
    ties on 2 and still leads, on the recency tiebreak."""
    from app.match_voiding import void_match

    await start_session(api_client, db_session)
    player = await make_user(db_session, "the.player")
    busy = await make_user(db_session, "busy.opponent")
    settled = await make_user(db_session, "settled.opponent")

    await _record_match_with_winner(db_session, player, busy, created_at=BASE_TIME)
    for day in range(1, 4):
        await _record_match_with_winner(
            db_session,
            player,
            busy,
            created_at=BASE_TIME + timedelta(days=day),
            status=MatchStatus.in_progress,
        )
    await _record_results(
        db_session, player, settled, "WL", start=BASE_TIME + timedelta(days=10)
    )
    # Played, remembered, and no longer counting.
    voided = await _record_match_with_winner(
        db_session, player, busy, created_at=BASE_TIME + timedelta(days=20)
    )
    await void_match(db_session, voided)
    await db_session.commit()

    body = (await api_client.get(f"/v1/players/{player.id}")).json()
    frequent = body["head_to_head"]["frequent_opponents"]

    assert _opponent_names(frequent) == ["settled.opponent", "busy.opponent"]
    assert frequent[0]["meetings"] == 2
    assert frequent[1]["meetings"] == 1
    # The undecided and voided matches are still HISTORY — only the head-to-head
    # declines to count them (the two totals differ on purpose, ADR-0915).
    assert body["match_total"] == 7


async def test_get_player_frequent_opponents_never_includes_the_solo_sentinel(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A solo match has no opponent, so it can never be a meeting — and its
    player-less sentinel side must never surface as a ``None``-named "opponent"
    (api/CLAUDE.md; CONTEXT.md, "Solo match").

    Two solo matches against one real meeting, so the sentinel would not just
    appear — it would LEAD the card, on two meetings to the real rival's one."""
    await start_session(api_client, db_session)
    player = await make_user(db_session, "the.player")
    rival = await make_user(db_session, "a.real.rival")
    await _record_solo_match(db_session, player, created_at=BASE_TIME)
    await _record_solo_match(
        db_session, player, created_at=BASE_TIME + timedelta(days=1)
    )
    await _record_match_with_winner(
        db_session, player, rival, created_at=BASE_TIME + timedelta(days=2)
    )

    body = (await api_client.get(f"/v1/players/{player.id}")).json()
    frequent = body["head_to_head"]["frequent_opponents"]

    assert _opponent_names(frequent) == ["a.real.rival"]
    assert frequent[0]["meetings"] == 1
    # The solo matches are still in the history — the sentinel is not filtered
    # away, it simply is not a rivalry.
    assert body["match_total"] == 3


async def test_get_player_head_to_head_counts_meetings_on_every_ladder(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A head-to-head is a fact about a PAIR OF PEOPLE, not about a ladder — so
    it is cross-league, like ``career`` and unlike ``rating`` / ``rank`` / ``peak``
    / ``confidence`` (ADR-0915). "How do I do against them" does not become a
    different question because they beat you in a different league.

    The caller and the player have met once at home and once away; both count,
    and they count whichever league the profile was requested for."""
    caller = await start_session(api_client, db_session)
    player = await make_user(db_session, "the.player")
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

    # Lost at home…
    await _record_match_with_winner(
        db_session, player, caller, created_at=BASE_TIME, league=home_league
    )
    # …and lost away as well.
    await _record_match_with_winner(
        db_session,
        player,
        caller,
        created_at=BASE_TIME + timedelta(days=1),
        league=side_league,
    )

    home = (await api_client.get(f"/v1/players/{player.id}")).json()
    away = (
        await api_client.get(f"/v1/players/{player.id}?league_id={side_league.id}")
    ).json()

    assert home["head_to_head"]["versus_viewer"]["losses"] == 2
    assert home["head_to_head"]["versus_viewer"]["meetings"] == 2
    # Ask for the other ladder and the rivalry is the same rivalry.
    assert away["head_to_head"] == home["head_to_head"]


# ---------------------------------------------------------------------------
# The rating chart: a CALENDAR window with a carry-in anchor (ADR-0915).
#
# These tests seed relative to `datetime.now(UTC)`, never to `BASE_TIME` — the
# window's edges are `now - 30d/90d/365d`, so a fixture pinned to a fixed date
# would drift across the boundary as the calendar moves and quietly re-bucket
# itself (2026-01-01 is outside 90d but inside 1y). Offsets are kept well clear
# of the edges so no assertion here can hinge on a clock tick.
# ---------------------------------------------------------------------------

NOW = datetime.now(UTC)


async def _rated_win(
    db_session: AsyncSession,
    winner: User,
    loser: User,
    *,
    at: datetime,
    before: float,
    after: float,
    league: League | None = None,
) -> Match:
    """A completed RATED match at ``at``, plus the rating-history row it wrote —
    one point on the winner's rating timeline. Match and audit row share the
    instant, exactly as production writes them (ADR-0012)."""
    match = await _record_match_with_winner(
        db_session, winner, loser, created_at=at, affects_rating=True, league=league
    )
    await _record_rating_change(
        db_session, winner, match, before=before, after=after, league=league, at=at
    )
    return match


def _at(point: dict) -> datetime:
    return datetime.fromisoformat(point["at"])


async def test_rating_history_anchors_the_window_on_a_point_outside_it(
    api_client: AsyncClient, db_session: AsyncSession
):
    """THE test for this endpoint. The window's left edge is almost never a match,
    so the chart carries in an ANCHOR: the player's rating as of the window start,
    read from the last change AT OR BEFORE it — a point from OUTSIDE the requested
    window (ADR-0915).

    This player's last match before the window was 200 days ago (1400 → 1500), and
    their first match *inside* it is 40 days in, nowhere near its left edge. Their
    rating on the day the window opened was 1500, and over the last 90 days they
    have gone 1500 → 1600, so the honest headline is **+100**.

    An implementation that clips strictly to the window — the cheap one ADR-0915
    rejects as "the version that quietly lies" — sees only the two in-window points,
    reports `anchor: null`, and computes +50 from the first of them. Both numbers
    below are chosen so that reading is a DIFFERENT number, not a coincidentally
    equal one: without the anchor this test reds."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "anchor.target")
    rival = await make_user(db_session, "anchor.rival")
    await _rate(db_session, target, 1600.0)

    # Their last match before the window opened. This is the carry-in.
    old = await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=200),
        before=1400.0,
        after=1500.0,
    )
    # …then a long silence, and two matches well inside the 90-day window.
    await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=40),
        before=1500.0,
        after=1550.0,
    )
    await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=10),
        before=1550.0,
        after=1600.0,
    )

    response = await api_client.get(f"/v1/players/{target.id}/rating-history?range=90d")
    assert response.status_code == 200
    body = response.json()

    # The anchor is present, is the rating they carried into the window, and — the
    # whole point — is stamped OUTSIDE it.
    assert body["anchor"] is not None
    assert body["anchor"]["rating"] == 1500.0
    assert body["anchor"]["match_id"] == str(old.id)
    assert _at(body["anchor"]) < NOW - timedelta(days=90)

    # The line itself holds only the in-window changes.
    assert [point["rating"] for point in body["points"]] == [1550.0, 1600.0]
    for point in body["points"]:
        assert _at(point) >= NOW - timedelta(days=90)

    # Measured from the anchor (1500), NOT from the first in-window point (1550),
    # which would say +50.
    assert body["change"] == 100.0
    # The window's own peak — not the all-time peak, which is a different field.
    assert body["peak"]["rating"] == 1600.0


async def test_rating_history_empty_window_returns_the_anchor_and_no_points(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A rated player with no matches in the last 90 days is a first-class state,
    not an error (ADR-0915): they get their anchor, ZERO points, and NO change.

    The chart draws a flat line at their current rating and suppresses the delta
    chip — `change` is `null`, never `+0`, because a zero would claim they played
    and moved nothing."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "idle.target")
    rival = await make_user(db_session, "idle.rival")
    await _rate(db_session, target, 1500.0)
    await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=200),
        before=1400.0,
        after=1500.0,
    )

    response = await api_client.get(f"/v1/players/{target.id}/rating-history?range=90d")

    assert response.status_code == 200
    body = response.json()
    assert body["points"] == []
    assert body["anchor"]["rating"] == 1500.0
    assert _at(body["anchor"]) < NOW - timedelta(days=90)
    # Not 0.0. An idle window has no delta to report.
    assert body["change"] is None
    # The in-window peak of an empty window is nothing — the all-time peak lives
    # on the profile bundle and is untouched by this.
    assert body["peak"] is None


async def test_rating_history_has_no_anchor_before_the_players_first_rating(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A player whose whole rated life fits inside the window held no rating when
    it opened, so there is nothing to carry in: `anchor` is `null`, and the change
    is measured from their first in-window point instead."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "fresh.target")
    rival = await make_user(db_session, "fresh.rival")
    await _rate(db_session, target, 1540.0)
    await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=20),
        before=1500.0,
        after=1520.0,
    )
    await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=5),
        before=1520.0,
        after=1540.0,
    )

    body = (
        await api_client.get(f"/v1/players/{target.id}/rating-history?range=90d")
    ).json()

    assert body["anchor"] is None
    assert [point["rating"] for point in body["points"]] == [1520.0, 1540.0]
    # From the first in-window point (1520) — the only honest baseline when there
    # is no earlier rating to carry in.
    assert body["change"] == 20.0


async def test_rating_history_omits_a_voided_matchs_point_entirely(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A voided match is ABSENT from the rating timeline, not merely skipped by it
    (CONTEXT.md, "Voided match"): voiding deletes its rating-history rows, so its
    point leaves the chart and the chart changes shape retroactively.

    The endpoint gets this for free by reading `rating_history` — and would lose it
    the moment anyone re-derived points from `matches` instead. This pins that: the
    voided match's spike is gone, and the window's change and peak are computed as
    though it never happened."""
    from app.match_voiding import void_match

    await start_session(api_client, db_session)
    target = await make_user(db_session, "voided.target")
    rival = await make_user(db_session, "voided.rival")
    await _rate(db_session, target, 1550.0)

    await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=200),
        before=1450.0,
        after=1500.0,
    )
    kept = await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=60),
        before=1500.0,
        after=1550.0,
    )
    # A big win 10 days ago — later voided, so it never really happened.
    voided = await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=10),
        before=1550.0,
        after=1700.0,
    )
    await void_match(db_session, voided)
    await db_session.commit()

    body = (
        await api_client.get(f"/v1/players/{target.id}/rating-history?range=90d")
    ).json()

    match_ids = [point["match_id"] for point in body["points"]]
    assert match_ids == [str(kept.id)]
    assert str(voided.id) not in match_ids
    # The 1700 spike is gone from every derived number, not just from the line.
    assert body["peak"]["rating"] == 1550.0
    assert body["change"] == 50.0


async def test_rating_history_is_scoped_to_the_requested_league(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A rating is a fact about ONE ladder (CONTEXT.md, "League"), so the chart is
    league-scoped like every other rating fact on the profile. Drop the
    `league_id` filter and the default league's chart starts plotting points the
    player earned on a different ladder — including, here, an anchor that is not
    theirs.

    The two ladders are seeded with disjoint rating levels so a leak is
    unmistakable, and with no `league_id` named the DEFAULT league answers."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "ladder.target")
    rival = await make_user(db_session, "ladder.rival")
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

    # Home ladder: 1400 carried in, one in-window win to 1450.
    await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=200),
        before=1350.0,
        after=1400.0,
    )
    await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=30),
        before=1400.0,
        after=1450.0,
    )
    # Side ladder: an entirely different, much higher career.
    await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=200),
        before=1850.0,
        after=1900.0,
        league=side_league,
    )
    await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=30),
        before=1900.0,
        after=1980.0,
        league=side_league,
    )

    home = (
        await api_client.get(f"/v1/players/{target.id}/rating-history?range=90d")
    ).json()
    away = (
        await api_client.get(
            f"/v1/players/{target.id}/rating-history"
            f"?range=90d&league_id={side_league.id}"
        )
    ).json()

    assert home["anchor"]["rating"] == 1400.0
    assert [point["rating"] for point in home["points"]] == [1450.0]
    assert away["anchor"]["rating"] == 1900.0
    assert [point["rating"] for point in away["points"]] == [1980.0]


async def test_rating_history_range_selects_the_calendar_window(
    api_client: AsyncClient, db_session: AsyncSession
):
    """`range` is a CALENDAR window, not a count of matches: the same history
    answers three different questions. A match 200 days ago is a point on the 1y
    chart and the ANCHOR of the 30d and 90d ones; a match 45 days ago is a point on
    the 90d chart and the anchor of the 30d one."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "range.target")
    rival = await make_user(db_session, "range.rival")
    await _rate(db_session, target, 1600.0)
    await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=200),
        before=1450.0,
        after=1500.0,
    )
    await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=45),
        before=1500.0,
        after=1550.0,
    )
    await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=5),
        before=1550.0,
        after=1600.0,
    )

    async def window(range_: str) -> dict:
        return (
            await api_client.get(
                f"/v1/players/{target.id}/rating-history?range={range_}"
            )
        ).json()

    year = await window("1y")
    ninety = await window("90d")
    thirty = await window("30d")

    assert [point["rating"] for point in year["points"]] == [1500.0, 1550.0, 1600.0]
    assert year["anchor"] is None
    assert year["change"] == 100.0

    assert [point["rating"] for point in ninety["points"]] == [1550.0, 1600.0]
    assert ninety["anchor"]["rating"] == 1500.0
    assert ninety["change"] == 100.0

    assert [point["rating"] for point in thirty["points"]] == [1600.0]
    assert thirty["anchor"]["rating"] == 1550.0
    assert thirty["change"] == 50.0


async def test_rating_history_carries_in_a_rating_that_came_from_no_match(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A rating change need not come from a match: a manual override, an import,
    or a seeded initial value is a real row on the timeline, with no ``match_id``
    and its own wall-clock ``created_at`` (ADR-0012). The chart plots those too —
    and, here, CARRIES ONE IN as the anchor.

    This is what makes the OUTER join and the ``coalesce(completed_at,
    created_at)`` axis load-bearing rather than decorative. Make the join an INNER
    one — the obvious "simplification", since every other row has a match — and
    this player's imported 1500 vanishes: the anchor goes ``null``, the chart
    starts from nowhere, and a manual correction applied after someone's last match
    would silently stop being their current rating.

    The player is idle inside the window, so the anchor is the ONLY thing the chart
    has. Nothing else in this file seeds a match-less row, so without this test the
    fallback is deletable with the suite green."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "imported.target")
    league = await get_default_league(db_session)
    assert league is not None
    await _rate(db_session, target, 1500.0)

    # An imported rating, 200 days ago. No match — it was never played for.
    imported = RatingHistory(
        league_id=league.id,
        user_id=target.id,
        match_id=None,
        rating_strategy_id=league.rating_strategy_id,
        rating_value=1500.0,
        rating_state={"rating": 1500.0, "rd": 200.0, "volatility": 0.06},
        previous_rating_value=None,
        source=RatingHistorySource.import_,
    )
    imported.created_at = NOW - timedelta(days=200)
    db_session.add(imported)
    await db_session.commit()

    body = (
        await api_client.get(f"/v1/players/{target.id}/rating-history?range=90d")
    ).json()

    assert body["anchor"] is not None
    assert body["anchor"]["rating"] == 1500.0
    # A point with no match behind it — and dated by its own `created_at`, since
    # there is no `completed_at` to take.
    assert body["anchor"]["match_id"] is None
    assert _at(body["anchor"]) < NOW - timedelta(days=90)
    assert body["points"] == []
    assert body["change"] is None


async def test_rating_history_plots_a_match_less_change_inside_the_window(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The other half of the same rule: a match-less change INSIDE the window is a
    point on the line, and the latest point is the player's current rating whatever
    produced it.

    An admin corrects this player DOWN to 1480 after their last rated match. Drop
    match-less rows and the chart's last point is still the 1560 they no longer
    have, so `change` reports a rise they did not keep."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "corrected.target")
    rival = await make_user(db_session, "corrected.rival")
    league = await get_default_league(db_session)
    assert league is not None
    await _rate(db_session, target, 1480.0)

    await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=200),
        before=1450.0,
        after=1500.0,
    )
    await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=30),
        before=1500.0,
        after=1560.0,
    )
    correction = RatingHistory(
        league_id=league.id,
        user_id=target.id,
        match_id=None,
        rating_strategy_id=league.rating_strategy_id,
        rating_value=1480.0,
        rating_state={"rating": 1480.0, "rd": 200.0, "volatility": 0.06},
        previous_rating_value=1560.0,
        source=RatingHistorySource.manual,
        note="Corrected after a scoring dispute.",
    )
    correction.created_at = NOW - timedelta(days=5)
    db_session.add(correction)
    await db_session.commit()

    body = (
        await api_client.get(f"/v1/players/{target.id}/rating-history?range=90d")
    ).json()

    assert [point["rating"] for point in body["points"]] == [1560.0, 1480.0]
    assert body["points"][-1]["match_id"] is None
    # From the anchor (1500) to where they actually stand now (1480) — a net LOSS
    # across a window whose only match was a win.
    assert body["change"] == -20.0
    # The peak is still the high they briefly held inside the window.
    assert body["peak"]["rating"] == 1560.0


async def test_rating_history_for_an_unrated_player_is_empty_not_an_error(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A player who has never finished a rated match has no timeline at all — no
    anchor, no points, no change. That is an empty answer, not a 404: the FE
    replaces the card with the "Unrated" panel off exactly this state."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "unrated.target")

    response = await api_client.get(f"/v1/players/{target.id}/rating-history")

    assert response.status_code == 200
    assert response.json() == {
        "anchor": None,
        "points": [],
        "peak": None,
        "change": None,
    }


async def test_rating_history_404_when_the_player_is_missing(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    missing = uuid.uuid4()

    response = await api_client.get(f"/v1/players/{missing}/rating-history")

    assert response.status_code == 404


async def test_rating_history_requires_a_session(api_client: AsyncClient):
    response = await api_client.get(f"/v1/players/{uuid.uuid4()}/rating-history")
    assert response.status_code == 401


async def test_rating_history_rejects_a_range_it_does_not_serve(
    api_client: AsyncClient, db_session: AsyncSession
):
    """`range` is a closed domain (`30d` / `90d` / `1y`), typed as a `Literal`, so
    a made-up window is a 422 at the boundary rather than a silently-wrong chart.
    The client degrades a mangled `?range=` in the URL to the default before it ever
    asks."""
    target = await start_session(api_client, db_session)

    response = await api_client.get(
        f"/v1/players/{target.id}/rating-history?range=all-time"
    )

    assert response.status_code == 422


async def test_get_player_embeds_the_rating_history_for_the_requested_range(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The profile bundle carries the chart's window inline, for the range the page
    loaded with — this is what makes first paint ONE request (ADR-0915): the client
    seeds the chart's cache from it and only calls the standalone endpoint when the
    user changes range.

    So the embedded block must be BYTE-IDENTICAL to what that endpoint returns for
    the same range — anchor included — or the seeded cache is a lie the first range
    flip would silently correct."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "bundle.target")
    rival = await make_user(db_session, "bundle.rival")
    await _rate(db_session, target, 1600.0)
    await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=200),
        before=1450.0,
        after=1500.0,
    )
    await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=20),
        before=1500.0,
        after=1600.0,
    )

    default_range = (await api_client.get(f"/v1/players/{target.id}")).json()
    thirty = (await api_client.get(f"/v1/players/{target.id}?range=30d")).json()
    standalone = (
        await api_client.get(f"/v1/players/{target.id}/rating-history?range=30d")
    ).json()

    # No `range` named: the page loads 90 days, and the anchor comes with it.
    assert default_range["rating_history"]["anchor"]["rating"] == 1500.0
    assert [point["rating"] for point in default_range["rating_history"]["points"]] == [
        1600.0
    ]
    assert default_range["rating_history"]["change"] == 100.0

    # Ask for another range and the bundle re-cuts the same timeline…
    assert thirty["rating_history"]["anchor"]["rating"] == 1500.0
    assert [point["rating"] for point in thirty["rating_history"]["points"]] == [1600.0]
    # …and what it embeds is exactly what the chart's own endpoint would fetch.
    assert thirty["rating_history"] == standalone


def test_downsample_caps_the_line_without_moving_its_endpoints():
    """A 1y window on a hyper-active player could otherwise ship thousands of
    points — on the PROFILE BUNDLE's first paint, not just on a range flip. Beyond
    `MAX_POINTS` the line is sampled down.

    What the sample must never do is move a number the page quotes. It keeps the
    FIRST and LAST points (the chart's axis and its latest rating are read off
    them) and preserves order; `peak` and `change` are folded from the full set
    before it runs, so they are unaffected either way. Tested as a pure fold rather
    than by seeding four hundred matches — the guard is then real regardless of how
    rarely it fires in production."""
    points = [
        RatingPoint(at=NOW - timedelta(days=1000 - i), rating=1500.0 + i)
        for i in range(1000)
    ]

    sampled = downsample(points, cap=MAX_POINTS)

    assert len(sampled) == MAX_POINTS
    assert sampled[0] == points[0]
    assert sampled[-1] == points[-1]
    # A subsequence, in order — a thinned line, not a re-drawn one.
    assert [point.at for point in sampled] == sorted(point.at for point in sampled)
    assert all(point in points for point in sampled)
    # Below the cap it is a no-op: every real player's chart is untouched.
    assert downsample(points[:10], cap=MAX_POINTS) == points[:10]


async def test_rating_history_peak_is_folded_before_the_line_is_thinned(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The number the page QUOTES is not read off the line the page DRAWS.

    Beyond `MAX_POINTS` the line is sampled down, and a uniform stride steps over
    points — so a one-off spike can be missing from the drawn line entirely. `peak`
    is folded from the FULL set BEFORE that sample runs, which is the only reason
    the quoted high is still the high the player actually hit.

    Here that spike sits at an index the stride DROPS: the response caps at 400
    points, none of which carries 9999.0, and `peak` is 9999.0 anyway. Fold `peak`
    from the sampled line instead — the tempting "simplification", since every
    other number is read off `points` — and this reds with 2499.0: the profile would
    quote a peak that is nowhere in the data it plotted.

    Nothing else in the suite can tell those two implementations apart. The pure-fold
    test above uses a monotone line, where the peak IS the last point and downsample
    keeps the last point regardless.

    (`change` needs no twin of this test: it is `points[-1] - baseline`, and
    downsample provably preserves the first and last points — pinned directly by
    the test above — so folding it from the sampled line is the same arithmetic.)
    """
    await start_session(api_client, db_session)
    target = await make_user(db_session, "spike.target")
    league = await get_default_league(db_session)
    assert league is not None

    total = 1000
    spike = 9999.0
    # Every point sits well inside the 90-day window, minutes apart — a bulk import
    # of an existing ladder's history, which is how a player ends up with more
    # changes in one window than the chart can draw.
    stamps = [NOW - timedelta(days=80) + timedelta(minutes=i) for i in range(total)]

    # Park the spike on an index the stride DROPS. Which indices survive is asked of
    # `downsample` itself (over a probe whose rating IS its index), so a later change
    # to the sampling rule cannot quietly slide the spike onto a kept point and turn
    # this into a test that passes for the wrong reason.
    probe = [RatingPoint(at=at, rating=float(i)) for i, at in enumerate(stamps)]
    kept = {int(point.rating) for point in downsample(probe)}
    spike_index = next(i for i in range(total) if i not in kept)

    # Otherwise a monotone climb, so the sampled line's own maximum is its LAST
    # point (2499.0) — a different number from the true peak, not a lucky match.
    ratings = [spike if i == spike_index else 1500.0 + i for i in range(total)]
    await _rate(db_session, target, ratings[-1])
    db_session.add_all(
        [
            RatingHistory(
                league_id=league.id,
                user_id=target.id,
                match_id=None,
                rating_strategy_id=league.rating_strategy_id,
                rating_value=rating,
                rating_state={"rating": rating, "rd": 200.0, "volatility": 0.06},
                previous_rating_value=ratings[i - 1] if i else None,
                source=RatingHistorySource.import_,
                created_at=stamps[i],
            )
            for i, rating in enumerate(ratings)
        ]
    )
    await db_session.commit()

    body = (
        await api_client.get(f"/v1/players/{target.id}/rating-history?range=90d")
    ).json()

    # The line is thinned…
    assert len(body["points"]) == MAX_POINTS
    drawn = [point["rating"] for point in body["points"]]
    # …and the spike is genuinely NOT on it. (If a future stride keeps index
    # `spike_index`, this reds: move the spike, don't delete the test.)
    assert spike not in drawn
    assert max(drawn) == 2499.0

    # THE assertion: the quoted peak is the spike, folded from the full set, even
    # though no drawn point carries it — and no drawn point is even stamped at it.
    assert body["peak"]["rating"] == spike
    assert _at(body["peak"]) not in [_at(point) for point in body["points"]]

    # Context, not a discriminator: the endpoints survive the sample, so the net
    # change is the same either way. Their whole rated life is in-window, so it is
    # measured from the first point.
    assert body["anchor"] is None
    assert body["change"] == 2499.0 - 1500.0


# ---------------------------------------------------------------------------
# An unknown `?league_id=` on the PROFILE is a stale LENS, not a missing
# resource — and stays an error everywhere else (ADR-0915).
#
# These three tests are a pair of halves and only mean something together:
# the first two pin that `/v1/players/{id}` and its rating-history sibling
# DEGRADE to the default ladder, the third that every other league-taking
# surface still 404s. Loosen `app.leagues.resolve_league` itself — "unifying"
# the two resolvers — and the first two still pass while the third reds. That
# is the point of the split; do not delete the third to make a refactor green.
# ---------------------------------------------------------------------------


async def test_get_player_with_an_unknown_league_falls_back_to_the_default_ladder(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A well-formed but UNKNOWN `league_id` on the profile returns the player on
    the DEFAULT ladder, 200 — it does not 404.

    `/players/{id}` addresses a *player*; the league is only the lens the rating
    half of the page is seen through (ADR-0915). A bookmark to a ladder that has
    since been deleted must not answer "Player not found" about a player who
    exists and is fine — the FE's route error boundary maps any 4xx here to
    exactly that copy, so a 404 blames the wrong thing.

    The target is deliberately rated on TWO ladders with disjoint numbers, and the
    stale response is asserted byte-identical to naming no league at all: "fell
    back to the default" is a stronger claim than "did not error", and rules out
    an impl that fell back to *some* league (the side one, the first one found) or
    to a null-shaped answer with no ladder at all."""
    await start_session(api_client, db_session)
    home = await get_default_league(db_session)
    assert home is not None
    away = await _side_league(db_session, "Deleted Ladder")

    target = await make_user(db_session, "stale.target")
    await _join_league(db_session, target, home)
    await _join_league(db_session, target, away)

    # Top of the home ladder and settled there; bottom of the away one and still
    # provisional on it. Every rating fact below therefore disagrees across them.
    await _rate_glicko2(db_session, target, rating=1520.0, rd=80.0, league=home)
    await _rate_glicko2(db_session, target, rating=1490.0, rd=200.0, league=away)
    await _rated_cohort(db_session, "stale.away", 3, league=away, base=1600.0)

    default = (await api_client.get(f"/v1/players/{target.id}")).json()
    on_the_side = (
        await api_client.get(f"/v1/players/{target.id}?league_id={away.id}")
    ).json()
    response = await api_client.get(f"/v1/players/{target.id}?league_id={uuid.uuid4()}")

    assert response.status_code == 200
    body = response.json()

    # The default ladder answers, whole: the same bytes as asking for no league.
    assert body == default

    # And emphatically not the other ladder, nor a ladderless husk.
    assert body["rating"] == 1520.0
    assert on_the_side["rating"] == 1490.0
    assert body["rank"] == 1
    assert on_the_side["rank"] == 4  # the 3-strong away cohort all outrate them
    assert body["confidence"]["level"] == "settled"
    assert body["confidence"]["deviation"] == 80.0
    assert on_the_side["confidence"]["level"] == "provisional"


async def test_rating_history_with_an_unknown_league_falls_back_to_the_default_ladder(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The chart endpoint degrades exactly as the bundle it is embedded in does:
    an unknown `league_id` plots the DEFAULT ladder's line rather than 404ing.

    The profile seeds this endpoint's cache from the bundle and calls it when the
    user flips range (ADR-0915) — so if the two disagreed about a stale `?league=`,
    a page that painted fine would blow up the moment its range changed."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "stale.chart")
    rival = await make_user(db_session, "stale.rival")
    away = await _side_league(db_session, "Deleted Chart Ladder")

    # Home ladder: 1400 carried in, one in-window win to 1450.
    await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=200),
        before=1350.0,
        after=1400.0,
    )
    await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=30),
        before=1400.0,
        after=1450.0,
    )
    # Away ladder: an entirely different, much higher career.
    await _rated_win(
        db_session,
        target,
        rival,
        at=NOW - timedelta(days=30),
        before=1900.0,
        after=1980.0,
        league=away,
    )

    default = (
        await api_client.get(f"/v1/players/{target.id}/rating-history?range=90d")
    ).json()
    response = await api_client.get(
        f"/v1/players/{target.id}/rating-history?range=90d&league_id={uuid.uuid4()}"
    )

    assert response.status_code == 200
    body = response.json()
    assert body == default
    # The default ladder's line, not the away ladder's 1980.
    assert [point["rating"] for point in body["points"]] == [1450.0]
    assert body["anchor"]["rating"] == 1400.0


async def test_unknown_league_is_still_a_404_where_the_league_is_the_resource(
    api_client: AsyncClient, db_session: AsyncSession
):
    """THE discriminator for the resolver split: `resolve_league` stays STRICT.

    On the roster and the opponent picker the league is not a lens on one player —
    it names the ladder the rows themselves are ranked and rated by. Substituting
    the default for a league that does not exist would serve confidently WRONG
    data (a roster ordered by a ladder nobody asked for) with nothing to tell the
    caller their id was junk. 404 is the honest answer, and the profile's
    fallback must not be smuggled in here by loosening the shared helper."""
    await start_session(api_client, db_session)
    await make_user(db_session, "strict.player")
    unknown = uuid.uuid4()

    roster = await api_client.get(f"/v1/players?league_id={unknown}")
    recent = await api_client.get(f"/v1/players/recent?league_id={unknown}")
    search = await api_client.get(f"/v1/players/search?q=strict&league_id={unknown}")

    for response in (roster, recent, search):
        assert response.status_code == 404, response.request.url
        assert response.json()["detail"] == "League not found."


# ---------------------------------------------------------------------------
# UNRATED means "has never finished a rated match" — NOT "has no rating row"
#
# Joining a league seeds a rating row: `seed_user_league_rating` writes 1500 and
# an `initial` history event the moment a user joins, which for the default
# league is when their SESSION IS MINTED. So `rating_value IS NOT NULL` is true
# of every member who ever loaded the site, and a read side that mistook it for
# "has a rating" rendered a brand-new guest at 1500, peak 1500, "#2 of 5" above
# real players, with a Rating-over-time chart of one dot and a confidence card
# offering "somewhere between 814 and 2186" — which is the seed's own RD of 350
# saying it knows nothing, dressed up as a finding.
#
# THE PLAYERS BELOW ARE BUILT THE WAY PRODUCTION BUILDS THEM: minted through
# `GET /v1/session` (so they carry the real seed row and its `initial` event) and
# matched through the real create/propose/accept endpoints (so the rating rows
# are written by `result_acceptance`, not by hand). The old tests hand-seeded a
# `rating_value = NULL` row — a shape production never produces — which is why
# they were green while the QA stack showed the bug in thirty seconds.
# ---------------------------------------------------------------------------


async def _guest(db_session: AsyncSession, username: str) -> tuple[AsyncClient, User]:
    """A real, production-shaped player: a session-minted guest, joined to the
    default league and seeded with its 1500 prior + an ``initial`` history row.
    The caller owns the client."""
    client = make_client()
    user = await start_session(client, db_session)
    user.username = username
    await db_session.commit()
    return client, user


async def _assert_carries_the_production_seed(
    db_session: AsyncSession, user: User
) -> None:
    """The premise of every test below, asserted rather than assumed: this player
    holds the exact row production hands out on join — a 1500 ``rating_value`` and
    an ``initial`` rating-history event.

    Without this, a fix that "worked" only because the fixture forgot to seed a
    rating at all would pass, and the bug would still be live. It is the guard the
    old suite was missing."""
    league = await get_default_league(db_session)
    assert league is not None
    row = (
        await db_session.execute(
            select(UserLeagueRating).where(
                UserLeagueRating.user_id == user.id,
                UserLeagueRating.league_id == league.id,
            )
        )
    ).scalar_one()
    assert row.rating_value == 1500.0
    sources = (
        (
            await db_session.execute(
                select(RatingHistory.source).where(
                    RatingHistory.user_id == user.id,
                    RatingHistory.league_id == league.id,
                )
            )
        )
        .scalars()
        .all()
    )
    assert RatingHistorySource.initial in sources


async def _play(
    client: AsyncClient,
    opp_client: AsyncClient,
    opponent_id: uuid.UUID,
    *,
    rated: bool,
    i_win: bool = True,
) -> str:
    """Play one match to completion through the REAL endpoints, so a rated one is
    finalized by ``result_acceptance`` exactly as it is in production — it writes
    the ``UserLeagueRating`` snapshot AND the match-sourced ``rating_history`` row
    — and an unrated one writes neither.

    An UNRATED match skips the acceptance gate and finalizes straight from
    ``/results`` (#485); a rated one needs the opponent to accept. Both end
    ``completed``, which is the point: the two players below have identical MATCH
    histories and completely different RATING ones."""
    created = await client.post(
        "/v1/matches",
        json={
            "opponent_user_id": str(opponent_id),
            "best_of": 1,
            "rated": rated,
        },
    )
    assert created.status_code == 201, created.text
    match_id = created.json()["id"]
    s1, s2 = (11, 4) if i_win else (4, 11)
    posted = await client.post(
        f"/v1/matches/{match_id}/results",
        json={"games": [{"game_number": 1, "side_1_points": s1, "side_2_points": s2}]},
    )
    assert posted.status_code == 201, posted.text
    if rated:
        await accept_standing_result(opp_client, match_id)
    else:
        assert posted.json()["status"] == "completed"
    return match_id


async def test_get_player_never_played_anything_is_unrated_seed_row_and_all(
    api_client: AsyncClient, db_session: AsyncSession
):
    """THE bug, pinned: a guest whose session was minted seconds ago — no matches,
    no results, nothing — is UNRATED, and every rating-flavoured field on their
    profile is ``null``.

    They are not a hand-built fiction: they hold the 1500 row and the ``initial``
    event the league gave them on join (asserted, not assumed), which is exactly
    what made the old read say 1500. A rated peer is on the ladder throughout, so
    a ``null`` ``rank_of`` cannot be excused as "there is no ladder yet", and the
    peer's own rank of 1 proves the ladder is real and being ranked.

    Every ``null`` below is a separate mutant: a peak of 1500 presents the prior as
    an achievement; a rank hands them a rung above real players (the QA report's "#2
    of 5"); a confidence card reports the seed's RD of 350 back as a finding."""
    viewer = await start_session(api_client, db_session)
    fresh_client, fresh = await _guest(db_session, "never.played")
    peer = await make_user(db_session, "never.peer")
    await _earn_rating(db_session, peer, 1600.0)
    await _assert_carries_the_production_seed(db_session, fresh)

    body = (await api_client.get(f"/v1/players/{fresh.id}")).json()
    await fresh_client.aclose()

    # The hero: unrated, top to bottom.
    assert body["rating"] is None
    assert body["rank"] is None
    assert body["rank_of"] is None
    assert body["percentile"] is None
    assert body["peak"] is None
    assert body["rating_delta"] is None
    # The confidence card does not render.
    assert body["confidence"] is None
    # Nor does the chart: the seed is a prior, not a played result, so there is no
    # line to draw — not a one-dot chart at 1500.
    assert body["rating_history"] == {
        "anchor": None,
        "points": [],
        "peak": None,
        "change": None,
    }
    # The Leagues card agrees with the hero rather than contradicting it inches
    # below: they belong to the ladder, they hold no rating on it.
    assert [row["rating"] for row in body["leagues"]] == [None]

    # …while everything that is NOT a rating still renders. They have a (empty)
    # career and a (empty) history, and the page is not broken.
    assert body["career"]["decided"] == 0
    assert body["matches"]["items"] == []
    assert body["match_total"] == 0
    assert body["wins"] == 0 and body["losses"] == 0

    # The ladder is real and is being ranked — the nulls above are about this
    # player, not about an empty league.
    peer_body = (await api_client.get(f"/v1/players/{peer.id}")).json()
    assert peer_body["rating"] == 1600.0
    assert peer_body["rank"] == 1
    assert peer_body["rank_of"] == 1  # …and the fresh guest is NOT a rung on it
    assert viewer.id != fresh.id


async def test_get_player_with_only_unrated_matches_has_a_career_but_no_rating(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A player with a pile of UNRATED matches has a real career and a real match
    history — and still no rating. (The QA report's second player: 27 matches,
    27 unrated, rendered at 1500 with a rank.)

    CONTEXT.md splits these deliberately: a *rating* is moved only by RATED
    matches, while *match history* counts every kind of match and *career* counts
    every decided one. So the two halves of this profile must disagree — a
    populated career beside an empty rating — and a fix that reached too far (say,
    gating the career on being rated) reds on the second half here."""
    await start_session(api_client, db_session)
    target_client, target = await _guest(db_session, "unrated.career")
    async with opponent_session(db_session, "unrated.rival") as (rival_client, rival):
        await _play(target_client, rival_client, rival.id, rated=False, i_win=True)
        await _play(target_client, rival_client, rival.id, rated=False, i_win=True)
        await _play(target_client, rival_client, rival.id, rated=False, i_win=False)
    await _assert_carries_the_production_seed(db_session, target)

    body = (await api_client.get(f"/v1/players/{target.id}")).json()
    await target_client.aclose()

    # No rated match ever finished → no rating, and nothing hanging off one.
    assert body["rating"] is None
    assert body["rank"] is None
    assert body["rank_of"] is None
    assert body["peak"] is None
    assert body["percentile"] is None
    assert body["rating_delta"] is None
    assert body["confidence"] is None
    assert body["rating_history"]["points"] == []
    assert body["rating_history"]["anchor"] is None

    # …and yet: a career, a record, form, and every match in the history.
    assert body["career"]["decided"] == 3
    assert body["wins"] == 2
    assert body["losses"] == 1
    assert body["form"] == "LWW"  # newest first
    assert body["match_total"] == 3
    assert len(body["matches"]["items"]) == 3


async def test_get_player_one_completed_rated_match_makes_them_rated(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The other side of the gate, so it is a GATE and not a blanket: ONE completed
    rated match and every field the two tests above assert ``null`` comes back.

    The match is finalized through the real propose/accept endpoints, so the rating
    is written by ``result_acceptance`` — the value is Glicko-2's, not a fixture's,
    which is why nothing below hardcodes it. Deleting the read-side gate makes the
    two tests above fail; deleting the RATING makes this one fail. Only the actual
    predicate satisfies both."""
    await start_session(api_client, db_session)
    target_client, target = await _guest(db_session, "rated.now")
    async with opponent_session(db_session, "rated.rival") as (rival_client, rival):
        await _play(target_client, rival_client, rival.id, rated=True, i_win=True)

    body = (await api_client.get(f"/v1/players/{target.id}")).json()
    await target_client.aclose()

    # A rating they PLAYED for: Glicko-2 lifts the winner above the 1500 prior.
    assert body["rating"] is not None
    assert body["rating"] > 1500.0
    # Rank 1 of the two players who have now finished a rated match — the loser is
    # the other rung. Every guest with a seed row is still off the ladder.
    assert body["rank"] == 1
    assert body["rank_of"] == 2
    assert body["peak"] == body["rating"]
    # Their last rated match is also their FIRST, so it ESTABLISHED this rating — it
    # did not move them UP from the 1500 prior they were seeded with, because they
    # never held that (#952). No `before`, no delta: the hero shows the rating and
    # suppresses the Δ chip. You didn't gain anything; you got rated.
    assert body["rating_delta"]["before"] is None
    assert body["rating_delta"]["delta"] is None
    assert body["rating_delta"]["after"] == body["rating"]
    # The confidence card renders now — and is talking about a rating that exists.
    assert body["confidence"] is not None
    assert body["confidence"]["deviation"] < 350.0
    # The chart has exactly ONE point: the match. Not two — the seed is not a point,
    # and it is not the anchor either (they held no rating when the window opened).
    history = body["rating_history"]
    assert [point["rating"] for point in history["points"]] == [body["rating"]]
    assert history["anchor"] is None
    # The Leagues card carries the same rating the hero does.
    assert [row["rating"] for row in body["leagues"]] == [body["rating"]]


async def test_get_player_first_rated_match_establishes_the_rating_it_reports(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The Recent-matches Δ column, for the LOSER of a first rated match — the exact
    shape QA caught on the match page (#952).

    They are a session-minted guest, so they carry the production seed: a 1500
    ``UserLeagueRating`` and an ``initial`` history row (asserted, not assumed). They
    then LOSE their first rated match, and Glicko-2 — starting, correctly, from that
    1500 prior — lands them somewhere near 1340.

    What the row must NOT say is "1500 → 1340, −160". They never held 1500. They were
    Unrated going in, by the same definition every other surface on this page uses,
    and this match is what gave them a rating. So: no ``before``, no ``delta``, and an
    ``after`` they can be told about honestly.

    The seed is what makes this discriminating: a fix that merely asked "is there an
    earlier rating-history row?" would find the ``initial`` one and report the phantom
    1500 all over again.
    """
    await start_session(api_client, db_session)
    target_client, target = await _guest(db_session, "first.timer")
    await _assert_carries_the_production_seed(db_session, target)
    async with opponent_session(db_session, "first.rival") as (rival_client, rival):
        await _play(target_client, rival_client, rival.id, rated=True, i_win=False)

    body = (await api_client.get(f"/v1/players/{target.id}")).json()
    await target_client.aclose()

    change = body["matches"]["items"][0]["rating_change"]
    assert change is not None
    assert change["before"] is None
    assert change["delta"] is None
    # Established BELOW the seed — the fall that never happened.
    assert change["after"] < 1500.0
    assert change["after"] == body["rating"]


async def test_list_players_does_not_rank_a_guest_who_has_never_played(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The roster gets the same gate — it shares ``PlayerSummary``, and it was
    ranking never-played guests above real players.

    Two players finish a rated match: Glicko-2 puts the winner near 1660 and the
    loser near 1340, i.e. STRADDLING the 1500 seed. A bystander who has never
    played anything then sits between them on `rating_value` alone — so the buggy
    read sorts them into the middle of the roster and ranks them #2, pushing the
    player who actually lost a rated match down to #3. Every assertion below is a
    different way of saying that must not happen."""
    await start_session(api_client, db_session)
    winner_client, winner = await _guest(db_session, "roster.winner")
    async with opponent_session(db_session, "roster.loser") as (loser_client, loser):
        await _play(winner_client, loser_client, loser.id, rated=True, i_win=True)
    bystander_client, bystander = await _guest(db_session, "roster.bystander")
    await _assert_carries_the_production_seed(db_session, bystander)
    await winner_client.aclose()
    await bystander_client.aclose()

    items = (await api_client.get("/v1/players", params={"q": "roster."})).json()[
        "items"
    ]

    # The bystander is on the ROSTER — they are a player, they are listed…
    assert {row["username"] for row in items} == {
        "roster.winner",
        "roster.loser",
        "roster.bystander",
    }
    # …but not on the LADDER: no rating, and so no rank.
    assert _rating_for_item(items, "roster.bystander") is None
    assert _rank_for(items, "roster.bystander") is None
    # The two who played straddle the seed, and rank 1-2 with nobody in between.
    assert _rating_for_item(items, "roster.winner") > 1500.0
    assert _rating_for_item(items, "roster.loser") < 1500.0
    assert _rank_for(items, "roster.winner") == 1
    assert _rank_for(items, "roster.loser") == 2
    # And the sort agrees with the ranks: the unrated guest is last, not wedged
    # into the middle of the ladder at the seed value.
    assert [row["username"] for row in items] == [
        "roster.winner",
        "roster.loser",
        "roster.bystander",
    ]


async def test_rating_history_endpoint_is_empty_for_a_player_who_never_played(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The chart endpoint is directly reachable, so it carries the gate itself
    rather than relying on the FE never asking.

    The ``initial`` seed row is a real ``rating_history`` row — it is what the
    per-match views read a player's pre-match rating from, and it stays written.
    It is simply not a POINT: plotting it drew this player a rating line for a
    rating they have never held. Empty window, no anchor, no change."""
    await start_session(api_client, db_session)
    fresh_client, fresh = await _guest(db_session, "chart.never")
    await _assert_carries_the_production_seed(db_session, fresh)
    await fresh_client.aclose()

    for window in ("30d", "90d", "1y"):
        body = (
            await api_client.get(
                f"/v1/players/{fresh.id}/rating-history", params={"range": window}
            )
        ).json()
        assert body == {
            "anchor": None,
            "points": [],
            "peak": None,
            "change": None,
        }, window
