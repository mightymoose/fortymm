import asyncio
import uuid
from collections.abc import Awaitable, Callable

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import selectinload

from app.matches import confirm_match_result, dispute_match_result
from app.models import (
    League,
    LeagueVisibility,
    Match,
    MatchGame,
    MatchGameScore,
    MatchSide,
    MatchStatus,
    User,
)
from app.notifications.apns import MATCH_RESULT_CONFIRMATION_CATEGORY
from tests._helpers import (
    FakeSender,
    make_client,
    make_user,
    opponent_session,
    start_session,
    use_sender,
)

# ----- create -------------------------------------------------------------


async def test_create_match_requires_a_session(api_client: AsyncClient):
    response = await api_client.post("/v1/matches", json={"best_of": 5})
    assert response.status_code == 401


async def test_create_rated_match_with_registered_opponent(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "rival")

    response = await api_client.post(
        "/v1/matches",
        json={
            "opponent_user_id": str(opponent.id),
            "best_of": 5,
            "rated": True,
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "in_progress"
    assert body["status_label"] == "Live"
    assert body["best_of"] == 5
    assert body["games_to_win"] == 3
    assert body["team_size"] == 1
    assert body["affects_rating"] is True

    assert [s["side_number"] for s in body["sides"]] == [1, 2]
    my_side, opp_side = body["sides"]
    assert my_side["is_current_user_side"] is True
    assert my_side["players"][0]["user_id"] == str(me.id)
    assert my_side["players"][0]["is_current_user"] is True
    assert my_side["games_won"] == 0

    assert opp_side["is_current_user_side"] is False
    assert opp_side["players"][0]["user_id"] == str(opponent.id)
    assert opp_side["players"][0]["is_current_user"] is False

    # Games are written lazily by the score-write endpoints — a freshly
    # created match has no game rows yet, only the deeplink target.
    assert body["games"] == []
    assert body["current_game"]["game_number"] == 1
    assert body["can_score"] is True
    assert body["can_finalize"] is False

    match = (await db_session.execute(select(Match))).scalar_one()
    assert str(match.id) == body["id"]
    games = (await db_session.execute(select(MatchGame))).scalars().all()
    assert games == []


async def test_create_unrated_match_with_opponent(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opponent = await make_user(db_session, "casual-rival")

    response = await api_client.post(
        "/v1/matches",
        json={
            "opponent_user_id": str(opponent.id),
            "best_of": 3,
            "rated": False,
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["affects_rating"] is False
    assert len(body["sides"]) == 2


async def test_create_match_without_opponent_has_a_sentinel_opponent_side(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)

    response = await api_client.post("/v1/matches", json={"best_of": 7, "rated": False})
    assert response.status_code == 201
    body = response.json()
    assert body["affects_rating"] is False
    # Two sides: the creator, plus a player-less sentinel "No opponent" side.
    sides = sorted(body["sides"], key=lambda s: s["side_number"])
    assert [s["side_number"] for s in sides] == [1, 2]
    assert sides[0]["players"][0]["user_id"] == str(me.id)
    assert sides[1]["players"] == []
    # The sentinel side makes the match scorable for its creator. The first
    # game number is still surfaced even though no MatchGame row exists yet.
    assert body["current_game"] == {"game_number": 1}
    assert body["can_score"] is True
    assert body["can_finalize"] is False

    rows = (await db_session.execute(select(MatchSide))).scalars().all()
    assert len(rows) == 2


async def test_match_without_opponent_can_be_scored_to_completion(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)

    match = (
        await api_client.post("/v1/matches", json={"best_of": 3, "rated": False})
    ).json()
    # Per-game scratchpad writes leave status untouched — the match isn't
    # decided until POST /results.
    after_g1 = (
        await api_client.post(
            f"/v1/matches/{match['id']}/games/1/scores/new",
            json={"side_1_points": 11, "side_2_points": 4},
        )
    ).json()
    assert after_g1["status"] == "in_progress"
    assert after_g1["can_finalize"] is False
    after_g2 = (
        await api_client.post(
            f"/v1/matches/{match['id']}/games/2/scores/new",
            json={"side_1_points": 11, "side_2_points": 7},
        )
    ).json()
    assert after_g2["status"] == "in_progress"
    # Two same-winner games in a best-of-3 → the saved scores form a decided
    # match, so the FE's submit button will swap to "Finalize match".
    assert after_g2["can_finalize"] is True

    finalized = await api_client.post(
        f"/v1/matches/{match['id']}/results",
        json={
            "games": [
                {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                {"game_number": 2, "side_1_points": 11, "side_2_points": 7},
            ]
        },
    )
    assert finalized.status_code == 201
    body = finalized.json()
    assert body["status"] == "completed"
    sides = sorted(body["sides"], key=lambda s: s["side_number"])
    assert [s["won"] for s in sides] == [True, False]
    # No rating moved — a player-less opponent can't be rated against.
    assert body["affects_rating"] is False
    assert body["current_game"] is None
    assert body["can_score"] is False
    assert body["can_finalize"] is False


async def test_rated_match_without_opponent_is_rejected(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)

    response = await api_client.post("/v1/matches", json={"best_of": 5, "rated": True})
    assert response.status_code == 422
    assert "rated" in response.json()["detail"].lower()
    assert (await db_session.execute(select(Match))).first() is None


async def test_cannot_start_a_match_against_yourself(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)

    response = await api_client.post(
        "/v1/matches",
        json={"opponent_user_id": str(me.id), "best_of": 5, "rated": True},
    )
    assert response.status_code == 422
    assert "yourself" in response.json()["detail"].lower()


async def test_unknown_opponent_is_rejected(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)

    response = await api_client.post(
        "/v1/matches",
        json={
            "opponent_user_id": str(uuid.uuid4()),
            "best_of": 5,
            "rated": True,
        },
    )
    assert response.status_code == 404
    assert "opponent" in response.json()["detail"].lower()


async def test_even_best_of_is_rejected(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opponent = await make_user(db_session, "rival")

    response = await api_client.post(
        "/v1/matches",
        json={
            "opponent_user_id": str(opponent.id),
            "best_of": 4,
            "rated": True,
        },
    )
    assert response.status_code == 422


# ----- details ------------------------------------------------------------


async def _create_match(
    client: AsyncClient, opponent_id: uuid.UUID, best_of: int = 5
) -> dict:
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


async def test_get_match_flags_current_user_side(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "rival")
    created = await _create_match(api_client, opponent.id)

    response = await api_client.get(f"/v1/matches/{created['id']}")
    assert response.status_code == 200
    body = response.json()
    my_side = next(s for s in body["sides"] if s["is_current_user_side"])
    opp_side = next(s for s in body["sides"] if not s["is_current_user_side"])
    assert my_side["players"][0]["user_id"] == str(me.id)
    assert opp_side["players"][0]["user_id"] == str(opponent.id)


async def test_details_perspective_swaps_per_caller(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    async with make_client() as other_client:
        them = await start_session(other_client, db_session)
        created = await _create_match(api_client, them.id)

        mine = (await api_client.get(f"/v1/matches/{created['id']}")).json()
        theirs = (await other_client.get(f"/v1/matches/{created['id']}")).json()

    my_perspective = next(s for s in mine["sides"] if s["is_current_user_side"])
    their_perspective = next(s for s in theirs["sides"] if s["is_current_user_side"])
    assert my_perspective["players"][0]["user_id"] == str(me.id)
    assert their_perspective["players"][0]["user_id"] == str(them.id)
    # The flag flips per caller, but the underlying side numbers are stable.
    assert my_perspective["side_number"] != their_perspective["side_number"]


async def test_get_match_is_open_to_non_participants(
    api_client: AsyncClient, db_session: AsyncSession
):
    spectator = await start_session(api_client, db_session)
    async with make_client() as other_client:
        await start_session(other_client, db_session)
        bystander = await make_user(db_session, "bystander")
        created = await _create_match(other_client, bystander.id)

        response = await api_client.get(f"/v1/matches/{created['id']}")
        assert response.status_code == 200
        body = response.json()
        # Spectator isn't on either side — both flags are False, and the
        # write affordance is suppressed regardless of game state.
        assert all(not s["is_current_user_side"] for s in body["sides"])
        assert all(
            not p["is_current_user"] for s in body["sides"] for p in s["players"]
        )
        assert body["can_score"] is False
        del spectator


async def test_get_unknown_match_is_404(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    response = await api_client.get(f"/v1/matches/{uuid.uuid4()}")
    assert response.status_code == 404


# ----- anonymous viewer ---------------------------------------------------


async def test_get_match_is_open_to_anonymous_callers(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Same endpoint as the authed view backs the public `/p/matches/$id`
    share route: anonymous callers get the same payload with no participant
    flags and can_score=False."""
    creator = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "anon.viewer.opp")
    created = await _create_match(api_client, opponent.id)

    async with make_client() as client:
        response = await client.get(f"/v1/matches/{created['id']}")
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == created["id"]
    # An anonymous caller never gets a session minted just by viewing.
    assert "session" not in response.cookies
    # No current user → no participant flags, no Score CTA.
    assert all(not s["is_current_user_side"] for s in body["sides"])
    assert all(not p["is_current_user"] for s in body["sides"] for p in s["players"])
    assert body["can_score"] is False
    # The underlying players still appear on the two sides.
    user_ids = {p["user_id"] for s in body["sides"] for p in s["players"]}
    assert user_ids == {str(creator.id), str(opponent.id)}


async def test_get_match_is_rate_limited_per_ip(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Per-IP rate limit (60/min) protects the endpoint from being scraped
    from a single source, now that anonymous callers can hit it."""
    await start_session(api_client, db_session)
    opponent = await make_user(db_session, "rl.match.opp")
    created = await _create_match(api_client, opponent.id)

    async with make_client() as client:
        for i in range(60):
            response = await client.get(f"/v1/matches/{created['id']}")
            assert response.status_code == 200, (i, response.text)
        over = await client.get(f"/v1/matches/{created['id']}")
    assert over.status_code == 429


# ----- list ---------------------------------------------------------------


async def test_list_matches_empty(api_client: AsyncClient, db_session: AsyncSession):
    await start_session(api_client, db_session)
    response = await api_client.get("/v1/matches")
    assert response.status_code == 200
    body = response.json()
    assert body["items"] == []
    assert body["total"] == 0
    assert body["page"] == 1
    assert body["page_size"] == 25
    assert body["status_counts"]["pending"] == 0
    assert body["status_counts"]["completed"] == 0


async def test_list_matches_shows_every_match_on_the_system(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    async with make_client() as other_client:
        them = await start_session(other_client, db_session)
        bystander = await make_user(db_session, "bystander")
        # A match between two strangers — historically hidden, now visible.
        other_match = await _create_match(other_client, bystander.id)

    response = await api_client.get("/v1/matches")
    body = response.json()
    ids = {row["id"] for row in body["items"]}
    assert other_match["id"] in ids
    # The spectator sees both sides flagged neutrally — neither claims to be
    # `is_current_user_side`, and `me` doesn't appear in any row's players.
    row = next(r for r in body["items"] if r["id"] == other_match["id"])
    assert [side["is_current_user_side"] for side in row["sides"]] == [
        False,
        False,
    ]
    usernames = {p["username"] for side in row["sides"] for p in side["players"]}
    assert usernames == {them.username, bystander.username}
    assert me.username not in usernames


async def test_list_q_filter_matches_caller_username(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    mine = await _create_match(api_client, opp.id)
    async with make_client() as other_client:
        await start_session(other_client, db_session)
        bystander = await make_user(db_session, "bystander")
        # A match the caller is not in — searching for the caller's own
        # username should not pick this up.
        unrelated = await _create_match(other_client, bystander.id)

    listing = (await api_client.get("/v1/matches", params={"q": me.username})).json()
    ids = {row["id"] for row in listing["items"]}
    assert mine["id"] in ids
    assert unrelated["id"] not in ids


async def test_list_filter_by_status(api_client: AsyncClient, db_session: AsyncSession):
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        in_progress = await _create_match(api_client, opp.id, best_of=1)
        # Finalize a separate match to flip it to completed — post + confirm
        # so the second signer's call lands the status transition.
        completed_match = await _create_match(api_client, opp.id, best_of=1)
        post = await api_client.post(
            f"/v1/matches/{completed_match['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 5},
                ]
            },
        )
        assert post.status_code == 201
        confirm = await opp_client.post(
            f"/v1/matches/{completed_match['id']}/confirmation"
        )
        assert confirm.status_code == 201

    listing = (
        await api_client.get("/v1/matches", params={"status": "in_progress"})
    ).json()
    assert [row["id"] for row in listing["items"]] == [in_progress["id"]]
    assert listing["status_counts"]["in_progress"] == 1
    assert listing["status_counts"]["completed"] == 1


async def test_list_q_filter_matches_any_player_username(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    alpha = await make_user(db_session, "alphabet")
    bravo = await make_user(db_session, "bravo")
    await _create_match(api_client, alpha.id)
    await _create_match(api_client, bravo.id)

    listing = (await api_client.get("/v1/matches", params={"q": "alpha"})).json()
    assert len(listing["items"]) == 1
    players = {
        p["username"] for side in listing["items"][0]["sides"] for p in side["players"]
    }
    assert "alphabet" in players
    # status_counts honors q (one row total)
    assert sum(listing["status_counts"].values()) == 1


async def test_list_pagination(api_client: AsyncClient, db_session: AsyncSession):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    for _ in range(3):
        await _create_match(api_client, opp.id)

    page_1 = (
        await api_client.get("/v1/matches", params={"page": 1, "page_size": 2})
    ).json()
    page_2 = (
        await api_client.get("/v1/matches", params={"page": 2, "page_size": 2})
    ).json()
    assert page_1["total"] == 3
    assert len(page_1["items"]) == 2
    assert len(page_2["items"]) == 1
    assert {row["id"] for row in page_1["items"]} & {
        row["id"] for row in page_2["items"]
    } == set()


async def test_list_row_carries_current_game_number_when_scorable(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    await _create_match(api_client, opp.id)

    listing = (await api_client.get("/v1/matches")).json()
    row = listing["items"][0]
    # No games scored yet, so the next un-scored game is game 1. Game rows
    # don't exist until the first POST .../scores/new, so the listing surfaces
    # the number, not an id.
    assert row["current_game_number"] == 1
    assert row["can_score"] is True


async def test_list_row_hides_scoring_affordance_from_spectators(
    api_client: AsyncClient, db_session: AsyncSession
):
    # Spectators get neither `can_score` nor `current_game_number` — the scoring
    # route 404s for them anyway, and the FE has no reason to deep-link.
    await start_session(api_client, db_session)
    async with make_client() as other_client:
        await start_session(other_client, db_session)
        bystander = await make_user(db_session, "bystander")
        created = await _create_match(other_client, bystander.id)

    listing = (await api_client.get("/v1/matches")).json()
    row = next(r for r in listing["items"] if r["id"] == created["id"])
    assert row["current_game_number"] is None
    assert row["can_score"] is False


# ----- TT scoring rules ---------------------------------------------------


@pytest.mark.parametrize(
    "side_1,side_2,is_valid",
    [
        (11, 0, True),
        (11, 9, True),
        (12, 10, True),
        (13, 11, True),
        (11, 10, False),  # at deuce, must lead by 2
        (13, 10, False),  # past 11 only legal when both reach 10
        (12, 9, False),
        (10, 5, False),  # winner didn't reach 11
        (0, 0, False),
        (11, 11, False),
        (100, 0, False),  # caps at 99
    ],
)
async def test_table_tennis_scoring_rules(
    api_client: AsyncClient,
    db_session: AsyncSession,
    side_1: int,
    side_2: int,
    is_valid: bool,
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)

    response = await api_client.post(
        f"/v1/matches/{match['id']}/games/1/scores/new",
        json={"side_1_points": side_1, "side_2_points": side_2},
    )
    if is_valid:
        assert response.status_code == 201
    else:
        assert response.status_code == 422


# ----- per-game score endpoints (scratchpad state) ------------------------


async def test_score_create_lazily_inserts_the_game_row(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)

    response = await api_client.post(
        f"/v1/matches/{match['id']}/games/1/scores/new",
        json={"side_1_points": 11, "side_2_points": 4},
    )
    assert response.status_code == 201
    body = response.json()
    # Match status, side wins, and side.won are untouched by per-game writes —
    # finalization lives entirely in POST /results.
    assert body["status"] == "in_progress"
    assert [s["games_won"] for s in body["sides"]] == [1, 0]
    assert all(s["won"] is None for s in body["sides"])
    # No trailing un-scored game auto-appended: only game 1 exists.
    assert [g["game_number"] for g in body["games"]] == [1]
    assert body["games"][0]["score"]["side_1_points"] == 11
    # current_game advances to the next un-scored slot (lazy — no row yet).
    assert body["current_game"] == {"game_number": 2}
    assert body["can_score"] is True
    assert body["can_finalize"] is False

    games = (await db_session.execute(select(MatchGame))).scalars().all()
    assert len(games) == 1


async def test_score_create_409_when_game_already_scored(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)
    await api_client.post(
        f"/v1/matches/{match['id']}/games/1/scores/new",
        json={"side_1_points": 11, "side_2_points": 4},
    )

    second = await api_client.post(
        f"/v1/matches/{match['id']}/games/1/scores/new",
        json={"side_1_points": 11, "side_2_points": 5},
    )
    assert second.status_code == 409
    assert second.json()["detail"] == "This game has already been scored."


async def test_score_create_422_when_game_number_exceeds_best_of(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=3)

    response = await api_client.post(
        f"/v1/matches/{match['id']}/games/4/scores/new",
        json={"side_1_points": 11, "side_2_points": 4},
    )
    assert response.status_code == 422
    assert "best of 3" in response.json()["detail"]


async def test_score_create_accepts_gaps(
    api_client: AsyncClient, db_session: AsyncSession
):
    # The per-game endpoints are pure scratchpad — gaps are fine. Contiguity
    # is enforced only when finalizing via POST /results.
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)

    # Score game 3 before game 1 or 2 — the FE can let users enter games in
    # any order.
    response = await api_client.post(
        f"/v1/matches/{match['id']}/games/3/scores/new",
        json={"side_1_points": 11, "side_2_points": 9},
    )
    assert response.status_code == 201
    body = response.json()
    assert [g["game_number"] for g in body["games"]] == [3]
    # current_game falls back to the lowest unscored slot — game 1.
    assert body["current_game"] == {"game_number": 1}
    assert body["can_finalize"] is False


async def test_score_update_overwrites_in_place(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)
    await api_client.post(
        f"/v1/matches/{match['id']}/games/1/scores/new",
        json={"side_1_points": 11, "side_2_points": 4},
    )

    edited = await api_client.put(
        f"/v1/matches/{match['id']}/games/1/scores",
        json={"side_1_points": 5, "side_2_points": 11},
    )
    assert edited.status_code == 200
    body = edited.json()
    # Side wins flip, but status / won / current_game stay untouched —
    # nothing about the match is finalized just because a score changed.
    assert [s["games_won"] for s in body["sides"]] == [0, 1]
    assert body["status"] == "in_progress"
    assert all(s["won"] is None for s in body["sides"])
    assert body["current_game"] == {"game_number": 2}
    # No new game row was created.
    assert [g["game_number"] for g in body["games"]] == [1]


async def test_score_update_404_when_no_saved_score(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)

    response = await api_client.put(
        f"/v1/matches/{match['id']}/games/1/scores",
        json={"side_1_points": 11, "side_2_points": 5},
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "Score not found."


async def test_score_delete_clears_the_score_and_keeps_the_game(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)
    await api_client.post(
        f"/v1/matches/{match['id']}/games/1/scores/new",
        json={"side_1_points": 11, "side_2_points": 4},
    )

    cleared = await api_client.delete(f"/v1/matches/{match['id']}/games/1/scores")
    assert cleared.status_code == 200
    body = cleared.json()
    assert [s["games_won"] for s in body["sides"]] == [0, 0]
    assert body["current_game"] == {"game_number": 1}

    # A fresh POST .../scores/new at the same game number succeeds — the
    # game row stays in place, just with no score attached.
    again = await api_client.post(
        f"/v1/matches/{match['id']}/games/1/scores/new",
        json={"side_1_points": 11, "side_2_points": 9},
    )
    assert again.status_code == 201

    scores = (await db_session.execute(select(MatchGameScore))).scalars().all()
    assert len(scores) == 1
    assert scores[0].side_2_points == 9


async def test_score_delete_404_when_no_saved_score(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)

    response = await api_client.delete(f"/v1/matches/{match['id']}/games/2/scores")
    assert response.status_code == 404


async def test_non_participant_cannot_score(
    api_client: AsyncClient, db_session: AsyncSession
):
    # 404 (not 403) — non-participants don't get to learn that the match
    # exists from a write path.
    await start_session(api_client, db_session)
    async with make_client() as other_client:
        them = await start_session(other_client, db_session)
        bystander = await make_user(db_session, "bystander")
        created = await _create_match(other_client, bystander.id)
        del them

        post = await api_client.post(
            f"/v1/matches/{created['id']}/games/1/scores/new",
            json={"side_1_points": 11, "side_2_points": 4},
        )
        assert post.status_code == 404
        put = await api_client.put(
            f"/v1/matches/{created['id']}/games/1/scores",
            json={"side_1_points": 11, "side_2_points": 4},
        )
        assert put.status_code == 404
        delete = await api_client.delete(f"/v1/matches/{created['id']}/games/1/scores")
        assert delete.status_code == 404
        results = await api_client.post(
            f"/v1/matches/{created['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                    {"game_number": 2, "side_1_points": 11, "side_2_points": 7},
                ]
            },
        )
        assert results.status_code == 404


async def test_can_score_match_without_opponent(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    created = (
        await api_client.post("/v1/matches", json={"best_of": 5, "rated": False})
    ).json()
    response = await api_client.post(
        f"/v1/matches/{created['id']}/games/1/scores/new",
        json={"side_1_points": 11, "side_2_points": 4},
    )
    # The sentinel opponent side makes the match scorable.
    assert response.status_code == 201
    body = response.json()
    sides = sorted(body["sides"], key=lambda s: s["side_number"])
    assert [s["games_won"] for s in sides] == [1, 0]


# ----- finalize (POST /v1/matches/{id}/results) ---------------------------


async def test_results_post_commits_canon_and_records_first_signature(
    api_client: AsyncClient, db_session: AsyncSession
):
    """``POST /results`` commits the canonical games (obliterating the
    scratchpad), sets ``side.won``, and inserts the caller's signature — but
    leaves status at ``in_progress`` until the opponent confirms."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)

        # Pre-post, the FE has scratched in a totally different game 1 score.
        # The /results payload is canon — it should win.
        await api_client.post(
            f"/v1/matches/{match['id']}/games/1/scores/new",
            json={"side_1_points": 5, "side_2_points": 11},
        )

        response = await api_client.post(
            f"/v1/matches/{match['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                    {"game_number": 2, "side_1_points": 11, "side_2_points": 7},
                ]
            },
        )
        assert response.status_code == 201
        body = response.json()
        # Status holds at in_progress with the awaiting-confirmation label —
        # the result is on the table, the other side hasn't signed.
        assert body["status"] == "in_progress"
        assert body["status_label"] == "Awaiting confirmation"
        assert body["can_score"] is False
        assert body["can_finalize"] is False
        assert body["can_confirm"] is False  # poster has already signed
        assert len(body["signatures"]) == 1
        sides = sorted(body["sides"], key=lambda s: s["side_number"])
        # side.won is set on /results — the games show who won, irrespective
        # of whether the result has been ratified yet.
        assert [s["won"] for s in sides] == [True, False]
        # Games + scores reflect the payload, not the scratchpad.
        games = sorted(body["games"], key=lambda g: g["game_number"])
        assert [g["game_number"] for g in games] == [1, 2]
        assert games[0]["score"]["side_1_points"] == 11
        assert games[0]["score"]["side_2_points"] == 4

        # DB-side sanity: no orphan score rows from the obliterated scratchpad.
        game_rows = (await db_session.execute(select(MatchGame))).scalars().all()
        score_rows = (await db_session.execute(select(MatchGameScore))).scalars().all()
        assert len(game_rows) == 2
        assert len(score_rows) == 2

        # The opponent confirms — match flips to completed.
        confirm = await opp_client.post(f"/v1/matches/{match['id']}/confirmation")
        assert confirm.status_code == 201
        confirmed = confirm.json()
        assert confirmed["status"] == "completed"
        assert confirmed["status_label"] == "Final"
        assert len(confirmed["signatures"]) == 2


async def test_results_409_when_already_posted(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A second ``POST /results`` on the same match (still awaiting
    confirmation) bounces — the user should be calling /confirmation instead."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)

        payload = {
            "games": [
                {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                {"game_number": 2, "side_1_points": 11, "side_2_points": 7},
            ]
        }
        first = await api_client.post(
            f"/v1/matches/{match['id']}/results", json=payload
        )
        assert first.status_code == 201

        second = await api_client.post(
            f"/v1/matches/{match['id']}/results", json=payload
        )
        assert second.status_code == 409


async def test_score_endpoints_409_once_result_is_posted(
    api_client: AsyncClient, db_session: AsyncSession
):
    """While awaiting confirmation, every per-game write returns 409.
    Disputing rewinds: signatures clear, scores become editable again."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        await api_client.post(
            f"/v1/matches/{match['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                    {"game_number": 2, "side_1_points": 11, "side_2_points": 7},
                ]
            },
        )

        # Every write path returns 409 while the posted result is awaiting
        # confirmation.
        post = await api_client.post(
            f"/v1/matches/{match['id']}/games/1/scores/new",
            json={"side_1_points": 8, "side_2_points": 11},
        )
        assert post.status_code == 409
        put = await api_client.put(
            f"/v1/matches/{match['id']}/games/1/scores",
            json={"side_1_points": 8, "side_2_points": 11},
        )
        assert put.status_code == 409
        delete = await api_client.delete(f"/v1/matches/{match['id']}/games/1/scores")
        assert delete.status_code == 409


async def test_score_endpoints_409_once_match_is_completed(
    api_client: AsyncClient, db_session: AsyncSession
):
    """After /confirmation lands and the match is completed, every write
    path 409s — there's no edit affordance on a finalized match."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        await api_client.post(
            f"/v1/matches/{match['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                    {"game_number": 2, "side_1_points": 11, "side_2_points": 7},
                ]
            },
        )
        await opp_client.post(f"/v1/matches/{match['id']}/confirmation")

        post = await api_client.post(
            f"/v1/matches/{match['id']}/games/1/scores/new",
            json={"side_1_points": 8, "side_2_points": 11},
        )
        assert post.status_code == 409
        put = await api_client.put(
            f"/v1/matches/{match['id']}/games/1/scores",
            json={"side_1_points": 8, "side_2_points": 11},
        )
        assert put.status_code == 409
        delete = await api_client.delete(f"/v1/matches/{match['id']}/games/1/scores")
        assert delete.status_code == 409


@pytest.mark.parametrize(
    "games,reason_contains",
    [
        # Gap — games 1 and 3 with no game 2.
        (
            [
                {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                {"game_number": 3, "side_1_points": 11, "side_2_points": 7},
            ],
            "consecutively",
        ),
        # Duplicate game numbers.
        (
            [
                {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                {"game_number": 1, "side_1_points": 11, "side_2_points": 7},
            ],
            "Duplicate",
        ),
        # Undecided — 1-1 in best-of-3 (need 2 wins).
        (
            [
                {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                {"game_number": 2, "side_1_points": 4, "side_2_points": 11},
            ],
            "decided",
        ),
        # Scored games past the decider — won 2-0 in game 2 but a game 3 is
        # also reported.
        (
            [
                {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                {"game_number": 2, "side_1_points": 11, "side_2_points": 7},
                {"game_number": 3, "side_1_points": 11, "side_2_points": 9},
            ],
            "past the deciding game",
        ),
        # game_number > best_of.
        (
            [
                {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                {"game_number": 2, "side_1_points": 11, "side_2_points": 7},
                {"game_number": 3, "side_1_points": 11, "side_2_points": 9},
                {"game_number": 4, "side_1_points": 11, "side_2_points": 9},
            ],
            "best_of",
        ),
    ],
)
async def test_finalize_422_on_invalid_payload(
    api_client: AsyncClient,
    db_session: AsyncSession,
    games: list[dict[str, int]],
    reason_contains: str,
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=3)

    response = await api_client.post(
        f"/v1/matches/{match['id']}/results", json={"games": games}
    )
    assert response.status_code == 422
    assert reason_contains in response.json()["detail"]


async def test_finalize_422_on_illegal_per_game_score(
    api_client: AsyncClient, db_session: AsyncSession
):
    # An individual game with an illegal score (11-10, no win-by-2) trips
    # the per-game validator inside MatchResultsGameWrite.
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=3)

    response = await api_client.post(
        f"/v1/matches/{match['id']}/results",
        json={
            "games": [
                {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                {"game_number": 2, "side_1_points": 11, "side_2_points": 10},
            ]
        },
    )
    assert response.status_code == 422


async def test_can_finalize_flag_tracks_saved_scores(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=3)

    after_g1 = (
        await api_client.post(
            f"/v1/matches/{match['id']}/games/1/scores/new",
            json={"side_1_points": 11, "side_2_points": 4},
        )
    ).json()
    # One game in — not enough to decide a best-of-3.
    assert after_g1["can_finalize"] is False

    after_g2 = (
        await api_client.post(
            f"/v1/matches/{match['id']}/games/2/scores/new",
            json={"side_1_points": 11, "side_2_points": 7},
        )
    ).json()
    # Same winner in both — match is decided.
    assert after_g2["can_finalize"] is True

    # Splitting g1/g2 leaves the match 1-1: undecided.
    edited = (
        await api_client.put(
            f"/v1/matches/{match['id']}/games/2/scores",
            json={"side_1_points": 5, "side_2_points": 11},
        )
    ).json()
    assert edited["can_finalize"] is False


# ----- league binding -----------------------------------------------------


async def test_create_match_without_league_id_uses_default_league(
    api_client: AsyncClient,
    db_session: AsyncSession,
    default_league: League,
):
    await start_session(api_client, db_session)
    response = await api_client.post("/v1/matches", json={"best_of": 3, "rated": False})
    assert response.status_code == 201
    body = response.json()
    assert body["league"]["id"] == str(default_league.id)
    assert body["league"]["name"] == default_league.name


async def test_create_match_with_explicit_league_id_uses_that_league(
    api_client: AsyncClient,
    db_session: AsyncSession,
    default_league: League,
):
    other = League(
        name="Side League",
        description="Not the default.",
        visibility=LeagueVisibility.private,
        rating_strategy_id=default_league.rating_strategy_id,
    )
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)

    await start_session(api_client, db_session)
    response = await api_client.post(
        "/v1/matches",
        json={"best_of": 3, "rated": False, "league_id": str(other.id)},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["league"]["id"] == str(other.id)
    assert body["league"]["name"] == "Side League"


async def test_create_match_with_unknown_league_id_is_404(
    api_client: AsyncClient,
    db_session: AsyncSession,
    default_league: League,
):
    await start_session(api_client, db_session)
    response = await api_client.post(
        "/v1/matches",
        json={
            "best_of": 3,
            "rated": False,
            "league_id": str(uuid.uuid4()),
        },
    )
    assert response.status_code == 404
    assert "league" in response.json()["detail"].lower()


async def test_create_match_with_no_default_seeded_is_500(
    api_client: AsyncClient,
    db_session: AsyncSession,
    default_league: League,
):
    await start_session(api_client, db_session)
    # Remove the autouse default after the session has already attached a
    # membership; the create-match call should now have no fallback to land on.
    await db_session.delete(default_league)
    await db_session.commit()

    response = await api_client.post("/v1/matches", json={"best_of": 3, "rated": False})
    assert response.status_code == 500


async def test_list_and_get_match_include_league(
    api_client: AsyncClient,
    db_session: AsyncSession,
    default_league: League,
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "league-rival")
    created = (
        await api_client.post(
            "/v1/matches",
            json={
                "opponent_user_id": str(opp.id),
                "best_of": 3,
                "rated": True,
            },
        )
    ).json()

    detail = (await api_client.get(f"/v1/matches/{created['id']}")).json()
    assert detail["league"]["id"] == str(default_league.id)
    assert detail["league"]["name"] == default_league.name

    listing = (await api_client.get("/v1/matches")).json()
    assert listing["items"][0]["league"]["id"] == str(default_league.id)


# ----- recent form + head to head -----------------------------------------


async def _play_match_to_completion(
    client: AsyncClient,
    opp_client: AsyncClient,
    opp_id: uuid.UUID,
    best_of: int,
    side_1_wins: bool,
) -> dict:
    """Create a match, post the result, and have the opponent confirm it —
    the full sign-off dance. The chosen side wins the minimum number of games
    needed to clinch. Returns the post-confirmation MatchDetails body."""
    match = await _create_match(client, opp_id, best_of=best_of)
    needed = best_of // 2 + 1
    s1, s2 = (11, 5) if side_1_wins else (5, 11)
    post = await client.post(
        f"/v1/matches/{match['id']}/results",
        json={
            "games": [
                {"game_number": n, "side_1_points": s1, "side_2_points": s2}
                for n in range(1, needed + 1)
            ]
        },
    )
    assert post.status_code == 201
    confirm = await opp_client.post(f"/v1/matches/{match['id']}/confirmation")
    assert confirm.status_code == 201
    body = confirm.json()
    assert body["status"] == "completed"
    return body


async def test_details_includes_empty_recent_form_for_first_meeting(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "first-rival")
    created = await _create_match(api_client, opp.id, best_of=3)

    detail = (await api_client.get(f"/v1/matches/{created['id']}")).json()
    assert detail["head_to_head"] == {
        "total_meetings": 0,
        "side_1_wins": 0,
        "side_2_wins": 0,
        "recent_meetings": [],
    }
    # Both players are in recent_form, both with empty results lists.
    forms = {f["user_id"]: f for f in detail["recent_form"]}
    assert len(forms) == 2
    for f in forms.values():
        assert f["recent_results"] == []


async def test_details_recent_form_lists_each_player_previous_results(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    opp = await make_user(db_session, "form-rival")
    # Play two finished matches with a third party so each side has its own
    # prior history that's *not* a head-to-head meeting.
    async with opponent_session(db_session, "third-party") as (other_client, other):
        await _play_match_to_completion(
            api_client, other_client, other.id, best_of=3, side_1_wins=True
        )
        await _play_match_to_completion(
            api_client, other_client, other.id, best_of=3, side_1_wins=False
        )
    # Now start a head-to-head match and ask for its details.
    current = await _create_match(api_client, opp.id, best_of=3)
    detail = (await api_client.get(f"/v1/matches/{current['id']}")).json()

    forms = {f["user_id"]: f for f in detail["recent_form"]}
    # I have 2 prior completed matches (1 W, 1 L) against third-party.
    mine = forms[str(me.id)]
    assert {r["is_win"] for r in mine["recent_results"]} == {True, False}
    assert all(r["opponent_username"] == "third-party" for r in mine["recent_results"])
    # Opp shows up in the form list with no prior completed matches.
    assert forms[str(opp.id)]["recent_results"] == []


async def test_details_recent_form_excludes_the_current_match(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    # Play to completion against this opp, then look up that match's detail.
    async with opponent_session(db_session, "exclude-rival") as (opp_client, opp):
        finished = await _play_match_to_completion(
            api_client, opp_client, opp.id, best_of=3, side_1_wins=True
        )

    detail = (await api_client.get(f"/v1/matches/{finished['id']}")).json()
    forms = {f["user_id"]: f for f in detail["recent_form"]}
    # The finished match itself must not appear in its own recent-form list.
    for f in forms.values():
        assert all(r["match_id"] != finished["id"] for r in f["recent_results"])


async def test_details_recent_form_excludes_matches_after_this_one(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Viewing an older match shows form as it stood then: a match completed
    before this one was created counts; one completed after it does not."""
    me = await start_session(api_client, db_session)
    opp = await make_user(db_session, "after-rival")
    async with opponent_session(db_session, "after-third-party") as (
        other_client,
        other,
    ):
        # A match I finished *before* the viewed match is created.
        earlier = await _play_match_to_completion(
            api_client, other_client, other.id, best_of=3, side_1_wins=True
        )
        # The match we'll view (in progress, so it stays "current" in time).
        current = await _create_match(api_client, opp.id, best_of=3)
        # A match I finish *after* the viewed match was created.
        later = await _play_match_to_completion(
            api_client, other_client, other.id, best_of=3, side_1_wins=False
        )

    detail = (await api_client.get(f"/v1/matches/{current['id']}")).json()
    forms = {f["user_id"]: f for f in detail["recent_form"]}
    my_match_ids = {r["match_id"] for r in forms[str(me.id)]["recent_results"]}
    assert earlier["id"] in my_match_ids
    assert later["id"] not in my_match_ids


async def test_details_head_to_head_counts_prior_meetings_per_side(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "h2h-rival") as (rival_client, rival):
        # Three completed prior meetings: I win two, lose one.
        await _play_match_to_completion(
            api_client, rival_client, rival.id, best_of=3, side_1_wins=True
        )
        await _play_match_to_completion(
            api_client, rival_client, rival.id, best_of=3, side_1_wins=True
        )
        await _play_match_to_completion(
            api_client, rival_client, rival.id, best_of=3, side_1_wins=False
        )
        # New in-progress match — H2H counts only completed *prior* meetings.
        current = await _create_match(api_client, rival.id, best_of=5)

    detail = (await api_client.get(f"/v1/matches/{current['id']}")).json()
    h2h = detail["head_to_head"]
    assert h2h["total_meetings"] == 3
    assert h2h["side_1_wins"] == 2  # me, on side 1 of the current match
    assert h2h["side_2_wins"] == 1
    # Most-recent meeting is the one I just lost.
    assert h2h["recent_meetings"][0]["winner_side_number"] == 2


async def test_details_head_to_head_is_null_for_solo_match(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    created = (
        await api_client.post("/v1/matches", json={"best_of": 3, "rated": False})
    ).json()
    detail = (await api_client.get(f"/v1/matches/{created['id']}")).json()
    assert detail["head_to_head"] is None
    # Only the creator is in recent_form — and they have no prior history.
    assert len(detail["recent_form"]) == 1
    assert detail["recent_form"][0]["recent_results"] == []


async def test_details_recent_form_includes_pre_match_rating_and_career(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "career-other") as (other_client, other):
        # Two completed wins build up career stats *and* rating history before
        # the head-to-head match is created.
        await _play_match_to_completion(
            api_client, other_client, other.id, best_of=3, side_1_wins=True
        )
        await _play_match_to_completion(
            api_client, other_client, other.id, best_of=3, side_1_wins=True
        )

    opp = await make_user(db_session, "pre-rating-opp")
    current = await _create_match(api_client, opp.id, best_of=3)
    detail = (await api_client.get(f"/v1/matches/{current['id']}")).json()

    forms = {f["user_id"]: f for f in detail["recent_form"]}
    mine = forms[str(me.id)]
    # I had 2 completed matches before this one, both wins.
    assert mine["career_matches_before"] == 2
    assert mine["career_wins_before"] == 2
    # Rating history exists with 3 prior entries (the league-join seed plus
    # one per rated match) and rating_before matches the most-recent entry.
    assert mine["rating_before"] is not None
    assert len(mine["rating_history"]) == 3
    assert mine["rating_history"][-1] == mine["rating_before"]
    # Brand-new opponent: no rating, no career.
    fresh = forms[str(opp.id)]
    assert fresh["rating_before"] is None
    assert fresh["rating_history"] == []
    assert fresh["career_matches_before"] == 0
    assert fresh["career_wins_before"] == 0


async def test_details_recent_form_excludes_self_from_career_count(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A just-completed match's own row in rating_history / its own match
    row must not double-count itself in the BFF. The session user still shows
    their league-join seed (recorded before the match), but none of the
    match's own freshly-written rating rows leak into the pre-match view."""
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "self-exclude-opp") as (opp_client, opp):
        finished = await _play_match_to_completion(
            api_client, opp_client, opp.id, best_of=3, side_1_wins=True
        )

    detail = (await api_client.get(f"/v1/matches/{finished['id']}")).json()
    forms = {f["user_id"]: f for f in detail["recent_form"]}
    # No prior matches exist — only the current one — so career counts are 0
    # for both players.
    for f in forms.values():
        assert f["career_matches_before"] == 0
        assert f["career_wins_before"] == 0

    # The session user joined the league at signup, so their pre-match rating
    # is the seeded baseline; the match's own rating rows are excluded.
    mine = forms[str(me.id)]
    assert mine["rating_before"] == 1500.0
    assert mine["rating_history"] == [1500.0]

    # The opponent's session join seeded their rating too — but only the
    # match-sourced rating row would predate the *next* match, and there
    # isn't one — so their pre-match history for this match is just the
    # seed (recorded before the match was created).
    opp_form = forms[str(opp.id)]
    assert opp_form["rating_before"] == 1500.0
    assert opp_form["rating_history"] == [1500.0]


async def test_list_matches_csv_export(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    opp = await make_user(db_session, "csv-rival")
    created = await _create_match(api_client, opp.id, best_of=5)

    response = await api_client.get("/v1/matches.csv")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "attachment; filename=" in response.headers["content-disposition"]
    lines = response.text.strip().splitlines()
    assert lines[0] == "Match ID,Created,Status,League,Side 1,Side 2,Score,Best of"
    # One data row for the one match, carrying both players + best_of.
    assert len(lines) == 2
    assert created["id"] in lines[1]
    assert me.username in lines[1]
    assert opp.username in lines[1]
    assert lines[1].endswith(",5")  # best_of; score blank while pending


async def test_list_matches_csv_includes_score_for_completed(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "csv-finished") as (opp_client, opp):
        await _play_match_to_completion(
            api_client, opp_client, opp.id, best_of=3, side_1_wins=True
        )

    response = await api_client.get("/v1/matches.csv")

    lines = response.text.strip().splitlines()
    assert len(lines) == 2
    # Best-of-3 won 2-0 by side 1 → score column populated.
    assert lines[1].endswith(",2-0,3")


async def test_list_matches_csv_honors_status_filter(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "csv-filter")
    await _create_match(api_client, opp.id)  # pending

    response = await api_client.get("/v1/matches.csv?status=completed")

    # Header only — the pending match is filtered out.
    assert response.status_code == 200
    assert response.text.strip().splitlines() == [
        "Match ID,Created,Status,League,Side 1,Side 2,Score,Best of"
    ]


# ----- signature flow (POST /confirmation + /dispute) ---------------------


async def _post_results(client: AsyncClient, match_id: str, best_of: int = 3) -> dict:
    """Caller wins the minimum games needed to clinch a best-of-N. Returns
    the response body."""
    needed = best_of // 2 + 1
    response = await client.post(
        f"/v1/matches/{match_id}/results",
        json={
            "games": [
                {"game_number": n, "side_1_points": 11, "side_2_points": 4}
                for n in range(1, needed + 1)
            ]
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


async def test_confirmation_finalizes_and_lands_second_signature(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "sig-opp") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        await _post_results(api_client, match["id"])

        confirm = await opp_client.post(f"/v1/matches/{match['id']}/confirmation")
        assert confirm.status_code == 201
        body = confirm.json()
        assert body["status"] == "completed"
        assert body["status_label"] == "Final"
        signers = {sig["user_id"] for sig in body["signatures"]}
        assert signers == {str(me.id), str(opp.id)}
        assert body["can_confirm"] is False


async def test_dispute_clears_signatures_and_rewinds_to_in_progress(
    api_client: AsyncClient, db_session: AsyncSession
):
    """``POST /dispute`` deletes every signature on the match, drops the
    side.won flags back to None, and leaves the canonical games in place so
    the disputer can navigate to the contested game and PUT a correction."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "dispute-opp") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        await _post_results(api_client, match["id"])

        dispute = await opp_client.post(f"/v1/matches/{match['id']}/dispute")
        assert dispute.status_code == 200
        body = dispute.json()
        assert body["status"] == "in_progress"
        assert body["status_label"] == "Live"
        assert body["signatures"] == []
        sides = sorted(body["sides"], key=lambda s: s["side_number"])
        assert [s["won"] for s in sides] == [None, None]
        # games_won still reflects the canonical scores (they're preserved so
        # the disputer can edit just the contested one); only the "this side
        # won" claim is rescinded.
        assert [s["games_won"] for s in sides] == [2, 0]
        # current_game must NOT point at a never-played game number — bo3
        # decided 2-0 has no "game 3" to score, even though one slot is
        # un-scored in 1..best_of. Otherwise the dashboard / list / scoring
        # page deep-links into a phantom game.
        assert body["current_game"] is None
        # ...but the match IS scorable again: clearing the signatures reopens
        # the scratchpad, so can_score is True even though there's no next game
        # to play (the disputer edits the contested game in place). Editability
        # follows the signature, not whether the board currently decides it.
        assert body["can_score"] is True
        # The saved scores are still valid + decided, so a mistaken dispute can
        # be undone by re-posting them unchanged (back into the sign-off flow).
        assert body["can_finalize"] is True
        # Canonical games stay around so the contested score can be edited.
        games = sorted(body["games"], key=lambda g: g["game_number"])
        assert [g["game_number"] for g in games] == [1, 2]
        for g in games:
            assert g["score"] is not None

        # The disputer can now PUT a correction to flip the result.
        put = await opp_client.put(
            f"/v1/matches/{match['id']}/games/2/scores",
            json={"side_1_points": 5, "side_2_points": 11},
        )
        assert put.status_code == 200


async def test_results_on_solo_finalizes_with_no_signature_row(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Solo matches (no opponent picked) keep today's auto-finalize behavior
    on /results — there's no second party to attest, so the match flips
    straight to completed and no signature row is inserted."""
    await start_session(api_client, db_session)
    match = (
        await api_client.post("/v1/matches", json={"best_of": 1, "rated": False})
    ).json()
    body = await _post_results(api_client, match["id"], best_of=1)
    assert body["status"] == "completed"
    assert body["signatures"] == []


async def test_confirmation_409_when_no_result_posted(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "early-confirm-opp") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        response = await opp_client.post(f"/v1/matches/{match['id']}/confirmation")
        assert response.status_code == 409
        assert "No posted result" in response.json()["detail"]


async def test_dispute_409_when_no_signatures(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "early-dispute-opp") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        response = await opp_client.post(f"/v1/matches/{match['id']}/dispute")
        assert response.status_code == 409


async def test_signer_cannot_confirm_or_dispute_their_own_post(
    api_client: AsyncClient, db_session: AsyncSession
):
    """``/confirmation`` and ``/dispute`` both require the caller to be a
    participant who *hasn't* yet signed. The first poster has already signed,
    so they get 409 on both."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "self-sign-opp") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        await _post_results(api_client, match["id"])

        self_confirm = await api_client.post(f"/v1/matches/{match['id']}/confirmation")
        assert self_confirm.status_code == 409
        self_dispute = await api_client.post(f"/v1/matches/{match['id']}/dispute")
        assert self_dispute.status_code == 409


async def test_non_participant_cannot_confirm_or_dispute(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A non-participant gets 404, mirroring the per-game write endpoints —
    no way to learn the match exists from a write path."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "non-part-opp") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        await _post_results(api_client, match["id"])

        # A third party — not the poster, not the opponent — can't sign.
        async with make_client() as bystander_client:
            await start_session(bystander_client, db_session)
            confirm = await bystander_client.post(
                f"/v1/matches/{match['id']}/confirmation"
            )
            assert confirm.status_code == 404
            dispute = await bystander_client.post(f"/v1/matches/{match['id']}/dispute")
            assert dispute.status_code == 404

        # Sanity: the legit opponent can still confirm.
        confirm = await opp_client.post(f"/v1/matches/{match['id']}/confirmation")
        assert confirm.status_code == 201


async def test_confirmation_409_after_already_finalized(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Once both sides have signed and the match is completed, further
    /confirmation calls 409. ``_enforce_confirmable`` catches it on the
    ``status != in_progress`` gate."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "post-final-opp") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        await _post_results(api_client, match["id"])
        first = await opp_client.post(f"/v1/matches/{match['id']}/confirmation")
        assert first.status_code == 201

        again = await opp_client.post(f"/v1/matches/{match['id']}/confirmation")
        assert again.status_code == 409


async def test_signature_unique_violation_returns_409_not_500(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The ``_enforce_*`` predicates catch a same-user double-sign before
    the insert, but a racing in-flight transaction can still slip past
    them and trip ``uq_match_signatures_match_id_user_id`` at commit. Map
    that to a 409 instead of a 500 so the user sees a coherent error on a
    rapid double-click / retry / browser-back refire.

    Simulated here by stuffing a pre-existing signature into the DB
    *after* the in-process handler's predicate read; commit then fails on
    the unique constraint and the helper should translate to 409."""
    from app.models import MatchSignature

    await start_session(api_client, db_session)
    async with opponent_session(db_session, "race-opp") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        await _post_results(api_client, match["id"])

        # Race surrogate: insert a duplicate opponent signature directly so
        # the next /confirmation appends a second MatchSignature(opp.id)
        # and 409s on the unique constraint at commit.
        db_session.add(MatchSignature(match_id=uuid.UUID(match["id"]), user_id=opp.id))
        await db_session.commit()

        response = await opp_client.post(f"/v1/matches/{match['id']}/confirmation")
        assert response.status_code == 409
        assert "already" in response.json()["detail"].lower()


async def test_dispute_then_repost_finalizes_with_fresh_signatures(
    api_client: AsyncClient, db_session: AsyncSession
):
    """End-to-end: poster posts, opp disputes, poster re-posts, opp confirms.
    The signature set after re-post contains exactly the new poster's row;
    after confirm, both sides are present."""
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "dispute-flow-opp") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        await _post_results(api_client, match["id"])

        dispute = await opp_client.post(f"/v1/matches/{match['id']}/dispute")
        assert dispute.status_code == 200
        assert dispute.json()["signatures"] == []

        # Re-post (same payload — doesn't matter what changed for this test).
        re_post = await _post_results(api_client, match["id"])
        assert re_post["status"] == "in_progress"
        assert [sig["user_id"] for sig in re_post["signatures"]] == [str(me.id)]

        confirm = await opp_client.post(f"/v1/matches/{match['id']}/confirmation")
        assert confirm.status_code == 201
        body = confirm.json()
        assert body["status"] == "completed"
        assert {sig["user_id"] for sig in body["signatures"]} == {
            str(me.id),
            str(opp.id),
        }


async def test_dispute_zeros_side_score_to_match_won_reset(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The denormalized ``side.score`` column has to stay consistent with
    ``side.won`` after a dispute. The BFF derives ``games_won`` from
    ``match.games`` (so the API response keeps the canonical counts), but
    any direct DB reader of ``side.score`` (analytics, future BFFs, the
    rating recompute job) would otherwise see won=None alongside score>0
    — a contradictory row state ``api/CLAUDE.md`` flags as a smell."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "side-score-opp") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        await _post_results(api_client, match["id"])
        # After /results: side.score should reflect the win counts.
        row = (
            await db_session.execute(
                select(Match)
                .where(Match.id == uuid.UUID(match["id"]))
                .options(selectinload(Match.sides))
            )
        ).scalar_one()
        sides_by_number = {s.side_number: s for s in row.sides}
        assert sides_by_number[1].score == 2
        assert sides_by_number[2].score == 0

        await opp_client.post(f"/v1/matches/{match['id']}/dispute")
        db_session.expire_all()
        row = (
            await db_session.execute(
                select(Match)
                .where(Match.id == uuid.UUID(match["id"]))
                .options(selectinload(Match.sides))
            )
        ).scalar_one()
        sides_by_number = {s.side_number: s for s in row.sides}
        # Both won AND score reset on dispute.
        assert [sides_by_number[n].won for n in (1, 2)] == [None, None]
        assert [sides_by_number[n].score for n in (1, 2)] == [0, 0]


async def test_awaiting_confirmation_response_keeps_won_and_scores_public(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Locks the "unratified result is public" contract for both the authed
    detail endpoint AND the anonymous public read path. From the moment
    ``POST /results`` lands, ``side.won`` and ``games[].score`` are visible;
    confirmation only ratifies the result for ratings/finality. The
    awaiting state is conveyed by ``status_label="Awaiting confirmation"``,
    NOT by hiding the outcome."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "shape-opp") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        await _post_results(api_client, match["id"])

        # Authed read (poster's perspective).
        authed = (await api_client.get(f"/v1/matches/{match['id']}")).json()
        assert authed["status"] == "in_progress"
        assert authed["status_label"] == "Awaiting confirmation"
        sides = sorted(authed["sides"], key=lambda s: s["side_number"])
        assert [s["won"] for s in sides] == [True, False]
        assert [s["games_won"] for s in sides] == [2, 0]
        # Per-game scores stay visible — the opponent (and any third party)
        # needs to see what's being attested to.
        for g in sorted(authed["games"], key=lambda g: g["game_number"]):
            assert g["score"] is not None
            assert g["score"]["side_1_points"] > 0
        assert len(authed["signatures"]) == 1

        # Anonymous read (public share route via the same endpoint).
        async with make_client() as anon:
            anon_view = (await anon.get(f"/v1/matches/{match['id']}")).json()
        assert anon_view["status"] == "in_progress"
        assert anon_view["status_label"] == "Awaiting confirmation"
        anon_sides = sorted(anon_view["sides"], key=lambda s: s["side_number"])
        assert [s["won"] for s in anon_sides] == [True, False]
        for g in sorted(anon_view["games"], key=lambda g: g["game_number"]):
            assert g["score"] is not None
        # Anonymous viewers see signatures (just user_id + signed_at — no PII).
        assert len(anon_view["signatures"]) == 1
        # No write affordances for the spectator.
        assert anon_view["can_score"] is False
        assert anon_view["can_finalize"] is False
        assert anon_view["can_confirm"] is False


async def test_list_status_label_reflects_awaiting_confirmation(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A list row for a match with a posted-but-unconfirmed result shows
    the ``Awaiting confirmation`` label, even though ``status`` remains
    ``in_progress`` — the FE renders the label directly."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "list-label-opp") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        await _post_results(api_client, match["id"])

    listing = (await api_client.get("/v1/matches")).json()
    row = next(r for r in listing["items"] if r["id"] == match["id"])
    assert row["status"] == "in_progress"
    assert row["status_label"] == "Awaiting confirmation"


async def test_list_row_can_confirm_flag_for_pending_signer(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The matches list surfaces ``can_confirm`` so the FE can flag rows the
    caller owes a signature on. The poster sees False (they signed); the
    opponent sees True."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "list-can-confirm-opp") as (
        opp_client,
        opp,
    ):
        match = await _create_match(api_client, opp.id, best_of=3)
        await _post_results(api_client, match["id"])

        my_list = (await api_client.get("/v1/matches")).json()
        my_row = next(r for r in my_list["items"] if r["id"] == match["id"])
        assert my_row["can_confirm"] is False

        opp_list = (await opp_client.get("/v1/matches")).json()
        opp_row = next(r for r in opp_list["items"] if r["id"] == match["id"])
        assert opp_row["can_confirm"] is True


async def test_concurrent_confirm_and_dispute_serialize(
    api_client: AsyncClient, db_session: AsyncSession, engine: AsyncEngine
):
    """Regression for #365. The opponent firing ``POST /confirmation`` and
    ``POST /dispute`` at the same instant must not corrupt the match.

    Before the row lock in ``_load_match_for_scoring(..., lock=True)`` both
    transactions read the same pre-image, both passed ``_enforce_confirmable``,
    and both committed — leaving a ``completed`` match with ``won=None`` on
    both sides, a single signature, and a rating change applied. The lock
    serializes them: exactly one transition wins, the other re-reads the
    committed post-image and 409s, and the match invariants always hold.

    This drives the two route handlers on *separate* DB sessions (real
    distinct Postgres connections) via ``asyncio.gather`` so the ``FOR UPDATE``
    actually blocks — the shared ``db_session`` override can't surface the race.
    """
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "race-opp") as (_opp_client, opp):
        # Set up a rated best-of-1 in "Awaiting confirmation": creator posts a
        # decided result, leaving the opponent owing a signature. These HTTP
        # calls commit, so fresh sessions on the same engine see the rows.
        match = await _create_match(api_client, opp.id, best_of=1)
        await _post_results(api_client, match["id"], best_of=1)
        match_id = uuid.UUID(match["id"])
        opp_id = opp.id

        make_session = async_sessionmaker(engine, expire_on_commit=False)

        async def run(
            handler: Callable[[uuid.UUID, User, AsyncSession], Awaitable[object]],
        ) -> object:
            # Each racer gets its own session/connection, mirroring two
            # concurrent requests. Return the HTTP status on rejection so the
            # assertions can tell winner from loser.
            async with make_session() as session:
                opp_user = (
                    await session.execute(select(User).where(User.id == opp_id))
                ).scalar_one()
                try:
                    await handler(match_id, opp_user, session)
                    return "ok"
                except HTTPException as exc:
                    return exc.status_code

        outcomes = await asyncio.gather(
            run(confirm_match_result), run(dispute_match_result)
        )

        # Exactly one transition wins; the other is cleanly rejected (409),
        # never a second silent success.
        assert sorted(str(o) for o in outcomes) == ["409", "ok"], outcomes

        # The committed match holds its invariants no matter which won.
        async with make_session() as verify:
            final = (
                await verify.execute(
                    select(Match)
                    .where(Match.id == match_id)
                    .options(selectinload(Match.sides), selectinload(Match.signatures))
                )
            ).scalar_one()
            sides = sorted(final.sides, key=lambda s: s.side_number)
            if final.status == MatchStatus.completed:
                # Confirm won: a real outcome and both signatures present.
                assert {s.won for s in sides} == {True, False}, [s.won for s in sides]
                assert len(final.signatures) == 2
            else:
                # Dispute won: rewound to in_progress with no live signatures
                # and no recorded winner.
                assert final.status == MatchStatus.in_progress
                assert final.signatures == []
                assert [s.won for s in sides] == [None, None]


# ----- result-confirmation push -------------------------------------------


async def _register_device(
    client: AsyncClient, token: str, *, environment: str = "sandbox"
) -> None:
    response = await client.post(
        "/v1/device-tokens",
        json={"token": token, "platform": "ios", "environment": environment},
    )
    assert response.status_code == 200, response.text


async def test_posting_result_pushes_confirmation_to_opponent(
    api_client: AsyncClient, db_session: AsyncSession
):
    """When a player posts a result on a two-human match, the opponent gets a
    push carrying the Approve/Dispute category, the match id, and copy with the
    games-won score plus the individual game scores."""
    me = await start_session(api_client, db_session)
    me.username = "poster"
    await db_session.commit()

    sender = FakeSender()
    use_sender(sender)

    async with opponent_session(db_session, "rival") as (opp_client, opp):
        await _register_device(opp_client, "opp-device")
        match = await _create_match(api_client, opp.id, best_of=3)

        response = await api_client.post(
            f"/v1/matches/{match['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 7},
                    {"game_number": 2, "side_1_points": 9, "side_2_points": 11},
                    {"game_number": 3, "side_1_points": 11, "side_2_points": 8},
                ]
            },
        )
        assert response.status_code == 201

    assert len(sender.sent) == 1
    push = sender.sent[0]
    assert push.token == "opp-device"
    assert push.category == MATCH_RESULT_CONFIRMATION_CATEGORY
    assert push.data == {"match_id": match["id"]}
    # Recipient-framed games-won (poster won 2–1) and the per-game scores,
    # oriented poster-first.
    assert "poster reported beating you 2–1" in push.body
    assert "11–7" in push.body
    assert "9–11" in push.body
    assert "11–8" in push.body


async def test_posting_result_does_not_push_to_the_poster(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Only the side that owes a sign-off is notified — never the poster, even
    when both players have a device registered."""
    await start_session(api_client, db_session)
    await _register_device(api_client, "poster-device")

    sender = FakeSender()
    use_sender(sender)

    async with opponent_session(db_session, "rival") as (opp_client, opp):
        await _register_device(opp_client, "opp-device")
        match = await _create_match(api_client, opp.id, best_of=1)

        response = await api_client.post(
            f"/v1/matches/{match['id']}/results",
            json={
                "games": [{"game_number": 1, "side_1_points": 11, "side_2_points": 5}]
            },
        )
        assert response.status_code == 201

    assert [push.token for push in sender.sent] == ["opp-device"]


async def test_solo_result_sends_no_push(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A solo (opponent-less) match finalizes on post with nobody to confirm —
    so no confirmation push is fired."""
    await start_session(api_client, db_session)

    sender = FakeSender()
    use_sender(sender)

    created = await api_client.post("/v1/matches", json={"best_of": 1, "rated": False})
    assert created.status_code == 201
    match = created.json()

    response = await api_client.post(
        f"/v1/matches/{match['id']}/results",
        json={"games": [{"game_number": 1, "side_1_points": 11, "side_2_points": 5}]},
    )
    assert response.status_code == 201
    assert sender.sent == []


async def test_posting_result_succeeds_when_opponent_has_no_device(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The push is best-effort: an opponent with no registered device just
    means nothing is sent — the result post still succeeds."""
    await start_session(api_client, db_session)

    sender = FakeSender()
    use_sender(sender)

    async with opponent_session(db_session, "rival") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        response = await api_client.post(
            f"/v1/matches/{match['id']}/results",
            json={
                "games": [{"game_number": 1, "side_1_points": 11, "side_2_points": 5}]
            },
        )
        assert response.status_code == 201

    assert sender.sent == []
