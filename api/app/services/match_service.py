"""Match domain service. A plain class with a plain ``__init__`` (no FastAPI
imports) so it's constructible in the REPL, in scripts, and in tests by handing
it a repository directly. A thin provider wires it for request handling."""

from __future__ import annotations

import uuid

from app.domain.match.models import Match
from app.repositories.match_repository import MatchRepository


class MatchService:
    def __init__(self, matches: MatchRepository) -> None:
        self._matches = matches

    async def get_match(self, match_id: uuid.UUID) -> Match | None:
        """Load the domain match for ``match_id`` via the repository, or
        ``None`` when no match exists (the caller maps that to a 404)."""
        return await self._matches.get(match_id)
