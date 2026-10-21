from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(tags=["health"])


class PingResponse(BaseModel):
    message: Literal["pong"]


@router.get("/ping")
def ping() -> PingResponse:
    """Check that the API is up."""
    return PingResponse(message="pong")
