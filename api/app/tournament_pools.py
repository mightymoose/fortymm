"""The one place an event's pools are written, and the seam their wire shape crosses.

A pool is a row now (ADR 20260801, "a pool belongs to its event, not to the event's draw
settings"), not an element of ``tournament_events.pools`` JSONB. So the two event write
verbs — ``create_event`` and ``update_event`` — no longer assign a column; they compose
:class:`~app.models.tournament_event_pool.TournamentEventPool` rows, and they do it
through this module rather than each spelling it out, for the reason
``app.tournament_tables`` exists for the venue catalogue: the shape a pool is stored in
must not depend on which verb happened to store it.

Two things live here and nowhere else.

**The position.** :func:`stored_pools` and :func:`apply_event_pools` stamp each pool
with its index in the list the client sent — the only place a ``position`` is ever
assigned, which is what makes an event's stored positions ``range(len(pools))`` by
construction (and what the ``UNIQUE (event_id, position)`` underneath now also insists
on).

**The Slot⇄columns conversion.** A pool's window is three wall-clock columns
(``slot_date``, ``slot_start``, ``slot_end``) and one wire value-object
(:class:`~app.schemas.tournament.Slot`, ``YYYY-MM-DD`` + ``HH:MM``). The strings are
parsed on the way in and composed on the way out, here, so no reader of a pool holds an
unparsed date and no writer invents a second spelling of one.

**The reservations.** A pool's ``table_ids`` are rows too now
(:class:`~app.models.tournament_event_pool_table.TournamentEventPoolTable`, ADR 20260801
"the tournament-scoping stops at the join table"), and the wire array is composed from
them in ``position`` order — so the row/JSONB change is invisible above this module on
that side as well. :func:`_reservations` is where the array becomes rows, and it is the
one place a reservation's ``tournament_id`` is written, which is why both write verbs
now take the parent tournament: the denormalized column is what the composite foreign
keys underneath compare, and a reservation composed without it is not a row Postgres
will accept. Each row's ``event_id`` is populated the same way, but through the
reservation's ``event`` relationship rather than a literal (:func:`_reservations` takes
``event`` too, now) — the event's own id does not exist yet on the create path, so the
unit of work has to fill it in after the event's own INSERT returns.

**The id.** A pool's id is a uuid the **database** mints (ADR 20260801's ``id uuid
PRIMARY KEY``), so nothing here assigns one on the create path and the create shape has
no field for one. On the edit path a client *cites* an id it was given, and citing one
this event does not have is refused rather than silently minted — the same split, and
the same 422, ``app.tournament_tables`` already makes for the venue catalogue.

The edit path is an **id-keyed diff** and not a wholesale replace, which is a change of
mechanism and not of meaning: the pool set an event may end up with is exactly what it
was (the freeze in ``app.tournament_events`` decides that), but a JSONB column could be
reassigned and rows cannot — re-sending a pool the event already has must UPDATE that
row, or the write would try to insert a duplicate primary key and, worse, would delete
and recreate the row every fixture in the event points at.

**The stage.** A pool's real parent is its stage now, not its event directly (ADR
20260815, "Sequencing with #1338": a pool re-parents onto the stage that owns it —
always the event's stage 0, decision 3). ``TournamentEvent.pools`` stays a *readable*
association (a VIEWONLY relationship through stage 0 — see that model), but writing
means resolving the actual stage row and assigning ``stage.pools``. On the create path
the stage is a fresh, unflushed object the caller already built
(``app.tournament_events.create_event`` passes it straight through); on the edit path
:func:`apply_event_pools` resolves it itself, with an explicit query, the same way
``app.tournament_event_stages.remint_stages_in_place`` does — never through
``TournamentEvent.stages`` (not eager; an async lazy load there would raise). That
query is why :func:`apply_event_pools` takes a session now, which is the one exception
to the claim below.

It otherwise imports the models, the schemas and the domain-error leaf, and nothing
else — no router, no FastAPI — so :func:`stored_pools` still stays callable from a REPL
and cycle-free; :func:`apply_event_pools` needs a session only for the stage lookup."""

