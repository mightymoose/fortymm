"""Regression for issue #79: a *saturated* connection pool must degrade to a
503 + ``Retry-After``, never an opaque 500.

The issue-79 concurrent-creates repro shows the create path itself is correct
under burst (no code defect). The failure mode was resource exhaustion: under
real load the shared async pool saturates and a waiter raises
``sqlalchemy.exc.TimeoutError``, which — unhandled — Starlette turns into a 500
with no retry hint. ``app.main.db_pool_timeout_handler`` now catches that class
and returns a 503 with a ``Retry-After`` header. This test forces the condition
with a deliberately tiny pool + a held connection and asserts the graceful shape.
"""

import asyncio

from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.db import get_session
from app.main import app as fastapi_app
from tests._helpers import CSRF_EVENT_HOOKS, make_user


async def test_saturated_pool_returns_503_with_retry_after(
    postgres_url: str,
    engine: AsyncEngine,
    db_session: AsyncSession,
    default_league,
) -> None:
    # Tiny pool: 1 connection, no overflow, 1s wait before giving up.
    tiny = create_async_engine(
        postgres_url, pool_size=1, max_overflow=0, pool_timeout=1
    )
    tiny_sessionmaker = async_sessionmaker(tiny, expire_on_commit=False)

    async def _real_session():
        async with tiny_sessionmaker() as session:
            yield session

    fastapi_app.dependency_overrides[get_session] = _real_session
    try:
        opponent = await make_user(db_session, "rival-79-probe")

        # Bootstrap needs the pool too; do it before we hog the connection.
        client = AsyncClient(
            transport=ASGITransport(app=fastapi_app, raise_app_exceptions=True),
            base_url="https://testserver",
            event_hooks=CSRF_EVENT_HOOKS,
        )
        boot = await client.get("/v1/session")
        assert boot.status_code == 200

        # Hog the single connection so concurrent creates must wait -> time out.
        held = await tiny.connect()
        await held.exec_driver_sql("SELECT 1")

        async def create() -> Response:
            return await client.post(
                "/v1/matches",
                json={
                    "opponent_user_id": str(opponent.id),
                    "best_of": 5,
                    "rated": True,
                },
            )

        results = await asyncio.gather(*[create() for _ in range(5)])
        await held.close()
        await client.aclose()

        # The single connection is held across the whole gather (closed only
        # after), so every create must wait on the pool and hit the timeout.
        # The handler is registered, so each resolves to a real 503 response
        # (with Retry-After) rather than raising a TimeoutError or returning an
        # opaque 500.
        assert all(r.status_code == 503 for r in results), (
            "expected every request to 503 under a saturated pool, got "
            f"{[r.status_code for r in results]}"
        )
        for r in results:
            assert "retry-after" in r.headers, (
                "503 from pool exhaustion must carry a Retry-After header"
            )
    finally:
        await tiny.dispose()
        fastapi_app.dependency_overrides.clear()
        from app.db import Base

        async with engine.begin() as conn:
            for table in reversed(Base.metadata.sorted_tables):
                await conn.execute(table.delete())
