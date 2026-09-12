"""Retention guards for sporting and lifecycle history; callers hold the owner lock."""

import uuid

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    AdvancementDecision,
    MatchGame,
    MatchLineup,
    MatchLineupPlayer,
    MatchResult,
    TournamentEntry,
    TournamentEntryMember,
    TournamentEvent,
    TournamentEventStage,
    TournamentFixture,
)
from app.models.event_reconciliation import EventReconciliation
from app.models.tournament_archive import TournamentArchiveHistory
from app.tournament_errors import RecordedPlayDeletionError


async def require_no_recorded_play(
    db: AsyncSession, *, tournament_id: uuid.UUID, event_id: uuid.UUID | None = None
) -> None:
    if (
        event_id is None
        and await db.scalar(
            select(TournamentArchiveHistory.tournament_id).where(
                TournamentArchiveHistory.tournament_id == tournament_id
            )
        )
        is not None
    ):
        raise RecordedPlayDeletionError(
            "Archive history must be preserved. This tournament cannot be deleted."
        )
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
    from app.models.tournament import EventLifecycleState

    if (
        await db.scalar(
            select(TournamentEvent.id)
            .where(
                TournamentEvent.id.in_(event_ids),
                TournamentEvent.lifecycle_state != EventLifecycleState.unstarted,
            )
            .limit(1)
        )
        is not None
    ):
        raise RecordedPlayDeletionError(
            "Event lifecycle history must be preserved. "
            "This event or tournament cannot be deleted."
        )
    if (
        await db.scalar(
            select(EventReconciliation.event_id)
            .where(EventReconciliation.event_id.in_(event_ids))
            .limit(1)
        )
        is not None
    ):
        raise RecordedPlayDeletionError(
            "Event reconciliation history must be preserved. "
            "This event or tournament cannot be deleted."
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
    # Direct score/result writers can record evidence before a status change
    # captures a lineup. A matchless winner is recorded play too; neither an
    # absent match nor pending status makes that history disposable.
    evidence = (
        select(TournamentFixture.id)
        .join(
            TournamentEventStage, TournamentEventStage.id == TournamentFixture.stage_id
        )
        .where(
            TournamentEventStage.event_id.in_(event_ids),
            or_(
                TournamentFixture.winner_entry_id.is_not(None),
                select(MatchGame.id)
                .where(MatchGame.match_id == TournamentFixture.match_id)
                .exists(),
                select(MatchResult.id)
                .where(MatchResult.match_id == TournamentFixture.match_id)
                .exists(),
            ),
        )
        .limit(1)
    )
    if (
        await db.scalar(evidence.execution_options(include_draw_history=True))
        is not None
    ):
        raise RecordedPlayDeletionError()

    # Imported history need not have a match, lineup, or official result. Its
    # explicit unknown provenance is still immutable, and parent deletion would
    # destroy the seat it explains. The owner/event locks serialize this guard
    # with advancement writers just as they do recorded-play retention.
    advancement = (
        select(AdvancementDecision.id)
        .join(TournamentFixture, TournamentFixture.id == AdvancementDecision.fixture_id)
        .join(
            TournamentEventStage, TournamentEventStage.id == TournamentFixture.stage_id
        )
        .where(TournamentEventStage.event_id.in_(event_ids))
        .limit(1)
    )
    if (
        await db.scalar(advancement.execution_options(include_draw_history=True))
        is not None
    ):
        raise RecordedPlayDeletionError(
            "Advancement history must be preserved. "
            "This event or tournament cannot be deleted."
        )
