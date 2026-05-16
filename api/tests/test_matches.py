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


async def test_create_match_without_opponent_has_a_single_side(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)

    response = await api_client.post(
        "/v1/matches", json={"best_of": 7, "rated": False}
    )
    assert response.status_code == 201
    body = response.json()
    assert body["affects_rating"] is False
    assert len(body["sides"]) == 1
    assert body["sides"][0]["players"][0]["user_id"] == str(me.id)
    # No opponent → nothing to score against, even though game 1 exists.
    assert body["current_game"] is not None
    assert body["can_score"] is False

    sides = (await db_session.execute(select(MatchSide))).scalars().all()
    assert len(sides) == 1


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


async def test_cannot_score_match_without_opponent(
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
    assert response.status_code == 422
    assert "opponent" in response.json()["detail"].lower()


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
