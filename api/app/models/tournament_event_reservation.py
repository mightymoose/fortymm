import uuid
from datetime import date, datetime, time
from typing import TYPE_CHECKING

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Integer,
    PrimaryKeyConstraint,
    Text,
    Time,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.tournament import TournamentEvent
    from app.models.tournament_event_reservation_table import (
        TournamentEventReservationTable,
    )


class TournamentEventReservation(Base):
    """One **reservation** of an event — a set of tables held for a window of time.

    This is the other half of what ``tournament_event_reservations`` used to be. A
    "reservation" said
    *these entrants play each other* and *they play here, then* in one row; the first
    claim is a
    :class:`~app.models.tournament_event_stage_group.TournamentEventStageGroup` now, and
    this row is the second. A group reaches its reservation through
    :class:`~app.models.tournament_event_group_reservation.TournamentEventGroupReservation`,
    and the wire's ``reservations[]`` array is the two projected back together
    (:func:`app.tournament_reservations.group_read`).

    **The parent is the event, not the stage** — deliberately, and unlike the group.
    Two reasons, and neither is symmetry with the group:

    * Nothing names a reservation through a composite key rooted in a fixture, so the
      constraint that forced a group onto the stage does not apply here.
    * A stage-parented reservation would hand every stage a reservation set before
      anything is built to edit one, which is the "a column no code writes" #1338's
      Non-Goals refuse. On the event, an rr-then-ko draw's two stages read one
      reservation set, and a knockout stage can later point at a reservation its event
      already holds — which is what makes #1316's stage-level reference buildable
      without moving this row again.

    **The tables are rows, not a JSONB array** (ADR 20260801, "the tournament-scoping
    stops at the join table") — see
    :class:`~app.models.tournament_event_reservation_table.TournamentEventReservationTable`.
    They followed this row from the reservation it split out of, and returned to the
    event on the way: ADR 20260815 re-parented them onto a stage because their
    reservation had moved there, and a reservation is event-parented, so they come back.

    **Its attributes do not freeze with the draw.** The set of *group* identities is
    frozen once a draw is cut (ADR-0786), because a fixture names a group. Nothing
    names a reservation's name, window or tables, so a director may edit all three
    mid-event and the draw is untouched. That split is the point of the split: the
    thing the draw depends on and the thing the venue schedule depends on stopped
    being one row.

    **The slot is ``date``/``time``, not ``timestamptz``, and that is deliberate** — the
    one place in this schema where api/CLAUDE.md's "datetimes are timezone-aware,
    always" does not apply, because these three columns are not datetimes. The window is
    *wall-clock*: the director types "the 13th, 09:00 to 12:30" and means it in the
    venue's own frame, which is carried once by ``tournament_events.timezone`` and
    anchored into real instants at the seam that needs instants
    (``app.schedule_solves``). Storing an instant here would bake that anchoring into
    the column, so correcting the event's timezone would have to rewrite every window
    rather than re-read the same wall-clock in the new zone (ADR "tournament times are
    timezone-aware instants" — "wall-clock is preserved across a timezone edit"). The
    wire shape is unchanged: the ``Slot`` value-object's ``YYYY-MM-DD`` / ``HH:MM``
    strings compose from and to these columns at the boundary
    (``app.tournament_reservations``).

    ``id`` is a **server-minted uuid** — ``gen_random_uuid()``. It is deliberately NOT
    on the wire: every reservation identifier the API serves is the *group's* id, so a
    reservation's own id names nothing a client has ever seen. The one place it surfaces
    at all is inside the solver's opaque namespaced key
    (``app.schedule_solves``), which is what makes that key mean "the reservation this
    fixture is confined to"."""

    __tablename__ = "tournament_event_reservations"
    __table_args__ = (
        # Named explicitly rather than left to Postgres' ``<table>_pkey`` default, so
        # the model and the migration describe the SAME constraint. They are two
        # independent descriptions of one schema and only the models are under test
        # (``pytest`` builds with ``create_all`` and never runs a migration), so a
        # name that appears in one and not the other is drift nothing would catch.
        PrimaryKeyConstraint("id", name="pk_tournament_event_reservations"),
        # The target of the join row's reservation leg, and of the reservation tables'
        # own. SQL can only reference a unique set of columns, and the *pair* is what
        # carries "my reservation is my own event's reservation" — the same reasoning
        # ``tournament_event_stage_groups`` uses one hop along, and the same reasoning
        # ``tournament_events`` and ``tournament_tables`` each carry a ``UNIQUE
        # (parent_id, id)`` for.
        #
        # Its index earns its keep besides: ``event_id`` leads, so it answers every read
        # of "this event's reservations", the event-delete cascade's lookup, and both
        # composite foreign keys' referential checks — none of which the single-column
        # primary key serves.
        UniqueConstraint(
            "event_id", "id", name="uq_tournament_event_reservations_event_id_id"
        ),
        # Two reservations of one event never share a place in its order.
        #
        # DEFERRABLE INITIALLY DEFERRED, for the reason every sibling ``position``
        # constraint is: reservations are written as a diff keyed on their group's id,
        # and a diff **re-orders** — sending C, A, B back as B, C, A moves each row onto
        # a position its neighbour has not vacated yet. Checked immediately, the
        # constraint would refuse a transaction whose END state is perfectly unique, and
        # so forbid the one gesture the payload's order exists to express.
        UniqueConstraint(
            "event_id",
            "position",
            name="uq_tournament_event_reservations_event_id_position",
            deferrable=True,
            initially="DEFERRED",
        ),
    )

    #: The reservation's identity. Server-minted, and NOT a reservation id on the wire
    #: — see the class docstring.
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    #: The event this reservation belongs to — the parent, unlike a group's stage. See
    #: the class docstring for why the two rows are parented differently.
    #:
    #: CASCADE: an event's reservations go with the event, exactly as its stages and
    #: their groups do.
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournament_events.id", ondelete="CASCADE"),
        nullable=False,
    )
    #: ``Text``, not ``String(255)``: the write boundary floors a name at one character
    #: and puts no ceiling on it, so a column with one would 500 on a payload the schema
    #: accepted. This is what the wire still calls ``reservations[].name``.
    name: Mapped[str] = mapped_column(Text, nullable=False)
    #: Where this reservation sits in its event's own order: 0-based, contiguous,
    #: assigned by the server from the index of the entry that wrote it.
    #:
    #: Not what the wire reports. ``reservations[].position`` is the *group's*
    #: position, which is the one the snake seeds against and the qualifier seam
    #: labels by. This column exists so a reservation set has a stable, non-arbitrary
    #: read order of its own —
    #: ordering by a random uuid would shuffle a director's list on every read — and it
    #: happens to equal the group's position under this slice's 1:1 lockstep.
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    #: The venue-local calendar day of this reservation's window. See the class
    #: docstring for why these three are wall-clock columns rather than instants.
    slot_date: Mapped[date] = mapped_column(Date, nullable=False)
    slot_start: Mapped[time] = mapped_column(Time, nullable=False)
    slot_end: Mapped[time] = mapped_column(Time, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    #: The event this reservation hangs off. ``back_populates`` so assigning
    #: ``reservation.event = event`` on the create path — where the event has no id yet,
    #: because it is server-minted and unassigned until flush — lets the unit of work
    #: populate ``event_id`` once the event's own INSERT returns.
    event: Mapped["TournamentEvent"] = relationship(back_populates="reservations")

    #: The tables this reservation holds, in the order the director sent them — which is
    #: what ``TournamentEventReservationTable.position`` carries and what the projected
    #: ``Reservation.table_ids`` is composed from.
    #:
    #: ``lazy="selectin"`` for the reason every collection on this path is eager: async
    #: SQLAlchemy raises rather than emitting a lazy load, so every reader that reaches
    #: a reservation's tables — the serializer, the solver's input load, the preview,
    #: the re-solve trigger's before/after comparison — would need to remember an
    #: option. ``delete-orphan`` is what the write leans on — a table dropped from the
    #: submitted list is removed by taking it out of this collection — and
    #: ``passive_deletes`` + the FK's ``ON DELETE CASCADE`` is the delete path for
    #: everything that does not load the collection first. Removing the venue TABLE is
    #: the third path, and the ORM is never involved in it at all: that cascade comes
    #: off ``tournament_tables``, which has no relationship pointing here.
    tables: Mapped[list["TournamentEventReservationTable"]] = relationship(
        back_populates="reservation",
        cascade="all, delete-orphan",
        passive_deletes=True,
        lazy="selectin",
        order_by="TournamentEventReservationTable.position",
    )
