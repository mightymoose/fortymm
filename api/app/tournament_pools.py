"""The one place an event's groups and reservations are written, and the seam their
wire shape crosses.

What the wire calls a **pool** is two rows here. A
:class:`~app.models.tournament_event_stage_group.TournamentEventStageGroup` is an
ordered set of entrants who play all-play-all, parented on a stage; a
:class:`~app.models.tournament_event_reservation.TournamentEventReservation` is a set of
tables held for a window of time, parented on the event; and a
:class:`~app.models.tournament_event_group_reservation.TournamentEventGroupReservation`
maps one to the other. This module is where the two are written together and read back
as one, so **the split is invisible above this line** — ``event.pools`` on the wire is
exactly what it was, and so is ``fixture.pool_id``.

Four things live here and nowhere else.

**The projection.** :func:`pool_read` is the join, in the read direction: a ``Pool``'s
``id`` and ``position`` come from the group, and its ``name``, ``slot`` and
``table_ids`` come from the group's mapped reservation. Every pool identifier the API
serves is therefore a **group** id — ``pools[].id``, ``fixture.pool_id`` and
``PoolStandingsRead.pool_id`` alike — and a reservation's own id never reaches a client.

**The 1:1.** A pool write creates, updates and removes a group *and* its reservation
together, on every path, so the two sets stay in lockstep. Nothing enforces that in the
database — the join deliberately carries no uniqueness on its reservation column,
because a later change lets two groups share one reservation — so it is this module's
invariant to keep. Break it and ``fixture.pool_id`` names a group id ``pools[].id`` does
not hold: the client's own id-set join buckets nothing and every pool card renders
empty.

**The position.** :func:`stored_pools` and :func:`apply_event_pools` stamp each entry
with its index in the list the client sent — the only place a ``position`` is ever
assigned, on either row. The group's is what the wire reports and what the snake seeds
against; the reservation's exists so a reservation set has a stable read order of its
own, and equals the group's under the lockstep above.

**The Slot⇄columns conversion.** A reservation's window is three wall-clock columns
(``slot_date``, ``slot_start``, ``slot_end``) and one wire value-object
(:class:`~app.schemas.tournament.Slot`, ``YYYY-MM-DD`` + ``HH:MM``). The strings are
parsed on the way in and composed on the way out, here, so no reader holds an unparsed
date and no writer invents a second spelling of one.

**The tables.** A reservation's ``table_ids`` are rows
(:class:`~app.models.tournament_event_reservation_table.TournamentEventReservationTable`,
ADR 20260801 "the tournament-scoping stops at the join table"), and the wire array is
composed from them in ``position`` order. :func:`_reservation_tables` is where the array
becomes rows, and it is the one place such a row's ``tournament_id`` is written, which
is why both write verbs take the parent tournament: the denormalized column is what the
composite foreign keys underneath compare, and a row composed without it is not one
Postgres will accept. Each row's ``event_id`` is populated through the ``event``
relationship rather than a literal — the event's own id does not exist yet on the create
path, so the unit of work has to fill it in after the event's INSERT returns.

**The id.** A group's id is a uuid the **database** mints, so nothing here assigns one
on the create path and the create shape has no field for one. On the edit path a client
*cites* an id it was given, and citing one this event does not have is refused rather
than silently minted — the same split, and the same 422, ``app.tournament_tables``
already makes for the venue catalogue.

The edit path is an **id-keyed diff** and not a wholesale replace, which is a change of
mechanism and not of meaning: re-sending a pool the event already has must UPDATE that
group, or the write would delete and recreate the row every fixture in the event points
at.

**The stage.** A group's parent is its stage (ADR 20260815, "Sequencing with #1338") —
always the event's stage 0 (decision 3). ``TournamentEvent.groups`` is a *readable*
association through stage 0, but writing means resolving the actual stage row and
assigning ``stage.groups``. On the create path the stage is a fresh, unflushed object
the caller already built (``app.tournament_events.create_event`` passes it straight
through); on the edit path :func:`apply_event_pools` resolves it itself, with an
explicit query, the same way ``app.tournament_event_stages.remint_stages_in_place`` does
— not because ``TournamentEvent.stages`` is unavailable (it is eager and would already
be populated) but because ``stage.groups`` is deliberately NOT eager, so this function
needs its own query to attach the ``selectinload``. That query is why
:func:`apply_event_pools` takes a session, which is the one exception to the claim
below.

It otherwise imports the models, the schemas and the domain-error leaf, and nothing else
— no router, no FastAPI — so :func:`stored_pools` stays callable from a REPL and
cycle-free."""

