import logging
import os
import secrets
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

import redis.asyncio as redis_asyncio
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import text

from app import db, queue
from app.dashboard import router as dashboard_router
from app.matches import router as matches_router
from app.notifications.router import router as notifications_router
from app.players import router as players_router
from app.rate_limiting import init_rate_limit_redis, shutdown_rate_limit_redis
from app.rbac import router as rbac_router
from app.sessions import CSRF_COOKIE_NAME, CSRF_HEADER_NAME, CSRF_SAFE_METHODS
from app.sessions import router as sessions_router
from app.tournaments import router as tournaments_router

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    connection = redis_asyncio.from_url(redis_url, encoding="utf-8")
    try:
        # A no-op publishing the connection — individual ``RedisRateLimiter``
        # dependencies build their pyrate-limiter buckets lazily on first
        # request. If Redis is unreachable then, the limiter falls open and
        # the request proceeds; offline tooling (regen-api-types, ad-hoc
        # local runs) still needs /openapi.json and the unprotected routes.
        init_rate_limit_redis(connection)
        yield
    finally:
        shutdown_rate_limit_redis()
        await connection.aclose()


app = FastAPI(title="FortyMM API", lifespan=lifespan)


@app.middleware("http")
async def csrf_protect(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """Double-submit CSRF guard: every unsafe-method request must echo the
    non-HttpOnly ``csrf_token`` cookie back in the ``X-CSRF-Token`` header. A
    cross-origin attacker's page can ride along the cookie but can neither read
    its value nor set a custom header, so it can't produce a match. The cookie
    is issued/rotated alongside the session cookie in ``app.sessions``."""
    if request.method not in CSRF_SAFE_METHODS:
        cookie = request.cookies.get(CSRF_COOKIE_NAME)
        header = request.headers.get(CSRF_HEADER_NAME)
        if not cookie or not header or not secrets.compare_digest(cookie, header):
            return JSONResponse(
                status_code=403,
                content={"detail": "CSRF token missing or invalid."},
            )
    return await call_next(request)


app.include_router(sessions_router)
app.include_router(rbac_router)
app.include_router(matches_router)
app.include_router(players_router)
app.include_router(dashboard_router)
app.include_router(notifications_router)
app.include_router(tournaments_router)

SOLVER_HEALTH_TIMEOUT = 10.0


class ComponentHealth(BaseModel):
    healthy: bool
    latency_ms: float | None = None
    error: str | None = None


class HealthResponse(BaseModel):
    redis: ComponentHealth
    database: ComponentHealth
    solver: ComponentHealth


@app.get("/v1/health")
async def health() -> HealthResponse:
    return HealthResponse(
        redis=_check_redis(),
        database=await _check_database(),
        solver=_check_solver(),
    )


def _check_redis() -> ComponentHealth:
    started = time.monotonic()
    try:
        connection = queue.get_queue().connection
        if not connection.ping():
            return ComponentHealth(healthy=False, error="redis ping returned falsy")
    except Exception as exc:
        return ComponentHealth(healthy=False, error=str(exc) or exc.__class__.__name__)
    return ComponentHealth(healthy=True, latency_ms=_elapsed_ms(started))


async def _check_database() -> ComponentHealth:
    started = time.monotonic()
    try:
        engine = db.get_engine()
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception as exc:
        return ComponentHealth(healthy=False, error=str(exc) or exc.__class__.__name__)
    return ComponentHealth(healthy=True, latency_ms=_elapsed_ms(started))


def _check_solver() -> ComponentHealth:
    started = time.monotonic()
    try:
        job = queue.get_queue().enqueue("app.solver.solve_hello_world", job_timeout=10)
    except Exception as exc:
        return ComponentHealth(healthy=False, error=str(exc) or exc.__class__.__name__)

    deadline = time.monotonic() + SOLVER_HEALTH_TIMEOUT
    while time.monotonic() < deadline:
        try:
            job.refresh()  # type: ignore[no-untyped-call]  # rq's Job.refresh is untyped
        except Exception as exc:
            return ComponentHealth(
                healthy=False, error=str(exc) or exc.__class__.__name__
            )
        if job.is_finished:
            healthy = bool(job.return_value())
            return ComponentHealth(
                healthy=healthy,
                latency_ms=_elapsed_ms(started),
                error=None if healthy else "solver returned an unsatisfiable result",
            )
        if job.is_failed:
            return ComponentHealth(
                healthy=False,
                latency_ms=_elapsed_ms(started),
                error="solver job failed",
            )
        time.sleep(0.1)
    return ComponentHealth(
        healthy=False,
        latency_ms=_elapsed_ms(started),
        error=f"timeout after {SOLVER_HEALTH_TIMEOUT * 1000:.0f}ms",
    )


def _elapsed_ms(started: float) -> float:
    return round((time.monotonic() - started) * 1000, 1)
