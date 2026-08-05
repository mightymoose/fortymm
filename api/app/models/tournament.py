import enum
import uuid
from datetime import date, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.tournament_entry import TournamentEntry
    from app.models.tournament_event_draw_settings import TournamentEventDrawSettings
    from app.models.tournament_event_pool import TournamentEventPool
    from app.models.tournament_fixture import TournamentFixture
    from app.models.tournament_table import VenueTable


class TournamentStatus(enum.Enum):
    draft = "draft"
    published = "published"
    live = "live"
    archived = "archived"


class EventFormat(enum.Enum):
    singles = "singles"
    doubles = "doubles"
    teams = "teams"


class DrawType(enum.Enum):
    # The draw types that RUN — nothing else (ADR "a draw type is a seeded row, and the
    # enum holds only what runs"). A member exists here if and only if
    # ``app.draws.strategy_for`` dispatches it to a strategy and
    # ``app.results.results_for`` reads it back out. That is what makes an unimplemented
    # draw type a 422 at the REQUEST BOUNDARY, named by Pydantic with the valid values,
    # rather than an event a director configures, enters players into, and only
    # discovers is impossible at the moment they cut it. Adding a format is a member
    # *plus* its strategies: the exhaustive ``match`` at every dispatch site is a type
    # error until all of them are written.
    #
    # No docstring on purpose: Pydantic emits an enum's ``__doc__`` as the OpenAPI
    # ``description``, so prose here would cross the wire into both generated clients.
    #
    # Member names use underscores; the *values* keep the hyphenated wire strings
    # from the front-end prototype. They are no longer a Postgres enum: a draw type
    # is persisted as the ``draw_types.key`` slug on an event's settings row, so
    # these values are that table's primary keys (a migration test asserts the two
    # agree) as well as the JSON the clients send.
    single_elim = "single-elim"
    round_robin = "round-robin"
    rr_then_ko = "rr-then-ko"
    swiss = "swiss"


