import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    DateTime,
    ForeignKeyConstraint,
    Index,
    Integer,
    PrimaryKeyConstraint,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.tournament import TournamentEvent
    from app.models.tournament_event_reservation import TournamentEventReservation


class TournamentEventReservationTable(Base):
    """One table a **reservation** holds — a row, where it used to be an entry in a
    pool's ``table_ids`` JSONB array (ADR 20260801, "the tournament-scoping stops at the
    join table").

    A reservation is the slice of the venue catalogue its groups draw on: the solver may
    place their matches on these tables and no others. It is a *preference*, not a
    commitment — which is the whole reason this row exists as a row. As a string in a
    JSONB array it could name anything at all, including a table belonging to **another
    tournament**, and nothing above the database would have said otherwise.

    **Three foreign keys, and this row is back where it started.** It was parented on a
    pool, which ADR 20260815 re-parented onto a stage — dragging this row onto
    ``(stage_id, pool_id)`` and forcing a *fourth* leg, ``(event_id, stage_id)``, to
    close the gap that indirection opened. A reservation hangs off the event directly,
    so the stage drops out of this row entirely and the fourth leg goes with it:

    ===============================  =============================================
    ``(event_id, reservation_id)``   → ``tournament_event_reservations (event_id, id)``
    ``(tournament_id, table_id)``    → ``tournament_tables (tournament_id, id)``
    ``(tournament_id, event_id)``    → ``tournament_events (tournament_id, id)``
    ===============================  =============================================

    ``tournament_id`` is denormalized and is the whole mechanism: a reservation has no
    ``tournament_id`` (it hangs off its event) and a table has no ``event_id``, so the
    two sides share no column until this row supplies one for them to agree on. **The
    ``tournament_id`` leg is the cross-tournament guard and is not droppable**: with
    only the reservation and table legs, a row could say ``tournament_id = X`` while its
    reservation's event belonged to tournament ``Y`` — both satisfied, and exactly the
    cross-tournament reservation the ADR forbids. (Each leg is composite for the reason
    the group leg on a fixture is: a plain ``REFERENCES tournament_tables (id)`` says
    the table *exists*, which was never the question.)

    Each referenced pair is a UNIQUE key that exists for no other purpose —
    ``tournament_events`` and ``tournament_tables`` each carry a ``UNIQUE (parent_id,
    id)`` beside their primary key, because SQL can only reference a unique set of
    columns and the *pair* is what carries the claim. Reservations needed nothing extra
    for their half: ``(event_id, id)`` is already their own composite-FK target.

    **All three delete rules are CASCADE, and one of them is the ADR's asymmetry.**
    Removing a table that a fixture is *placed at* is refused (``ON DELETE RESTRICT`` on
    ``tournament_fixtures.table_id``) and the director says yes on purpose; removing a
    table that a reservation merely *holds* is silent, and this CASCADE is what makes it
    true rather than merely tolerated — the row disappears with the table instead of
    lingering as a string naming nothing (ADR 20260801, "a placement names a real
    table"). A reservation's tables likewise go with the reservation, and an event's
    with the event, so no delete path has to learn about this table.
    """

    __tablename__ = "tournament_event_reservation_tables"
    __table_args__ = (
        # A reservation holds a table at most once. ``event_id`` leads for the reason it
        # leads on ``tournament_event_reservations``: every read is "the tables of this
        # reservation", and the key's own index answers that shape, the reservation
        # leg's referential check, and the event-delete cascade's lookup — all three,
        # which is what the pool-era version needed a second index to do once its pool
        # leg pointed at a stage instead.
        PrimaryKeyConstraint(
            "event_id",
            "reservation_id",
            "table_id",
            name="pk_tournament_event_reservation_tables",
        ),
        # "My reservation is my own event's reservation" — the leg that replaces the
        # pool-era ``(stage_id, pool_id)`` one, pointing at the pair a reservation is
        # keyed on.
        ForeignKeyConstraint(
            ["event_id", "reservation_id"],
            [
                "tournament_event_reservations.event_id",
                "tournament_event_reservations.id",
            ],
            name="fk_tournament_event_reservation_tables_event_id_reservation_id",
            ondelete="CASCADE",
        ),
        # "My table is my own tournament's table" — the cross-tournament guard, kept
        # verbatim through the split.
        ForeignKeyConstraint(
            ["tournament_id", "table_id"],
            ["tournament_tables.tournament_id", "tournament_tables.id"],
            name="fk_tournament_event_reservation_tables_tournament_id_table_id",
            ondelete="CASCADE",
        ),
        # "My event is my own tournament's event" — what makes the other two legs mean
        # "my own tournament's table, held by my own event's reservation" rather than
        # two unrelated true statements.
        ForeignKeyConstraint(
            ["tournament_id", "event_id"],
            ["tournament_events.tournament_id", "tournament_events.id"],
            name="fk_tournament_event_reservation_tables_tournament_id_event_id",
            ondelete="CASCADE",
        ),
        # Two tables of one reservation never share a place in its order — the guarantee
        # ``app.tournament_pools`` makes by construction (it stamps ``range(len(...))``)
        # said here as a constraint.
        #
        # DEFERRABLE INITIALLY DEFERRED for the reason every sibling ``position``
        # constraint is: the tables of a reservation are written as a diff keyed on the
        # table id, and a diff **re-orders** — a payload that moves a table up the list
        # puts it on a position its neighbour has not vacated yet, and SQLAlchemy cannot
        # emit those UPDATEs as one statement. Checked immediately, the constraint would
        # refuse a transaction whose END state is perfectly unique.
        UniqueConstraint(
            "event_id",
            "reservation_id",
            "position",
            name="uq_tournament_event_reservation_tables_reservation_position",
            deferrable=True,
            initially="DEFERRED",
        ),
        # The index Postgres does NOT create for a REFERENCING pair, on the leg that
        # needs it most: removing a venue table cascades through this FK, and unindexed
        # that check is a sequential scan of every reservation table on the platform per
        # table removed. The primary key covers both legs that lead with ``event_id``;
        # this pair leads with ``tournament_id``, which no other index here does.
        #
        # There is no second ``ix_`` here, unlike the pool-era table: its pool leg led
        # with ``stage_id``, which was not a primary-key column at all and so rode no
        # index. This row's reservation leg leads with ``event_id``, a prefix of the
        # primary key, so it rides the key's own index for free again.
        Index(
            "ix_tournament_event_reservation_tables_tournament_id_table_id",
            "tournament_id",
            "table_id",
        ),
    )

    #: The tournament this row is inside — **denormalized on purpose**, and the only
    #: reason the cross-tournament claim is expressible at all. See the class docstring.
    tournament_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    #: Half of the "this event is that tournament's" leg, and half of the reservation's
    #: own composite key. Kept as its own column rather than reached through the
    #: reservation, for the same reason ``tournament_id`` is denormalized: this row is
    #: where the event and tournament sides meet, and nothing upstream of it carries
    #: both.
    #:
    #: **Populated through the** :attr:`event` **relationship below, not a literal**,
    #: unlike ``tournament_id`` (a real value at construction time, since the tournament
    #: this row is inside already exists). At CREATE, the event itself does not have an
    #: id yet — it is a server-minted uuid, unassigned until flush — so
    #: ``app.tournament_pools`` sets ``.event = event`` on the still-unsaved object
    #: graph and lets the unit of work populate this column once the event's INSERT
    #: returns, the same mechanism that populates ``reservation_id`` through
    #: :attr:`reservation`. On the UPDATE path the event already has an id, but the same
    #: assignment is used uniformly rather than switching mechanisms per call site.
    event_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    #: The other half of the reservation's key. There is deliberately no ``stage_id``
    #: column: a reservation hangs off the event, so nothing here needs to name a stage,
    #: and the fourth leg the stage indirection required went with it.
    reservation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False
    )
    #: The held table. ``UUID(as_uuid=False)`` — a real ``uuid`` column typed as ``str``
    #: in Python, exactly as ``TournamentFixture.table_id`` is, because a table id
    #: crosses this codebase as its canonical text: here, on a placement, and as the
    #: solver's ``TableId``. The database holds the type; everything above it compares
    #: the text.
    table_id: Mapped[str] = mapped_column(UUID(as_uuid=False), nullable=False)
    #: Where this table sits in the reservation's list: 0-based, contiguous, assigned by
    #: the server from the order the ids arrived in.
    #:
    #: The JSONB array carried that order for free and the wire shape is still an array,
    #: so something has to carry it now that the array is rows. Ordering by ``table_id``
    #: instead would be *arbitrary* (random UUIDs), so a director's list would come back
    #: shuffled on every read.
    #:
    #: Deliberately not on the wire: the read shape is the array whose order this is,
    #: and carrying the number beside it would be carrying a field and its own
    #: derivation (api/CLAUDE.md).
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    reservation: Mapped["TournamentEventReservation"] = relationship(
        back_populates="tables"
    )

    #: This row's event — resolved from the ``(tournament_id, event_id) ->
    #: tournament_events (tournament_id, id)`` leg, the only foreign key here that
    #: touches ``tournament_events``. Exists so ``event_id`` can be populated by the
    #: unit of work rather than as a literal (see that column's docstring) — no reader
    #: needs ``row.event`` today.
    #:
    #: ``overlaps`` names what genuinely does overlap and is genuinely safe.
    #: ``event_id`` is written by this relationship AND by :attr:`reservation` (whose
    #: leg is ``(event_id, reservation_id)``), so SQLAlchemy warns that two
    #: relationships target one column. They cannot disagree: the reservation's
    #: ``event_id`` is this event's id, which the ``(event_id, reservation_id)`` foreign
    #: key requires. The pool-era version of this row needed no such declaration because
    #: its parent leg led with ``stage_id`` and touched no column this one writes.
    event: Mapped["TournamentEvent"] = relationship(overlaps="reservation,tables")