import uuid
from collections.abc import Sequence
from datetime import date, time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import (
    Tournament,
    TournamentEvent,
    TournamentEventPool,
    TournamentEventPoolTable,
    TournamentEventStage,
)
from app.schemas.tournament import Pool, PoolUpsert, PoolWrite, Slot
from app.tournament_errors import PoolNotInEventError

__all__ = ["apply_event_pools", "pool_read", "stored_pools"]


def _slot_columns(slot: Slot) -> tuple[date, time, time]:
    """The three stored columns one wire :class:`Slot` becomes.

    ``fromisoformat`` and not a hand-rolled ``strptime``: it is the parser the rest of
    this codebase already reads dates with (``app.schedule_preview_solve``), and the
    boundary has already refused anything it would choke on
    (:data:`~app.schemas.tournament.PoolSlot`) — so this is a total function of what can
    reach it, not a parse that needs a failure branch.
    """
    return (
        date.fromisoformat(slot.date),
        time.fromisoformat(slot.start),
        time.fromisoformat(slot.end),
    )


def _slot_read(pool: TournamentEventPool) -> Slot:
    """The wire :class:`Slot` a stored pool's three columns compose back into.

    ``%H:%M`` exactly, with no seconds, because that is the shape the boundary accepts
    and therefore the only shape a stored value can have had (:data:`PoolSlot` refuses a
    time carrying seconds rather than storing one it would later have to truncate). The
    round trip is lossless: what a client sends is what it reads back, character for
    character.
    """
    return Slot(
        date=pool.slot_date.isoformat(),
        start=pool.slot_start.strftime("%H:%M"),
        end=pool.slot_end.strftime("%H:%M"),
    )


def pool_read(pool: TournamentEventPool) -> Pool:
    """One stored pool as the shape everything above the database reads
    (:class:`~app.schemas.tournament.Pool`).

    The read boundary, and the reason the row/JSONB change is invisible above it: every
    consumer — the serializer, ``draw_config``, the solver's input load, the schedule
    preview, the call copy, the dashboard panel — went through ``Pool``, and still does.
    They used to get there by validating an untyped JSONB dict; they get there by
    projecting typed columns now, which is the same "parse, don't validate" contract
    with the parsing already done by Postgres.
    """
    return Pool(
        id=pool.id,
        name=pool.name,
        slot=_slot_read(pool),
        table_ids=[reservation.table_id for reservation in pool.tables],
        position=pool.position,
    )


def _reservations(
    event: TournamentEvent,
    tournament: Tournament,
    submitted: Sequence[str],
    stored: Sequence[TournamentEventPoolTable] = (),
) -> list[TournamentEventPoolTable]:
    """The reservation rows one pool's submitted ``table_ids`` resolve to, keyed on the
    table id against whatever ``stored`` rows the pool already has.

    ``event`` is threaded through purely so each fresh row can be given ``event=event``
    — the reservation's ``event_id`` is populated by the unit of work through that
    relationship, not as a literal, because on the create path the event does not have
    an id yet (see the module docstring's "The reservations").

    Keyed rather than replaced wholesale for a mechanical reason as well as a tidy one:
    a reservation's identity IS ``(event, pool, table)``, so re-sending a table the pool
    already reserves and letting the collection be rebuilt would ask the unit of work to
    INSERT a primary key it is about to DELETE — and it emits the inserts first. Keeping
    the row and moving its ``position`` is the same end state with no such window.

    **A table the tournament's catalogue does not hold is dropped, silently**, which is
    this module's one judgement call and is the ADR's "quiet" half said at write time.
    A reservation is a *preference* — the loud refusal is reserved for a placement — and
    a preference naming a table that does not exist is not a preference the schema can
    hold at all now that it is a foreign key. Nothing observable moves: every reader
    already intersected ``table_ids`` with the catalogue (the solver's
    ``_load_solver_inputs``, the preview's snapshot), because a JSONB string could name
    anything; this puts that intersection at the boundary where it belongs instead of
    repeating it at each read. The same rule covers the cross-tournament id the
    composite foreign keys exist to refuse — the app cannot construct the row, and the
    database would not accept it if it did.

    Duplicates collapse (``dict.fromkeys``, order-preserving) for the same reason: the
    primary key says a pool reserves a table at most once, and a payload that names one
    twice means what it says once.
    """
    catalogue = {str(table.id) for table in tournament.tables}
    kept = {reservation.table_id: reservation for reservation in stored}
    rows: list[TournamentEventPoolTable] = []
    for table_id in dict.fromkeys(submitted):
        if table_id not in catalogue:
            continue
        row = kept.get(table_id)
        if row is None:
            row = TournamentEventPoolTable(
                tournament_id=tournament.id,
                table_id=table_id,
                position=len(rows),
                event=event,
            )
        else:
            row.position = len(rows)
        rows.append(row)
    return rows


