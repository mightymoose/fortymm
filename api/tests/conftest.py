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
from app.models import League, LeagueVisibility, RatingStrategy


@pytest.fixture(autouse=True)
def fake_solver_queue(monkeypatch):
    connection = fakeredis.FakeStrictRedis()
    q = Queue(queue_module.SOLVER_QUEUE, connection=connection, is_async=False)
    monkeypatch.setattr(queue_module, "get_queue", lambda: q)
    return q


@pytest.fixture(autouse=True)
def fake_email_queue(monkeypatch):
    """Sync RQ queue against fakeredis so enqueued jobs execute inline.

    Tests can assert against the queue's ``finished_job_registry`` or peek
    at recorded jobs via ``q.get_jobs()`` before they run by toggling
    ``is_async`` if they need to inspect enqueue arguments without
    triggering the email send.
    """
    connection = fakeredis.FakeStrictRedis()
    q = Queue(queue_module.EMAIL_QUEUE, connection=connection, is_async=False)
    monkeypatch.setattr(queue_module, "get_email_queue", lambda: q)
    return q


@pytest.fixture(autouse=True)
def stub_captcha(monkeypatch):
    """Pretend Cloudflare Turnstile said yes. Tests that want the failure
    path override the patched function with ``monkeypatch.setattr``."""

    async def _always_pass(token):  # noqa: ARG001
        return True

    from app import captcha as captcha_module

    monkeypatch.setattr(captcha_module, "verify_captcha", _always_pass)


@pytest_asyncio.fixture(autouse=True)
async def rate_limiter_fakeredis():
    """Initialise FastAPILimiter against an in-memory fakeredis per test so
    the rate-limit counters start clean. The httpx ASGITransport used by the
    test client doesn't fire the app's lifespan, so we init here directly."""
    import fakeredis.aioredis
    from fastapi_limiter import FastAPILimiter

    fake = fakeredis.aioredis.FakeRedis(encoding="utf-8")
    await FastAPILimiter.init(fake)
    try:
        yield fake
    finally:
        await FastAPILimiter.close()
        await fake.aclose()


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


GLICKO2_STATE_SCHEMA = {
    "type": "object",
    "required": ["rating", "rd", "volatility"],
    "properties": {
        "rating": {"type": "number"},
        "rd": {"type": "number"},
        "volatility": {"type": "number"},
    },
    "additionalProperties": False,
}
MANUAL_STATE_SCHEMA = {
    "type": "object",
    "required": ["rating"],
    "properties": {"rating": {"type": "number"}},
    "additionalProperties": False,
}


@pytest_asyncio.fixture(autouse=True)
async def rating_strategies(db_session: AsyncSession) -> dict[str, RatingStrategy]:
    """Seed the canonical rating strategies. Migration 0005 inserts these in
    real deployments; tests build via ``Base.metadata.create_all`` so we
    re-seed here for every test."""
    glicko2 = RatingStrategy(
        key="glicko2",
        name="Glicko-2",
        description="Glicko-2.",
        state_schema=GLICKO2_STATE_SCHEMA,
        initial_state={"rating": 1500.0, "rd": 350.0, "volatility": 0.06},
        initial_rating_value=1500.0,
        is_automatic=True,
    )
    manual = RatingStrategy(
        key="manual",
        name="Manual / external",
        description="Ratings supplied externally.",
        state_schema=MANUAL_STATE_SCHEMA,
        initial_state=None,
        initial_rating_value=None,
        is_automatic=False,
    )
    db_session.add_all([glicko2, manual])
    await db_session.commit()
    return {"glicko2": glicko2, "manual": manual}


@pytest_asyncio.fixture(autouse=True)
async def default_league(
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
) -> League:
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
        rating_strategy_id=rating_strategies["glicko2"].id,
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
