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

The edit path is an **id-keyed diff** and not a wholesale replace, which is a change of
mechanism and not of meaning: the pool set an event may end up with is exactly what it
was (the freeze in ``app.tournament_events`` decides that), but a JSONB column could be
reassigned and rows cannot — re-sending a pool the event already has must UPDATE that
row, or the write would try to insert a duplicate primary key and, worse, would delete
and recreate the row every fixture in the event points at.

It imports the models, the schemas and nothing else — no session, no router, no FastAPI
— so it stays callable from a REPL and cycle-free."""

from collections.abc import Sequence
from datetime import date, time

from app.models import TournamentEvent, TournamentEventPool
from app.schemas.tournament import Pool, PoolWrite, Slot

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
        table_ids=list(pool.table_ids),
        position=pool.position,
    )


def stored_pools(submitted: Sequence[PoolWrite]) -> list[TournamentEventPool]:
    """Fresh :class:`TournamentEventPool` rows for an event that has none yet — the
    create verb's whole job.

    Each row is stamped with the ``position`` of its index in ``submitted``: the only
    place a position is assigned on the create path, and what makes the stored positions
    ``range(len(submitted))`` by construction rather than by a caller's care.

    The ``id`` is the client's, for now — the pool-set freeze and the fixtures both name
    a pool by that string — unlike a venue table's, which the database mints. The chore
    that moves pools onto server-minted uuids (#1226 slice 3d) is the one that changes
    it, together with the column type and ``PoolId``.
    """
    return [_new_pool(pool, position) for position, pool in enumerate(submitted)]


def _new_pool(submitted: PoolWrite, position: int) -> TournamentEventPool:
    """One brand-new pool row, at ``position``, from the pool a client sent."""
    slot_date, slot_start, slot_end = _slot_columns(submitted.slot)
    return TournamentEventPool(
        id=submitted.id,
        name=submitted.name,
        position=position,
        slot_date=slot_date,
        slot_start=slot_start,
        slot_end=slot_end,
        table_ids=list(submitted.table_ids),
    )


def apply_event_pools(event: TournamentEvent, submitted: Sequence[PoolWrite]) -> None:
    """Make ``event``'s pools equal ``submitted``, as an **id-keyed diff**.

    A pool whose ``id`` the event already has keeps its row — re-named, re-timed,
    re-tabled and re-positioned as this payload says — and one whose id is new is added.
    A stored pool no entry names is **removed**, by leaving it out of the reassigned
    collection, which ``delete-orphan`` turns into a ``DELETE``.

    **Keying on the id is not an optimization, it is the only correct mechanism.** A
    fixture holds its pool's id (and, since ADR 20260801, holds it as a foreign key), so
    a delete-and-recreate of the row a standing draw points at would take the draw with
    it or be refused outright. The JSONB column this replaces could be reassigned
    wholesale precisely because nothing pointed into it.

    What may change is decided **before** this runs, not here:
    ``_enforce_pool_set_frozen`` (``app.tournament_events``) refuses a payload that
    would add or remove a pool of an event whose draw is cut. With no draw, any diff is
    legal — which is why this function has no refusal of its own, and why a new id is an
    addition rather than the 422 the venue catalogue's diff answers an unknown table id
    with (a table id is the server's to mint, so an id it did not mint names nothing; a
    pool id is still the client's).

    Reassigning the whole collection is what expresses all three operations at once, in
    the payload's order — the same gesture ``apply_table_catalogue`` makes, and the
    reason both tables carry a DEFERRABLE ``UNIQUE (…, position)``: a reorder moves a
    row onto a position its neighbour has not vacated yet.
    """
    stored = {pool.id: pool for pool in event.pools}
    event.pools = [
        _pool_for(stored, entry, position) for position, entry in enumerate(submitted)
    ]


def _pool_for(
    stored: dict[str, TournamentEventPool], entry: PoolWrite, position: int
) -> TournamentEventPool:
    """The row one submitted pool resolves to: the event's own pool of that id, updated
    in place, or a brand-new one.

    ``position`` is the entry's index in the submitted list and is assigned on both
    arms, so a patch that re-orders the pools re-orders them (and one that re-sends them
    unchanged writes the positions they already had).
    """
    row = stored.get(entry.id)
    if row is None:
        return _new_pool(entry, position)
    row.name = entry.name
    row.position = position
    row.slot_date, row.slot_start, row.slot_end = _slot_columns(entry.slot)
    row.table_ids = list(entry.table_ids)
    return row
