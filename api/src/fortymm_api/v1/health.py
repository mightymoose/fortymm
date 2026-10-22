from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from fortymm_api.database import DatabaseConnection

router = APIRouter(tags=["health"])


class HealthStatus(BaseModel):
    database: Literal["ok"]


class HealthResponse(BaseModel):
    data: HealthStatus


@router.get("/health")
def health(connection: DatabaseConnection) -> HealthResponse:
    """Check that the API can reach its database."""
    connection.execute("SELECT 1")
    return HealthResponse(data=HealthStatus(database="ok"))
