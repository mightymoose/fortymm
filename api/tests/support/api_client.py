from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from pydantic import PostgresDsn

from api.app import create_app
from api.settings import Settings


@asynccontextmanager
async def api_client(database_url: str) -> AsyncIterator[httpx.AsyncClient]:
    """The whole app in process, started as uvicorn starts it, using this database."""
    app = create_app(Settings(database_url=PostgresDsn(database_url)))
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://api") as client:
            yield client