class Tournament(Base):
    """A tournament owned by the user who created it, run on exactly one league —
    the rating ladder its eligibility rules are judged on (ADR-0783). It was
    "standalone, not tied to a league" until an event's rating predicate needed a
    ladder to mean anything; ``league_id`` is NOT NULL, and an omitted one resolves
    to the default league at create. Names are owner-scoped, not globally unique,
    so there's no unique constraint on ``name``. ``address`` is a typed JSONB
    value-object decoded to a Pydantic model at the API boundary; the venue catalogue
    is **not** — it is ``tables``, a real child table (ADR 20260801 "a placement names
    a real table")."""

    __tablename__ = "tournaments"
    __table_args__ = (
        Index(
            "ix_tournaments_created_by_user_id_created_at",
            "created_by_user_id",
            text("created_at DESC"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[TournamentStatus] = mapped_column(
        Enum(
            TournamentStatus,
            name="tournament_status",
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
        server_default=TournamentStatus.draft.value,
    )
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    # SQL NULL means "this tournament has no venue" — a real state at every status
    # (announced before the venue is booked, or deliberately withheld). When an
    # address *is* stored it is always fully geocoded, so no reader ever meets a
    # half-populated address. See the 2026-07-26 amendment to ADR
    # ``20260725-a-venues-coordinates-are-geocoded-server-side-and-not-null``.
    #
    # ``none_as_null=True`` is load-bearing, not decoration. A plain JSONB column
    # serializes Python ``None`` into the JSON ``null`` *literal* — a present value of
    # JSONB type ``null`` — so "no venue" would have TWO stored representations: the
    # literal for rows the app wrote, and a true SQL NULL for rows written by hand or
    # by a migration backfill. Both deserialize back to Python ``None``, which is
    # exactly why the divergence is invisible from Python and stays invisible until a
    # reader writes the obvious ``Tournament.address.is_(None)`` and silently matches
    # zero rows. With this flag, ``None`` persists as a real SQL NULL and ``IS NULL``
    # is the correct, only predicate for "has no venue".
    address: Mapped[dict[str, Any] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    # There is deliberately no ``table_catalogue`` column. The venue catalogue was a
    # NOT NULL JSONB list of ``{id, label, court}`` value-objects keyed by
    # client-supplied strings; it is the ``tables`` relationship below now, so a
    # placement can foreign-key the table it names (ADR 20260801).
    #
    # The ladder that judges this tournament's eligibility rules (ADR-0783).
    # RESTRICT on delete, like ``Match.league_id``: the league a tournament is run
    # on cannot be deleted out from under it.
    league_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("leagues.id", ondelete="RESTRICT"),
        nullable=False,
    )
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
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

    events: Mapped[list["TournamentEvent"]] = relationship(
        back_populates="tournament",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="TournamentEvent.created_at",
    )

    # The venue catalogue (ADR 20260801). Ordered by the director's own order, which
    # is what ``VenueTable.position`` carries.
    #
    # ``lazy="selectin"``, and eagerly rather than by an option at each call site, for
    # the reason ``TournamentEvent.draw_settings`` is eager: async SQLAlchemy raises
    # instead of emitting a lazy load, so every one of the ~10 places that loads a
    # ``Tournament`` and reads its catalogue (the serializer, the dashboard panel, the
    # call copy, the solver's input load, the preview) would need to remember an
    # option. ``selectin`` and not ``joined`` because this is a one-to-many: joined
    # would multiply the parent rows, which the list endpoint's ordering could not
    # survive. It batches over the whole result set, so the tournament LIST pays ONE
    # extra statement however many tournaments it returns — the statement-count pins
    # in ``tests/test_tournaments.py`` moved by exactly one.
    #
    # ``passive_deletes`` + the FK's ``ON DELETE CASCADE`` is the delete path, the same
    # shape ``events`` uses: deleting a tournament takes its tables with it.
    #
    # With one honest difference from ``events``, caused by the eager load above: the
    # collection is already in the session when the delete runs, so the unit of work
    # issues the child ``DELETE`` itself and the database cascade never fires on the
    # ORM path. It is not decoration — it is what covers every path that does NOT load
    # the collection first (a raw ``DELETE``, psql, a future bulk reap), and
    # ``test_the_venue_tables_fk_cascades_in_the_database`` is one of those paths
    # precisely because the ORM-path test stays green without it.
    #
    # ``delete-orphan`` is what the catalogue *write* leans on — a table dropped from
    # the submitted list is removed by taking it out of this collection.
    tables: Mapped[list["VenueTable"]] = relationship(
        back_populates="tournament",
        cascade="all, delete-orphan",
        passive_deletes=True,
        lazy="selectin",
        order_by="VenueTable.position",
    )


class TournamentEvent(Base):
    """An event (a draw) within a tournament — its own format, draw type, entry
    rules, schedule slot, and pool layout. The value-objects (``slot``,
    ``match_settings``, ``predicates``) are typed JSONB decoded to Pydantic models at
    the API boundary; the pool layout is **not** — it is ``pools``, a real child table
    (ADR 20260801 "a pool belongs to its event")."""

    __tablename__ = "tournament_events"
    __table_args__ = (
        Index(
            "ix_tournament_events_tournament_id_created_at",
            "tournament_id",
            text("created_at DESC"),
        ),
        # Mirrors the CHECKs in migration 0010 so ``Base.metadata.create_all``
        # (how pytest builds its schema) carries them too. A NULL max_players is
        # the "no cap" sentinel (ADR-0935) and passes the CHECK; a present cap
        # must be positive, and an entry fee must be non-negative.
        CheckConstraint(
            "max_players > 0", name="ck_tournament_events_max_players_positive"
        ),
        CheckConstraint(
            "entry_fee >= 0", name="ck_tournament_events_entry_fee_non_negative"
        ),
        # Redundant against the primary key, and there for exactly one purpose: it is
        # the target ``tournament_event_pool_tables`` foreign-keys
        # ``(tournament_id, event_id)`` against, which is the leg that forces a
        # reservation's denormalized ``tournament_id`` to be the tournament its pool's
        # event actually belongs to (ADR 20260801). Without it the other two legs of
        # that row are satisfiable by a cross-tournament reservation — see
        # ``TournamentEventPoolTable``.
        UniqueConstraint(
            "tournament_id", "id", name="uq_tournament_events_tournament_id_id"
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
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    format: Mapped[EventFormat] = mapped_column(
        Enum(
            EventFormat,
            name="event_format",
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )
    # The event's draw configuration, as a row (ADR "an event's draw configuration
    # is a row, not a column"). NOT NULL, and the FK lives HERE on the parent —
    # the ``matches.match_settings_id`` shape — because that is the only way SQL
    # can say "every event has exactly one settings row". ``RESTRICT`` so a
    # settings row cannot be deleted out from under the event that points at it.
    #
    # There is deliberately NO ``draw_type`` column beside it. The settings row is
    # the only home for that fact, so an event whose draw type disagrees with its
    # settings is not a state anyone can construct.
    #
    # ``index=True`` because Postgres does not index a REFERENCING column, and this
    # one is on a routine DELETE path: every ``tournament_event_draw_settings`` row
    # we delete (the delete-orphan on event delete, and ``reap_draw_settings`` on
    # tournament delete) makes the RESTRICT trigger run
    # ``SELECT 1 FROM tournament_events WHERE draw_settings_id = $1 FOR KEY SHARE``.
    # Unindexed that is a sequential scan of EVERY event on the platform per
    # settings row deleted, not per event in the tournament (measured on 50k
    # events: 7.9ms → 0.08ms), and ``reap_draw_settings``' ``NOT EXISTS`` anti-join
    # has nothing to probe either. The sibling ``matches.match_settings_id`` is
    # deliberately left unindexed and that asymmetry is intentional: match settings
    # rows are never deleted, so its RI check never runs.
    draw_settings_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournament_event_draw_settings.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    # NULL means "no cap" (ADR-0935). A present cap is positive by CHECK.
    max_players: Mapped[int | None] = mapped_column(Integer, nullable=True)
    entry_fee: Mapped[float] = mapped_column(Numeric(8, 2), nullable=False)
    # The venue timezone (IANA name, e.g. ``America/Chicago``) that ANCHORS this
    # event's wall-clock ``slot`` windows to real instants (ADR "tournament times are
    # timezone-aware instants"). NOT NULL: a wall-clock window without a zone cannot be
    # placed on the same instant axis as ``now``, which is the defect the ADR fixes. It
    # does not reshape the ``slot`` JSONB — it is the frame those strings are read in.
    # Validated as a real IANA zone at the API boundary (``EventTimezone``).
    timezone: Mapped[str] = mapped_column(String(64), nullable=False)
    # There is deliberately no ``entered`` column. The registration count is
    # derived from the live ``entries`` below (ADR-0016) — a stored counter is a
    # second copy of the truth that can drift from the rows it counts.
    slot: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    match_settings: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    predicates: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )
    # There is deliberately no ``pools`` JSONB column. An event's pools were a NOT NULL
    # JSONB list of ``{id, name, slot, table_ids}`` value-objects keyed by
    # client-supplied strings; they are the ``pools`` relationship below now, so a
    # fixture can foreign-key the pool it names — and name one of its OWN event's pools
    # (ADR 20260801 "a pool belongs to its event").
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    tournament: Mapped["Tournament"] = relationship(back_populates="events")

    # Eager by default, and eager as a JOIN. Async SQLAlchemy raises rather than
    # emitting a lazy load, so a reader that reaches ``event.draw_settings`` on an
    # event some other loader fetched would blow up unless every one of those ~13
    # loaders remembered an option — declaring the strategy once on the
    # relationship is what makes that impossible to get wrong.
    #
    # ``joined`` rather than ``selectin`` because this is a NOT NULL many-to-one
    # onto a one-row-per-event table: it rides along in the query that loads the
    # event instead of costing a second round trip, so it moves NO statement count
    # anywhere (the ``EXPECTED_TOURNAMENT_*_STATEMENTS`` pins in
    # ``test_tournaments.py`` are unchanged by it), and a many-to-one join cannot
    # multiply rows, so it is safe under the LIMIT/OFFSET the list queries use.
    # ``innerjoin=True`` because the FK is NOT NULL — an outer join would be
    # asking about an absence the schema has ruled out.
    #
    # ``delete-orphan`` (with ``single_parent=True``, which SQLAlchemy requires to
    # cascade a delete *up* a many-to-one) because a settings row exists only to
    # configure the event pointing at it: deleting the event through the ORM must
    # take its settings row with it, or every event delete leaks a row nothing
    # will ever reference again. The unit of work orders the two DELETEs for us —
    # ``tournament_events`` holds the FK, so it goes first and the ``RESTRICT`` is
    # never tripped.
    #
    # This does NOT cover the tournament-delete path: ``Tournament.events`` is
    # ``passive_deletes=True``, so events are removed by Postgres' ``ON DELETE
    # CASCADE`` without the ORM ever seeing them, and a database cascade does not
    # run Python-side cascades. ``app.tournament_draw_settings.reap_draw_settings``
    # is what closes that path.
    draw_settings: Mapped["TournamentEventDrawSettings"] = relationship(
        back_populates="events",
        lazy="joined",
        innerjoin=True,
        cascade="all, delete-orphan",
        single_parent=True,
    )

    entries: Mapped[list["TournamentEntry"]] = relationship(
        back_populates="event",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="TournamentEntry.created_at",
    )

    # The event's pools, as rows (ADR 20260801), in the director's own order — which is
    # what ``TournamentEventPool.position`` carries, and what the snake seeds against.
    #
    # ``lazy="selectin"``, and declared here rather than as an option at each call site,
    # for the reason ``Tournament.tables`` and ``draw_settings`` are eager: async
    # SQLAlchemy raises instead of emitting a lazy load, so each of the ~8 readers of an
    # event's pools (``event_pools`` and everything through it — the serializer, the
    # draw config, the solver's input load, the preview, the call copy, the dashboard)
    # would have to remember one. ``selectin`` and not ``joined`` because this is a
    # one-to-many: a joined load would multiply the event rows, which the tournament
    # list's LIMIT/OFFSET could not survive. It batches over the whole result set, so a
    # page of events costs ONE extra statement however many events it holds.
    #
    # ``delete-orphan`` is what the pools *write* leans on — a pool dropped from the
    # submitted list is removed by taking it out of this collection — and
    # ``passive_deletes`` + the FK's ``ON DELETE CASCADE`` is the delete path for
    # everything that does not load the collection first (the tournament delete's single
    # cascading statement, a raw DELETE, psql).
    pools: Mapped[list["TournamentEventPool"]] = relationship(
        back_populates="event",
        cascade="all, delete-orphan",
        passive_deletes=True,
        lazy="selectin",
        order_by="TournamentEventPool.position",
    )

    # The event's draw: every fixture the cut produced (ADR-0786). Empty until the
    # draw is cut; a re-cut replaces the set wholesale, which is what
    # ``delete-orphan`` buys.
    #
    # Ordered pool → round → position — the same total order the read path's
    # ``fixtures_by_event`` loader applies, and the one the fixtures' own
    # ``UNIQUE (event_id, pool_id, round, position)`` makes a total order at all. The
    # ``pool_id`` used to be missing from this list, which left the relationship
    # ordering a *pooled* draw by round and position alone: pool A's round 1 and pool
    # B's round 1 would interleave, so the same draw would come back in two different
    # sequences depending on which of the two ways a caller happened to read it. A
    # bracket has one order, and there is no reader that wants the other one.
    #
    # NULLs last, explicitly, rather than relying on Postgres' ASC default: a NULL
    # ``pool_id`` is a real value here ("this fixture belongs to no pool" —
    # single-elim, or this is the KO stage of an rr-then-ko event), and it belongs
    # after the pools that feed it.
    #
    # It orders the pools by ``pool_id``, where ``fixtures_by_event`` orders them by the
    # pool's ``position`` in the event's own pool order (ADR 20260801) — a relationship
    # ``order_by`` is an expression over *this* table, so saying it here would still
    # take a correlated subquery in a string, even now that the position is a column on
    # ``tournament_event_pools`` and joinable. The two agree wherever the ids sort as
    # the director ordered them and part company where they do not (``p-10-`` sorts
    # between ``p-1-`` and ``p-2-``). Nothing in the app reads this relationship's order
    # today — every draw a client sees comes through the loader.
    fixtures: Mapped[list["TournamentFixture"]] = relationship(
        back_populates="event",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by=(
            "TournamentFixture.pool_id.asc().nulls_last(), "
            "TournamentFixture.round, TournamentFixture.position"
        ),
    )
