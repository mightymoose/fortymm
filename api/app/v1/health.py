from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from app.jsonapi import Document

router = APIRouter()


class Health(BaseModel):
    server: Literal["ok"]


@router.get("/health")
def health() -> Document[Health]:
    return Document(data=Health(server="ok"))
