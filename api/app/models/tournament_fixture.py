import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    DateTime,
    ForeignKey,
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

    ``pool_id`` is a **string ref, not a foreign key**: pools are JSONB value-objects
    on the event (``{id, name, slot, table_ids}`` — a slice of the venue), so there is
    no table to point at. Integrity is procedural: the event's pool *id set* freezes
    while a draw exists. ``NULL`` means the draw is un-pooled — single-elim today, and
    the knockout stage of a pools-then-knockout draw type once #787 adds one.

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
    #: Names a ``Pool`` value-object in the event's own ``pools`` JSONB — deliberately
    #: not a FK (there is no pools table). ``NULL`` = the draw is un-pooled.
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
    #: A **placement**'s table: a *string ref* into the tournament's
    #: ``table_catalogue`` JSONB (names a ``TournamentTable.id``), the same string-ref
    #: pattern as ``pool_id`` — deliberately not a foreign key, there is no tables
    #: table. ``NULL`` = unassigned. ``(table_id, scheduled_start) = (NULL, NULL)``
    #: means the fixture is unplaced (ADR-0790).
    table_id: Mapped[str | None] = mapped_column(Text, nullable=True)
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
