import asyncio
import logging
from typing import Literal

import asyncpg
from pydantic import BaseModel, ConfigDict

logger = logging.getLogger(__name__)

# How long the database gets to answer SELECT 1, connecting included.
DATABASE_TIMEOUT_SECONDS = 2.0


class HealthOk(BaseModel):
    # The database answered SELECT 1 in time.

    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)

    status: Literal["ok"] = "ok"
    database: Literal["ok"] = "ok"


class HealthUnavailable(BaseModel):
    # The database did not answer SELECT 1 in time. Carries no detail, by design.

    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)

    status: Literal["unavailable"] = "unavailable"
    database: Literal["unavailable"] = "unavailable"


class HealthCheck:
    """Whether the API can do its job: does its database answer SELECT 1?"""

    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    async def run(self) -> HealthOk | HealthUnavailable:
        """Ask the database now, on a new connection. Never raises for a failing database;
        the cause goes to the log."""
        try:
            async with asyncio.timeout(DATABASE_TIMEOUT_SECONDS):
                await self._select_1()
        except Exception as error:
            logger.warning("Health check failed: the database did not answer: %r", error)
            return HealthUnavailable()
        return HealthOk()

    async def _select_1(self) -> None:
        connection = await asyncpg.connect(self._database_url)
        try:
            await connection.fetchval("SELECT 1")
        except BaseException:
            # Cancelled or failed mid-query: drop the socket without waiting on the server.
            connection.terminate()
            raise
        await connection.close()
