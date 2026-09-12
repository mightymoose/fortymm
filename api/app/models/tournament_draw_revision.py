"""One event-wide draw cut, retained when replaced or removed."""

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class TournamentDrawRevision(Base):
    __tablename__ = "tournament_draw_revisions"
    __table_args__ = (
        UniqueConstraint("event_id", "id", name="uq_draw_revision_event_id"),
        CheckConstraint(
            "retired_at IS NULL OR retired_at >= created_at",
            name="ck_draw_revision_interval",
        ),
        Index(
            "uq_draw_revision_current_event",
            "event_id",
            unique=True,
            postgresql_where=text("retired_at IS NULL"),
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()")
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tournament_events.id", ondelete="CASCADE"), nullable=False
    )
    created_by_account_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.clock_timestamp()
    )
    retired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    configuration: Mapped[dict[str, object]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
