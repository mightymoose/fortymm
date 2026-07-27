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
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.tournament_entry import TournamentEntry
    from app.models.tournament_fixture import TournamentFixture


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
    # Member names use underscores; the persisted *values* keep the hyphenated
    # wire strings from the front-end prototype (values_callable on the column
    # makes Postgres store the value, not the member name).
    single_elim = "single-elim"
    double_elim = "double-elim"
    round_robin = "round-robin"
    rr_then_ko = "rr-then-ko"
    swiss = "swiss"


class Tournament(Base):
    """A tournament owned by the user who created it, run on exactly one league —
    the rating ladder its eligibility rules are judged on (ADR-0783). It was
    "standalone, not tied to a league" until an event's rating predicate needed a
    ladder to mean anything; ``league_id`` is NOT NULL, and an omitted one resolves
    to the default league at create. Names are owner-scoped, not globally unique,
    so there's no unique constraint on ``name``. ``address`` and
    ``table_catalogue`` are typed JSONB value-objects decoded to Pydantic models at
    the API boundary."""

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
    table_catalogue: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )
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


class TournamentEvent(Base):
    """An event (a draw) within a tournament — its own format, draw type, entry
    rules, schedule slot, and pool layout. The value-objects (``slot``,
    ``match_settings``, ``predicates``, ``pools``) are typed JSONB decoded to
    Pydantic models at the API boundary."""

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
    draw_type: Mapped[DrawType] = mapped_column(
        Enum(
            DrawType,
            name="draw_type",
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
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
    pools: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
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

    entries: Mapped[list["TournamentEntry"]] = relationship(
        back_populates="event",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="TournamentEntry.created_at",
    )

    # The event's draw: every fixture the cut produced (ADR-0786). Empty until the
    # draw is cut; a re-cut replaces the set wholesale, which is what
    # ``delete-orphan`` buys.
    #
    # Ordered pool → round → position — the SAME total order the read path's
    # ``fixtures_by_event`` loader applies, and the one the fixtures' own
    # ``UNIQUE (event_id, pool_id, round, position)`` makes a total order at all. The
    # ``pool_id`` used to be missing from this list, which left the relationship
    # ordering a *pooled* draw by round and position alone: pool A's round 1 and pool
    # B's round 1 would interleave, so the same draw would come back in two different
    # sequences depending on which of the two ways a caller happened to read it. A
    # bracket has one order, and there is no reader that wants the other one.
    #
    # NULLs last, explicitly, rather than relying on Postgres' ASC default: a NULL
    # ``pool_id`` is a real value here ("this fixture belongs to no pool" — an
    # rr-then-ko event's KO stage), and it belongs after the pools that feed it.
    fixtures: Mapped[list["TournamentFixture"]] = relationship(
        back_populates="event",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by=(
            "TournamentFixture.pool_id.asc().nulls_last(), "
            "TournamentFixture.round, TournamentFixture.position"
        ),
    )
