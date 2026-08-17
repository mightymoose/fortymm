import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    PrimaryKeyConstraint,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.tournament_event_group_reservation import (
        TournamentEventGroupReservation,
    )
    from app.models.tournament_event_reservation import TournamentEventReservation
    from app.models.tournament_event_stage import TournamentEventStage


class TournamentEventStageGroup(Base):
    """One **group** of a stage — an ordered set of entrants who play all-play-all.

    This row is what ``tournament_event_groups`` used to be, with one of its two faces
    removed. A "group" said two things at once: *these entrants play each other* and
    *they play on these tables, in this window*. Those are different claims about
    different things, and the second one moved out — to
    :class:`~app.models.tournament_event_reservation.TournamentEventReservation`, an
    event-parented row a group reaches through
    :class:`~app.models.tournament_event_group_reservation.TournamentEventGroupReservation`.

    So a group carries no ``name``, no window and no tables. It carries who is in it
    (through the fixtures whose composite foreign key names it) and where it stands in
    its stage's order. Everything else a reader used to get off a group now comes from
    the mapped reservation, which is what :func:`app.tournament_reservations.group_read`
    composes the unchanged wire ``Group`` out of.

    **The parent is the stage.** It has to be: a fixture's composite foreign key is
    ``(stage_id, group_id) → (stage_id, id)``, and a fixture carries ``stage_id`` and no
    ``event_id`` at all (ADR 20260815 dropped it). A row a fixture names must share a
    parent column with that fixture, so the group keeps exactly the parent the group row
    had. The reservation is free to hang off the event instead, and does, because
    nothing points at a reservation with a composite key through a fixture.

    **A group's identity freezes once a draw exists** (ADR-0786), exactly as the group
    set froze before it — ``app.tournament_events._enforce_group_set_frozen`` is the
    409, and the composite foreign key underneath is the backstop. The *reservation's*
    attributes do not freeze: a director may re-name, re-table and re-window one
    mid-event, because none of that is identity.

    **The label is derived, not stored.** A group had a ``name`` for as long as it was
    also a reservation and the director typed one. A group's own label is a function of
    its ``position`` (``app.draws.group_label``) — nothing writes it and nothing stores
    it. The wire serves no ``groups[].name`` at all: ``GroupRead`` is ``id`` /
    ``position`` / ``reservation_id``, and the director-typed name lives where it is
    actually stored, on ``reservations[].name``.

    ``id`` is a **server-minted uuid** — ``gen_random_uuid()`` — inherited unchanged
    from the group row this splits, along with ``tournament_fixtures.group_id``'s type
    and the composite-foreign-key target below."""

    __tablename__ = "tournament_event_stage_groups"
    __table_args__ = (
        # Named explicitly rather than left to Postgres' ``<table>_pkey`` default, so
        # the model and the migration describe the SAME constraint. They are two
        # independent descriptions of one schema and only the models are under test
        # (``pytest`` builds with ``create_all`` and never runs a migration), so a
        # name that appears in one and not the other is drift nothing would catch.
        PrimaryKeyConstraint("id", name="pk_tournament_event_stage_groups"),
        # The target of the fixture's composite foreign key — and of the join row's
        # group leg. SQL can only reference a unique set of columns, and the *pair* is
        # what carries "my group is my own stage's group". Redundant against the primary
        # key as a uniqueness claim (a uuid id is unique on its own), and that is
        # exactly what it is for; inherited verbatim from ``tournament_event_groups``,
        # whose own ``UNIQUE (stage_id, id)`` said the same thing about the same
        # fixtures. It earns its index twice over anyway: ``stage_id`` leads, so it
        # answers "the groups of this stage" (every read there is), the stage-delete
        # cascade's lookup, and the referential check of both composite foreign keys —
        # none of which the single-column primary key's index can serve.
        UniqueConstraint(
            "stage_id", "id", name="uq_tournament_event_stage_groups_stage_id_id"
        ),
        # Two groups of one stage never share a place in its order — the guarantee
        # ``app.tournament_reservations`` makes by construction (it stamps
        # ``range(len(...))``) said here as a constraint.
        #
        # DEFERRABLE INITIALLY DEFERRED, for the reason every sibling ``position``
        # constraint is: the groups of a stage are written as an id-keyed diff, and a
        # diff **re-orders** — patching groups C, A, B back as B, C, A moves each row
        # onto a position its neighbour has not vacated yet, and SQLAlchemy cannot emit
        # three UPDATEs as one statement. Checked immediately, the constraint would
        # refuse a transaction whose END state is perfectly unique, i.e. it would forbid
        # reordering — which is the one gesture the payload's order exists to express.
        UniqueConstraint(
            "stage_id",
            "position",
            name="uq_tournament_event_stage_groups_stage_id_position",
            deferrable=True,
            initially="DEFERRED",
        ),
    )

    #: The group's identity, and what a fixture's ``group_id`` holds — a uuid the
    #: **database** mints. This is the id every group identifier the API serves carries:
    #: ``groups[].id``, ``fixture.group_id`` and ``GroupStandingsRead.group_id`` are all
    #: this column, projected. The reservation's own id is not on the wire at all.
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    #: A group's parent is its STAGE (ADR 20260815) — the one column it must share with
    #: the fixtures that name it. Always the event's stage at position 0 in practice
    #: (decision 3), but that placement is not this column's job to enforce;
    #: ``app.tournament_reservations.apply_event_reservations`` resolves the stage
    #: before it writes.
    stage_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournament_event_stages.id", ondelete="CASCADE"),
        nullable=False,
    )
    #: Where this group sits in its stage's order: 0-based, contiguous, assigned by the
    #: server from the group's index in the list it was sent in.
    #:
    #: Load-bearing, not decoration (ADR 20260801, "Groups carry an explicit
    #: ``position``"): the snake seeds against this order, so a re-order deals a draw
    #: that still cuts but seeds differently — invisible to the type checker. It is also
    #: what a group's label derives from, and what the projection reports as
    #: ``groups[].position``.
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    # There is deliberately no ``name``, no ``slot_date``/``slot_start``/``slot_end``
    # and no tables relationship. All five moved to ``tournament_event_reservations``,
    # which is what those five things were always about — a set of tables for a window
    # of time — and which a group reaches through the join below.
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    #: The stage this group hangs off — always the event's stage 0 in practice, but
    #: nothing on this relationship enforces that (see ``stage_id``).
    stage: Mapped["TournamentEventStage"] = relationship(back_populates="groups")

    #: The join row that maps this group to its reservation — **the write side**.
    #:
    #: ``uselist=False`` because the join carries a primary key on the group column: one
    #: group maps to at most one reservation, which is the whole shape of the 1:1 this
    #: slice keeps. ``delete-orphan`` is what makes a removed group take its mapping
    #: with it, and ``passive_deletes`` + the FK's ``ON DELETE CASCADE`` covers every
    #: path that does not load the collection first. In this slice the mapping is never
    #: absent — ``app.tournament_reservations`` writes a group and its reservation
    #: together on every path — so the ``reservation`` view below is total in
    #: practice. The type stays non-optional to say so.
    reservation_link: Mapped["TournamentEventGroupReservation"] = relationship(
        back_populates="group",
        cascade="all, delete-orphan",
        passive_deletes=True,
        # ``joined``, NOT ``selectin``, for two reasons that happen to agree.
        #
        # It is a ONE-TO-ONE, so a join adds columns and never multiplies group rows —
        # this row and the reservation beyond it both ride along in whatever statement
        # loads the group, for no statement of their own. That is what keeps the split
        # free: a page costs exactly what it did when a group was a single row.
        #
        # And a chained ``selectin`` does not survive every path a group is loaded by.
        # ``TournamentEvent.groups`` is a VIEWONLY ``secondary=`` association, and a
        # group reached through it came back with a ``selectin`` child still unloaded —
        # so the ``reservation`` property below lazy-loaded, which under async is a
        # ``MissingGreenlet`` rather than a slow read. A joined load is part of the
        # parent's own SELECT, so no load path can leave it behind.
        lazy="joined",
        uselist=False,
    )

    @property
    def reservation(self) -> "TournamentEventReservation":
        """This group's reservation — the read side, over the *same* rows the write side
        loads.

        A plain Python property and deliberately NOT a second relationship. A viewonly
        ``secondary=`` association straight to ``tournament_event_reservations`` would
        read the same way, and it was the obvious shape — but it is a second loader path
        to one row. Every eager load of a group would then walk both chains, doubling
        the statements the reservation side costs on a page of events, and, worse,
        splitting
        which chain a query has to remember: ``apply_event_reservations`` asks for
        ``reservation_link → reservation → tables``, so a reader coming back through the
        *other* path would find it unloaded and lazy-load it — which is a
        ``MissingGreenlet`` under async, not a slow read.

        As a property there is one chain, ``reservation_link`` is eager, and the
        ``selectinload`` that the write path attaches is exactly the one the read path
        needs.

        Total on anything the **application** wrote: ``app.tournament_reservations`` is
        the one write seam and every arm of it writes a group and a reservation
        together. That is an invariant of the seam, not a constraint the database
        enforces — the join table has no group-side NOT NULL, and a direct-to-database
        seed can make a bare group (one test deliberately does, to prove the fixture's
        composite foreign key refuses a cross-stage reference). Nothing projects such a
        row today. The change that lets a group exist without a reservation has to
        revisit this property, ``reservation_link``'s non-optional type, and
        :func:`app.tournament_reservations.group_read` together.
        """
        return self.reservation_link.reservation
