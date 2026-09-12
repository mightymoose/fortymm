"""The transport-neutral cut / un-cut draw write verbs (ADR-0786).

The orchestration behind ``POST`` and ``DELETE
/v1/tournaments/{id}/events/{id}/draw`` — the ``FOR UPDATE`` load-lock on the
tournament, the owner gate, the event-under-tournament load, the play-evidence
gate, and the ``cut_draw`` / ``uncut_draw`` domain core — extracted out of the
router so it can run without FastAPI: from the HTTP adapters
(``app.tournaments.cut_event_draw`` / ``uncut_event_draw``) and, later, from an
MCP tool alike, and be constructed in a plain REPL with a raw session.

Per the tournament-verbs ADR (mirroring the match-flow ADR and the edit verb in
``app.tournament_edit``), it signals every refusal with a **domain exception** from
``app.tournament_errors`` — never an ``HTTPException`` — and each adapter maps it
back to the exact response it produced before:

* an absent tournament → :class:`TournamentNotFoundError` (404);
* an event that is not under it → :class:`EventNotFoundError` (404);
* a non-owner → :class:`NotTournamentOwnerError` (403);
* a draw with evidence of play → :class:`DrawUnderWayError` (409).

The :class:`~app.draws.DrawError` family (``UnsupportedDrawType`` /
``NonSinglesDraw`` / ``DegenerateDraw``) is **already** a FastAPI-free domain
family; :func:`cut_draw` raises it and this verb lets it propagate **unchanged**,
for the adapter to turn into the 422 ``_draw_refusal`` composes. A cut refused
that way rolls back first, so a 422 destroys nothing — the same rollback the
router used to do inline.

The tournament is loaded through the same ``FOR UPDATE`` loader the edit verb
uses (``app.tournament_edit._load_tournament_for_update``): the lock is not
decoration. A cut reads the event's active field and writes fixtures derived from
it, and Postgres runs READ COMMITTED, so an unlocked read would answer from its
own statement's snapshot and an entry (or a withdrawal) committing between the
read and the INSERT would leave a persisted draw that never matched any real field
of players. Every writer of the entrant field already queues on this row, so
taking it here is what puts the cut in that queue.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.draws import DrawError
from app.models import ScheduleSolveTrigger, TournamentEvent, User
from app.schedule_solves import request_solve, tournament_has_drawn_event
from app.schemas.tournament import TournamentFixtureRead
from app.tournament_draw_limits import lock_draw_actor
from app.tournament_draws import (
    cut_draw,
    draw_has_play,
    event_has_draw,
    uncut_draw,
)
from app.tournament_edit import _load_owned_tournament_for_update
from app.tournament_errors import (
    DrawUnderWayError,
    EventNotFoundError,
)
from app.tournament_queries import fixtures_by_event


async def _load_owned_event_for_draw(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    actor: User,
) -> TournamentEvent:
    """The event whose draw is about to be written, loaded under the tournament's row
    lock and the owner check — the refusal ordering both draw verbs share.

    **404 → 403 → 409**, the ordering ADR-0017 fixed and every tournament write
    keeps: a tournament that does not exist (:class:`TournamentNotFoundError`) or an
    event that is not under it (:class:`EventNotFoundError`) is a 404 before
    ownership is considered, so a stranger probing ids learns nothing; a non-owner
    (:class:`NotTournamentOwnerError`) is a 403 before the draw's *state* is looked
    at, so the refusal never leaks whether an event has been played. The play-evidence
    409 (:func:`_enforce_unplayed`) is the caller's own, and comes last.

    The tournament is loaded through the **locking** loader the edit, entry,
    withdrawal and transition paths all share — the same lock, on the same row, taken
    first — which is what keeps them free of a deadlock cycle. The FastAPI-free
    equivalent of the router's ``_get_owned_event_for_draw_or_404``.
    """
    await _load_owned_tournament_for_update(db, tournament_id, actor)
    # The event must belong to the named tournament — scoped by both ids so a
    # mismatched pair is a miss, not a cross-tournament draw.
    event = (
        await db.execute(
            select(TournamentEvent).where(
                TournamentEvent.id == event_id,
                TournamentEvent.tournament_id == tournament_id,
            )
        )
    ).scalar_one_or_none()
    if event is None:
        raise EventNotFoundError()
    return event


async def _enforce_unplayed(db: AsyncSession, event: TournamentEvent) -> None:
    """Refuse draw replacement or removal once a winner or linked match exists.

    Read under the tournament lock. Retaining the former revision does not grant
    permission to redraw competition that is already under way.
    """
    if await draw_has_play(db, event.id):
        raise DrawUnderWayError()


async def cut_event_draw(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    actor: User,
) -> list[TournamentFixtureRead]:
    """Create a current draw revision and return its fixtures in canonical order.

    The shared load locks the tournament, checks authority and event ownership,
    then refuses evidence of play. The draw core retires the former revision and
    creates its replacement in this transaction. A planning refusal rolls back
    configuration changes and retirement, preserving the previous current draw.

    Request a settings solve, commit, and read through the same current-draw
    loader as the tournament detail page. A queue outage costs the solve rather
    than the cut. Domain errors remain transport-neutral for HTTP and MCP callers.
    """
    await lock_draw_actor(db, actor.id)
    event = await _load_owned_event_for_draw(
        db, tournament_id=tournament_id, event_id=event_id, actor=actor
    )
    await _enforce_unplayed(db, event)
    try:
        await cut_draw(db, event, actor_id=actor.id)
    except DrawError:
        # Configuration may already have been cloned or resized. Roll back
        # the entire attempted replacement before the adapter reports refusal.
        await db.rollback()
        raise
    await request_solve(db, tournament_id, ScheduleSolveTrigger.settings_changed)
    await db.commit()
    return (await fixtures_by_event(db, [event.id]))[event.id]


async def uncut_event_draw(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    actor: User,
) -> None:
    """Retire the current draw while preserving fixtures and participation history.

    Use the same authority, ownership and play checks as cutting. Removing an
    absent draw remains idempotent. A real removal requests a settings solve only
    when another current draw remains in the tournament, then commits.
    """
    event = await _load_owned_event_for_draw(
        db, tournament_id=tournament_id, event_id=event_id, actor=actor
    )
    await _enforce_unplayed(db, event)
    # An absent current draw changes no scheduling input.
    had_draw = await event_has_draw(db, event.id)
    await uncut_draw(db, [event.id])
    if had_draw and await tournament_has_drawn_event(db, tournament_id):
        await request_solve(db, tournament_id, ScheduleSolveTrigger.settings_changed)
    await db.commit()
