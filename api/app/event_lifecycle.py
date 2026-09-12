"""Event progress reconciles through the same results projection readers use.

Callers retain their transaction. The event row serializes sporting transitions;
the database owns timestamps, versions and immutable transition history.
"""

import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import TournamentEvent, TournamentFixture, User
from app.models.tournament import EventLifecycleState
from app.tournament_queries import (
    active_entrants_by_event,
    fixtures_by_event,
    game_counts_by_match,
)
from app.tournament_serialization import event_results


async def reconcile_event(db: AsyncSession, event_id: uuid.UUID) -> None:
    await db.flush()
    event = await db.scalar(
        select(TournamentEvent)
        .where(TournamentEvent.id == event_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if event is None or event.lifecycle_state is EventLifecycleState.cancelled:
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


async def reconcile_match_event(db: AsyncSession, match_id: uuid.UUID) -> None:
    event_id = await db.scalar(
        select(TournamentFixture.scope_event_id).where(
            TournamentFixture.match_id == match_id
        )
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


async def require_game_recording_allowed(
    db: AsyncSession, match_id: uuid.UUID, game_numbers: tuple[int, ...]
) -> None:
    """Refuse new play after cancellation; recorded game corrections remain valid."""
    from app.match_errors import ScoreNotAllowedError
    from app.models.event_lifecycle import EventRecordedGame

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
