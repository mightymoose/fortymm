"""The one place a tournament's venue catalogue is written.

A table is a row now (ADR 20260801, "a placement names a real table, and only that is
an invariant"), not an entry in ``tournaments.table_catalogue`` JSONB, and its id is
minted by the database. So the two write verbs — ``create_tournament`` and
``edit_tournament`` — no longer assign a column; they compose ``VenueTable`` rows, and
they do it through this module rather than each spelling it out, for the reason
``stored_reservations`` is shared between the event verbs: the shape a catalogue is
stored in
must not depend on which verb happened to store it.

The edit path is a **diff**, and the ADR is explicit about why it had to become one:
"``table_catalogue``'s wholesale replace becomes a diff. A PATCH that omits a table is
now a delete, and a delete can be refused, so the verb has to compute what changed
rather than assign a list." That refusal — a removal a fixture's placement stands in the
way of — is this module's other half, and it is what pulls a session in here: the
question "is anything placed at this table" is a query, and the answer decides whether
the write happens at all.

It imports the models, the write schemas and the domain-error leaf, and nothing else —
no router, no FastAPI — so it stays callable from a REPL with a raw session, and
cycle-free.
"""

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Tournament, TournamentFixture, VenueTable
from app.schemas.tournament import (
    TournamentTableUpsert,
    TournamentTableWrite,
    named_list,
)
from app.tournament_errors import TableInUseError, TableNotInCatalogueError

__all__ = ["AppliedCatalogue", "apply_table_catalogue", "stored_tables"]


def stored_tables(submitted: Sequence[TournamentTableWrite]) -> list[VenueTable]:
    """Fresh :class:`VenueTable` rows for a catalogue that has none yet — the create
    verb's whole job.

    Each row is stamped with the ``position`` of its index in ``submitted`` — the only
    place a position is ever assigned on the create path, and what makes the stored
    positions ``range(len(submitted))`` by construction. No ``id`` is set: that is the
    database's (``gen_random_uuid()``), and the point of the ADR is that it is not the
    client's to author.
    """
    return [
        VenueTable(label=table.label, court=table.court, position=index)
        for index, table in enumerate(submitted)
    ]


@dataclass(frozen=True)
class AppliedCatalogue:
    """What :func:`apply_table_catalogue` did, for the caller that has to react to it.

    Two facts, and they are wanted by two different consumers, which is why this is a
    small record rather than a bare ``bool``:

    * ``changed`` — whether the **set** of tables moved (one was added or removed), the
      re-solve trigger's question. Deliberately about the set and not the words: the
      solver reduces the catalogue to its ids (``_load_solver_inputs``), so adding or
      removing a table changes its inputs while re-wording a label — or re-ordering the
      list, which is presentation — does not.
    * ``unplaced_event_ids`` — the events whose fixtures this write unplaced, under the
      opt-in. Their entrants have just lost a table and a time off their panels, so they
      are exactly the audience of a ``dashboard.changed`` hint; an ordinary catalogue
      edit unplaces nobody and this is empty.
    """

    changed: bool
    unplaced_event_ids: tuple[uuid.UUID, ...]


def _tables_in_use_detail(labels: list[str], *, placements: int) -> str:
    """The 409 sentence for a catalogue edit that would remove a table matches are
    placed at — composed in the house style of ``_reservation_set_frozen_detail``
    (``app.tournament_events``): **name the things, then name the way out.**

    It names the tables **by label**, never by id, for the reason ``named_list`` exists:
    the id is what the diff compared, but "table 4f9c-… cannot be removed" tells a
    director looking at a page of named tables nothing to act on.

    And it names both ways out, because a refusal with only one is a director stuck
    between an edit they cannot make and a schedule they did not want to lose: send the
    same edit again with the opt-in and accept the unplacing, or move the matches off
    the table first and keep them. Which of the two is right is theirs to decide — that
    is the whole content of the ADR's split between a reservation (quiet) and a
    placement (loud).
    """
    one = len(labels) == 1
    has, it, the_table = ("has", "it", "the table") if one else ("have", "them", "them")
    matches = "match" if placements == 1 else "matches"
    return (
        f"{named_list(labels)} {has} {placements} {matches} placed at {it}, so "
        f"removing {it} from the catalogue would leave those matches with no table — "
        "indistinguishable from matches nobody ever placed. To remove "
        f"{it} anyway, send the same edit again with "
        "“unplace_fixtures_on_removed_tables”: true, and those matches lose their "
        "table, their time and their call and go back to the schedule to be placed "
        f"again. To keep them where they are, leave {the_table} in the catalogue and "
        f"move the matches off {it} first."
    )


