from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from api.routes import errors, v1
from api.settings import Settings


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the app. Without settings, it reads them from the environment at startup."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.settings = settings or Settings()
        yield

    app = FastAPI(title="fortymm API", version="0.1.0", lifespan=lifespan)
    # Every error response, FastAPI's own included, is an error document.
    errors.install(app)
    # /openapi.json and /docs stay unversioned: one document describes every version.
    app.include_router(v1.router)
    return app
