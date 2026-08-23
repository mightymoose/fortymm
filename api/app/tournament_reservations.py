"""The one place an event's groups and reservations are written, and the seam their
wire shape crosses.

The wire carries two arrays now: ``groups`` (server-owned, read-only) and
``reservations`` (the one a client writes). A
:class:`~app.models.tournament_event_stage_group.TournamentEventStageGroup` is an
ordered set of entrants who play all-play-all, parented on a stage; a
:class:`~app.models.tournament_event_reservation.TournamentEventReservation` is a set of
tables held for a window of time, parented on the event; and a
:class:`~app.models.tournament_event_group_reservation.TournamentEventGroupReservation`
maps one to the other.

Four things live here and nowhere else.

**The projection.** :func:`group_read` and :func:`reservation_read` are the two reads:
a group's own ``id``, ``position`` and ``reservation_id``; a reservation's own ``id``,
``position``, ``name``, ``slot`` and ``table_ids``. Slice 1's single joined reservation
projection is gone — the wire no longer hides which row an id belongs to.

**The materialisation** (#1387, ADR 20260822, #1484, ADR 20260823). The server owns an
event's group rows. :func:`materialise_event_groups` makes **every stage's** group row
count equal :func:`group_count_for`'s answer on every event write — the count is a
property of the stage template (:func:`app.tournament_event_stages.stage_template`),
not of a reservation count: an ``rr-then-ko`` event's group stage derives its count
from #1386's derivation against the field it is handed (the preview field on an event
write, the real registered field at the cut), and every other stage — a standalone
event's only stage, and an ``rr-then-ko`` event's knockout stage — holds exactly one,
always. Each group maps to the reservation at ``position % reservation count``, or to
none when the event has no reservation. A group count creates no reservation. Nothing
calls it once a draw exists: the cut re-derives once against the real field and the
identities and the mapping freeze there.

**The position.** :func:`stored_reservations`, :func:`apply_event_reservations` and
:func:`materialise_event_groups` stamp each row with its index — the reservation's
from the list the client sent, the group's from ``range(count)`` — the only place a
``position`` is ever assigned, on either row. The reservation's is what the wire
reports for ``reservations[]``; the group's is what the snake seeds against and what
its label derives from.

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

**The id.** A reservation's id is a uuid the **database** mints, so nothing here
assigns one on the create path and the create shape has no field for one. On the edit
path a client *cites* an id it was given, and citing one this event does not have is
refused rather than silently minted — the same split, and the same 422,
``app.tournament_tables`` already makes for the venue catalogue.

Both edit paths are **id-keyed diffs** and not wholesale replaces, which is a change
of mechanism and not of meaning: re-sending a reservation the event already has must
UPDATE that reservation, and re-materialising a count the event already holds must keep
every group row, or the write would delete and recreate the rows every fixture in the
event points at.

**The stage.** A group's parent is its stage (ADR 20260815, "Sequencing with #1338") —
**every** stage an event holds, not only stage 0 (#1484, ADR 20260823 amends decision
3's "always the event's stage 0"). ``TournamentEvent.groups`` is a *readable*
association across every one of an event's stages, but writing means resolving the
actual stage row and assigning ``stage.groups``. On the create path the stage is a
fresh, unflushed object the caller already built (``app.tournament_events.create_event``
hands each of them to :func:`materialise_groups`); on the edit path
:func:`materialise_event_groups` resolves every stage itself, with an explicit query,
the same way ``app.tournament_event_stages.remint_stages_in_place`` does — not because
``TournamentEvent.stages`` is unavailable (it is eager and would already be populated)
but because ``stage.groups`` is deliberately NOT eager, so this function needs its own
query to attach the ``selectinload``. That query is why it takes a session.

It otherwise imports the models, the schemas, the pure derivation and the domain-error
leaf, and nothing else — no router, no FastAPI — so :func:`materialise_groups` stays
callable from a REPL and cycle-free."""

