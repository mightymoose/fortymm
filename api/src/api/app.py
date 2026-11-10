from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.routing import APIRoute

from api.routes import errors, v1
from api.settings import Settings


def operation_id(route: APIRoute) -> str:
    """Every operation's OpenAPI operationId is its route function's name, e.g. get_health,
    which a generated client uses as the method name. Name route functions verb_noun and
    keep them unique across the API: api:openapi fails on a duplicate."""
    return route.name


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the app. Without settings, it reads them from the environment at startup."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.settings = settings or Settings()
        yield

    app = FastAPI(
        title="fortymm API",
        version="0.1.0",
        lifespan=lifespan,
        generate_unique_id_function=operation_id,
    )
    # Every error response, FastAPI's own included, is an error document.
    errors.install(app)
    # /openapi.json and /docs stay unversioned: one document describes every version.
    app.include_router(v1.router)
    return app
