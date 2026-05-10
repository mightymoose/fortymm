import os
from collections.abc import AsyncIterator, Iterator

import fakeredis
import pytest
import pytest_asyncio
from rq import Queue
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app import queue as queue_module
from app.db import Base
import app.models  # noqa: F401  -- ensures models register on Base.metadata


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
