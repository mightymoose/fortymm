import hmac
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from psycopg_pool import ConnectionPool

from fortymm_api import v1

WORKER_SECRET_HEADER = "X-FortyMM-Worker-Secret"


def operation_id(route: APIRoute) -> str:
    """Name each OpenAPI operation after its route function (e.g. `health`).

    FastAPI's default IDs embed the path and method (`health_v1_health_get`), which
    leak into the clients generated from the schema.
    """
    return route.name


def require_worker_secret(app: FastAPI, secret: str) -> None:
    """Reject every request that doesn't carry the Worker secret.

    The Cloud Run URL is public, so this is what keeps clients from going
    around the Cloudflare Worker, which adds the header (see worker/index.ts).
    """

    @app.middleware("http")
    async def check_worker_secret(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        sent = request.headers.get(WORKER_SECRET_HEADER, "")
        if not hmac.compare_digest(sent.encode(), secret.encode()):
            return JSONResponse(
                {
                    "errors": [
                        {
                            "status": "403",
                            "title": "Requests must come through the Worker",
                        }
                    ]
                },
                status_code=403,
            )
        return await call_next(request)


def create_app() -> FastAPI:
    secret = os.environ.get("WORKER_SECRET", "")
    database_url = os.environ.get("DATABASE_URL", "")
    # Cloud Run sets K_SERVICE. Failing there stops a revision without the
    # secret from starting, rather than serving the API to anyone.
    if os.environ.get("K_SERVICE") and not secret:
        raise RuntimeError("WORKER_SECRET must be set when running on Cloud Run")
    # Off Cloud Run the database is optional, so the OpenAPI export runs
    # without one.
    if os.environ.get("K_SERVICE") and not database_url:
        raise RuntimeError("DATABASE_URL must be set when running on Cloud Run")

    # db-f1-micro allows 25 connections, shared by up to 3 production
    # instances and the Preview revisions.
    pool = (
        ConnectionPool(database_url, min_size=1, max_size=4, open=False)
        if database_url
        else None
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if pool is None:
            yield
            return
        # Opens without waiting for a connection, so a slow database doesn't
        # stop the API from starting.
        pool.open()
        try:
            yield
        finally:
            pool.close()

    app = FastAPI(
        title="FortyMM API",
        version="0.1.0",
        generate_unique_id_function=operation_id,
        lifespan=lifespan,
    )
    app.state.pool = pool
    app.include_router(v1.router)
    if secret:
        require_worker_secret(app, secret)
    return app


app = create_app()
