"""FastAPI dependencies: how routes get settings and services."""

from typing import Annotated

from fastapi import Depends, Request

from api.services.health_check import HealthCheck
from api.services.match_database import MatchDatabase
from api.settings import Settings


def get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def get_health_check(settings: Annotated[Settings, Depends(get_settings)]) -> HealthCheck:
    return HealthCheck(str(settings.database_url))


def get_match_database(settings: Annotated[Settings, Depends(get_settings)]) -> MatchDatabase:
    return MatchDatabase(settings.environment_number)
