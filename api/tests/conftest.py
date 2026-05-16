import os
from collections.abc import AsyncIterator, Iterator

import fakeredis
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from rq import Queue
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app import queue as queue_module
from app.db import Base, get_session
from app.main import app as fastapi_app
import app.models  # noqa: F401  -- ensures models register on Base.metadata
from app.models import League, LeagueVisibility


@pytest.fixture(autouse=True)
def fake_solver_queue(monkeypatch):
    connection = fakeredis.FakeStrictRedis()
    q = Queue(queue_module.SOLVER_QUEUE, connection=connection, is_async=False)
    monkeypatch.setattr(queue_module, "get_queue", lambda: q)
    return q


@pytest.fixture(scope="session")
def postgres_url() -> Iterator[str]:
    override = os.environ.get("TEST_DATABASE_URL")
    if override:
        yield override
        return

    from testcontainers.postgres import PostgresContainer

    with PostgresContainer("postgres:16-alpine", driver="asyncpg") as pg:
        yield pg.get_connection_url()


@pytest_asyncio.fixture(scope="session")
async def engine(postgres_url: str) -> AsyncIterator[AsyncEngine]:
    eng = create_async_engine(postgres_url)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def db_session(engine: AsyncEngine) -> AsyncIterator[AsyncSession]:
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with sessionmaker() as session:
        try:
            yield session
        finally:
            await session.rollback()
    async with engine.begin() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            await conn.execute(table.delete())


@pytest_asyncio.fixture(autouse=True)
async def default_league(db_session: AsyncSession) -> League:
    """Seed a default league so user-creation paths can attach memberships.

    Autouse so tests don't have to remember to opt in. Tests that want to
    exercise the "no default league" branch can ``await db_session.delete(...)``
    this row before triggering the path under test.
    """
    league = League(
        name="FortyMM",
        description="Test default league.",
        visibility=LeagueVisibility.public,
        is_default=True,
    )
    db_session.add(league)
    await db_session.commit()
    return league


@pytest_asyncio.fixture
async def api_client(db_session: AsyncSession) -> AsyncIterator[AsyncClient]:
    """HTTP client bound to the test app, sharing the per-test ``db_session``
    so commits inside endpoints are visible to assertions in the same test."""

    async def _override() -> AsyncIterator[AsyncSession]:
        yield db_session

    fastapi_app.dependency_overrides[get_session] = _override
    transport = ASGITransport(app=fastapi_app)
    async with AsyncClient(
        transport=transport, base_url="https://testserver"
    ) as client:
        yield client
    fastapi_app.dependency_overrides.clear()