import uuid
from collections.abc import Sequence
from datetime import date, time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.draw_structure import (
    DrawStructureOptions,
    SettingOwnership,
    derive_draw_structure,
)
from app.models import (
    DrawType,
    Tournament,
    TournamentEvent,
    TournamentEventGroupReservation,
    TournamentEventReservation,
    TournamentEventReservationTable,
    TournamentEventStage,
    TournamentEventStageGroup,
)
from app.schemas.tournament import (
    GroupRead,
    Reservation,
    ReservationUpsert,
    ReservationWrite,
    Slot,
)
from app.tournament_draw_settings import draw_settings_of
from app.tournament_errors import ReservationNotInEventError
from app.tournament_event_stages import GroupCountSource, stage_template

__all__ = [
    "apply_event_reservations",
    "group_count_for",
    "group_read",
    "materialise_event_groups",
    "materialise_groups",
    "materialise_stage_groups",
    "ordered_reservations",
    "reservation_read",
    "stored_reservations",
]


def _slot_columns(slot: Slot) -> tuple[date, time, time]:
    """The three stored columns one wire :class:`Slot` becomes.

    ``fromisoformat`` and not a hand-rolled ``strptime``: it is the parser the rest of
    this codebase already reads dates with (``app.schedule_preview_solve``), and the
    boundary has already refused anything it would choke on
    (:data:`~app.schemas.tournament.WellFormedSlot`) — so this is a total function of
    what can reach it, not a parse that needs a failure branch.
    """
    return (
        date.fromisoformat(slot.date),
        time.fromisoformat(slot.start),
        time.fromisoformat(slot.end),
    )


def _slot_read(reservation: TournamentEventReservation) -> Slot:
    """The wire :class:`Slot` a stored reservation's three columns compose back into.

    ``%H:%M`` exactly, with no seconds, because that is the shape the boundary accepts
    and therefore the only shape a stored value can have had (:data:`WellFormedSlot
    <app.schemas.tournament.WellFormedSlot>` refuses a time carrying seconds rather
    than storing one it would later have to truncate). The round trip is lossless:
    what a client sends is what it reads back, character for character.
    """
    return Slot(
        date=reservation.slot_date.isoformat(),
        start=reservation.slot_start.strftime("%H:%M"),
        end=reservation.slot_end.strftime("%H:%M"),
    )


def group_read(group: TournamentEventStageGroup) -> GroupRead:
    """One stored group, projected as the shape everything above the database reads
    (:class:`~app.schemas.tournament.GroupRead`).

    ``id`` and ``position`` come straight off the row, and so does ``stage_id`` (#1484)
    — the field that lets a reader tell a knockout stage's group apart from its
    group-stage siblings once ``TournamentEvent.groups`` stops pinning to stage 0:
    ``position`` alone is no longer unique across an event's groups (a knockout stage's
    sole group and its event's first pool group both stand at ``position: 0``), so
    ``stage_id`` is what every filter that labels, ranks, deals or panels a group
    disambiguates on. ``reservation_id`` is read through the join
    (``group.reservation_link.reservation_id``) rather than through the loaded
    ``reservation`` object, so this needs no eager load of the reservation itself when
    a caller only wants the id — and it is ``None`` for a group with no join row, which
    is how a group that plays in no reservation reaches the wire (#1387).
    """
    link = group.reservation_link
    return GroupRead(
        id=group.id,
        position=group.position,
        stage_id=group.stage_id,
        reservation_id=link.reservation_id if link is not None else None,
    )


