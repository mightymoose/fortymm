import uuid
from datetime import datetime
from typing import Literal

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class VenueTableCallHistory(Base):
    """One call, move, or cancellation tied to its stable venue table."""

    __tablename__ = "tournament_table_call_history"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('called', 'moved', 'cancelled')",
            name="ck_tournament_table_call_history_kind",
        ),
        ForeignKeyConstraint(
            ["tournament_id", "table_id"],
            ["tournament_tables.tournament_id", "tournament_tables.id"],
            name="fk_tournament_table_call_history_tournament_id_table_id",
            ondelete="RESTRICT",
        ),
        Index(
            "ix_tournament_table_call_history_tournament_id_table_id",
            "tournament_id",
            "table_id",
        ),
        Index(
            "ix_tournament_table_call_history_fixture_id_created_at",
            "fixture_id",
            "created_at",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    tournament_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournaments.id", ondelete="CASCADE"),
        nullable=False,
    )
    table_id: Mapped[str] = mapped_column(UUID(as_uuid=False), nullable=False)
    fixture_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tournament_fixtures.id", ondelete="SET NULL")
    )
    kind: Mapped[Literal["called", "moved", "cancelled"]] = mapped_column(
        String(16), nullable=False
    )
    scheduled_start: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