def stored_pools(
    event: TournamentEvent, tournament: Tournament, submitted: Sequence[PoolWrite]
) -> list[TournamentEventPool]:
    """Fresh :class:`TournamentEventPool` rows for an event that has none yet — the
    create verb's whole job.

    Each row is stamped with the ``position`` of its index in ``submitted``: the only
    place a position is assigned on the create path, and what makes the stored positions
    ``range(len(submitted))`` by construction rather than by a caller's care.

    ``event`` is the fresh, unflushed event these pools belong to (used only for its
    reservations' ``event`` relationship — see :func:`_reservations`); the caller is
    responsible for attaching the returned rows to the right stage
    (``app.tournament_events.create_event`` assigns them to the event's stage 0).
    ``tournament`` is here for the reservations too: it supplies both the catalogue each
    ``table_ids`` entry is resolved against and the ``tournament_id`` every reservation
    row carries (:func:`_reservations`).

    No ``id`` is set: that is the database's (``gen_random_uuid()``), exactly as a venue
    table's is (:func:`app.tournament_tables.stored_tables`), and the point of the ADR
    is that it is not the client's to author — the create shape (:class:`PoolWrite`) has
    no field for one.
    """
    return [
        _new_pool(event, tournament, pool, position)
        for position, pool in enumerate(submitted)
    ]


def _new_pool(
    event: TournamentEvent, tournament: Tournament, submitted: PoolWrite, position: int
) -> TournamentEventPool:
    """One brand-new pool row, at ``position``, from the pool a client sent — with no
    ``id``, which the database mints."""
    slot_date, slot_start, slot_end = _slot_columns(submitted.slot)
    return TournamentEventPool(
        name=submitted.name,
        position=position,
        slot_date=slot_date,
        slot_start=slot_start,
        slot_end=slot_end,
        tables=_reservations(event, tournament, submitted.table_ids),
    )


