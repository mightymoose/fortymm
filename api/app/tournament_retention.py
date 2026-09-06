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
    # Keep the event -> member lock order used by roster writers. Locking the
    # events first also prevents new memberships appearing after this scan.
    events = select(TournamentEvent.id).where(
        TournamentEvent.tournament_id == tournament_id
    )
    if event_id is not None:
        events = events.where(TournamentEvent.id == event_id)
    event_ids = list(
        (await db.scalars(events.order_by(TournamentEvent.id).with_for_update())).all()
    )
    # A first lineup's FK takes KEY SHARE on these rows, even when its caller
    # never locks the tournament (a rated participant proposal). Wait for that
    # transaction before the subsequent READ COMMITTED history check, then keep
    # these locks through deletion so a new capture cannot race the check.
    await db.execute(
        select(TournamentEntryMember.id)
        .join(TournamentEntry, TournamentEntry.id == TournamentEntryMember.entry_id)
        .where(TournamentEntry.event_id.in_(event_ids))
        .order_by(TournamentEntryMember.id)
        .with_for_update(of=TournamentEntryMember)
    )
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
