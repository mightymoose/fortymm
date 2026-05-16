"""Shared test helpers for the API test suite.

The leading underscore keeps pytest from auto-collecting this as a test module;
fixtures still belong in ``conftest.py``.
"""

from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.main import app as fastapi_app
from app.models import User


async def start_session(
    api_client: AsyncClient, db_session: AsyncSession
) -> User:
    """Establish a session cookie on the client and return the signed-in user."""
    response = await api_client.get("/v1/session")
    assert response.status_code == 200
    username = response.json()["data"]["user"]["username"]
    return (
        await db_session.execute(select(User).where(User.username == username))
    ).scalar_one()


async def make_user(db_session: AsyncSession, username: str) -> User:
    user = User(username=username)
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


def make_client() -> AsyncClient:
    """Build a second cookie-isolated client bound to the same test app.

    Useful when a test needs two distinct users (each one calls
    ``start_session`` on their own client) sharing the same ``db_session``
    fixture override — which the primary ``api_client`` fixture has already
    installed by the time this helper runs.
    """
    return AsyncClient(
        transport=ASGITransport(app=fastapi_app),
        base_url="https://testserver",
    )
