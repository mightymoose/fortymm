import uuid
from datetime import date, datetime, time
from typing import TYPE_CHECKING

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Integer,
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
    from app.models.tournament_event_pool_table import TournamentEventPoolTable


class TournamentEventPool(Base):
    """One pool of an event — a slice of the venue reserved for a window of time, as a
    **row** (ADR 20260801 "a pool belongs to its event, not to the event's draw
    settings").

    It used to be an element of ``tournament_events.pools``: a JSONB array of
    ``{id, name, slot, table_ids}`` value-objects. That is why a fixture's ``pool_id``
    could name a pool that did not exist — there was no key to point at — and why the
    integrity of that reference had to be procedural (``_enforce_pool_set_frozen``,
    ADR-0786). It is a row now, so the reference is a foreign key, and specifically the
    **composite** one on :class:`~app.models.tournament_fixture.TournamentFixture`:
    ``(event_id, pool_id) → (event_id, id)``, which says the thing a plain FK to ``id``
    cannot — that a fixture's pool belongs to *that fixture's own event*.

    **The parent is the event, not the event's draw settings row.** The 2026-07-26 ADR
    sketched ``draw_settings_id`` here; the composite FK above is what makes that
    impossible, because ``tournament_event_draw_settings`` deliberately carries no
    ``event_id`` and so shares no column with a fixture. The ADR named at the top is
    that correction, and it also holds the rest of the reasoning: a pool is a 1:N
    collection of entities with their own identity, not a scalar of a configuration.

    **The slot is ``date``/``time``, not ``timestamptz``, and that is deliberate** — the
    one place in this schema where api/CLAUDE.md's "datetimes are timezone-aware,
    always" does not apply, because these three columns are not datetimes. A pool's
    window is *wall-clock*: the director types "the 13th, 09:00 to 12:30" and means it
    in the venue's own frame, which is carried once by ``tournament_events.timezone``
    and anchored into real instants at the seam that needs instants
    (``app.schedule_solves``). Storing an instant here would bake that anchoring into
    the column, so correcting the event's timezone would have to rewrite every pool
    window rather than re-read the same wall-clock in the new zone (ADR "tournament
    times are timezone-aware instants" — "wall-clock is preserved across a timezone
    edit"). The wire shape is unchanged: the ``Slot`` value-object's ``YYYY-MM-DD`` /
    ``HH:MM`` strings compose from and to these columns at the boundary
    (``app.tournament_pools``).

    ``id`` is a **server-minted uuid** — ``gen_random_uuid()``, the same default a venue
    table's id has. It was a client-supplied string (``p-1-…``) for as long as a pool
    was a JSONB value-object with nothing to mint it; the column,
    ``tournament_fixtures.pool_id`` and ``PoolId`` moved onto ``uuid`` in one step,
    because they are one representation and a half-moved one is not a state worth
    having."""

    __tablename__ = "tournament_event_pools"
    __table_args__ = (
        # The target of the fixture's — and the reservation's — composite foreign key:
        # SQL can only reference a unique set of columns, and the *pair* is what carries
        # "my pool is my own event's pool". Redundant against the primary key as a
        # uniqueness claim (a uuid id is unique on its own), and that is exactly what
        # the ADR says it is for: "``UNIQUE (event_id, id)`` is redundant against the
        # primary key and exists purely as the target that composite FK needs."
        #
        # It earns its index twice over anyway: ``event_id`` leads, so it answers "the
        # pools of this event" (every read there is), the event-delete cascade's lookup,
        # and the referential check of both composite foreign keys — none of which the
        # single-column primary key's index can serve.
        UniqueConstraint(
            "event_id", "id", name="uq_tournament_event_pools_event_id_id"
        ),
        # Two pools of one event never share a place in its order — the guarantee
        # ``stored_pools`` made by construction (it stamps ``range(len(pools))``) said
        # here as a constraint, now that pools are rows and a constraint is available.
        #
        # DEFERRABLE INITIALLY DEFERRED, for the reason
        # ``uq_tournament_tables_tournament_position`` is: the pools of an event are
        # written as an id-keyed diff, and a diff **re-orders** — patching pools C, A, B
        # back as B, C, A moves each row onto a position its neighbour has not vacated
        # yet, and SQLAlchemy cannot emit three UPDATEs as one statement. Checked
        # immediately, the constraint would refuse a transaction whose END state is
        # perfectly unique, i.e. it would forbid reordering — which is the one gesture
        # the payload's order exists to express.
        UniqueConstraint(
            "event_id",
            "position",
            name="uq_tournament_event_pools_event_id_position",
            deferrable=True,
            initially="DEFERRED",
        ),
    )

    #: The pool's identity, and what a fixture's ``pool_id`` holds — a uuid the
    #: **database** mints (ADR 20260801's DDL: ``id uuid PRIMARY KEY``).
    #:
    #: **The primary key is ``id`` alone**, where it was ``(event_id, id)``. The pair
    #: was never about the fixture's foreign key (that references the ``UNIQUE
    #: (event_id, id)`` above, which stands either way) — it was there because a
    #: *client-minted* string is only unique per event: two events of one tournament
    #: could each hold a “pool-a”, and a bare ``id`` key would have imposed
    #: platform-wide uniqueness on a string nothing above the database controlled. A
    #: minted uuid is globally unique by construction, so the reason is gone and the
    #: narrower key is the honest one: a pool id names one pool, anywhere.
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournament_events.id", ondelete="CASCADE"),
        nullable=False,
    )
    #: ``Text``, not ``String(255)``: the write boundary floors a pool name at one
    #: character and puts no ceiling on it, so a column with one would 500 on a payload
    #: the schema accepted.
    name: Mapped[str] = mapped_column(Text, nullable=False)
    #: Where this pool sits in its event's pool order: 0-based, contiguous, assigned by
    #: the server from the pool's index in the list it was sent in.
    #:
    #: Load-bearing, not decoration (ADR 20260801, "Pools carry an explicit
    #: ``position``"): pool order was carried by the JSONB array's order and by the
    #: lexicographic sort of client-minted ids, and both of those disappear here. The
    #: snake seeds against this order, so under random ids an id-sort would deal a draw
    #: that still cuts but seeds differently — invisible to the type checker.
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    #: The venue-local calendar day of this pool's window. See the class docstring for
    #: why these three are wall-clock columns rather than instants.
    slot_date: Mapped[date] = mapped_column(Date, nullable=False)
    slot_start: Mapped[time] = mapped_column(Time, nullable=False)
    slot_end: Mapped[time] = mapped_column(Time, nullable=False)
    # There is deliberately no ``table_ids`` column. The tables a pool reserves were a
    # NOT NULL JSONB array of table-id strings, which could name a table of another
    # tournament (or of none); they are the ``tables`` relationship below now — rows
    # with composite foreign keys to both sides, so a cross-tournament reservation is
    # not constructible (ADR 20260801, "the tournament-scoping stops at the join
    # table"). The wire shape is unchanged: ``Pool.table_ids`` is composed from those
    # rows, in ``position`` order, by ``app.tournament_pools``.
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    event: Mapped["TournamentEvent"] = relationship(back_populates="pools")

    # The tables this pool reserves (ADR 20260801), in the order the director sent them
    # — which is what ``TournamentEventPoolTable.position`` carries and what
    # ``Pool.table_ids`` is composed from.
    #
    # ``lazy="selectin"`` for the reason ``TournamentEvent.pools`` itself is eager:
    # async SQLAlchemy raises rather than emitting a lazy load, so every reader that
    # reaches a pool's tables — the serializer, the solver's input load, the preview,
    # the re-solve trigger's before/after comparison — would need to remember an option.
    # SQLAlchemy chains it onto the pools' own selectin load, so a page of events pays
    # ONE extra statement however many pools it holds (the
    # ``EXPECTED_TOURNAMENT_*_STATEMENTS`` pins moved by exactly one).
    #
    # ``delete-orphan`` is what the reservation *write* leans on — a table dropped from
    # the submitted list is removed by taking it out of this collection — and
    # ``passive_deletes`` + the FK's ``ON DELETE CASCADE`` is the delete path for
    # everything that does not load the collection first (the event- and
    # tournament-delete cascades, a raw DELETE, psql). Removing the TABLE is the third
    # path, and the ORM is never involved in it at all: that cascade comes off
    # ``tournament_tables``, which has no relationship pointing here.
    tables: Mapped[list["TournamentEventPoolTable"]] = relationship(
        back_populates="pool",
        cascade="all, delete-orphan",
        passive_deletes=True,
        lazy="selectin",
        order_by="TournamentEventPoolTable.position",
    )
