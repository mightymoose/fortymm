"""Deletion guards for recorded tournament play; callers hold the owner row lock."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    MatchLineup,
    MatchLineupPlayer,
    TournamentEntry,
    TournamentEntryMember,
    TournamentEvent,
)
from app.tournament_errors import RecordedPlayDeletionError


async def require_no_recorded_play(
    db: AsyncSession, *, tournament_id: uuid.UUID, event_id: uuid.UUID | None = None
) -> None:
    # Follow preserved membership, not mutable fixture seats. These are the
    # references that a parent deletion would cascade into and the FK protects.
    query = (
        select(MatchLineup.id)
        .join(MatchLineupPlayer, MatchLineupPlayer.lineup_id == MatchLineup.id)
        .join(
            TournamentEntryMember,
            TournamentEntryMember.id == MatchLineupPlayer.entry_member_id,
        )
        .join(TournamentEntry, TournamentEntry.id == TournamentEntryMember.entry_id)
        .join(TournamentEvent, TournamentEvent.id == TournamentEntry.event_id)
        .where(TournamentEvent.tournament_id == tournament_id)
        .limit(1)
    )
    if event_id is not None:
        query = query.where(TournamentEvent.id == event_id)
    if await db.scalar(query) is not None:
        raise RecordedPlayDeletionError()
