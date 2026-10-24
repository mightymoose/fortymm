from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import text

from fortymm_api.database import DatabaseSession

router = APIRouter(tags=["health"])


class HealthStatus(BaseModel):
    database: Literal["ok"]


class HealthResponse(BaseModel):
    data: HealthStatus


@router.get("/health")
def health(session: DatabaseSession) -> HealthResponse:
    """Check that the API can reach its database."""
    session.execute(text("SELECT 1"))
    return HealthResponse(data=HealthStatus(database="ok"))
