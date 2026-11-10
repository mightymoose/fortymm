from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import APIRouter
from pydantic import PostgresDsn

from api.app import create_app
from api.settings import Settings


@asynccontextmanager
async def api_client(
    database_url: str, extra_routes: APIRouter | None = None
) -> AsyncIterator[httpx.AsyncClient]:
    """The whole app in process, started as uvicorn starts it, using this database.

    extra_routes adds test-only routes, for behavior no real route can trigger on
    demand (an unhandled exception). Unhandled exceptions become 500 responses, as
    they do under uvicorn, instead of being raised into the test.
    """
    app = create_app(Settings(database_url=PostgresDsn(database_url)))
    if extra_routes is not None:
        app.include_router(extra_routes)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://api") as client:
            yield client
