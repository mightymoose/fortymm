import enum
import uuid
from datetime import date, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
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
    """A tournament owned by the user who created it. Standalone — not tied to a
    league. Names are owner-scoped, not globally unique, so there's no unique
    constraint on ``name``. ``address`` and ``table_catalogue`` are typed JSONB
    value-objects decoded to Pydantic models at the API boundary."""

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
    address: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    table_catalogue: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
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
    max_players: Mapped[int] = mapped_column(Integer, nullable=False)
    entry_fee: Mapped[float] = mapped_column(Numeric(8, 2), nullable=False)
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
