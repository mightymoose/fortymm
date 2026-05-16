import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Match, MatchStatus
from tests._helpers import make_client, make_user, start_session


async def _create_match(
    client: AsyncClient, opponent_id, best_of: int = 5
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
    assert body == {
        "score_banner": None,
        "next_match": None,
        "recent_results": [],
    }


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
    assert body["score_banner"]["match_id"] == match["id"]
    assert body["score_banner"]["opponent_username"] == "rival"
    assert body["score_banner"]["current_game_id"] == after_g1["current_game"]["id"]
    # An in-progress match is not "pending" so the next_match slot is empty.
    assert body["next_match"] is None
    assert body["recent_results"] == []


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
    assert body["score_banner"] is None
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
    assert body == {
        "score_banner": None,
        "next_match": None,
        "recent_results": [],
    }