def reservation_read(reservation: TournamentEventReservation) -> Reservation:
    """One stored reservation, projected as the shape everything above the database
    reads (:class:`~app.schemas.tournament.Reservation`).

    ``id`` and ``position`` come straight off the row. ``name``, ``slot`` and
    ``table_ids`` compose from the reservation's own columns and its mapped
    :class:`~app.models.tournament_event_reservation_table.TournamentEventReservationTable`
    rows, in ``position`` order.
    """
    return Reservation(
        id=reservation.id,
        name=reservation.name,
        slot=_slot_read(reservation),
        table_ids=[row.table_id for row in reservation.tables],
        position=reservation.position,
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


def stored_reservations(
    event: TournamentEvent,
    tournament: Tournament,
    submitted: Sequence[ReservationWrite],
) -> list[TournamentEventReservation]:
    """Fresh reservation rows for an event that has none yet, which is the create
    verb's reservation half (its group half is :func:`materialise_groups`).

    Each row is stamped with the ``position`` of its index in ``submitted``: the only
    place a reservation's position is assigned on the create path, and what makes the
    stored positions ``range(len(submitted))`` by construction rather than by a
    caller's care. Each row's ``event`` is set to the fresh, unflushed ``event``, which
    populates its ``event_id`` at flush.

    ``tournament`` supplies both the catalogue each ``table_ids`` entry is resolved
    against and the ``tournament_id`` every reservation-table row carries
    (:func:`_reservation_tables`).

    No ``id`` is set: that is the database's, exactly as a venue table's is
    (:func:`app.tournament_tables.stored_tables`), and the point of the ADR is that it
    is not the client's to author — the create shape (:class:`ReservationWrite`) has no
    field for one.
    """
    return [
        _new_reservation(event, tournament, reservation, position)
        for position, reservation in enumerate(submitted)
    ]


def _new_reservation(
    event: TournamentEvent,
    tournament: Tournament,
    submitted: ReservationWrite,
    position: int,
) -> TournamentEventReservation:
    """One brand-new reservation at ``position``, from the reservation a client sent —
    with no ``id``, which the database mints."""
    slot_date, slot_start, slot_end = _slot_columns(submitted.slot)
    return TournamentEventReservation(
        name=submitted.name,
        position=position,
        slot_date=slot_date,
        slot_start=slot_start,
        slot_end=slot_end,
        event=event,
        tables=_reservation_tables(event, tournament, submitted.table_ids),
    )


def ordered_reservations(
    event: TournamentEvent,
) -> list[TournamentEventReservation]:
    """The event's reservations in ``position`` order — the one definition of "the
    event's reservation order", which is what a group's ``position % reservation
    count`` mapping, the wire's ``reservations[]`` and the freeze's order comparison
    all read (#1387). The twin of ``app.tournament_draws._ordered_groups``.

    Sorted explicitly rather than trusted to the relationship's own ``order_by``: that
    ordering is a property of a load, and a caller that built the event in memory (the
    create path) or just reassigned the collection (the reservations diff) holds the
    list in whatever order it was given.
    """
    return sorted(event.reservations, key=lambda row: row.position)


def group_count_for(source: GroupCountSource, *, field_size: int) -> int:
    """How many group rows a stage whose count comes from ``source`` holds (#1387,
    #1484, ADR 20260822).

    **Two rules, stated rather than hidden.** A :data:`~app.tournament_event_stages
    .GroupCountSource.structural` stage — today, only an ``rr-then-ko`` event's group
    stage — derives its count from the field through #1386's derivation, with every
    structural setting automatic (``ceil(field / 5)``, at least one). A
    :data:`~app.tournament_event_stages.GroupCountSource.one` stage — every other
    stage any template mints, including an ``rr-then-ko`` event's own knockout stage
    — always holds exactly one, whatever the field or the event's reservation count.
    Whether ``round-robin`` should run groups of five is a product question about
    that draw type, not a materialisation one (#1387 decision 2).

    **The floor is what lets every stage hold a group.** A fixture reaches the
    reservation that restricts it through its group
    (``app.schedule_solves.restricting_reservation_key``), so a stage with no group
    row has no hop to make and its fixtures fall to the synthetic event-wide
    reservation — the whole venue, the whole day. A single-elim or swiss event
    booking one reservation therefore had its bracket placed across the tournament's
    entire table catalogue until the group existed to carry the restriction. At least
    one group, always, is what closes that. The zero-reservation case is unchanged in
    outcome and not refused: the group exists, maps to no reservation, and its
    fixtures still fall to the event-wide one until #1364 mints a real reservation
    for them.

    **This function never compares a draw type**, ``rr_then_ko`` or otherwise — the
    caller (:func:`stage_template`, via :func:`materialise_stage_groups`) has already
    resolved which source a stage's count comes from, and that resolution is what
    tells apart an ``rr-then-ko`` event's stage 0 from a standalone ``round-robin``
    event's only stage: both are a ``round_robin`` *component*, but the template says
    ``structural`` for one and ``one`` for the other (#1484 decision 1).

    ``field_size`` is the **caller's** question — the preview field (the cap, or 16)
    on an event write, the real registered field at the cut — and this function only
    takes the number. This module writes no arithmetic of its own: the count is the
    derivation's, called with whichever field the caller holds.
    """
    if source is GroupCountSource.one:
        return 1
    return derive_draw_structure(
        DrawStructureOptions(
            preview_field_size=field_size,
            group_count_mode=SettingOwnership.automatic,
            manual_group_count=None,
            group_size_mode=SettingOwnership.automatic,
            manual_group_size=None,
            qualifiers_mode=SettingOwnership.automatic,
            manual_qualifiers=None,
        )
    ).group_count


def materialise_groups(
    stage: TournamentEventStage,
    reservations: Sequence[TournamentEventReservation],
    *,
    group_count_source: GroupCountSource,
    field_size: int,
) -> None:
    """Make ``stage``'s groups exactly the rows :func:`group_count_for` says
    ``group_count_source`` holds against ``field_size``, at positions ``0..count-1``,
    each mapped to ``reservations[position % len(reservations)]`` — or to nothing when
    the event has no reservation — as an **id-keyed diff** over the rows the stage
    holds.

    **This is the whole per-stage materialisation policy, in one place.** Which count,
    which field, which mapping: :func:`materialise_stage_groups` — the create path's
    in-memory door and :func:`materialise_event_groups`'s queried door both come
    through it — calls this once per stage of the event's template, so a create and a
    patch cannot drift on any of the event's stages, not only its first.
    ``reservations`` is taken in the order given, which is why the session doors hand
    it :func:`ordered_reservations`.

    Pure over loaded objects: no session.

    **Which rows survive a shrink is named, not incidental.** Going from eight groups
    to two keeps positions 0 and 1 and drops the tail, so the surviving mapping and
    the ``Group A`` / ``Group B`` labels agree with what the 409 and the draw panel
    report. A grow appends fresh rows after the highest kept position; nothing is
    re-positioned, so a kept group's ``id`` — the one its fixtures name — never moves.

    **The join row is diffed in place, never replaced.** Its primary key is the group's
    id, so assigning a fresh ``TournamentEventGroupReservation`` to a group that already
    has one would ask the unit of work to INSERT a primary key it is about to DELETE —
    and it emits the inserts first. A kept group whose target reservation changed has
    its existing row re-pointed (an UPDATE); one whose target vanished has the row
    orphaned (``delete-orphan`` on ``reservation_link``, a DELETE); one whose target is
    unchanged is not touched at all.
    """
    count = group_count_for(group_count_source, field_size=field_size)
    kept = sorted(stage.groups, key=lambda group: group.position)[:count]
    groups: list[TournamentEventStageGroup] = []
    for position in range(count):
        target = reservations[position % len(reservations)] if reservations else None
        if position < len(kept):
            group = kept[position]
            group.position = position
            link = group.reservation_link
            if target is None:
                group.reservation_link = None
            elif link is None:
                group.reservation_link = TournamentEventGroupReservation(
                    reservation=target
                )
            elif link.reservation is not target:
                link.reservation = target
        else:
            group = TournamentEventStageGroup(
                position=position,
                reservation_link=(
                    TournamentEventGroupReservation(reservation=target)
                    if target is not None
                    else None
                ),
            )
        groups.append(group)
    stage.groups = groups


def materialise_stage_groups(
    stages: Sequence[TournamentEventStage],
    reservations: Sequence[TournamentEventReservation],
    *,
    draw_type: DrawType,
    field_size: int,
) -> None:
    """Materialise every one of ``draw_type``'s template stages' groups, in one pass
    (#1484) — the shared core ``app.tournament_events.create_event``'s in-memory door
    (the stages are freshly minted and unflushed, with no id yet to query by) and
    :func:`materialise_event_groups`'s queried door both run through, so the two paths
    cannot drift on which stage gets which count source.

    ``stages`` must be exactly ``draw_type``'s template, whatever order it arrives in
    — sorted here by ``position`` before being zipped, ``strict=True``, against
    :func:`~app.tournament_event_stages.stage_template`'s own tuple. A caller that
    hands this a template-mismatched list (a re-mint that ran stale, a draw type
    changed with no remint) fails loudly here — a ``ValueError`` — rather than
    materialising a stage against the wrong count source, mirroring
    ``app.tournament_draws.cut_draw``'s ``_stage_id_at`` on the read side of the same
    invariant.

    Pure over loaded objects: no session, exactly like :func:`materialise_groups`,
    which this calls once per stage.
    """
    for stage, (_component, count_source) in zip(
        sorted(stages, key=lambda stage: stage.position),
        stage_template(draw_type),
        strict=True,
    ):
        materialise_groups(
            stage, reservations, group_count_source=count_source, field_size=field_size
        )


async def materialise_event_groups(
    db: AsyncSession, event: TournamentEvent, *, field_size: int
) -> None:
    """Make **every one of** ``event``'s stages hold the group rows
    :func:`group_count_for` says its own template entry holds for ``field_size`` and
    the event's current reservations, mapped round-robin (:func:`materialise_groups`,
    via :func:`materialise_stage_groups`) — the edit-path and cut-path door onto the
    materialisation.

    **Every stage, not stage 0 alone** (#1484): an ``rr-then-ko`` event's knockout
    stage now holds its own single group, the same way its group stage holds its
    structural pool — both are template entries, and this walks the whole template
    rather than special-casing the first entry. The create path
    (``app.tournament_events.create_event``) already materialises every stage through
    the same :func:`materialise_stage_groups`, because it holds the freshly-minted
    stages directly and has no query to make; this is that same policy's queried door,
    for an event that already exists.

    **The caller decides whether it runs, and which field it runs against.**
    ``app.tournament_events.update_event`` calls it unconditionally, late in the write
    (after the reservations diff and after ``store_draw_settings``, so it maps onto the
    new reservation set and reads the new draw type) and only while the event has no
    draw, with the preview field. ``app.tournament_draws.cut_draw`` calls it with the
    real registered field, and only when the derived count differs from the stored
    one. Nothing calls it after the cut: the identities and the mapping freeze there
    (#1387 decision 3).

    Reads the draw type off ``draw_settings_of(event.draw_settings)`` — the settings
    row rides along with the event (``lazy="joined"``) — and the reservations off
    ``event.reservations``, which is eager and, on the edit path, already the list the
    reservations diff just assigned.

    Resolves the event's stages with an explicit query, the same discipline
    ``app.tournament_event_stages.remint_stages_in_place`` follows: ``TournamentEvent
    .stages`` is eager, but ``TournamentEventStage.groups`` is deliberately NOT, so
    this needs its own query to attach the ``selectinload`` that loads it.

    Does not flush. A fresh group's ``id`` is the database's (``gen_random_uuid()``)
    and projects as ``None`` until the INSERT runs, so a caller that reads the groups
    back in the same transaction — the cut, which hands their ids to the snake — flushes
    after this returns.
    """
    # ``.options(selectinload(...))`` here, rather than a default eager strategy on the
    # relationship itself: ``TournamentEventStage.groups`` is deliberately NOT eager (an
    # event-wide default would double-load against ``TournamentEvent.groups``'s own
    # selectin), so this one direct reader asks for exactly the load it needs. ONE
    # option, not a chain down to the tables: ``reservation_link`` and ``reservation``
    # are ``joined`` on their own models and ride this query's own SELECT.
    stages = (
        (
            await db.execute(
                select(TournamentEventStage)
                .options(selectinload(TournamentEventStage.groups))
                .where(TournamentEventStage.event_id == event.id)
                .order_by(TournamentEventStage.position)
            )
        )
        .scalars()
        .all()
    )
    materialise_stage_groups(
        stages,
        ordered_reservations(event),
        draw_type=draw_settings_of(event.draw_settings).draw_type,
        field_size=field_size,
    )


async def apply_event_reservations(
    db: AsyncSession,
    tournament: Tournament,
    event: TournamentEvent,
    submitted: Sequence[ReservationUpsert],
) -> None:
    """Make ``event``'s reservations equal ``submitted`` as an **id-keyed diff** —
    keyed on the reservation's own id, the one the wire exposes and a PATCH cites.

    ``tournament`` is the event's own parent, and it is here for the reservation tables:
    it supplies the catalogue each ``table_ids`` is resolved against and the
    ``tournament_id`` their rows carry (:func:`_reservation_tables`).

    **This writes reservations only.** The groups are the server's
    (:func:`materialise_event_groups`), and ``app.tournament_events.update_event``
    re-materialises them after this diff — unconditionally, whether or not the patch
    carried a ``reservations`` key — so they map onto the reservation set this just
    wrote. Before #1387 this function wrote a group per reservation in lockstep; that
    1:1 is gone, and a reservation a group maps to can be removed here (with no draw
    cut) because the re-materialisation that follows re-points the group.

    Each entry either cites the ``id`` of a reservation the event already has — which
    keeps that row, re-named, re-timed, re-tabled and re-positioned as this payload
    says — or omits one, which adds a row the database mints an id for.

    **Keying on the id is not an optimization, it is the only correct mechanism.** A
    group's join row holds its reservation's id as a foreign key, and a delete-and-
    recreate of a reservation would take every mapping with it.

    Two refusals, and they are asked in two different places:

    * an entry citing an id this **event** does not have →
      :class:`~app.tournament_errors.ReservationNotInEventError` (a 422 on that entry's
      ``id``), judged here and before anything is written. The id is the server's, so
      one it did not mint names nothing — and quietly minting a fresh one would hand the
      client back a different id than it asked for while *removing* the reservation it
      meant to keep. It is the same 422
      :func:`~app.tournament_tables.apply_table_catalogue` answers an unknown table id
      with, for the same reason.
    * a payload that would add or remove a reservation of an event whose draw is
      **cut** → ``_enforce_group_set_frozen`` (``app.tournament_events``), which runs
      *before* this function, so the 409 wins over the 422 whenever both apply. With no
      draw, any diff is legal.

    Reassigning the whole collection is what expresses all three operations at once, in
    the payload's order — the same gesture ``apply_table_catalogue`` makes, and the
    reason every ``position`` constraint involved is DEFERRABLE: a reorder moves a row
    onto a position its neighbour has not vacated yet.

    ``event.reservations`` is eager (``selectin``), so it is already loaded on the
    object in hand and the assignment below never triggers the lazy load that, under
    async, would raise ``MissingGreenlet``.

    **Unmaps, then flushes, and the order is the point.** A group mapped to a
    reservation this payload removes has its join row orphaned here, and the whole
    diff is flushed before this returns. Two facts force that. The join row's
    reservation leg is ``ON DELETE CASCADE``, and the unit of work emits the
    reservation's DELETE before a join row's UPDATE — so re-pointing the row at a new
    reservation in the same flush would have the database cascade it away first and
    the UPDATE match nothing. And the join row's primary key is the group's id, so
    minting a fresh row for the same group in the same flush as the orphan's DELETE
    would INSERT a key about to be deleted (the inserts go first). Orphaning in this
    flush and letting :func:`materialise_event_groups` mint the replacement in the
    next is the one ordering both accept. A group whose reservation is kept keeps its
    row untouched; a re-point between two kept reservations is a plain UPDATE there.
    """
    stored = {reservation.id: reservation for reservation in event.reservations}
    # Judged first, over the whole payload, for the reason the catalogue's twin is: a
    # reservation list naming a reservation this event does not have is not a
    # reservation list, and every subsequent question (what is kept, and therefore what
    # is removed) would be answered against a list the client did not mean. Named by
    # index so the refusal lands on the entry that caused it.
    for index, entry in enumerate(submitted):
        if entry.id is not None and entry.id not in stored:
            raise ReservationNotInEventError(index=index, reservation_id=str(entry.id))
    kept = {entry.id for entry in submitted if entry.id is not None}
    for group in event.groups:
        link = group.reservation_link
        if link is not None and link.reservation_id not in kept:
            group.reservation_link = None
    event.reservations = [
        _reservation_for(event, tournament, stored, entry, position)
        for position, entry in enumerate(submitted)
    ]
    await db.flush()


def _reservation_for(
    event: TournamentEvent,
    tournament: Tournament,
    stored: dict[uuid.UUID, TournamentEventReservation],
    entry: ReservationUpsert,
    position: int,
) -> TournamentEventReservation:
    """The reservation one submitted entry resolves to — the cited row, updated in
    place, or a brand-new one.

    ``position`` is the entry's index in the submitted list and is assigned on both
    arms, so a patch that re-orders the reservations re-orders them (and one that
    re-sends them unchanged writes the positions they already had).

    ``stored[entry.id]`` cannot miss — every cited id was checked against ``stored``
    before this runs, so this is an indexing operation rather than a second lookup with
    a second opinion about what an unknown id means.
    """
    if entry.id is None:
        return _new_reservation(event, tournament, entry, position)
    reservation = stored[entry.id]
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
    return reservation
