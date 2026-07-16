import asyncio
import contextlib
import logging
import math
import os
import secrets
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

import redis.asyncio as redis_asyncio
from fastapi import FastAPI, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import TimeoutError as SQLAlchemyTimeoutError

from app import db, queue
from app.dashboard import router as dashboard_router
from app.match_calls import pin_tick_loop
from app.matches import router as matches_router
from app.notifications.router import router as notifications_router
from app.players import router as players_router
from app.rate_limiting import init_rate_limit_redis, shutdown_rate_limit_redis
from app.rbac import router as rbac_router
from app.sessions import (
    CSRF_COOKIE_NAME,
    CSRF_HEADER_NAME,
    CSRF_SAFE_METHODS,
    SESSION_COOKIE_NAME,
)
from app.sessions import router as sessions_router
from app.tournaments import router as tournaments_router

# Log on uvicorn's own error logger (not __name__): the app configures no
# logging, so a __name__ logger propagates to the root logger, which defaults
# to WARNING with no handler — INFO lines would be silently dropped. uvicorn
# configures "uvicorn.error" with a stdout handler at INFO, so the proxy-trust
# line below surfaces alongside "Application startup complete" in every stack.
log = logging.getLogger("uvicorn.error")


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
        forwarded_allow_ips = os.environ.get("FORWARDED_ALLOW_IPS")
        if forwarded_allow_ips:
            log.info("proxy trust: FORWARDED_ALLOW_IPS=%s", forwarded_allow_ips)
        else:
            log.warning(
                "proxy trust: FORWARDED_ALLOW_IPS is unset — uvicorn's "
                "ProxyHeadersMiddleware will not rewrite request.client, so "
                "IP-keyed rate limiters bucket on the direct peer IP (the "
                "#837 failure mode: behind a proxy every request shares one "
                "peer IP)."
            )
        # The pin tick (ADR "the call is pinned"): every ~60s, enqueue a
        # run_pin_tick job per live tournament. Multiple API replicas each
        # running this loop are harmless — the tick's pinned_at re-check under
        # row locks makes the second of any duplicate pair a no-op (see
        # app.match_calls). Cancelled (and awaited) on shutdown.
        pin_tick_task = asyncio.create_task(pin_tick_loop())
        try:
            yield
        finally:
            pin_tick_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await pin_tick_task
    finally:
        shutdown_rate_limit_redis()
        await connection.aclose()


app = FastAPI(title="FortyMM API", lifespan=lifespan)

# When the async DB connection pool saturates under a burst, SQLAlchemy raises
# ``sqlalchemy.exc.TimeoutError`` ("QueuePool limit ... connection timed out")
# out of the request. Unhandled, Starlette turns that into an opaque 500 with no
# retry hint (issue #79). Convert it to a 503 + ``Retry-After`` so the pressure
# is transient-and-retryable to the caller. The catch is deliberately narrow —
# only the pool-timeout class — so genuine query errors still surface as 500s.
POOL_TIMEOUT_RETRY_AFTER_SECONDS = 1


@app.exception_handler(SQLAlchemyTimeoutError)
async def db_pool_timeout_handler(
    request: Request, exc: SQLAlchemyTimeoutError
) -> JSONResponse:
    log.warning(
        "DB pool exhausted; returning 503 for %s %s",
        request.method,
        request.url.path,
    )
    return JSONResponse(
        status_code=503,
        content={"detail": "The server is briefly overloaded. Please retry."},
        headers={"Retry-After": str(POOL_TIMEOUT_RETRY_AFTER_SECONDS)},
    )


def _json_safe_float(value: float) -> float | str:
    """``inf``/``-inf``/``nan`` as their names; every other float unchanged."""
    return value if math.isfinite(value) else repr(value)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(
    _: Request, exc: RequestValidationError
) -> JSONResponse:
    """FastAPI's own 422 handler, with the one thing it cannot render fixed: a
    **non-finite number** in the input it echoes back.

    JSON has no ``Infinity`` or ``NaN`` literal, but Python's ``json.loads`` — which
    Starlette parses request bodies with — reads both tokens anyway. So a hand-written
    body (curl, a native client, anything that is not a browser's ``JSON.stringify``)
    can put ``inf`` into a numeric field. The schema refuses it, correctly... and then
    the *refusal itself* dies: a validation error carries the offending ``input`` back
    to the caller, and ``JSONResponse`` serializes with ``json.dumps(allow_nan=False)``,
    which raises on ``inf``. The 422 became a **500** — the boundary was right and the
    apology was the crash.

    That is every route's 422, not just the one this was found on (#783 QA), so the fix
    is here rather than in a schema: the non-finite float is rendered as its name, and
    the caller gets the refusal it earned. The body is otherwise byte-for-byte what
    FastAPI would have sent.
    """
    return JSONResponse(
        status_code=422,
        content={
            "detail": jsonable_encoder(
                exc.errors(), custom_encoder={float: _json_safe_float}
            )
        },
    )


@app.middleware("http")
async def csrf_protect(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """Double-submit CSRF guard: every unsafe-method request that rides an
    established ``session`` cookie must echo the non-HttpOnly ``csrf_token``
    cookie back in the ``X-CSRF-Token`` header. A cross-origin attacker's page
    can ride along the cookie but can neither read its value nor set a custom
    header, so it can't produce a match. The cookie is issued/rotated alongside
    the session cookie in ``app.sessions``.

    The guard only engages when a session cookie is present, because CSRF is
    only meaningful against a request abusing a victim's *ambient authority* —
    the session cookie the browser attaches automatically. A request with no
    session cookie carries no such authority: it runs anonymously, so there is
    nothing to forge. Exempting it is what lets the cold, cookieless auth flows
    work — landing straight on ``/login`` to request a sign-in link, or opening
    a magic-link / email-confirm on a device that never loaded the app (and so
    was never issued a csrf_token cookie). Those endpoints are gated by their
    own non-cookie credential — a captcha + rate limit on ``/login/request``, an
    unguessable single-use token in the body on consume/confirm — so they don't
    need (or get) CSRF cover. The moment a session cookie rides along, the
    double-submit guard is enforced in full."""
    if request.method not in CSRF_SAFE_METHODS and request.cookies.get(
        SESSION_COOKIE_NAME
    ):
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


class ReadyzResponse(BaseModel):
    redis: ComponentHealth
    database: ComponentHealth


@app.get("/v1/health")
async def health() -> HealthResponse:
    return HealthResponse(
        redis=_check_redis(),
        database=await _check_database(),
        solver=await asyncio.to_thread(_check_solver_sync),
    )


@app.get("/v1/readyz", include_in_schema=False)
async def readyz(response: Response) -> ReadyzResponse:
    """Machine-readable readiness gate for the k8s probe and deploy smoke
    check. Unlike ``/v1/health`` (a diagnostic dashboard endpoint that always
    returns 200), this returns 503 when a component the request path
    actually depends on — redis, the database — is unhealthy. The solver is
    deliberately excluded: it's an async RQ worker off the request path, and
    gating readiness on it would pull the API pod out of rotation for every
    endpoint whenever just the worker restarts.
    """
    redis_health, database_health = await asyncio.gather(
        asyncio.to_thread(_check_redis), _check_database()
    )
    if not redis_health.healthy or not database_health.healthy:
        response.status_code = 503
    return ReadyzResponse(redis=redis_health, database=database_health)


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


def _check_solver_sync() -> ComponentHealth:
    """Blocking solver probe — polls RQ with ``time.sleep``, so callers must
    run it off the event loop (e.g. ``await asyncio.to_thread(...)``)."""
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
