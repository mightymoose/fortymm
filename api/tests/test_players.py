from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.leagues import get_default_league
from app.models import (
    Match,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchSignature,
    MatchStatus,
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


async def test_recent_opponents_backfills_with_other_players(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    rival = await make_user(db_session, "rival")
    await make_user(db_session, "zoe")
    await make_user(db_session, "amy")

    await _record_match(db_session, me, rival, created_at=BASE_TIME)

    response = await api_client.get("/v1/players/recent")
    assert response.status_code == 200
    # The played opponent leads; never-played users backfill alphabetically.
    assert _usernames(response) == ["rival", "amy", "zoe"]


async def test_recent_opponents_for_a_new_player_is_a_non_empty_default(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    db_session.add_all(
        [User(username="charlie"), User(username="alice"), User(username="bob")]
    )
    await db_session.commit()

    response = await api_client.get("/v1/players/recent")
    assert response.status_code == 200
    # No match history at all — fall back to the alphabetical roster.
    assert _usernames(response) == ["alice", "bob", "charlie"]


async def test_recent_opponents_excludes_the_current_user(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    rival = await make_user(db_session, "rival")
    await _record_match(db_session, me, rival, created_at=BASE_TIME)

    response = await api_client.get("/v1/players/recent")
    assert response.status_code == 200
    assert me.username not in _usernames(response)


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
    await start_session(api_client, db_session)
    for name in ("ana", "bo", "cy", "di"):
        await make_user(db_session, name)

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
) -> Match:
    """Persist a singles match with explicit winner/loser so W-L and form
    assertions are deterministic. Same shape as `_record_match` but flips
    `MatchSide.won` on the right side. ``won`` is stamped only for completed
    matches, mirroring the API: since #485 it's written at the moment a match
    becomes final, never while one is still in progress.

    ``signed_by`` attaches a single ``MatchSignature`` — an ``in_progress``
    match with one models the "posted result awaiting the other side's
    confirmation" state."""
    settings = MatchSettings(team_size=1, best_of=5, affects_rating=False)
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
        match.signatures.append(MatchSignature(match=match, user=signed_by))
    db_session.add(match)
    await db_session.commit()
    return match


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
                rating_value=2000.0,
            ),
            UserLeagueRating(
                league_id=league.id,
                user_id=low.id,
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


async def test_list_player_matches_result_hidden_while_awaiting_confirmation(
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
    # No signature yet → genuinely live, not awaiting confirmation.
    assert row["status_label"] == "Live"


async def test_list_player_matches_labels_awaiting_confirmation_distinctly(
    api_client: AsyncClient, db_session: AsyncSession
):
    """An in_progress match with a posted result (one signature) is awaiting
    the other side's confirmation. The public profile must surface that as
    ``Awaiting confirmation`` rather than mislabeling it ``Live`` (issue #364)
    — the status enum alone can't express the derived bucket, so the row
    carries the shared ``status_label``."""
    await start_session(api_client, db_session)
    target = await make_user(db_session, "awaiting2.target")
    rival = await make_user(db_session, "awaiting2.rival")
    await _record_match_with_winner(
        db_session,
        target,
        rival,
        created_at=BASE_TIME,
        status=MatchStatus.in_progress,
        signed_by=target,
    )

    response = await api_client.get(f"/v1/players/{target.id}/matches")
    assert response.status_code == 200
    row = response.json()["items"][0]
    assert row["status"] == "in_progress"
    assert row["status_label"] == "Awaiting confirmation"
    # Still no official outcome while unconfirmed.
    assert row["result"] is None


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
