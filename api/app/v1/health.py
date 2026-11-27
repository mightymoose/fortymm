from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.jsonapi import Document
from app.services.health import HealthService

router = APIRouter()


class Health(BaseModel):
    # camelCase on the wire (`coreHealthy`), snake_case in Python.
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    server: Literal["ok"]
    core_healthy: bool


@router.get("/health")
def health(service: Annotated[HealthService, Depends()]) -> Document[Health]:
    return Document(data=Health(server="ok", core_healthy=service.core_healthy))
