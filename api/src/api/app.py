from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from api.routes import health
from api.settings import Settings


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the app. Without settings, it reads them from the environment at startup."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.settings = settings or Settings()
        yield

    app = FastAPI(title="fortymm API", version="0.1.0", lifespan=lifespan)
    app.include_router(health.router)
    return app
