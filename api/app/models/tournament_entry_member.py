import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.tournament_entry import TournamentEntry


class TournamentEntryMember(Base):
    """A Player's membership interval in an entry, independent of played lineups."""

    __tablename__ = "tournament_entry_members"
    __table_args__ = (
        CheckConstraint(
            "left_at IS NULL OR left_at >= joined_at",
            name="ck_tournament_entry_members_interval",
        ),
        Index(
            "uq_tournament_entry_members_current_player",
            "entry_id",
            "player_id",
            unique=True,
            postgresql_where=text("left_at IS NULL"),
        ),
        Index("ix_tournament_entry_members_entry_id", "entry_id"),
        Index("ix_tournament_entry_members_player_id", "player_id"),
        Index(
            "ix_tournament_entry_members_joined_by_account_id", "joined_by_account_id"
        ),
        Index("ix_tournament_entry_members_left_by_account_id", "left_by_account_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    entry_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tournament_entries.id", ondelete="CASCADE"), nullable=False
    )
    player_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("players.id", ondelete="RESTRICT"), nullable=False
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp(), nullable=False
    )
    left_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    joined_by_account_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT")
    )
    left_by_account_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT")
    )
    entry: Mapped["TournamentEntry"] = relationship(back_populates="members")
