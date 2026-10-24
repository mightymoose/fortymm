import hmac
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from sqlalchemy.orm import sessionmaker

from fortymm_api import v1
from fortymm_api.database import create_database_engine, migrate

WORKER_SECRET_HEADER = "X-FortyMM-Worker-Secret"
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def error_response(status: int, title: str) -> JSONResponse:
    return JSONResponse(
        {"errors": [{"status": str(status), "title": title}]}, status_code=status
    )


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
            return error_response(403, "Requests must come through the Worker")
        return await call_next(request)


def require_json(app: FastAPI) -> None:
    """Reject a write whose body isn't declared as JSON.

    A cross-site HTML form can send a POST without CORS, but not with this
    content type. Without the check, a form on another site could make
    POST /v1/session replace the visitor's session with a new guest's.
    """

    @app.middleware("http")
    async def check_content_type(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        content_type = request.headers.get("Content-Type", "")
        media_type = content_type.partition(";")[0].strip().lower()
        if request.method in WRITE_METHODS and media_type != "application/json":
            return error_response(
                415, "Requests must send Content-Type: application/json"
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

    engine = create_database_engine(database_url) if database_url else None

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if engine is None:
            yield
            return
        # Before serving, so no request sees an old schema. A database that
        # can't be reached stops the API from starting.
        migrate(engine)
        try:
            yield
        finally:
            engine.dispose()

    app = FastAPI(
        title="FortyMM API",
        version="0.1.0",
        generate_unique_id_function=operation_id,
        lifespan=lifespan,
    )
    app.state.sessions = sessionmaker(engine) if engine is not None else None
    app.include_router(v1.router)
    require_json(app)
    # Added last so it runs first: a request without the secret learns nothing
    # else about the API.
    if secret:
        require_worker_secret(app, secret)
    return app


app = create_app()