async def apply_event_pools(
    db: AsyncSession,
    tournament: Tournament,
    event: TournamentEvent,
    submitted: Sequence[PoolUpsert],
) -> None:
    """Make ``event``'s stage-0 pools equal ``submitted``, as an **id-keyed diff**.

    ``tournament`` is the event's own parent, and it is here for the reservations: it
    supplies the catalogue each pool's ``table_ids`` are resolved against and the
    ``tournament_id`` their rows carry (:func:`_reservations`).

    Resolves the event's stage 0 with an explicit query — **never** through
    ``TournamentEvent.stages`` (deliberately not eager; an async lazy load there would
    raise), the same discipline
    ``app.tournament_event_stages.remint_stages_in_place`` follows for the same reason.
    ``scalar_one()``, not ``scalar_one_or_none()``: every event holds at least one stage
    from the moment it exists (ADR 20260815 decision 1), so a miss here means the event
    was seeded straight through the ORM bypassing ``create_event`` — a test-fixture bug,
    not a state this function is asked to tolerate.

    Each entry either cites the ``id`` of a pool the stage already has — which keeps
    that row, re-named, re-timed, re-tabled and re-positioned as this payload says — or
    omits one, which adds a row the database mints an id for. A stored pool no entry
    cites is **removed**, by leaving it out of the reassigned collection, which
    ``delete-orphan`` turns into a ``DELETE``.

    **Keying on the id is not an optimization, it is the only correct mechanism.** A
    fixture holds its pool's id (and, since ADR 20260801, holds it as a foreign key), so
    a delete-and-recreate of the row a standing draw points at would take the draw with
    it or be refused outright. The JSONB column this replaces could be reassigned
    wholesale precisely because nothing pointed into it.

    Two refusals, and they are asked in two different places:

    * an entry citing an id this **event** does not have →
      :class:`~app.tournament_errors.PoolNotInEventError` (a 422 on that entry's
      ``id``), judged here and before anything is written. Until the ids were minted
      this arm was an *addition*: the id was the client's, so one the server had never
      seen still named the pool the client meant. It is the server's now, so an id it
      did not mint names nothing — and quietly minting a fresh one would hand the client
      back a different id than it asked for while *removing* the pool it meant to keep.
      It is the same 422 :func:`~app.tournament_tables.apply_table_catalogue` answers an
      unknown table id with, for the same reason and now with the same justification.
    * a payload that would add or remove a pool of an event whose draw is **cut** →
      ``_enforce_pool_set_frozen`` (``app.tournament_events``), which runs *before* this
      function, so the 409 wins over the 422 whenever both apply. With no draw, any diff
      is legal.

    Reassigning the whole collection is what expresses all three operations at once, in
    the payload's order — the same gesture ``apply_table_catalogue`` makes, and the
    reason both tables carry a DEFERRABLE ``UNIQUE (…, position)``: a reorder moves a
    row onto a position its neighbour has not vacated yet.
    """
    # ``.options(selectinload(...))`` here, rather than a default eager strategy on the
    # relationship itself: ``TournamentEventStage.pools`` is deliberately NOT eager
    # (see that relationship's docstring — an event-wide default would double-load
    # against ``TournamentEvent.pools``'s own selectin), so this one direct reader asks
    # for exactly the load it needs.
    stage = (
        await db.execute(
            select(TournamentEventStage)
            .options(selectinload(TournamentEventStage.pools))
            .where(
                TournamentEventStage.event_id == event.id,
                TournamentEventStage.position == 0,
            )
        )
    ).scalar_one()
    stored = {pool.id: pool for pool in stage.pools}
    # Judged first, over the whole payload, for the reason the catalogue's twin is: a
    # pool list naming a pool this event does not have is not a pool list, and every
    # subsequent question (what is kept, and therefore what is removed) would be
    # answered against a list the client did not mean. Named by index so the refusal
    # lands on the entry that caused it.
    for index, entry in enumerate(submitted):
        if entry.id is not None and entry.id not in stored:
            raise PoolNotInEventError(index=index, pool_id=str(entry.id))
    stage.pools = [
        _pool_for(event, tournament, stored, entry, position)
        for position, entry in enumerate(submitted)
    ]


def _pool_for(
    event: TournamentEvent,
    tournament: Tournament,
    stored: dict[uuid.UUID, TournamentEventPool],
    entry: PoolUpsert,
    position: int,
) -> TournamentEventPool:
    """The row one submitted pool resolves to: the cited pool, updated in place, or a
    brand-new one.

    ``position`` is the entry's index in the submitted list and is assigned on both
    arms, so a patch that re-orders the pools re-orders them (and one that re-sends them
    unchanged writes the positions they already had).

    ``stored[entry.id]`` cannot miss — every cited id was checked against ``stored``
    before this runs, so this is an indexing operation rather than a second lookup with
    a second opinion about what an unknown id means.
    """
    if entry.id is None:
        return _new_pool(event, tournament, entry, position)
    row = stored[entry.id]
    row.name = entry.name
    row.position = position
    row.slot_date, row.slot_start, row.slot_end = _slot_columns(entry.slot)
    # The reservations are a diff of their own, one level down: a table this pool
    # already reserves keeps its row (re-positioned), a new one is added, and a stored
    # one this payload leaves out becomes an orphan the relationship's ``delete-orphan``
    # deletes. Assigning fresh rows for the whole list instead would delete and
    # re-insert the same primary keys in one flush.
    row.tables = _reservations(event, tournament, entry.table_ids, row.tables)
    return row
