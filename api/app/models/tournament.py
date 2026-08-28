import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    CheckConstraint,
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
    from app.models.tournament_event_reservation import TournamentEventReservation
    from app.models.tournament_event_stage import TournamentEventStage
    from app.models.tournament_event_stage_group import TournamentEventStageGroup
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
    # is persisted as a FK to ``draw_types.id`` on an event's settings row, and
    # these values are that table's ``key`` column — UNIQUE, not the primary key,
    # since ADR 20260815 gave the table a surrogate id (a migration test asserts
    # the seeded ``key`` set and this enum agree) — as well as the JSON the
    # clients send.
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
    # There is deliberately no ``start_date``/``end_date`` column pair any more
    # (#1511, "A tournament's dates run backwards, and an event can sit outside
    # them"). They used to be typed, independently-writable columns — nothing
    # stopped a caller from sending a backwards range, or from creating an event
    # dated outside the range the tournament claimed to span. The date range a
    # tournament shows is now derived on every read from the min/max of its
    # events' own ``slot.date`` (``app.tournament_serialization.serialize_detail``),
    # never stored: a tournament with no events has no range, and a range with a
    # backwards ``start``/``end`` is not a state anything can construct, because
    # it is a min/max of one list rather than two independently-typed fields.
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
    rules, schedule slot, and groups/reservations. The value-objects (``slot``,
    ``match_settings``, ``predicates``) are typed JSONB decoded to Pydantic models at
    the API boundary; the groups and reservations are **not** — they are real child
    tables, ``groups`` and ``reservations`` below (ADR 20260801, on what belongs to an
    event rather than to its draw settings)."""

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
        # the target ``tournament_event_reservation_tables`` foreign-keys
        # ``(tournament_id, event_id)`` against, which is the leg that forces that row's
        # denormalized ``tournament_id`` to be the tournament its reservation's event
        # actually belongs to (ADR 20260801). Without it the other two legs are
        # satisfiable by a cross-tournament reservation — see
        # ``TournamentEventReservationTable``.
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
    # There is deliberately no JSONB column for either. An event's groups and their
    # reservations were once a NOT NULL JSONB list of ``{id, name, slot, table_ids}``
    # value-objects keyed by client-supplied strings; they are the ``groups`` and
    # ``reservations`` relationships below now, so a fixture can foreign-key the group
    # it names — and name one of its OWN event's groups (ADR 20260801, on what belongs
    # to an event rather than to its draw settings).
    #
    # Monotonic optimistic-concurrency token (#1499), the same device
    # ``MatchGameScore.version`` is. Every accepted PATCH of this event bumps it by
    # one, and a PATCH stating a different number is refused with a 409 before it
    # writes anything — so a director's second tab, holding a read from before some
    # other write, can no longer clobber the whole editable surface silently.
    #
    # It exists because ``updated_at`` **could not** serve as the token. A
    # reservations-only edit assigns ``event.reservations``, a relationship: SQLAlchemy
    # writes the child rows and never marks this parent row dirty, so ``onupdate``
    # above did not fire and ``updated_at`` did not move on exactly the edit the lost
    # update was found on.
    #
    # Note the tense. That is a statement about the world BEFORE this column existed,
    # and it is the reason the column is here — not a claim you can still observe. The
    # verb now assigns this scalar on every accepted PATCH, which dirties the parent
    # row, so ``updated_at`` moves on a reservations-only edit too. Do not read that as
    # permission to go back to ``updated_at``: it moves because of this column, and it
    # would stop moving the moment this one went away.
    #
    # ``default=1`` as well as ``server_default``: the read schema types it ``int``
    # and NOT optional, so an unrefreshed instance whose attribute was still ``None``
    # would make a freshly created event a 500 at the read boundary rather than a 1.
    lock_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default=text("1")
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

    # The event's GROUPS, across EVERY stage (#1484) — which is what
    # ``TournamentEventStageGroup.position`` carries within its own stage, and what
    # the snake seeds against for the stage it deals.
    #
    # This relationship carried one combined name until a single wire-level slot split
    # into a group row and a reservation row. A group is the half a fixture names; the
    # tables and the window are a reservation, which hangs off this event directly
    # (``reservations`` below). The wire now serves the two as separate arrays —
    # :func:`app.tournament_reservations.group_read` projects a group,
    # :func:`~app.tournament_reservations.reservation_read` its mapped reservation.
    #
    # VIEWONLY, reachable through the event's stages, not the real parent-child
    # relationship: ADR 20260815's "Sequencing with #1338" consequence parents a group
    # on its stage, because ``tournament_fixtures.event_id`` is dropped in the same ADR
    # and a group must share a column with the fixtures whose composite FK targets it.
    # Writes go through ``app.tournament_reservations``, which resolves the stage(s) it
    # is materialising and assigns ``stage.groups`` (the real relationship, declared on
    # :class:`~app.models.tournament_event_stage.TournamentEventStage`) — never this
    # one, which SQLAlchemy refuses to flush from.
    # ``secondary="tournament_event_stages"`` is an unusual use of that argument (the
    # "secondary" table is a full mapped entity here, not a bare association table), and
    # ``viewonly=True`` is what makes it safe: SQLAlchemy never attempts to
    # INSERT/DELETE through this relationship, so it only ever uses the table for the
    # join.
    #
    # **The ``primaryjoin`` no longer pins to stage 0** (#1484): it used to, back when
    # a director's groups only ever hung off the event's first stage and an
    # ``rr-then-ko`` event's knockout stage held none of its own. Now every stage a
    # draw type's template mints holds groups, and this is what makes an
    # ``rr-then-ko`` event's knockout group reach the wire, the freeze and the
    # solver's reservation hop (``app.schedule_solves.restricting_reservation_key``,
    # through ``app.tournament_draws.event_groups``). **The consequence every reader
    # must now handle**: ``position`` is unique only WITHIN a stage, not across the
    # whole list this relationship returns, so a knockout stage's sole group and its
    # event's first group-stage group can both report ``position: 0``. Every reader
    # that labels, ranks, deals or panels a group filters to stages that seat both
    # sides at the cut (``app.draws.seats_both_sides_at_cut``) or otherwise
    # disambiguates on ``stage_id`` — see ``app.tournament_draws.draw_config``,
    # ``group_order`` and ``app.tournament_events``'s freeze sentence. Only the
    # reservation-resolution hop is meant to read the whole, unfiltered array.
    #
    # ``lazy="selectin"``, for the reason every collection on this path is eager: a
    # joined load would multiply the event rows, which the tournament list's
    # LIMIT/OFFSET could not survive.
    groups: Mapped[list["TournamentEventStageGroup"]] = relationship(
        secondary="tournament_event_stages",
        primaryjoin="TournamentEvent.id == TournamentEventStage.event_id",
        secondaryjoin="TournamentEventStage.id == TournamentEventStageGroup.stage_id",
        viewonly=True,
        lazy="selectin",
        order_by="TournamentEventStageGroup.position",
    )

    # The event's RESERVATIONS — the tables-and-window half of what one wire-level
    # slot used to be, parented here rather than on a stage (see
    # :class:`~app.models.tournament_event_reservation.TournamentEventReservation` for
    # why: nothing names a reservation through a fixture's composite key, and an
    # event-parented one is what lets an rr-then-ko draw's two stages read one set).
    #
    # A REAL relationship, not a viewonly one, unlike ``groups`` above — this is the
    # collection ``app.tournament_reservations`` writes, and ``delete-orphan`` is what
    # removes a reservation when its own entry leaves the payload.
    #
    # **Eager (``selectin``), since #1387.** It was deliberately lazy while every group
    # had exactly one reservation, because then the group chain
    # (``groups[].reservation_link.reservation``) already held every reservation and a
    # second load here bought nothing. That 1:1 is gone: an ``rr-then-ko`` event's
    # group count derives from its field, so an event may hold a reservation no group
    # maps onto (one group, four reservations) or a group no reservation maps onto (an
    # event with no reservation at all). The wire's ``reservations[]`` and every solver
    # input read THIS collection now (``app.tournament_draws.event_reservations``), so
    # it has to ride along with the event however the event was loaded — a lazy load
    # under async is a ``MissingGreenlet``, not a slow read. It costs the tournament
    # list, the detail read and the dashboard panel one statement each (plus one for
    # the reservations' ``tables``); the pinned counts in their tests moved with it.
    #
    # ``selectin``, not ``joined``: a one-to-many joined load would multiply the event
    # rows, which the tournament list's LIMIT/OFFSET could not survive.
    reservations: Mapped[list["TournamentEventReservation"]] = relationship(
        back_populates="event",
        cascade="all, delete-orphan",
        passive_deletes=True,
        lazy="selectin",
        order_by="TournamentEventReservation.position",
    )

    # The event's stages, as rows the system mints from a template keyed on the
    # event's draw type (ADR 20260815 decision 1/3) — a director never authors these,
    # and ``app.tournament_event_stages`` is the only writer. Every event holds at
    # least one: the create path mints the whole template as this collection at
    # construction time (``stages=mint_stages(...)``), in the same transaction as the
    # event itself.
    #
    # ``lazy="selectin"``, matching ``groups`` above and for the same reason: async
    # SQLAlchemy raises rather than emitting a lazy load, so every reader of an event's
    # stages — the tournament-detail/list serializers today, and whatever reads them
    # next — would otherwise have to remember its own loader option. ``selectin`` and
    # not ``joined`` because this is a one-to-many, batching over the whole result set
    # in ONE extra statement however many events a page holds (the same reasoning
    # ``groups`` gives). ``app.tournament_event_stages`` still reaches these rows
    # through explicit queries of its own on the mint/re-mint path — it never reads
    # this attribute — but every OTHER reader (the serializer chief among them) now
    # gets a populated collection for free.
    #
    # ``passive_deletes=True`` is what keeps ``await db.delete(event)``
    # (``app.tournament_events.delete_event``) from needing to load this collection to
    # cascade the delete in Python — the database's own ``ON DELETE CASCADE`` does it,
    # exactly as it already does for ``entries``/``fixtures`` above.
    stages: Mapped[list["TournamentEventStage"]] = relationship(
        back_populates="event",
        cascade="all, delete-orphan",
        passive_deletes=True,
        lazy="selectin",
        order_by="TournamentEventStage.position",
    )

    # There is deliberately no ``fixtures`` relationship here any more. A fixture
    # names its stage, not its event (ADR 20260815 decision 5, "a fixture names its
    # stage"; ``tournament_fixtures.event_id`` is dropped outright) —
    # :attr:`~app.models.tournament_event_stage.TournamentEventStage.fixtures` is the
    # real relationship, one stage at a time; an rr-then-ko event's draw spans BOTH of
    # its stages, unlike ``groups`` above, because both the group stage and the
    # knockout stage hold fixtures. This model carried a VIEWONLY shim spanning both
    # stages, ordered group → round → position, for the one test that walked it
    # directly; that test now walks a stage's own ``fixtures`` instead (the same order,
    # declared on that relationship). Every production read of a draw goes through the
    # batched ``app.tournament_queries.fixtures_by_event`` loader, never through either
    # relationship.
