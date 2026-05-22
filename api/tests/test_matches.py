import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    League,
    LeagueVisibility,
    Match,
    MatchGame,
    MatchGameScore,
    MatchSide,
)
from tests._helpers import make_client, make_user, start_session


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

    # Game 1 always exists from the moment a match is created.
    assert len(body["games"]) == 1
    assert body["games"][0]["game_number"] == 1
    assert body["games"][0]["score"] is None
    assert body["current_game"]["id"] == body["games"][0]["id"]
    assert body["current_game"]["game_number"] == 1
    assert body["can_score"] is True

    match = (await db_session.execute(select(Match))).scalar_one()
    assert str(match.id) == body["id"]
    games = (await db_session.execute(select(MatchGame))).scalars().all()
    assert len(games) == 1
    assert games[0].game_number == 1


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

    response = await api_client.post(
        "/v1/matches", json={"best_of": 7, "rated": False}
    )
    assert response.status_code == 201
    body = response.json()
    assert body["affects_rating"] is False
    # Two sides: the creator, plus a player-less sentinel "No opponent" side.
    sides = sorted(body["sides"], key=lambda s: s["side_number"])
    assert [s["side_number"] for s in sides] == [1, 2]
    assert sides[0]["players"][0]["user_id"] == str(me.id)
    assert sides[1]["players"] == []
    # The sentinel side makes the match scorable for its creator.
    assert body["current_game"] is not None
    assert body["can_score"] is True

    rows = (await db_session.execute(select(MatchSide))).scalars().all()
    assert len(rows) == 2


async def test_match_without_opponent_can_be_scored_to_completion(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)

    match = (
        await api_client.post(
            "/v1/matches", json={"best_of": 3, "rated": False}
        )
    ).json()
    # The creator is side 1; the sentinel opponent is side 2.
    after_g1 = (
        await api_client.post(
            f"/v1/matches/{match['id']}/games/{match['games'][0]['id']}/scores",
            json={"side_1_points": 11, "side_2_points": 4},
        )
    ).json()
    assert after_g1["status"] == "in_progress"
    game_2 = after_g1["games"][1]
    after_g2 = (
        await api_client.post(
            f"/v1/matches/{match['id']}/games/{game_2['id']}/scores",
            json={"side_1_points": 11, "side_2_points": 7},
        )
    )
    assert after_g2.status_code == 201
    body = after_g2.json()
    assert body["status"] == "completed"
    sides = sorted(body["sides"], key=lambda s: s["side_number"])
    assert [s["won"] for s in sides] == [True, False]
    # No rating moved — a player-less opponent can't be rated against.
    assert body["affects_rating"] is False


async def test_rated_match_without_opponent_is_rejected(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)

    response = await api_client.post(
        "/v1/matches", json={"best_of": 5, "rated": True}
    )
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
    their_perspective = next(
        s for s in theirs["sides"] if s["is_current_user_side"]
    )
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
            not p["is_current_user"]
            for s in body["sides"]
            for p in s["players"]
        )
        assert body["can_score"] is False
        del spectator