async def _placed_fixtures(
    db: AsyncSession, table_ids: Iterable[str]
) -> Sequence[TournamentFixture]:
    """Every fixture whose placement names one of ``table_ids``.

    Scoped by the ids alone and not by the tournament, which is not a shortcut: these
    ids came off this tournament's own catalogue rows, and a fixture's ``table_id`` is a
    foreign key to exactly those rows, so "placed at this table" already means "in this
    tournament". The ``ix_tournament_fixtures_table_id`` index — the one the ``ON DELETE
    RESTRICT`` needed anyway — is what makes this a lookup rather than a scan.

    The rows themselves, not a count: the refusal needs to say how many there are, the
    opt-in needs to clear their placement columns, and the hint needs their events. One
    query answers all three.
    """
    return (
        (
            await db.execute(
                select(TournamentFixture).where(
                    TournamentFixture.table_id.in_(list(table_ids))
                )
            )
        )
        .scalars()
        .all()
    )


async def _unplace_or_refuse(
    db: AsyncSession, removed: Sequence[VenueTable], *, unplace: bool
) -> tuple[uuid.UUID, ...]:
    """Clear the placements standing in the way of removing ``removed`` — or, without
    the opt-in, raise :class:`TableInUseError` having written nothing.

    This is the ADR's split, in one function. A table that no fixture names is removed
    with no ceremony whatever any *reservation* thinks of it: a reservation's
    ``table_ids`` are a reservation, and the reservation simply reserves one fewer. A
    table a fixture is **placed at** is a different question, and it is asked of the
    director rather than answered for them.

    Under the opt-in the three placement columns go together — ``table_id``,
    ``scheduled_start`` and ``pinned_at`` — because two of them are meaningless without
    the first. A start with no table is a bar on a schedule with nowhere to be, and a
    ``pinned_at`` is a *promise about a table*: leaving it set would tell every later
    solve that this fixture is nailed to a table that no longer exists. The same three,
    together, are what the broken-pin void clears (``app.schedule_solves``), for the
    same reason.

    The explicit ``flush`` IS the mechanism, not belt-and-braces. The caller removes the
    ``VenueTable`` rows straight after this returns, by dropping them from
    ``Tournament.tables`` (``delete-orphan``), and ``tournament_fixtures.table_id`` is
    ``ON DELETE RESTRICT`` — checked immediately, never deferred. There is no ORM
    ``relationship`` between the two (the FK is a bare column), so the unit of work has
    no dependency to order the child UPDATEs ahead of the parent DELETEs; flushing here
    puts them in the database first, in this transaction, where the RESTRICT check will
    find them.
    """
    placed = await _placed_fixtures(db, [str(table.id) for table in removed])
    if not placed:
        return ()
    if not unplace:
        blocking = {fixture.table_id for fixture in placed}
        labels = [table.label for table in removed if str(table.id) in blocking]
        raise TableInUseError(
            _tables_in_use_detail(labels, placements=len(placed)),
            tables=labels,
            placements=len(placed),
        )
    for fixture in placed:
        fixture.table_id = None
        fixture.scheduled_start = None
        fixture.pinned_at = None
    await db.flush()
    return tuple(sorted({fixture.event_id for fixture in placed}))


