"""Match domain service. A plain class with a plain ``__init__`` (no FastAPI
imports) so it's constructible in the REPL, in scripts, and in tests by handing
it a repository directly. A thin provider wires it for request handling."""

from __future__ import annotations

import uuid
from datetime import datetime

from app.domain.match.extras import MatchViewExtras
from app.domain.match.models import Match
from app.models.match import MatchStatus
from app.repositories.match_details_repository import MatchDetailsRepository
from app.repositories.match_repository import MatchRepository


class MatchService:
    def __init__(
        self, matches: MatchRepository, details: MatchDetailsRepository
    ) -> None:
        self._matches = matches
        self._details = details

    async def get_match(self, match_id: uuid.UUID) -> Match | None:
        """Load the domain match for ``match_id`` via the repository, or
        ``None`` when no match exists (the caller maps that to a 404)."""
        return await self._matches.get(match_id)

    async def load_view_extras(
        self,
        *,
        match_id: uuid.UUID,
        league_id: uuid.UUID,
        status: MatchStatus,
        created_at: datetime,
        user_ids: list[uuid.UUID],
    ) -> MatchViewExtras:
        """The participant-only extras block for a match the caller has already
        loaded: rating changes, each player's recent form, and the head-to-head.

        Takes primitives rather than a loaded row so the repository stays free of
        the ORM hierarchy. Callers that must *not* show the extras (anonymous or
        spectator viewers — see #515) pass none of this and use
        ``MatchViewExtras.empty()`` instead."""
        return MatchViewExtras(
            rating_changes=await self._details.rating_changes(match_id, status),
            recent_form=await self._details.recent_form(
                user_ids, match_id, league_id, created_at
            ),
            head_to_head=await self._details.head_to_head(
                user_ids, match_id, created_at
            ),
        )
