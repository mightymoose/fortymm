"""Data access for the match domain. A plain class wired with an
``AsyncSession`` (no FastAPI imports) so it's constructible in the REPL, in
scripts, and in tests."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.match.models import Match as MatchModel
from app.models.match import Match


class MatchRepository:
    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def get(self, match_id: uuid.UUID) -> MatchModel | None:
        """Load the data the match domain needs for ``match_id``, returning the
        storage-agnostic domain model (``None`` when no match exists — the
        caller maps that to a 404). Selects only the columns the domain model
        carries rather than the full hierarchical match."""
        row = (
            await self._db.execute(
                select(Match.id, Match.status).where(Match.id == match_id)
            )
        ).one_or_none()
        if row is None:
            return None
        return MatchModel(id=row.id, status=row.status)
