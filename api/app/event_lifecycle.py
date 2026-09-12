"""Event progress reconciles through the same results projection readers use.

Callers retain their transaction. The event row serializes sporting transitions;
the database owns timestamps, versions and immutable transition history.
"""

import uuid

from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Tournament, TournamentEvent, TournamentFixture, User
from app.models.tournament import EventLifecycleState
from app.tournament_queries import (
    active_entrants_by_event,
    fixtures_by_event,
    game_counts_by_match,
)
from app.tournament_serialization import event_results


async def reconcile_event(db: AsyncSession, event_id: uuid.UUID) -> None:
    await db.flush()
    # Completion and cancellation both serialize parent scope before event state.
    await db.scalar(
        select(Tournament.id)
        .join(TournamentEvent, TournamentEvent.tournament_id == Tournament.id)
        .where(TournamentEvent.id == event_id)
        .with_for_update(of=Tournament)
    )
    event = await db.scalar(
        select(TournamentEvent)
        .where(TournamentEvent.id == event_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if event is None:
        return
    if event.lifecycle_state is EventLifecycleState.cancelled:
        await _record_reconciliation(db, event)
        return
    fixtures = (await fixtures_by_event(db, [event_id]))[event_id]
    entrants = (await active_entrants_by_event(db, [event_id]))[event_id]
    counts = await game_counts_by_match(
        db, [f.match_id for f in fixtures if f.match_id is not None]
    )
    results = event_results(
        event,
        entrants=entrants,
        fixtures=fixtures,
        game_counts=counts,
        stage_draw_types={s.id: s.draw_type for s in event.stages},
    )
    complete = results is not None and results.complete
    next_state = (
        EventLifecycleState.finished
        if complete
        else EventLifecycleState.in_progress
        if event.lifecycle_state is EventLifecycleState.finished
        else event.lifecycle_state
    )
    if next_state is not event.lifecycle_state:
        await db.execute(
            update(TournamentEvent)
            .where(TournamentEvent.id == event_id)
            .values(lifecycle_state=next_state)
        )
        await db.refresh(event)
    await _record_reconciliation(db, event)


async def _record_reconciliation(db: AsyncSession, event: TournamentEvent) -> None:
    """Assert this transaction's projected event snapshot for deferred integrity.

    A plain unstarted event has no receipt obligation and remains deletable.
    Completed attachments and administrator voids invalidate an earlier assertion;
    their transaction must reconcile again after changing the result inputs.
    """
    await db.execute(
        text("""
            INSERT INTO tournament_event_reconciliations
                (event_id, lifecycle_state, lifecycle_version,
                 transaction_id, reconciled)
            SELECT :event, :state, :version, pg_current_xact_id()::text::bigint, true
            WHERE :version > 0 OR EXISTS (
                SELECT 1 FROM tournament_event_reconciliations r
                WHERE r.event_id=:event
                  AND r.transaction_id=pg_current_xact_id()::text::bigint
            ) OR EXISTS (
                SELECT 1 FROM tournament_fixtures f
                JOIN matches m ON m.id=f.match_id
                WHERE f.scope_event_id=:event AND
                    (m.status='completed' OR EXISTS (
                        SELECT 1 FROM match_void_actions v WHERE v.match_id=m.id
                    ))
            )
            ON CONFLICT (event_id, transaction_id) DO UPDATE SET
                lifecycle_state=EXCLUDED.lifecycle_state,
                lifecycle_version=EXCLUDED.lifecycle_version,
                reconciled=true
        """),
        {
            "event": event.id,
            "state": event.lifecycle_state.value,
            "version": event.lifecycle_version,
        },
    )


async def reconcile_match_event(db: AsyncSession, match_id: uuid.UUID) -> None:
    event_id = await db.scalar(
        select(TournamentFixture.scope_event_id)
        .where(TournamentFixture.match_id == match_id)
        .execution_options(include_draw_history=True)
    )
    if event_id is not None:
        await reconcile_event(db, event_id)


async def cancel_event(
    db: AsyncSession, *, tournament_id: uuid.UUID, event_id: uuid.UUID, actor: "User"
) -> None:
    """Record the director's terminal cancellation in the caller's transaction."""
    from app.tournament_edit import _load_owned_tournament_for_update
    from app.tournament_errors import EventNotFoundError

    await _load_owned_tournament_for_update(db, tournament_id, actor)
    event = await db.scalar(
        select(TournamentEvent)
        .where(
            TournamentEvent.id == event_id,
            TournamentEvent.tournament_id == tournament_id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if event is None:
        raise EventNotFoundError()
    if event.lifecycle_state not in (
        EventLifecycleState.unstarted,
        EventLifecycleState.in_progress,
    ):
        raise ValueError("Only an unstarted or in-progress event can be cancelled")
    await db.execute(
        update(TournamentEvent)
        .where(TournamentEvent.id == event_id)
        .values(lifecycle_state=EventLifecycleState.cancelled)
    )
    await db.refresh(event)
    await _record_reconciliation(db, event)


async def require_game_recording_allowed(
    db: AsyncSession, match_id: uuid.UUID, game_numbers: tuple[int, ...]
) -> None:
    """Refuse new play after cancellation; recorded game corrections remain valid."""
    from app.match_errors import ScoreNotAllowedError
    from app.models.event_lifecycle import EventRecordedGame

    # Finalization later needs this same parent lock. Taking the event first
    # would deadlock against cancellation, which already holds the tournament.
    await db.scalar(
        select(Tournament.id)
        .join(TournamentFixture, TournamentFixture.scope_tournament_id == Tournament.id)
        .where(TournamentFixture.match_id == match_id)
        .with_for_update(of=Tournament)
    )
    state = await db.scalar(
        select(TournamentEvent.lifecycle_state)
        .join(TournamentFixture, TournamentFixture.scope_event_id == TournamentEvent.id)
        .where(TournamentFixture.match_id == match_id)
        .with_for_update(of=TournamentEvent)
    )
    if state is EventLifecycleState.cancelled:
        recorded = set(
            await db.scalars(
                select(EventRecordedGame.game_number).where(
                    EventRecordedGame.match_id == match_id,
                    EventRecordedGame.game_number.in_(game_numbers),
                )
            )
        )
        if not set(game_numbers).issubset(recorded):
            raise ScoreNotAllowedError(
                "This event is cancelled; only previously recorded games can be "
                "corrected."
            )
