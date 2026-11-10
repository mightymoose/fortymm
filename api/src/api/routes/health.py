"""GET /v1/health: turns HealthCheck's result into a response document.

200: {"data": {"type": "health", "id": "api", "attributes": {"database": "ok"}}}
503: the error document (api.routes.errors) with DatabaseUnavailableError.
"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from api.dependencies import get_health_check
from api.routes.errors import ErrorObject, documented, error_response
from api.services.health_check import HealthCheck, HealthOk, HealthUnavailable

router = APIRouter()


class HealthAttributes(BaseModel):
    model_config = ConfigDict(extra="forbid")

    database: Literal["ok"]


class HealthResource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["health"]
    # The resource is the health of this API, so there is exactly one.
    id: Literal["api"]
    attributes: HealthAttributes


class HealthDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    data: HealthResource


class DatabaseUnavailableError(ErrorObject):
    status: Literal["503"] = "503"
    code: Literal["database_unavailable"] = "database_unavailable"
    title: Literal["The database did not answer"] = "The database did not answer"


@router.get(
    "/health",
    summary="Whether the API can reach its database",
    response_model=HealthDocument,
    responses=documented(DatabaseUnavailableError),
)
async def get_health(
    health_check: Annotated[HealthCheck, Depends(get_health_check)],
) -> HealthDocument | JSONResponse:
    match await health_check.run():
        case HealthOk():
            return HealthDocument(
                data=HealthResource(
                    type="health", id="api", attributes=HealthAttributes(database="ok")
                )
            )
        case HealthUnavailable():
            return error_response(DatabaseUnavailableError())
