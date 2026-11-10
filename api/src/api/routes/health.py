from typing import Annotated

from fastapi import APIRouter, Depends, status
from fastapi.responses import JSONResponse

from api.dependencies import get_health_check
from api.services.health_check import HealthCheck, HealthOk, HealthUnavailable

router = APIRouter()


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
async def health(
    health_check: Annotated[HealthCheck, Depends(get_health_check)],
) -> HealthOk | JSONResponse:
    match await health_check.run():
        case HealthOk() as ok:
            return ok
        case HealthUnavailable() as unavailable:
            return JSONResponse(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                content=unavailable.model_dump(),
            )
