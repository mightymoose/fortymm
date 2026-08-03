import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    DateTime,
    ForeignKeyConstraint,
    Index,
    Integer,
    PrimaryKeyConstraint,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.tournament_event_pool import TournamentEventPool


class TournamentEventPoolTable(Base):
    """One table a pool **reserves** — a row, where it used to be an entry in the pool's
    ``table_ids`` JSONB array (ADR 20260801, "the tournament-scoping stops at the join
    table").

    A reservation is the slice of the venue catalogue a pool draws on: the solver may
    place that pool's matches on these tables and no others. It is a *preference*, not a
    commitment — which is the whole reason this row exists as a row. As a string in a
    JSONB array it could name anything at all, including a table belonging to **another
    tournament**, and nothing above the database would have said otherwise.

    **The three foreign keys, and why it takes three.** A pool belongs to an event, an
    event belongs to a tournament, and a table belongs to a tournament — so "this pool's
    table is its own tournament's table" is a claim about a path this row is the only
    place to walk. It is spelled by carrying ``tournament_id`` here, denormalized, and
    pinning every leg of the path to it:

    ==========================  =========================================
    ``(event_id, pool_id)``     → ``tournament_event_pools (event_id, id)``
    ``(tournament_id, table_id)``  → ``tournament_tables (tournament_id, id)``
    ``(tournament_id, event_id)``  → ``tournament_events (tournament_id, id)``
    ==========================  =========================================

    The third one is the one that looks redundant and is not. With only the first two,
    a row may say ``tournament_id = X`` while its pool's event belongs to tournament
    ``Y``: both constraints are satisfied — the pool exists, and ``X`` really does own
    that table — and the row is *exactly* the reservation the ADR forbids, across two
    tournaments.
    The third leg is what forces the ``tournament_id`` this row claims to be the
    tournament its pool actually lives under, and only then does the second leg mean "my
    own tournament's table". (Each is composite for the same reason the fixture's
    ``(event_id, pool_id)`` is: a plain ``REFERENCES tournament_tables (id)`` says the
    table *exists*, which was never the question.)

    Each referenced pair is a UNIQUE key that exists for no other purpose —
    ``tournament_events`` and ``tournament_tables`` both gained a
    ``UNIQUE (tournament_id, id)`` beside their primary key, because SQL can only
    reference a unique set of columns and the *pair* is what carries the claim. Pools
    needed nothing: ``(event_id, id)`` is already their primary key.

    **All three delete rules are CASCADE, and one of them is the ADR's asymmetry.**
    Removing a table that a fixture is *placed at* is refused (``ON DELETE RESTRICT`` on
    ``tournament_fixtures.table_id``) and the director says yes on purpose; removing a
    table that a pool merely *reserves* is silent, and this CASCADE is what makes it
    true rather than merely tolerated — the reservation disappears with the table
    instead of lingering as a string naming nothing (ADR 20260801, "a placement names a
    real table"). A pool's reservations likewise go with the pool, and an event's with
    the event, so no delete path has to learn about this table.
    """

    __tablename__ = "tournament_event_pool_tables"
    __table_args__ = (
        # A pool reserves a table at most once. ``event_id`` leads for the reason it
        # leads on ``tournament_event_pools``: every read is "the reservations of this
        # pool", and its own index answers the (event_id, pool_id) foreign key's
        # referential check as well as the event-delete cascade's lookup.
        PrimaryKeyConstraint(
            "event_id",
            "pool_id",
            "table_id",
            name="pk_tournament_event_pool_tables",
        ),
        ForeignKeyConstraint(
            ["event_id", "pool_id"],
            ["tournament_event_pools.event_id", "tournament_event_pools.id"],
            name="fk_tournament_event_pool_tables_event_id_pool_id",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tournament_id", "table_id"],
            ["tournament_tables.tournament_id", "tournament_tables.id"],
            name="fk_tournament_event_pool_tables_tournament_id_table_id",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["tournament_id", "event_id"],
            ["tournament_events.tournament_id", "tournament_events.id"],
            name="fk_tournament_event_pool_tables_tournament_id_event_id",
            ondelete="CASCADE",
        ),
        # Two reservations of one pool never share a place in its order — the guarantee
        # ``app.tournament_pools`` makes by construction (it stamps ``range(len(...))``)
        # said here as a constraint.
        #
        # DEFERRABLE INITIALLY DEFERRED for the reason both sibling ``position``
        # constraints are: the reservations of a pool are written as a diff keyed on the
        # table id, and a diff **re-orders** — a payload that moves a table up the list
        # puts it on a position its neighbour has not vacated yet, and SQLAlchemy cannot
        # emit those UPDATEs as one statement. Checked immediately, the constraint would
        # refuse a transaction whose END state is perfectly unique.
        UniqueConstraint(
            "event_id",
            "pool_id",
            "position",
            name="uq_tournament_event_pool_tables_event_id_pool_id_position",
            deferrable=True,
            initially="DEFERRED",
        ),
        # The index Postgres does NOT create for a REFERENCING pair, on the leg that
        # needs it most: removing a venue table cascades through this FK, and unindexed
        # that check is a sequential scan of every reservation on the platform per table
        # removed. The primary key covers the other two legs (both lead with
        # ``event_id``); this pair leads with ``tournament_id``, which no other index
        # here does.
        Index(
            "ix_tournament_event_pool_tables_tournament_id_table_id",
            "tournament_id",
            "table_id",
        ),
    )

    #: The tournament this reservation is inside — **denormalized on purpose**, and the
    #: only reason the cross-tournament claim is expressible at all. A pool has no
    #: ``tournament_id`` (it hangs off its event) and a table has no ``event_id``, so
    #: the two sides share no column until this row supplies one for them to agree on.
    tournament_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    #: Half of the reserving pool's composite key, and half of the "this event is that
    #: tournament's" leg. Both foreign keys read this one column, which is what ties the
    #: pool and the table into the same tournament.
    event_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    #: The other half of the pool's key. ``Text``, like ``TournamentEventPool.id``,
    #: while pool ids are still the client's strings; it moves to ``uuid`` with them
    #: (#1226 slice 3d), which is the same DDL on both sides and no change to any of the
    #: constraints above.
    pool_id: Mapped[str] = mapped_column(Text, nullable=False)
    #: The reserved table. ``UUID(as_uuid=False)`` — a real ``uuid`` column typed as
    #: ``str`` in Python, exactly as ``TournamentFixture.table_id`` is, because a table
    #: id crosses this codebase as its canonical text: here, on a placement, and as the
    #: solver's ``TableId``. The database holds the type; everything above it compares
    #: the text.
    table_id: Mapped[str] = mapped_column(UUID(as_uuid=False), nullable=False)
    #: Where this table sits in the pool's reservation list: 0-based, contiguous,
    #: assigned by the server from the order the reservation arrived in.
    #:
    #: The JSONB array carried that order for free and the wire shape is still an
    #: array, so something has to carry it now that the array is rows — the same
    #: argument, and the same remedy, as ``TournamentEventPool.position`` and
    #: ``VenueTable.position``. Ordering by ``table_id`` instead would be *arbitrary*
    #: (random UUIDs), so a director's list would come back shuffled on every read.
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

    pool: Mapped["TournamentEventPool"] = relationship(back_populates="tables")
