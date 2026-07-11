"""Repro for issue #79: transient 500s on POST /v1/matches under a burst of
rated creates from the same user.

Unlike the shared ``api_client`` fixture (which pins every request to one
``db_session``), this exercises the *production* session lifecycle — each
concurrent request gets its own session from a real sessionmaker bound to the
testcontainers engine, so the real connection pool and real per-request
transactions are in play. That is the only setup in which a per-user
concurrency bug can surface.
"""

import asyncio
import collections

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.db import get_session
from app.main import app as fastapi_app
from app.models import Match
from tests._helpers import CSRF_EVENT_HOOKS, make_user


@pytest.mark.parametrize("burst", [20])
async def test_concurrent_rated_creates_do_not_500(
    engine: AsyncEngine,
    db_session: AsyncSession,
    default_league,
    burst: int,
) -> None:
    real_sessionmaker = async_sessionmaker(engine, expire_on_commit=False)

    async def _real_session():
        async with real_sessionmaker() as session:
            yield session

    fastapi_app.dependency_overrides[get_session] = _real_session
    try:
        opponent = await make_user(db_session, "rival-79")

        client = AsyncClient(
            transport=ASGITransport(app=fastapi_app, raise_app_exceptions=True),
            base_url="https://testserver",
            event_hooks=CSRF_EVENT_HOOKS,
        )
        boot = await client.get("/v1/session")
        assert boot.status_code == 200

        async def create():
            return await client.post(
                "/v1/matches",
                json={
                    "opponent_user_id": str(opponent.id),
                    "best_of": 5,
                    "rated": True,
                },
            )

        results = await asyncio.gather(
            *[create() for _ in range(burst)], return_exceptions=True
        )
        await client.aclose()

        statuses: collections.Counter = collections.Counter()
        first_failure = None
        for r in results:
            if isinstance(r, BaseException):
                statuses["EXC:" + type(r).__name__] += 1
                if first_failure is None:
                    first_failure = repr(r)
            else:
                statuses[r.status_code] += 1
                if r.status_code >= 400 and first_failure is None:
                    first_failure = f"{r.status_code}: {r.text[:500]}"

        print(f"\n[issue-79] burst={burst} status distribution: {dict(statuses)}")
        if first_failure:
            print(f"[issue-79] first failure: {first_failure}")

        async with real_sessionmaker() as s:
            count = (
                await s.execute(select(func.count()).select_from(Match))
            ).scalar_one()
        print(f"[issue-79] matches actually created: {count}")

        non_201 = {k: v for k, v in statuses.items() if k != 201}
        assert not non_201, f"expected all 201, got failures: {non_201}"
    finally:
        fastapi_app.dependency_overrides.clear()
        # Clean up the rows this test committed through its own sessions
        # (they bypass the db_session fixture's truncate).
        async with engine.begin() as conn:
            from app.db import Base

            for table in reversed(Base.metadata.sorted_tables):
                await conn.execute(table.delete())
