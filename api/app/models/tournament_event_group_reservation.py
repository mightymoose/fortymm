import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    DateTime,
    ForeignKeyConstraint,
    Index,
    PrimaryKeyConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.tournament_event_reservation import TournamentEventReservation
    from app.models.tournament_event_stage_group import TournamentEventStageGroup


class TournamentEventGroupReservation(Base):
    """The row that maps one **group** to the **reservation** it plays in.

    Splitting one wire-level reservation slot into two rows left the two halves with no way to find
    each other. A group is parented on its stage (it must be — a fixture's composite
    foreign key names it, and a fixture carries ``stage_id`` and nothing else) and a
    reservation is parented on the event, so the two share no column. This row is the
    join.

    **Three foreign key legs, because two cannot say it.** A composite key can only
    assert a relationship between columns that exist on both sides, and the group side
    and the reservation side have no column in common. So:

    ==============================  ==============================================
    ``(stage_id, group_id)``        → ``tournament_event_stage_groups (stage_id, id)``
    ``(event_id, reservation_id)``  → ``tournament_event_reservations (event_id, id)``
    ``(event_id, stage_id)``        → ``tournament_event_stages (event_id, id)``
    ==============================  ==============================================

    The first two say each side is real and correctly parented. The **third is the one
    that matters**: without it, ``event_id`` and ``stage_id`` may name two different
    events while both other legs stay satisfied — the group really is its stage's group,
    the reservation really is its event's reservation, and the row still hands one
    event's stage a *different* event's reservation. The third leg forces ``stage_id``
    to be one of ``event_id``'s own stages, and only then do the three together mean "my
    own event's reservation, for my own event's group". ``tournament_fixtures`` carries
    four legs for exactly this reason after ADR 20260815, so the shape is idiomatic
    here.

    **The primary key is the group column alone, and that is the 1:1.** One group maps
    to at most one reservation, which is the uniqueness this slice's every write path
    maintains and every reader assumes. There is deliberately **no** uniqueness on
    ``reservation_id``: two groups of one event naming one reservation is a state the
    database accepts and no application path in this slice produces. #1370 is what
    starts producing it — a group count that creates groups without booking a venue —
    and it needs the column already free of a constraint that would have refused it.

    ``reservation_id`` is ``NOT NULL``. Every write path mints a group and a reservation
    together, so a reservation-less group is unreachable here
    and the column states what is true rather than what a later slice will allow. #1370
    relaxes it by editing the revision in place, because no environment holds data worth
    keeping.

    **All three delete rules are CASCADE.** The mapping is not a thing in its own right:
    it exists only while both ends do, so it goes with either of them, and with the
    stage or event above them. Removing the *group* is the path the application takes —
    a reservation write drops a group and its reservation in one diff, and this row goes with
    the group — and ``delete-orphan`` on ``TournamentEventStageGroup.reservation_link``
    handles it through the ORM before the constraint ever has to.
    """

    __tablename__ = "tournament_event_group_reservations"
    __table_args__ = (
        # One group maps to at most one reservation — the 1:1, said as the key rather
        # than as a separate UNIQUE beside a synthetic id, because the group IS this
        # row's identity. Nothing else about the mapping needs naming.
        PrimaryKeyConstraint("group_id", name="pk_tournament_event_group_reservations"),
        # "My group is my own stage's group".
        ForeignKeyConstraint(
            ["stage_id", "group_id"],
            [
                "tournament_event_stage_groups.stage_id",
                "tournament_event_stage_groups.id",
            ],
            name="fk_tournament_event_group_reservations_stage_id_group_id",
            ondelete="CASCADE",
        ),
        # "My reservation is my own event's reservation".
        ForeignKeyConstraint(
            ["event_id", "reservation_id"],
            [
                "tournament_event_reservations.event_id",
                "tournament_event_reservations.id",
            ],
            name="fk_tournament_event_group_reservations_event_id_reservation_id",
            ondelete="CASCADE",
        ),
        # "My stage is my own event's stage" — the leg that ties the other two together.
        # Drop it and this row can hand one event's stage another event's reservation
        # with every other constraint satisfied. See the class docstring.
        ForeignKeyConstraint(
            ["event_id", "stage_id"],
            ["tournament_event_stages.event_id", "tournament_event_stages.id"],
            name="fk_tournament_event_group_reservations_event_id_stage_id",
            ondelete="CASCADE",
        ),
        # Postgres indexes the REFERENCED key of a foreign key, never the referencing
        # columns. The primary key (``group_id``) covers nothing that leads with
        # ``event_id``, so both remaining legs — and the reservation-delete and
        # stage-delete cascades through them — would otherwise be sequential scans.
        Index(
            "ix_tournament_event_group_reservations_event_id_reservation_id",
            "event_id",
            "reservation_id",
        ),
        Index(
            "ix_tournament_event_group_reservations_event_id_stage_id",
            "event_id",
            "stage_id",
        ),
    )

    #: The mapped group, and this row's whole identity. Half of the group leg's
    #: composite key; populated by the unit of work through the :attr:`group`
    #: relationship, which fills ``stage_id`` in the same move.
    group_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    #: The group's stage — half of the group leg, and half of the third leg that ties
    #: this row's ``event_id`` to it. Not reached through the group, because a foreign
    #: key compares columns and this row is the only place the two sides meet.
    stage_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    #: The reservation's event — half of the reservation leg, and half of the third leg.
    #: Populated through the :attr:`reservation` relationship, which fills
    #: ``reservation_id`` in the same move; at CREATE the event has no id yet, so this
    #: has to come from the object graph rather than a literal.
    event_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    #: The mapped reservation. ``NOT NULL`` — see the class docstring.
    reservation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    #: The group side. Populates ``group_id`` AND ``stage_id`` — one relationship over a
    #: composite foreign key fills every column of its leg.
    group: Mapped["TournamentEventStageGroup"] = relationship(
        back_populates="reservation_link"
    )

    #: The reservation side. Populates ``reservation_id`` AND ``event_id``, the same
    #: way.
    #:
    #: ``lazy="joined"``, NOT ``selectin``, and that is a statement count rather than a
    #: style: this is a **many-to-one**, so a join adds columns and never multiplies
    #: rows — the reservation rides along in the query that loads these join rows, for
    #: no extra statement. ``selectin`` reads identically and costs one more statement
    #: on every page that touches a group. (The one-to-many collections on this path
    #: stay ``selectin``, where a join WOULD fan the parent rows out.)
    #:
    #: Eager either way, because async SQLAlchemy raises rather than emitting a lazy
    #: load, and every reader of a group's reservation goes through here.
    reservation: Mapped["TournamentEventReservation"] = relationship(lazy="joined")
