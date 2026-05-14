import uuid
from collections.abc import AsyncIterator

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.main import app
from app.models import Match, MatchSide, User


@pytest_asyncio.fixture
async def api_client(db_session: AsyncSession) -> AsyncIterator[AsyncClient]:
    async def _override() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = _override
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="https://testserver"
    ) as client:
        yield client
    app.dependency_overrides.clear()


async def _start_session(
    api_client: AsyncClient, db_session: AsyncSession
) -> User:
    """Establish a session cookie on the client; return the signed-in user."""
    response = await api_client.get("/v1/session")
    assert response.status_code == 200
    username = response.json()["data"]["user"]["username"]
    return (
        await db_session.execute(select(User).where(User.username == username))
    ).scalar_one()


async def _make_user(db_session: AsyncSession, username: str) -> User:
    user = User(username=username)
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


async def test_create_match_requires_a_session(api_client: AsyncClient):
    response = await api_client.post("/v1/matches", json={"best_of": 5})
    assert response.status_code == 401


async def test_create_rated_match_with_registered_opponent(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await _start_session(api_client, db_session)
    opponent = await _make_user(db_session, "rival")

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
    assert body["status"] == "pending"
    assert body["created_by_user_id"] == str(me.id)
    assert body["settings"]["best_of"] == 5
    assert body["settings"]["team_size"] == 1
    assert body["settings"]["affects_rating"] is True

    sides = sorted(body["sides"], key=lambda side: side["side_number"])
    assert [side["side_number"] for side in sides] == [1, 2]
    assert sides[0]["players"][0]["user_id"] == str(me.id)
    assert sides[1]["players"][0]["user_id"] == str(opponent.id)

    match = (await db_session.execute(select(Match))).scalar_one()
    assert str(match.id) == body["id"]


async def test_create_unrated_match_with_opponent(
    api_client: AsyncClient, db_session: AsyncSession
):
    await _start_session(api_client, db_session)
    opponent = await _make_user(db_session, "casual-rival")

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
    assert body["settings"]["affects_rating"] is False
    assert len(body["sides"]) == 2


async def test_create_match_without_opponent_has_a_single_side(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await _start_session(api_client, db_session)

    response = await api_client.post(
        "/v1/matches", json={"best_of": 7, "rated": False}
    )
    assert response.status_code == 201
    body = response.json()
    assert body["settings"]["affects_rating"] is False
    assert len(body["sides"]) == 1
    assert body["sides"][0]["side_number"] == 1
    assert body["sides"][0]["players"][0]["user_id"] == str(me.id)

    sides = (await db_session.execute(select(MatchSide))).scalars().all()
    assert len(sides) == 1


async def test_rated_match_without_opponent_is_rejected(
    api_client: AsyncClient, db_session: AsyncSession
):
    await _start_session(api_client, db_session)

    response = await api_client.post(
        "/v1/matches", json={"best_of": 5, "rated": True}
    )
    assert response.status_code == 422
    assert "rated" in response.json()["detail"].lower()
    assert (await db_session.execute(select(Match))).first() is None


async def test_cannot_start_a_match_against_yourself(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await _start_session(api_client, db_session)

    response = await api_client.post(
        "/v1/matches",
        json={"opponent_user_id": str(me.id), "best_of": 5, "rated": True},
    )
    assert response.status_code == 422
    assert "yourself" in response.json()["detail"].lower()


async def test_unknown_opponent_is_rejected(
    api_client: AsyncClient, db_session: AsyncSession
):
    await _start_session(api_client, db_session)

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
    await _start_session(api_client, db_session)
    opponent = await _make_user(db_session, "rival")

    response = await api_client.post(
        "/v1/matches",
        json={
            "opponent_user_id": str(opponent.id),
            "best_of": 4,
            "rated": True,
        },
    )
    assert response.status_code == 422


async def test_get_match_returns_the_created_match(
    api_client: AsyncClient, db_session: AsyncSession
):
    await _start_session(api_client, db_session)
    opponent = await _make_user(db_session, "rival")
    created = (
        await api_client.post(
            "/v1/matches",
            json={
                "opponent_user_id": str(opponent.id),
                "best_of": 5,
                "rated": True,
            },
        )
    ).json()

    response = await api_client.get(f"/v1/matches/{created['id']}")
    assert response.status_code == 200
    assert response.json() == created


async def test_get_unknown_match_is_404(api_client: AsyncClient):
    response = await api_client.get(f"/v1/matches/{uuid.uuid4()}")
    assert response.status_code == 404
