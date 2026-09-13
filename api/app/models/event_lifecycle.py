"""The durable, database-owned event transition ledger."""

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.tournament import EventLifecycleState


class EventLifecycleHistory(Base):
    __tablename__ = "tournament_event_lifecycle_history"
    __table_args__ = (
        UniqueConstraint(
            "event_id", "version", name="uq_event_lifecycle_history_version"
        ),
        CheckConstraint(
            "version > 0 AND from_state <> to_state",
            name="ck_event_lifecycle_transition",
        ),
        CheckConstraint(
            "occurred_at IS NULL OR occurred_at <= observed_at",
            name="ck_event_lifecycle_chronology",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tournament_events.id", ondelete="RESTRICT"), nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    from_state: Mapped[EventLifecycleState] = mapped_column(
        Enum(EventLifecycleState, name="event_lifecycle_state"), nullable=False
    )
    to_state: Mapped[EventLifecycleState] = mapped_column(
        Enum(EventLifecycleState, name="event_lifecycle_state"), nullable=False
    )
    observed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    occurred_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class EventRecordedGame(Base):
    __tablename__ = "tournament_event_recorded_games"
    match_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("matches.id", ondelete="RESTRICT"), primary_key=True
    )
    game_number: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tournament_events.id", ondelete="RESTRICT"), nullable=False
    )
    observed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("clock_timestamp()"),
    )
