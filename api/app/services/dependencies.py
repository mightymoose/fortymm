"""FastAPI providers for the service layer — the single place that knows how
to wire a request-scoped session into repositories and services. The services
and repositories themselves stay FastAPI-free; this module owns the ``Depends``
graph so handlers can declare ``service: MatchService = Depends(get_match_service)``
and tests can override it via ``app.dependency_overrides``."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.repositories.match_details_repository import MatchDetailsRepository
from app.repositories.match_repository import MatchRepository
from app.services.match_service import MatchService


def get_match_service(db: AsyncSession = Depends(get_session)) -> MatchService:
    return MatchService(MatchRepository(db), MatchDetailsRepository(db))
