from collections.abc import AsyncIterator

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.main import app
from app.models import User


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


async def test_list_players_requires_a_session(api_client: AsyncClient):
    response = await api_client.get("/v1/players")
    assert response.status_code == 401


async def test_list_players_excludes_the_current_user(
    api_client: AsyncClient, db_session: AsyncSession
):
    session_response = await api_client.get("/v1/session")
    my_username = session_response.json()["data"]["user"]["username"]

    db_session.add_all([User(username="ana"), User(username="bo")])
    await db_session.commit()

    response = await api_client.get("/v1/players")
    assert response.status_code == 200
    usernames = [player["username"] for player in response.json()]
    assert usernames == ["ana", "bo"]
    assert my_username not in usernames
