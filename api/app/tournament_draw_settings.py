"""Cleanup for the rows behind ``tournament_events.draw_settings_id``.

An event's draw configuration is a row, not a column (ADR "an event's draw
configuration is a row, not a column"), and the FK lives on the *parent*: the
event points at its settings row, never the other way round. That direction is
what makes "every event has exactly one settings row" a database fact — and it is
also why nothing in the database can reap a settings row when its event goes
away. A settings row has no ``event_id`` to cascade along.

The ORM covers the path where an event is deleted **through a mapped object**:
``TournamentEvent.draw_settings`` is ``cascade="all, delete-orphan"``, so
``await db.delete(event)`` takes the settings row with it, and the unit of work
orders the two DELETEs correctly (the event holds the FK, so it goes first and
the ``ON DELETE RESTRICT`` is never tripped).

It does **not** cover the path where events are removed by Postgres.
``Tournament.events`` is ``passive_deletes=True``, so deleting a tournament is a
single ``DELETE FROM tournaments`` and its events are swept by their own ``ON
DELETE CASCADE`` — a *database* cascade, which cannot run a *Python*-side one.
That is the gap :func:`reap_draw_settings` closes, and why the tournament-delete
verb collects its events' settings ids before the delete and hands them here
after it.
"""

import uuid
from collections.abc import Collection

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import TournamentEvent, TournamentEventDrawSettings


async def draw_settings_ids_for_tournament(
    db: AsyncSession, tournament_id: uuid.UUID
) -> list[uuid.UUID]:
    """The settings-row ids every event under ``tournament_id`` currently points at.

    Read **before** the tournament is deleted, because afterwards the events that
    named them are gone and there is nothing left to find them by.
    """
    rows = await db.scalars(
        select(TournamentEvent.draw_settings_id).where(
            TournamentEvent.tournament_id == tournament_id
        )
    )
    return list(rows)


async def reap_draw_settings(
    db: AsyncSession, settings_ids: Collection[uuid.UUID]
) -> None:
    """Delete the settings rows in ``settings_ids`` that no event points at any more.

    The ``NOT EXISTS`` sub-query is what makes this total rather than hopeful: a row
    still referenced by some event is skipped rather than attempted, so the call is
    safe to make with ids whose events survived, safe to repeat, and can never turn
    into the ``ON DELETE RESTRICT`` violation a blind ``DELETE ... WHERE id IN`` would
    raise. Callers must have flushed the deletes that orphaned these rows first —
    otherwise the events are still there and nothing is reaped.

    Does not commit; the caller's transaction owns that.
    """
    if not settings_ids:
        return
    await db.execute(
        delete(TournamentEventDrawSettings).where(
            TournamentEventDrawSettings.id.in_(settings_ids),
            ~select(TournamentEvent.id)
            .where(TournamentEvent.draw_settings_id == TournamentEventDrawSettings.id)
            .exists(),
        )
    )
