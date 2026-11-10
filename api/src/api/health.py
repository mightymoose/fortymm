import asyncio
import logging
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from api import database
from api.settings import Settings

logger = logging.getLogger(__name__)

# How long the database gets to answer SELECT 1, connecting included.
DATABASE_TIMEOUT_SECONDS = 2.0

router = APIRouter()


class HealthOk(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)

    status: Literal["ok"] = "ok"
    database: Literal["ok"] = "ok"


class HealthUnavailable(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)

    status: Literal["unavailable"] = "unavailable"
    database: Literal["unavailable"] = "unavailable"


def get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


@router.get(
    "/health",
    summary="Whether the API can reach its database",
    response_model=HealthOk,
    responses={
        status.HTTP_503_SERVICE_UNAVAILABLE: {
            "model": HealthUnavailable,
            "description": "The database did not answer SELECT 1 in time",
        },
    },
)
async def health(settings: Annotated[Settings, Depends(get_settings)]) -> HealthOk | JSONResponse:
    try:
        async with asyncio.timeout(DATABASE_TIMEOUT_SECONDS):
            await database.ping(str(settings.database_url))
    except Exception as error:
        # The cause goes to the log for operators; the response says only which part failed.
        logger.warning("Health check failed: the database did not answer: %r", error)
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content=HealthUnavailable().model_dump(),
        )
    return HealthOk()
