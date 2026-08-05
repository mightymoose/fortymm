"""The rows behind ``tournament_events.draw_settings_id`` — their settings column's
storage boundary, and their cleanup.

**The boundary.** ``tournament_event_draw_settings.settings`` is one NOT NULL JSON
object (ADR "a draw type's settings are one NOT NULL JSON object") and it is the
serialized form of a union that already exists: ``DrawSettingsWriteArm``, the
discriminated union the request boundary parses into. :func:`draw_settings_of` decodes a
row into that arm, and :func:`store_draw_settings` encodes an arm back onto one
(:func:`draw_settings_row` is the same write for a row that does not exist yet, and
delegates). Both directions are here, in one module, because a settings object written
one way and read another is the single failure this column can have.

**Where the untyped blob is allowed to exist.** It crosses this module's boundary
functions and the two ends they call —
:meth:`~app.schemas.tournament.DrawSettingsWriteBase.stored_settings` encoding on the
schema side, and ``TournamentEventDrawSettings.configure`` storing on the model side.
That is the whole of it: no caller of this module ever holds a ``dict[str, Any]``, which
is the property api/CLAUDE.md's "parse, don't validate" asks for. The claim is about
*callers*, not about a literal two-function count — the encode necessarily lives on the
schema because the model cannot import the schemas.

They live beside the row rather than on it: the model cannot import the schemas (the
schemas import the models, and the arrow only points one way), so the model takes the
draw type and a plain mapping and this module is what turns an arm into that pair.

**The cleanup.** An event's draw configuration is a row, not a column (ADR "an event's
draw
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
from app.schemas.tournament import DrawSettingsWriteArm, draw_settings_from_storage


def draw_settings_of(row: TournamentEventDrawSettings) -> DrawSettingsWriteArm:
    """This settings row's draw configuration, parsed — the ONE read boundary onto the
    ``settings`` column.

    Every reader of an event's draw configuration goes through here and holds the
    **arm**, never the row's two columns: the draw type and the settings that belong to
    it are one fact, and reading them apart is how a strategy ends up configured from a
    blob that names a different draw type.

    Raises :class:`~pydantic.ValidationError` on a blob that is not the arm its draw
    type names — see :func:`app.schemas.tournament.draw_settings_from_storage` for why
    that is louder than the request side's 422.
    """
    return draw_settings_from_storage(row.draw_type, row.settings)


def store_draw_settings(
    row: TournamentEventDrawSettings, settings: DrawSettingsWriteArm
) -> None:
    """Write ``settings`` onto ``row`` — the ONE write boundary onto that column.

    The inverse of :func:`draw_settings_of`, and the reason both are in one module: the
    arm's discriminator becomes the ``draw_type_key`` slug and the rest of it becomes
    the JSON object, in a single call, so the pair cannot be written half-way. Delegates
    to ``configure``, which is the model's own "these two columns are one fact" door.
    """
    row.configure(settings.draw_type, settings=settings.stored_settings())


def draw_settings_row(
    settings: DrawSettingsWriteArm,
) -> TournamentEventDrawSettings:
    """A **new** settings row carrying ``settings`` — what the event-create path builds
    its event's ``draw_settings`` with.

    The create-shaped face of :func:`store_draw_settings` — and it *delegates* to it
    rather than restating the split, so create and edit serialize an arm exactly one way
    between them by construction rather than by two spellings that happen to agree.
    """
    row = TournamentEventDrawSettings()
    store_draw_settings(row, settings)
    return row


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
