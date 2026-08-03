import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.tournament import TournamentEvent


class TournamentFixture(Base):
    """One planned pairing of an event's draw — a round and a position (and a pool,
    when the draw is pooled), whose sides may still be unknown. A fixture is **not**
    a match: it *materializes* into one once both sides are known (a later slice).

    One table holds every draw type's fixtures, because topology is the *strategy's*
    knowledge, not the schema's (ADR-0786). There is deliberately no ``next_slot_id``:
    single-elim's successor is arithmetic on ``(round, position)``, round-robin has no
    successor at all, and a swiss draw could not know its next round until the current
    one finished. Storing the topology would be a second copy of the truth that churns
    on every re-cut, so ``advance()`` recomputes it from these rows instead.

    **A ``NULL`` side means exactly one thing: TBD** — ``advance()`` will fill it when
    the feeding fixture is decided. Byes are *not* a NULL side; they are the **absence
    of a row** (a byed seed simply has no round-1 fixture and is placed directly into
    round 2). That is why there is no ``is_bye`` flag: it would make NULL mean two
    things, and the "is this side unknown, or is it a bye?" question would have to be
    answered by reading a second column.

    ``pool_id`` is a **foreign key**, and a *composite* one: ``(event_id, pool_id) →
    tournament_event_pools (event_id, id)``. Pools are rows now (ADR 20260801 "a pool
    belongs to its event, not to the event's draw settings"), and the composite form is
    what makes the reference say the thing that actually matters — not merely "this pool
    exists" but "this pool is **my own event's**". A plain FK to
    ``tournament_event_pools.id`` would happily seat one event's fixture in another
    event's pool, and that is the illegal state the ADR is about; it is unrepresentable
    here because the two tables share ``event_id`` and the constraint requires it to
    agree. ``NULL`` means the draw is un-pooled — single-elim, and the knockout stage of
    an rr-then-ko draw. (A composite FK with one NULL member is satisfied vacuously
    under the SQL default MATCH SIMPLE, which is exactly right: an un-pooled fixture
    names no pool to check.)

    The ``UNIQUE (event_id, pool_id, round, position)`` below is the identity a re-cut
    reconciles on, and it is declared **NULLS NOT DISTINCT** (Postgres 15+). Under the
    default (NULLS DISTINCT) a ``NULL`` ``pool_id`` would compare unequal to itself, so
    an *un-pooled* draw — single-elim, every KO fixture — would have **no uniqueness
    guard at all** and could persist the same ``(event, round, position)`` twice. Since
    ``NULL`` here is a real value in the domain ("this draw has no pools"), not a
    missing one, it must be compared as one.
    """

    __tablename__ = "tournament_fixtures"
    __table_args__ = (
        # "My pool is my own event's pool", as one line of DDL (ADR 20260801). The
        # referenced ``(event_id, id)`` is a unique constraint on
        # ``tournament_event_pools`` that exists for no other purpose — SQL can only
        # reference a unique set of columns, and the *pair* is what carries the claim.
        #
        # DEFERRABLE INITIALLY DEFERRED with the default (NO ACTION) delete rule, rather
        # than ``RESTRICT``, because of the **event-delete** path — the same hazard the
        # entry FKs below name. Deleting an event removes its pools through the ORM (the
        # collection is eagerly loaded, so the unit of work issues that DELETE itself)
        # and its fixtures through Postgres' ``ON DELETE CASCADE``, in that order and in
        # two separate statements. An immediately-checked constraint fires between them,
        # on fixtures that are about to be deleted one statement later, and kills the
        # whole delete. Deferring is not a weakening: the pair is checked, in full,
        # before the transaction can commit — a fixture pointing at another event's pool
        # is refused either way, just at COMMIT rather than at the INSERT.
        #
        # Removing a pool a fixture is drawn into is refused before it ever reaches this
        # constraint, by ``_enforce_pool_set_frozen``'s 409 (ADR-0786) — which is now
        # the *second* line of defence rather than the only one.
        ForeignKeyConstraint(
            ["event_id", "pool_id"],
            ["tournament_event_pools.event_id", "tournament_event_pools.id"],
            name="fk_tournament_fixtures_event_id_pool_id",
            deferrable=True,
            initially="DEFERRED",
        ),
        # The identity of a fixture within its draw. NULLS NOT DISTINCT so the guard
        # also covers un-pooled draws, where ``pool_id`` is NULL for every row — see
        # the class docstring.
        UniqueConstraint(
            "event_id",
            "pool_id",
            "round",
            "position",
            name="uq_tournament_fixtures_event_id_pool_id_round_position",
            postgresql_nulls_not_distinct=True,
        ),
        # Every read of a draw is "the fixtures of this event" — ``advance()`` loads
        # the whole set, and the detail BFF loads it per event.
        Index("ix_tournament_fixtures_event_id", "event_id"),
        # A completed match is the trigger to write ``winner_entry_id`` back and re-run
        # ``advance()``, and that path arrives holding a match id, not a fixture id.
        Index("ix_tournament_fixtures_match_id", "match_id"),
        # The index Postgres does NOT create for a REFERENCING column, and under
        # ``ON DELETE RESTRICT`` it is the one that pays for itself: every delete of a
        # ``tournament_tables`` row must prove no fixture references it, which unindexed
        # is a sequential scan of every fixture on the platform per table removed. The
        # same argument ``VenueTable`` makes for its own ``tournament_id``.
        Index("ix_tournament_fixtures_table_id", "table_id"),
    )

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
    #: Names a pool of **this fixture's own event** — half of the composite foreign key
    #: declared above. ``NULL`` = the draw is un-pooled.
    pool_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 1-based.
    round: Mapped[int] = mapped_column(Integer, nullable=False)
    #: 1-based within its round (and pool, when pooled).
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    #: ``NULL`` = TBD, never a bye (byes are the absence of a row).
    #:
    #: ``CASCADE``, not ``RESTRICT``, because of the **event-delete** path:
    #: ``DELETE /tournaments/{id}/events/{id}`` deletes the event with
    #: ``passive_deletes``, so the database cascades to ``tournament_entries`` and
    #: ``tournament_fixtures`` in one statement. ``RESTRICT`` is checked immediately
    #: (it cannot be deferred), so it would make that delete depend on the order
    #: Postgres happens to fire the two cascades in.
    #:
    #: Withdrawal is a *soft*-delete, so it does not touch these rows — but an entry
    #: **can** be hard-deleted elsewhere: ``merge_user`` (``app/account_merge.py``)
    #: DELETEs a guest's duplicate *active* entry when the surviving account is already
    #: entered in the same event. Under this CASCADE that would silently take any
    #: fixtures referencing the guest's entry with it, punching a hole in a cut draw.
    #: The fix belongs in the merge path, not here — and it is **not** to re-point these
    #: columns onto the survivor's entry. That would seat one human in two slots of the
    #: same pool, and because the go-live currency check compares entrant *sets*, the
    #: corrupted draw would silently satisfy it and go live. The merge instead **un-cuts
    #: the event's draw** (a draw cut from a field that double-counted a human is wrong
    #: throughout — its pool sizes and seeding were computed against N+1 entrants), and
    #: the director re-cuts. That un-cut path is only for an **unplayed** draw. Once
    #: play has begun (a fixture here has a ``match_id`` or a ``winner_entry_id`` —
    #: ``draw_has_play``), the draw cannot be un-cut, so instead the guest's colliding
    #: entry is **withdrawn** (soft-deleted, not hard-deleted — these rows survive) and
    #: the exposed guest-vs-survivor self-play match is transferred then voided
    #: (ADR-0788). See ADR-786 and ADR-788; ``_resolve_entry_collisions`` holds both
    #: paths.
    entry_a_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournament_entries.id", ondelete="CASCADE"),
        nullable=True,
    )
    entry_b_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournament_entries.id", ondelete="CASCADE"),
        nullable=True,
    )
    #: Written back when this fixture's match completes (a later slice); until then the
    #: fixture is pending or ready, never decided.
    winner_entry_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournament_entries.id", ondelete="CASCADE"),
        nullable=True,
    )
    #: Set when the fixture materializes into a real match — which only happens once
    #: the tournament is ``live`` (ADR-0786). ``NULL`` before then.
    match_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("matches.id", ondelete="SET NULL"),
        nullable=True,
    )
    #: A **placement**'s table — a real **foreign key** into ``tournament_tables``
    #: (ADR 20260801, "a placement names a real table, and only that is an invariant").
    #: ``NULL`` = unassigned; ``(table_id, scheduled_start) = (NULL, NULL)`` means the
    #: fixture is unplaced (ADR-0790).
    #:
    #: This is the one placement claim that is an **invariant** rather than a flag. The
    #: other three — the table belongs to the fixture's pool, the start falls inside the
    #: pool's window, nothing is double-booked — are statements about a *relationship*
    #: between things that each legitimately move while the other stands, so they stay
    #: derived on read (ADR-0790, undisturbed). "This id names a table" is not that: it
    #: is whether the reference resolves at all, and a placement whose table does not
    #: exist is not a state the director chose but a dangling pointer nothing downstream
    #: can render. It was soft only because there was no table to point at.
    #:
    #: ``ON DELETE RESTRICT``, deliberately, and deliberately unlike ``pool_id``'s
    #: procedural freeze: ``SET NULL`` would destroy information on an *unrelated* write
    #: — the fixture would stop being "placed at a table that vanished" and become
    #: indistinguishable from "nobody ever placed this", as an invisible side effect of
    #: editing the venue. The database refuses by default and the director says yes on
    #: purpose, through the tournament-edit verb's named 409 and its unplace-and-remove
    #: opt-in. (A *pool* that merely reserves a table gets the quiet treatment instead —
    #: the table drops out of its ``table_ids``.)
    #:
    #: **The Python/wire type stays ``str``** while the column is a real ``uuid``
    #: (``as_uuid=False``): a table id crosses this codebase as its canonical text in
    #: three places at once — here, in a pool's ``table_ids``, and in the solver's
    #: ``TableId`` — and they are one representation, moved together, not one at a
    #: time. The database is what holds the type; ``str(table.id)`` is what everything
    #: above it compares. A non-``uuid`` string can therefore still be *sent*, and it
    #: is refused at the placement boundary by the same 422 an unknown id gets, rather
    #: than splitting one refusal ("this names no table") into two a client must tell
    #: apart.
    table_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("tournament_tables.id", ondelete="RESTRICT"),
        nullable=True,
    )
    #: A **placement**'s predicted start — a ``timestamptz`` **instant**
    #: (``TIMESTAMP WITH TIME ZONE``), the server composes it from the event's Slot
    #: wall-clock components anchored by the event ``timezone`` (see the
    #: 2026-07-19 ADR "tournament times are timezone-aware instants", which
    #: supersedes ADR-0790's naive-wall-clock exemption on the representation
    #: question). A ``DateTime(timezone=True)`` column yields an aware datetime.
    #: ``NULL`` = unassigned.
    scheduled_start: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: When this fixture was **called** — the moment its placement stopped being an
    #: estimate and became a promise (ADR "the schedule is solved, the call is
    #: pinned"). ``NULL`` = unpinned: the solver may still move it freely. Set (with
    #: both players notified, in one transaction) it becomes a hard constraint in
    #: every later solve. A ``timestamptz`` **instant** (the call's ``now``), like
    #: ``scheduled_start`` above — both moved onto timezone-aware instants by the
    #: 2026-07-19 ADR "tournament times are timezone-aware instants" (superseding
    #: ADR-0790's naive exemption).
    pinned_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: How many times the players were told about this fixture's placement — the
    #: initial call plus every "moved"/"cancelled" correction. 0 = never notified.
    #: A count, not a flag, because the UI prices a director's re-drag by exactly
    #: this ("both players were told Table 3 — moving sends a correction").
    call_notified_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
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

    event: Mapped["TournamentEvent"] = relationship(back_populates="fixtures")