async def apply_table_catalogue(
    db: AsyncSession,
    tournament: Tournament,
    submitted: Sequence[TournamentTableUpsert],
    *,
    unplace_fixtures: bool,
) -> AppliedCatalogue:
    """Make ``tournament``'s catalogue equal ``submitted`` as an **id-keyed diff**, and
    report what that did (:class:`AppliedCatalogue`).

    Each entry either cites the ``id`` of a table the tournament already has — which
    keeps that row, with the ``label``/``court`` and the position this payload gives it
    — or omits one, which adds a row the database mints an id for. A stored table no
    entry cites is **removed**, by dropping it from ``Tournament.tables``, which
    ``delete-orphan`` turns into a ``DELETE``.

    **Keying on the id is what makes a reorder move tables.** The by-position stopgap
    this replaces (chore 2a) matched the i-th sent against the i-th stored, so sending
    two tables in the other order left each row holding its own id and its neighbour's
    words — a fixture placed at "Table 1" silently began rendering as "Table 2", with
    nothing refused and nothing to see. Only the client knows which of its rows is
    which, and the id is the one way it can say so.

    Three refusals, all judged **before anything is written**, so a refused catalogue
    leaves the tournament byte-identical:

    * an entry citing an id this tournament's catalogue does not hold →
      :class:`TableNotInCatalogueError` (a 422 on that entry's ``id``). Never a silently
      minted new table: that would hand the client an id it did not ask for and remove
      the table it meant to keep.
    * a removal a fixture's **placement** stands in the way of, without
      ``unplace_fixtures`` → :class:`TableInUseError` (the named 409). See
      :func:`_unplace_or_refuse` for why this one is loud where a group's reservation
      is silent.
    * (two entries citing one id is refused a layer earlier, at the boundary —
      :data:`~app.schemas.tournament.EditedTableCatalogue`.)

    With ``unplace_fixtures`` the removal goes through and those fixtures are unplaced,
    and the events they belong to come back on the result so the caller can hint their
    entrants: a player whose promised table just disappeared is told by nothing else.

    ``changed`` answers the re-solve trigger, and is deliberately about the **set** of
    tables: the solver reduces the catalogue to its ids, so an add or a remove changes
    its inputs while re-wording a label — or re-ordering the list — does not.
    """
    stored = {table.id: table for table in tournament.tables}
    # Judged first, over the whole payload, because a catalogue naming a table this
    # tournament does not have is not a catalogue: every subsequent question (what is
    # kept, and therefore what is removed) would be answered against a list the client
    # did not mean. Named by index so the refusal lands on the entry that caused it.
    for index, entry in enumerate(submitted):
        if entry.id is not None and entry.id not in stored:
            raise TableNotInCatalogueError(index=index, table_id=str(entry.id))

    kept = {entry.id for entry in submitted if entry.id is not None}
    removed = [table for table in tournament.tables if table.id not in kept]
    unplaced_event_ids: tuple[uuid.UUID, ...] = ()
    if removed:
        # The refusal, or the opt-in's unplacing — either way this returns before a
        # single catalogue row has been touched, which is what makes the 409 a refusal
        # rather than a report of something that already happened.
        unplaced_event_ids = await _unplace_or_refuse(
            db, removed, unplace=unplace_fixtures
        )

    # Assigning the whole collection is what expresses all three operations at once: the
    # rows carried over keep their identity (and every ref that names them), the fresh
    # ``VenueTable``s are inserts, and the stored rows left out are orphans that
    # ``delete-orphan`` deletes. The list order IS the catalogue order, so the read-back
    # is in the order the director sent without waiting for a re-select.
    tournament.tables = [
        _table_for(stored, entry, position) for position, entry in enumerate(submitted)
    ]
    return AppliedCatalogue(
        changed=bool(removed) or any(entry.id is None for entry in submitted),
        unplaced_event_ids=unplaced_event_ids,
    )


def _table_for(
    stored: dict[uuid.UUID, VenueTable], entry: TournamentTableUpsert, position: int
) -> VenueTable:
    """The row one catalogue entry resolves to: the cited table, re-worded and
    re-placed, or a brand-new one.

    ``position`` is the entry's index in the submitted list and is assigned here on both
    arms, so the stored positions are ``range(len(submitted))`` by construction — the
    same guarantee :func:`stored_tables` makes on create, and the reason a reorder is
    expressible at all.

    Re-positioning kept rows is precisely why the catalogue's
    ``uq_tournament_tables_tournament_position`` is ``DEFERRABLE INITIALLY DEFERRED``:
    swapping two tables moves one onto a position the other has not vacated yet, and an
    immediate constraint would refuse the intermediate state of a transaction whose
    *end* state is perfectly unique.

    ``stored[entry.id]`` cannot miss — every cited id was checked against ``stored``
    before this runs, so this is an indexing operation rather than a second lookup with
    a second opinion about what an unknown id means.
    """
    if entry.id is None:
        return VenueTable(label=entry.label, court=entry.court, position=position)
    row = stored[entry.id]
    row.label = entry.label
    row.court = entry.court
    row.position = position
    return row