import uuid
from collections.abc import Sequence
from datetime import date, time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import (
    Tournament,
    TournamentEvent,
    TournamentEventGroupReservation,
    TournamentEventReservation,
    TournamentEventReservationTable,
    TournamentEventStage,
    TournamentEventStageGroup,
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


def _slot_read(reservation: TournamentEventReservation) -> Slot:
    """The wire :class:`Slot` a stored reservation's three columns compose back into.

    ``%H:%M`` exactly, with no seconds, because that is the shape the boundary accepts
    and therefore the only shape a stored value can have had (:data:`PoolSlot` refuses a
    time carrying seconds rather than storing one it would later have to truncate). The
    round trip is lossless: what a client sends is what it reads back, character for
    character.
    """
    return Slot(
        date=reservation.slot_date.isoformat(),
        start=reservation.slot_start.strftime("%H:%M"),
        end=reservation.slot_end.strftime("%H:%M"),
    )


def pool_read(group: TournamentEventStageGroup) -> Pool:
    """One stored group, projected with its reservation, as the shape everything above
    the database reads (:class:`~app.schemas.tournament.Pool`).

    **This is the join that keeps the wire still.** The row that used to answer all five
    fields is two rows now, and this is where they are put back together:

    ==================  ===========================================
    ``id``              the **group**
    ``position``        the **group**
    ``name``            the group's mapped **reservation**
    ``slot``            the group's mapped **reservation**
    ``table_ids``       the group's mapped **reservation**
    ==================  ===========================================

    The ``id`` half is the load-bearing one. A fixture's ``pool_id`` is a group id, so
    the id this projects must be the group's too, or the client's own join of
    ``fixture.pool_id`` against the ``pools[]`` id set matches nothing and every pool
    card renders empty. That is a failure no type check can see and no regen can catch,
    which is why it is stated here rather than left to follow from the field order.

    ``group.reservation`` is total in this slice: every write path in this module
    writes a group and a reservation together, so a group with no mapping is a state
    nothing can produce.
    """
    reservation = group.reservation
    return Pool(
        id=group.id,
        name=reservation.name,
        slot=_slot_read(reservation),
        table_ids=[row.table_id for row in reservation.tables],
        position=group.position,
    )


def _reservation_tables(
    event: TournamentEvent,
    tournament: Tournament,
    submitted: Sequence[str],
    stored: Sequence[TournamentEventReservationTable] = (),
) -> list[TournamentEventReservationTable]:
    """The rows one reservation's submitted ``table_ids`` resolve to, keyed on the table
    id against whatever ``stored`` rows the reservation already has.

    ``event`` is threaded through purely so each fresh row can be given ``event=event``
    — the row's ``event_id`` is populated by the unit of work through that relationship,
    not as a literal, because on the create path the event does not have an id yet (see
    the module docstring's "The tables").

    Keyed rather than replaced wholesale for a mechanical reason as well as a tidy one:
    a row's identity IS ``(event, reservation, table)``, so re-sending a table the
    reservation already holds and letting the collection be rebuilt would ask the unit
    of work to INSERT a primary key it is about to DELETE — and it emits the inserts
    first. Keeping the row and moving its ``position`` is the same end state with no
    such window.

    **A table the tournament's catalogue does not hold is dropped, silently**, which is
    this module's one judgement call and is the ADR's "quiet" half said at write time. A
    reservation is a *preference* — the loud refusal is reserved for a placement — and a
    preference naming a table that does not exist is not a preference the schema can
    hold at all now that it is a foreign key. Nothing observable moves: every reader
    already intersected ``table_ids`` with the catalogue (the solver's
    ``_load_solver_inputs``, the preview's snapshot), because a JSONB string could name
    anything; this puts that intersection at the boundary where it belongs instead of
    repeating it at each read. The same rule covers the cross-tournament id the
    composite foreign keys exist to refuse — the app cannot construct the row, and the
    database would not accept it if it did.

    Duplicates collapse (``dict.fromkeys``, order-preserving) for the same reason: the
    primary key says a reservation holds a table at most once, and a payload that names
    one twice means what it says once.
    """
    catalogue = {str(table.id) for table in tournament.tables}
    kept = {row.table_id: row for row in stored}
    rows: list[TournamentEventReservationTable] = []
    for table_id in dict.fromkeys(submitted):
        if table_id not in catalogue:
            continue
        row = kept.get(table_id)
        if row is None:
            row = TournamentEventReservationTable(
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
) -> list[TournamentEventStageGroup]:
    """Fresh group rows — each already mapped to its own fresh reservation — for an
    event that has none yet, which is the create verb's whole job.

    Returns the **groups**, and the reservations ride along inside them: each group
    carries a ``reservation_link`` holding a brand-new reservation whose ``event`` is
    this event, so attaching the groups to a stage attaches the whole graph. The caller
    does not have to know the shape — ``app.tournament_events.create_event`` assigns the
    result to the event's stage 0 and the unit of work writes all four tables in
    dependency order.

    Each row is stamped with the ``position`` of its index in ``submitted``: the only
    place a position is assigned on the create path, and what makes the stored positions
    ``range(len(submitted))`` by construction rather than by a caller's care.

    ``event`` is the fresh, unflushed event these belong to; ``tournament`` supplies
    both the catalogue each ``table_ids`` entry is resolved against and the
    ``tournament_id`` every reservation-table row carries (:func:`_reservation_tables`).

    No ``id`` is set on either row: that is the database's, exactly as a venue table's
    is (:func:`app.tournament_tables.stored_tables`), and the point of the ADR is that
    it is not the client's to author — the create shape (:class:`PoolWrite`) has no
    field for one.
    """
    return [
        _new_group(event, tournament, pool, position)
        for position, pool in enumerate(submitted)
    ]


def _new_group(
    event: TournamentEvent, tournament: Tournament, submitted: PoolWrite, position: int
) -> TournamentEventStageGroup:
    """One brand-new group at ``position``, mapped to one brand-new reservation, from
    the pool a client sent — with no ``id`` on either, which the database mints.

    The two are created together and can only be created together: this is the single
    place the create path can produce a group at all, so "every group has a reservation"
    holds by construction rather than by inspection.
    """
    slot_date, slot_start, slot_end = _slot_columns(submitted.slot)
    reservation = TournamentEventReservation(
        name=submitted.name,
        position=position,
        slot_date=slot_date,
        slot_start=slot_start,
        slot_end=slot_end,
        event=event,
        tables=_reservation_tables(event, tournament, submitted.table_ids),
    )
    return TournamentEventStageGroup(
        position=position,
        reservation_link=TournamentEventGroupReservation(reservation=reservation),
    )


async def apply_event_pools(
    db: AsyncSession,
    tournament: Tournament,
    event: TournamentEvent,
    submitted: Sequence[PoolUpsert],
) -> None:
    """Make ``event``'s stage-0 groups and its reservations equal ``submitted``, as an
    **id-keyed diff** over both at once.

    ``tournament`` is the event's own parent, and it is here for the reservation tables:
    it supplies the catalogue each ``table_ids`` is resolved against and the
    ``tournament_id`` their rows carry (:func:`_reservation_tables`).

    **Both collections are reassigned, and that is the 1:1.** ``stage.groups`` and
    ``event.reservations`` are written from the same pass over the same payload, in the
    same order, so an entry adds a group *and* a reservation, an entry citing an id
    updates both, and an entry that disappears removes both — the second by
    ``delete-orphan`` on each collection, which also takes the join row with the group.
    Writing only one of the two would leave ``fixture.pool_id`` naming a group the
    projected ``pools[]`` no longer holds, which nothing downstream is loud enough to
    notice (see the module docstring's "The 1:1").

    Resolves the event's stage 0 with an explicit query, the same discipline
    ``app.tournament_event_stages.remint_stages_in_place`` follows. Not because
    ``TournamentEvent.stages`` would fail — it is eager (``lazy="selectin"``) and would
    already be populated on ``event`` — but because ``TournamentEventStage.groups`` is
    the one that is deliberately NOT eager, so this still needs its own query to attach
    the ``selectinload`` that loads it. The ``reservation_link`` and its ``reservation``
    are chained onto that load, because the update arm re-times and re-tables the
    reservation each kept group already has.
    ``scalar_one()``, not ``scalar_one_or_none()``: every event holds at least one stage
    from the moment it exists (ADR 20260815 decision 1), so a miss here means the event
    was seeded straight through the ORM bypassing ``create_event`` — a test-fixture bug,
    not a state this function is asked to tolerate.

    Each entry either cites the ``id`` of a group the stage already has — which keeps
    that row and its reservation, re-named, re-timed, re-tabled and re-positioned as
    this payload says — or omits one, which adds a pair the database mints ids for.

    **Keying on the id is not an optimization, it is the only correct mechanism.** A
    fixture holds its group's id as a foreign key, so a delete-and-recreate of the row a
    standing draw points at would take the draw with it or be refused outright.

    Two refusals, and they are asked in two different places:

    * an entry citing an id this **event** does not have →
      :class:`~app.tournament_errors.PoolNotInEventError` (a 422 on that entry's
      ``id``), judged here and before anything is written. The id is the server's, so
      one it did not mint names nothing — and quietly minting a fresh one would hand the
      client back a different id than it asked for while *removing* the pool it meant to
      keep. It is the same 422 :func:`~app.tournament_tables.apply_table_catalogue`
      answers an unknown table id with, for the same reason.
    * a payload that would add or remove a pool of an event whose draw is **cut** →
      ``_enforce_group_set_frozen`` (``app.tournament_events``), which runs *before*
      this function, so the 409 wins over the 422 whenever both apply. With no draw, any
      diff is legal.

    Reassigning whole collections is what expresses all three operations at once, in the
    payload's order — the same gesture ``apply_table_catalogue`` makes, and the reason
    every ``position`` constraint involved is DEFERRABLE: a reorder moves a row onto a
    position its neighbour has not vacated yet.
    """
    # ``.options(selectinload(...))`` here, rather than a default eager strategy on the
    # relationship itself: ``TournamentEventStage.groups`` is deliberately NOT eager (an
    # event-wide default would double-load against ``TournamentEvent.groups``'s own
    # selectin), so this one direct reader asks for exactly the load it needs — the
    # groups, their join rows, and the reservations those name, because the update arm
    # writes through all three.
    stage = (
        await db.execute(
            select(TournamentEventStage)
            # ONE option, not a chain down to the tables. Everything below ``groups`` is
            # already eager on its own model — ``reservation_link`` and ``reservation``
            # as ``joined`` (one-to-one and many-to-one, so they ride this query's own
            # SELECT), and ``tables`` as ``selectin``. Spelling the tail out here would
            # not add loads, it would REPLACE them: an explicit loader option overrides
            # the mapper's default for that path, so chaining ``selectinload`` over the
            # two joined legs turns each into its own round trip — five statements where
            # two do, and precisely the joins those models argue for.
            .options(selectinload(TournamentEventStage.groups))
            .where(
                TournamentEventStage.event_id == event.id,
                TournamentEventStage.position == 0,
            )
        )
    ).scalar_one()
    # ``TournamentEvent.reservations`` is deliberately NOT eager (see that
    # relationship's docstring: no reader needs it, and eager it would cost every page
    # a statement it never reads). This is its one writer, so it loads it here.
    #
    # It has to be loaded BEFORE the assignment below: assigning to an unloaded
    # ``delete-orphan`` collection makes the unit of work emit a lazy load
    # mid-assignment, to work out what is being orphaned — which under async raises
    # ``MissingGreenlet`` rather than querying.
    #
    # ``awaitable_attrs`` is the sanctioned spelling for exactly that (``AsyncAttrs`` on
    # ``app.db.Base``): it loads the one relationship, on the object already in hand. A
    # throwaway ``select(TournamentEvent)`` carrying a loader option does the same job
    # for two statements instead of one, and re-reads a row the session already holds.
    await event.awaitable_attrs.reservations
    stored = {group.id: group for group in stage.groups}
    # Judged first, over the whole payload, for the reason the catalogue's twin is: a
    # pool list naming a pool this event does not have is not a pool list, and every
    # subsequent question (what is kept, and therefore what is removed) would be
    # answered against a list the client did not mean. Named by index so the refusal
    # lands on the entry that caused it.
    for index, entry in enumerate(submitted):
        if entry.id is not None and entry.id not in stored:
            raise PoolNotInEventError(index=index, pool_id=str(entry.id))
    groups = [
        _group_for(event, tournament, stored, entry, position)
        for position, entry in enumerate(submitted)
    ]
    # Assigned in lockstep, from the one list, so the two collections cannot disagree
    # about which pools this event has. The reservations are read back off the groups
    # rather than accumulated separately, which makes "the reservation set IS the mapped
    # set" true by construction instead of by a parallel append nobody would notice
    # drifting.
    stage.groups = groups
    event.reservations = [group.reservation for group in groups]


def _group_for(
    event: TournamentEvent,
    tournament: Tournament,
    stored: dict[uuid.UUID, TournamentEventStageGroup],
    entry: PoolUpsert,
    position: int,
) -> TournamentEventStageGroup:
    """The group one submitted pool resolves to — the cited group with its reservation
    updated in place, or a brand-new pair.

    ``position`` is the entry's index in the submitted list and is assigned on both arms
    and to both rows, so a patch that re-orders the pools re-orders them (and one that
    re-sends them unchanged writes the positions they already had).

    ``stored[entry.id]`` cannot miss — every cited id was checked against ``stored``
    before this runs, so this is an indexing operation rather than a second lookup with
    a second opinion about what an unknown id means.

    The update arm writes the **reservation's** name, window and tables and the
    **group's** position, which is exactly the split the projection reads back: identity
    and order on the group, everything a director can edit mid-event on the reservation.
    """
    if entry.id is None:
        return _new_group(event, tournament, entry, position)
    group = stored[entry.id]
    group.position = position
    reservation = group.reservation
    reservation.name = entry.name
    reservation.position = position
    reservation.slot_date, reservation.slot_start, reservation.slot_end = _slot_columns(
        entry.slot
    )
    # The tables are a diff of their own, one level down: a table this reservation
    # already holds keeps its row (re-positioned), a new one is added, and a stored one
    # this payload leaves out becomes an orphan the relationship's ``delete-orphan``
    # deletes. Assigning fresh rows for the whole list instead would delete and
    # re-insert the same primary keys in one flush.
    reservation.tables = _reservation_tables(
        event, tournament, entry.table_ids, reservation.tables
    )
    return group
