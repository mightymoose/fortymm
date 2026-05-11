import hashlib
from collections.abc import AsyncIterator

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.main import app
from app.models import User, UserToken
from app.sessions import SESSION_COOKIE_NAME, SESSION_TOKEN_CONTEXT


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


async def test_creates_session_when_no_cookie(
    api_client: AsyncClient, db_session: AsyncSession
):
    response = await api_client.get("/v1/session")
    assert response.status_code == 200

    username = response.json()["data"]["user"]["username"]
    assert username

    cookie_header = response.headers.get("set-cookie", "").lower()
    assert "httponly" in cookie_header
    assert "secure" in cookie_header
    assert "samesite=lax" in cookie_header
    assert "path=/" in cookie_header

    raw_token = response.cookies.get(SESSION_COOKIE_NAME)
    assert raw_token

    user = (
        await db_session.execute(select(User).where(User.username == username))
    ).scalar_one()

    token = (
        await db_session.execute(
            select(UserToken).where(
                UserToken.token
                == hashlib.sha256(raw_token.encode("utf-8")).digest()
            )
        )
    ).scalar_one()
    assert token.user_id == user.id
    assert token.context == SESSION_TOKEN_CONTEXT


async def test_returns_existing_session_when_cookie_valid(
    api_client: AsyncClient, db_session: AsyncSession
):
    first = await api_client.get("/v1/session")
    first_username = first.json()["data"]["user"]["username"]
    first_token = first.cookies.get(SESSION_COOKIE_NAME)

    second = await api_client.get("/v1/session")
    assert second.status_code == 200
    assert second.json()["data"]["user"]["username"] == first_username
    assert "set-cookie" not in second.headers

    users = (await db_session.execute(select(User))).scalars().all()
    assert len(users) == 1

    tokens = (await db_session.execute(select(UserToken))).scalars().all()
    assert len(tokens) == 1
    assert tokens[0].token == hashlib.sha256(
        first_token.encode("utf-8")
    ).digest()


async def test_creates_new_session_when_cookie_invalid(
    api_client: AsyncClient, db_session: AsyncSession
):
    api_client.cookies.set(
        SESSION_COOKIE_NAME, "not-a-real-token", domain="testserver"
    )
    response = await api_client.get("/v1/session")
    assert response.status_code == 200

    new_token = response.cookies.get(SESSION_COOKIE_NAME)
    assert new_token
    assert new_token != "not-a-real-token"

    tokens = (await db_session.execute(select(UserToken))).scalars().all()
    assert len(tokens) == 1
    assert tokens[0].token == hashlib.sha256(
        new_token.encode("utf-8")
    ).digest()


async def test_token_is_stored_hashed_not_plaintext(
    api_client: AsyncClient, db_session: AsyncSession
):
    response = await api_client.get("/v1/session")
    raw_token = response.cookies.get(SESSION_COOKIE_NAME)

    tokens = (await db_session.execute(select(UserToken))).scalars().all()
    assert len(tokens) == 1
    assert tokens[0].token != raw_token.encode("utf-8")
    assert (
        tokens[0].token
        == hashlib.sha256(raw_token.encode("utf-8")).digest()
    )
