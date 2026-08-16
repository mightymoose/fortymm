import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.tournament import Tournament


class VenueTable(Base):
    """One physical table in a tournament's venue catalogue — a **row**, not a JSONB
    value-object (ADR 20260801 "a placement names a real table").

    The catalogue used to be ``tournaments.table_catalogue``: a JSONB list of
    ``{id, label, court}`` objects whose ``id`` was a **client-supplied string**. That
    left nothing for a placement or a pool to foreign-key, which is the only reason
    ADR-0790 could say a ``table_id`` naming no table is stored rather than refused.
    A table is a row now, so "this id names a table" becomes something the database can
    answer — and the id is the database's to mint (``gen_random_uuid()``), never the
    client's to author, exactly as a pool's ``position`` became the server's to assign.

    Named ``VenueTable`` rather than ``TournamentTable`` only because the *schema* of
    that name — the wire shape in ``app.schemas.tournament`` — already holds it; the
    same reason ``DrawTypeOption`` is not called ``DrawType``. The table itself follows
    the ``<singular_parent>_<plural_child>`` rule: ``tournament_tables``.
    """

    __tablename__ = "tournament_tables"
    __table_args__ = (
        # The catalogue's order is the director's order, so it is read (and deleted
        # against) by this index. It doubles as the index Postgres does NOT create for
        # a REFERENCING column: ``tournament_id`` is on the tournament-delete cascade
        # path, and unindexed that check is a sequential scan of every table row on
        # the platform per tournament deleted.
        Index(
            "ix_tournament_tables_tournament_id_position",
            "tournament_id",
            "position",
        ),
        # Two tables of one tournament never share a place in its order — the same
        # guarantee ``Pool.position`` makes by construction, said here as a constraint
        # because these are rows and a constraint is available.
        #
        # DEFERRABLE INITIALLY DEFERRED, because the catalogue's write is an id-keyed
        # diff and a diff **re-orders**: dragging table B above table A moves B onto a
        # position A has not vacated yet, and SQLAlchemy has no way to emit two UPDATEs
        # as one. Checked immediately, that transient collision would refuse a
        # transaction whose END state is perfectly unique — i.e. the constraint would
        # forbid reordering, which is one of the two things the diff exists to allow.
        # Deferring is not a weakening: uniqueness is a claim about the catalogue, and
        # a catalogue only exists between commits.
        UniqueConstraint(
            "tournament_id",
            "position",
            name="uq_tournament_tables_tournament_position",
            deferrable=True,
            initially="DEFERRED",
        ),
        # Redundant against the primary key, and there for exactly one purpose: SQL can
        # only reference a UNIQUE set of columns, so this is the target that lets
        # ``tournament_event_reservation_tables`` foreign-key ``(tournament_id,
        # table_id)`` and thereby say "the table this pool reserves is my own
        # tournament's" (ADR 20260801). The same trick, one level down, as
        # ``tournament_event_reservations``' ``(event_id, id)`` primary key — which is
        # that table's key rather than an extra constraint only because a pool id is
        # per-event and a table id is not.
        UniqueConstraint(
            "tournament_id", "id", name="uq_tournament_tables_tournament_id_id"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    tournament_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournaments.id", ondelete="CASCADE"),
        nullable=False,
    )
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    court: Mapped[str] = mapped_column(String(255), nullable=False)
    # Where this table sits in its tournament's catalogue: 0-based, contiguous,
    # assigned by the server from the index the table arrived at.
    #
    # It is not decoration. Under the random UUID primary key above, ordering the
    # catalogue by ``id`` is *arbitrary* and ordering it by ``created_at`` is worse than
    # arbitrary — every row of one write shares the transaction timestamp, so the tie
    # breaks on the random id anyway. The array order the JSONB column used to carry for
    # free has to be carried by something, and this is it (the same argument, and the
    # same remedy, as ``PoolPosition`` in ADR 20260801).
    #
    # Deliberately NOT on the wire: the read shape is a JSON *array*, whose order is
    # this column, and the write shape's order is what assigns it. Carrying the number
    # beside the array it is derived from would be carrying a field and its own
    # derivation (api/CLAUDE.md).
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

    tournament: Mapped["Tournament"] = relationship(back_populates="tables")