async def test_get_unknown_match_is_404(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    response = await api_client.get(f"/v1/matches/{uuid.uuid4()}")
    assert response.status_code == 404


# ----- list ---------------------------------------------------------------


async def test_list_matches_empty(
    api_client: AsyncClient, db_session: AsyncSession
):
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

    listing = (
        await api_client.get("/v1/matches", params={"q": me.username})
    ).json()
    ids = {row["id"] for row in listing["items"]}
    assert mine["id"] in ids
    assert unrelated["id"] not in ids


async def test_list_filter_by_status(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    in_progress = await _create_match(api_client, opp.id, best_of=1)
    # Score game 1 to flip a separate match to completed.
    completed_match = await _create_match(api_client, opp.id, best_of=1)
    score_resp = await api_client.post(
        f"/v1/matches/{completed_match['id']}/games/{completed_match['games'][0]['id']}/scores",
        json={"side_1_points": 11, "side_2_points": 5},
    )
    assert score_resp.status_code == 201

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

    listing = (
        await api_client.get("/v1/matches", params={"q": "alpha"})
    ).json()
    assert len(listing["items"]) == 1
    players = {
        p["username"]
        for side in listing["items"][0]["sides"]
        for p in side["players"]
    }
    assert "alphabet" in players
    # status_counts honors q (one row total)
    assert sum(listing["status_counts"].values()) == 1


async def test_list_pagination(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    for _ in range(3):
        await _create_match(api_client, opp.id)

    page_1 = (
        await api_client.get(
            "/v1/matches", params={"page": 1, "page_size": 2}
        )
    ).json()
    page_2 = (
        await api_client.get(
            "/v1/matches", params={"page": 2, "page_size": 2}
        )
    ).json()
    assert page_1["total"] == 3
    assert len(page_1["items"]) == 2
    assert len(page_2["items"]) == 1
    assert {row["id"] for row in page_1["items"]} & {
        row["id"] for row in page_2["items"]
    } == set()


async def test_list_row_carries_current_game_id_when_scorable(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    created = await _create_match(api_client, opp.id)

    listing = (await api_client.get("/v1/matches")).json()
    row = listing["items"][0]
    assert row["current_game_id"] == created["games"][0]["id"]
    assert row["can_score"] is True


async def test_list_row_hides_scoring_affordance_from_spectators(
    api_client: AsyncClient, db_session: AsyncSession
):
    # Spectators get neither `can_score` nor `current_game_id` — the scoring
    # route 404s for them anyway, and the FE has no reason to deep-link.
    await start_session(api_client, db_session)
    async with make_client() as other_client:
        await start_session(other_client, db_session)
        bystander = await make_user(db_session, "bystander")
        created = await _create_match(other_client, bystander.id)

    listing = (await api_client.get("/v1/matches")).json()
    row = next(r for r in listing["items"] if r["id"] == created["id"])
    assert row["current_game_id"] is None
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
        f"/v1/matches/{match['id']}/games/{match['games'][0]['id']}/scores",
        json={"side_1_points": side_1, "side_2_points": side_2},
    )
    if is_valid:
        assert response.status_code == 201
    else:
        assert response.status_code == 422


# ----- score lifecycle ----------------------------------------------------


async def test_scoring_game_1_keeps_in_progress_and_adds_game_2(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)

    response = await api_client.post(
        f"/v1/matches/{match['id']}/games/{match['games'][0]['id']}/scores",
        json={"side_1_points": 11, "side_2_points": 4},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "in_progress"
    assert body["status_label"] == "Live"
    assert [s["games_won"] for s in body["sides"]] == [1, 0]

    # Game 2 has been opened.
    assert len(body["games"]) == 2
    assert body["games"][1]["game_number"] == 2
    assert body["games"][1]["score"] is None
    assert body["current_game"]["game_number"] == 2


async def test_deciding_game_flips_to_completed_with_no_trailing_unscored(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=3)

    # Win game 1, win game 2 → match completed (best of 3, need 2).
    after_g1 = (
        await api_client.post(
            f"/v1/matches/{match['id']}/games/{match['games'][0]['id']}/scores",
            json={"side_1_points": 11, "side_2_points": 4},
        )
    ).json()
    game_2 = after_g1["games"][1]
    after_g2 = (
        await api_client.post(
            f"/v1/matches/{match['id']}/games/{game_2['id']}/scores",
            json={"side_1_points": 11, "side_2_points": 7},
        )
    ).json()

    assert after_g2["status"] == "completed"
    assert after_g2["status_label"] == "Final"
    assert len(after_g2["games"]) == 2  # no trailing unscored game
    assert after_g2["current_game"] is None
    assert [s["won"] for s in after_g2["sides"]] == [True, False]
    assert after_g2["can_score"] is False


async def test_post_score_409_when_game_already_scored(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)
    game_id = match["games"][0]["id"]
    await api_client.post(
        f"/v1/matches/{match['id']}/games/{game_id}/scores",
        json={"side_1_points": 11, "side_2_points": 4},
    )

    second = await api_client.post(
        f"/v1/matches/{match['id']}/games/{game_id}/scores",
        json={"side_1_points": 11, "side_2_points": 5},
    )
    assert second.status_code == 409
    assert second.json()["detail"] == "This game has already been scored."


async def test_put_edits_a_past_games_score(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)
    game_1 = match["games"][0]
    after_g1 = (
        await api_client.post(
            f"/v1/matches/{match['id']}/games/{game_1['id']}/scores",
            json={"side_1_points": 11, "side_2_points": 4},
        )
    ).json()
    score_id = after_g1["games"][0]["score"]["id"]

    edited = await api_client.put(
        f"/v1/matches/{match['id']}/games/{game_1['id']}/scores/{score_id}",
        json={"side_1_points": 5, "side_2_points": 11},
    )
    assert edited.status_code == 200
    body = edited.json()
    assert [s["games_won"] for s in body["sides"]] == [0, 1]
    # Status stays in_progress; game 2 stays open.
    assert body["status"] == "in_progress"


async def test_put_reopens_a_completed_match(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=3)
    after_g1 = (
        await api_client.post(
            f"/v1/matches/{match['id']}/games/{match['games'][0]['id']}/scores",
            json={"side_1_points": 11, "side_2_points": 4},
        )
    ).json()
    game_2 = after_g1["games"][1]
    after_g2 = (
        await api_client.post(
            f"/v1/matches/{match['id']}/games/{game_2['id']}/scores",
            json={"side_1_points": 11, "side_2_points": 7},
        )
    ).json()
    assert after_g2["status"] == "completed"

    # Flip game 2 so the opponent wins it → only game 1 has been won by me, 1-1.
    g2_score_id = after_g2["games"][1]["score"]["id"]
    reopened = await api_client.put(
        f"/v1/matches/{match['id']}/games/{game_2['id']}/scores/{g2_score_id}",
        json={"side_1_points": 7, "side_2_points": 11},
    )
    assert reopened.status_code == 200
    body = reopened.json()
    assert body["status"] == "in_progress"
    assert all(s["won"] is None for s in body["sides"])
    # Game 3 has been opened by reconciliation.
    assert len(body["games"]) == 3
    assert body["games"][2]["score"] is None
    assert body["current_game"]["game_number"] == 3


async def test_put_closes_match_earlier_and_deletes_trailing_unscored(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=3)

    # Game 1: opponent wins. Game 2: I win. Now 1-1 with game 3 open.
    after_g1 = (
        await api_client.post(
            f"/v1/matches/{match['id']}/games/{match['games'][0]['id']}/scores",
            json={"side_1_points": 5, "side_2_points": 11},
        )
    ).json()
    game_2 = after_g1["games"][1]
    after_g2 = (
        await api_client.post(
            f"/v1/matches/{match['id']}/games/{game_2['id']}/scores",
            json={"side_1_points": 11, "side_2_points": 4},
        )
    ).json()
    assert after_g2["status"] == "in_progress"
    assert len(after_g2["games"]) == 3  # game 3 open

    # Edit game 1 so I win it instead → 2-0 → match completed, game 3 deleted.
    g1_score_id = after_g2["games"][0]["score"]["id"]
    edited = await api_client.put(
        f"/v1/matches/{match['id']}/games/{match['games'][0]['id']}/scores/{g1_score_id}",
        json={"side_1_points": 11, "side_2_points": 6},
    )
    body = edited.json()
    assert body["status"] == "completed"
    assert len(body["games"]) == 2
    assert body["current_game"] is None

    # No orphan score rows or trailing games left behind in the DB.
    games = (await db_session.execute(select(MatchGame))).scalars().all()
    assert len(games) == 2
    scores = (
        await db_session.execute(select(MatchGameScore))
    ).scalars().all()
    assert len(scores) == 2


async def test_put_404_for_unknown_score_id(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)
    game_id = match["games"][0]["id"]
    await api_client.post(
        f"/v1/matches/{match['id']}/games/{game_id}/scores",
        json={"side_1_points": 11, "side_2_points": 4},
    )

    response = await api_client.put(
        f"/v1/matches/{match['id']}/games/{game_id}/scores/{uuid.uuid4()}",
        json={"side_1_points": 11, "side_2_points": 5},
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "Score not found."


async def test_put_404_for_mismatched_game_and_score(
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
    score_id = after_g1["games"][0]["score"]["id"]
    other_game_id = after_g1["games"][1]["id"]

    response = await api_client.put(
        f"/v1/matches/{match['id']}/games/{other_game_id}/scores/{score_id}",
        json={"side_1_points": 11, "side_2_points": 5},
    )
    assert response.status_code == 404


async def test_non_participant_cannot_score(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    async with make_client() as other_client:
        them = await start_session(other_client, db_session)
        bystander = await make_user(db_session, "bystander")
        created = await _create_match(other_client, bystander.id)
        del them

        post = await api_client.post(
            f"/v1/matches/{created['id']}/games/{created['games'][0]['id']}/scores",
            json={"side_1_points": 11, "side_2_points": 4},
        )
        assert post.status_code == 404
        put = await api_client.put(
            f"/v1/matches/{created['id']}/games/{created['games'][0]['id']}/scores/{uuid.uuid4()}",
            json={"side_1_points": 11, "side_2_points": 4},
        )
        assert put.status_code == 404


async def test_scoring_an_unknown_game_404(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)
    response = await api_client.post(
        f"/v1/matches/{match['id']}/games/{uuid.uuid4()}/scores",
        json={"side_1_points": 11, "side_2_points": 4},
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "Game not found."


async def test_can_score_match_without_opponent(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    created = (
        await api_client.post(
            "/v1/matches", json={"best_of": 5, "rated": False}
        )
    ).json()
    response = await api_client.post(
        f"/v1/matches/{created['id']}/games/{created['games'][0]['id']}/scores",
        json={"side_1_points": 11, "side_2_points": 4},
    )
    # The sentinel opponent side makes the match scorable.
    assert response.status_code == 201
    body = response.json()
    sides = sorted(body["sides"], key=lambda s: s["side_number"])
    assert [s["games_won"] for s in sides] == [1, 0]


# ----- league binding -----------------------------------------------------


async def test_create_match_without_league_id_uses_default_league(
    api_client: AsyncClient,
    db_session: AsyncSession,
    default_league: League,
):
    await start_session(api_client, db_session)
    response = await api_client.post(
        "/v1/matches", json={"best_of": 3, "rated": False}
    )
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

    response = await api_client.post(
        "/v1/matches", json={"best_of": 3, "rated": False}
    )
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
    opponent_id: uuid.UUID,
    best_of: int,
    side_1_wins: bool,
) -> dict:
    """Create a match and score it to completion. The chosen side wins the
    minimum number of games needed to clinch. Returns the final payload."""
    match = await _create_match(client, opponent_id, best_of=best_of)
    needed = best_of // 2 + 1
    body = match
    for _ in range(needed):
        current = body["current_game"]
        assert current is not None
        s1, s2 = (11, 5) if side_1_wins else (5, 11)
        body = (
            await client.post(
                f"/v1/matches/{body['id']}/games/{current['id']}/scores",
                json={"side_1_points": s1, "side_2_points": s2},
            )
        ).json()
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
    other = await make_user(db_session, "third-party")
    await _play_match_to_completion(api_client, other.id, best_of=3, side_1_wins=True)
    await _play_match_to_completion(api_client, other.id, best_of=3, side_1_wins=False)
    # Now start a head-to-head match and ask for its details.
    current = await _create_match(api_client, opp.id, best_of=3)
    detail = (await api_client.get(f"/v1/matches/{current['id']}")).json()

    forms = {f["user_id"]: f for f in detail["recent_form"]}
    # I have 2 prior completed matches (1 W, 1 L) against third-party.
    mine = forms[str(me.id)]
    assert {r["is_win"] for r in mine["recent_results"]} == {True, False}
    assert all(
        r["opponent_username"] == "third-party" for r in mine["recent_results"]
    )
    # Opp shows up in the form list with no prior completed matches.
    assert forms[str(opp.id)]["recent_results"] == []


async def test_details_recent_form_excludes_the_current_match(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "exclude-rival")
    # Play to completion against this opp, then look up that match's detail.
    finished = await _play_match_to_completion(
        api_client, opp.id, best_of=3, side_1_wins=True
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
    other = await make_user(db_session, "after-third-party")
    # A match I finished *before* the viewed match is created.
    earlier = await _play_match_to_completion(
        api_client, other.id, best_of=3, side_1_wins=True
    )
    # The match we'll view (in progress, so it stays "current" in time).
    current = await _create_match(api_client, opp.id, best_of=3)
    # A match I finish *after* the viewed match was created.
    later = await _play_match_to_completion(
        api_client, other.id, best_of=3, side_1_wins=False
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
    rival = await make_user(db_session, "h2h-rival")
    # Three completed prior meetings: I win two, lose one.
    await _play_match_to_completion(api_client, rival.id, best_of=3, side_1_wins=True)
    await _play_match_to_completion(api_client, rival.id, best_of=3, side_1_wins=True)
    await _play_match_to_completion(api_client, rival.id, best_of=3, side_1_wins=False)
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
        await api_client.post(
            "/v1/matches", json={"best_of": 3, "rated": False}
        )
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
    other = await make_user(db_session, "career-other")
    # Two completed wins build up career stats *and* rating history before
    # the head-to-head match is created.
    await _play_match_to_completion(api_client, other.id, best_of=3, side_1_wins=True)
    await _play_match_to_completion(api_client, other.id, best_of=3, side_1_wins=True)

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
    opp = await make_user(db_session, "self-exclude-opp")
    finished = await _play_match_to_completion(
        api_client, opp.id, best_of=3, side_1_wins=True
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

    # The opponent came in via make_user (no league join) and is only seeded
    # when the match completes — after match creation — so they have no
    # pre-match history.
    opp_form = forms[str(opp.id)]
    assert opp_form["rating_before"] is None
    assert opp_form["rating_history"] == []


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
    opp = await make_user(db_session, "csv-finished")
    await _play_match_to_completion(api_client, opp.id, best_of=3, side_1_wins=True)

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
