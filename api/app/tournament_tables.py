"""The one place a tournament's venue catalogue is written.

A table is a row now (ADR 20260801, "a placement names a real table, and only that is
an invariant"), not an entry in ``tournaments.table_catalogue`` JSONB, and its id is
minted by the database. So the two write verbs — ``create_tournament`` and
``edit_tournament`` — no longer assign a column; they compose ``VenueTable`` rows, and
they do it through this module rather than each spelling it out, for the reason
``stored_pools`` is shared between the event verbs: the shape a catalogue is stored in
must not depend on which verb happened to store it.

It imports the model and the write schema and nothing else — no router, no session —
so it stays callable from a REPL and cycle-free.
"""

from collections.abc import Sequence

from app.models import Tournament, VenueTable
from app.schemas.tournament import TournamentTableWrite

__all__ = ["apply_table_catalogue", "stored_tables"]


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


def apply_table_catalogue(
    tournament: Tournament, submitted: Sequence[TournamentTableWrite]
) -> bool:
    """Make ``tournament``'s catalogue equal ``submitted``, **by position**, and answer
    whether the set of tables changed (a table was added or removed).

    The i-th table sent is the i-th table stored: its row keeps its id and takes the new
    ``label``/``court``. A longer list appends rows; a shorter one drops the tail, which
    ``delete-orphan`` on ``Tournament.tables`` turns into DELETEs.

    **Position is the only identity a client has left**, and matching on it is the whole
    reason this is not a two-line "delete them all and insert the new list". The
    catalogue is sent in full on *every* tournament PATCH (the web client re-sends the
    tournament it loaded), so a rebuild would re-mint every id on a rename — dangling
    every pool's ``table_ids`` and unplacing every fixture, as an invisible side effect
    of editing the venue's name. The ADR is explicit that a placement must not be
    destroyed by an unrelated write.

    It is deliberately **not** the id-keyed diff the ADR ends at. That diff needs the
    client to be able to name an existing table, and it has to be able to *refuse* —
    removing a table a fixture is placed at is a named 409 with an unplace-and-remove
    opt-in. Both belong with the ``ON DELETE RESTRICT`` that makes the refusal
    enforceable; until then, positional matching is what keeps the ids that already
    exist pointing at the tables they already named.

    The answer feeds the re-solve trigger, so it is deliberately about the *set* and not
    the labels: the solver reduces the catalogue to its ids (``_load_solver_inputs``),
    so adding or removing a table changes its inputs and re-wording a label does not.
    Under positional identity a length change is exactly an add or a remove.
    """
    existing = list(tournament.tables)
    for row, table in zip(existing, submitted, strict=False):
        row.label = table.label
        row.court = table.court
    if len(submitted) > len(existing):
        tournament.tables.extend(
            VenueTable(label=table.label, court=table.court, position=position)
            for position, table in enumerate(submitted[len(existing) :], len(existing))
        )
    elif len(submitted) < len(existing):
        del tournament.tables[len(submitted) :]
    return len(submitted) != len(existing)
