from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(tags=["health"])


class PingResponse(BaseModel):
    data: Literal["pong"]


@router.get("/ping")
def ping() -> PingResponse:
    """Check that the API is up."""
    return PingResponse(data="pong")
