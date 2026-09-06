"""Historical tournament match lineups, separate from scheduled participants."""

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class MatchLineup(Base):
    __tablename__ = "match_lineups"
    __table_args__ = (
        Index("ix_match_lineups_match_id", "match_id"),
        Index("ix_match_lineups_recorded_by_account_id", "recorded_by_account_id"),
        UniqueConstraint("match_id", "revision", name="uq_match_lineups_revision"),
        CheckConstraint("revision > 0", name="ck_match_lineups_revision"),
        CheckConstraint(
            "(revision = 1 AND correction_reason IS NULL) OR "
            "(revision > 1 AND recorded_by_account_id IS NOT NULL "
            "AND correction_reason IS NOT NULL AND length(trim(correction_reason)) "
            "> 0)",
            name="ck_match_lineups_correction_audit",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    match_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("matches.id", ondelete="RESTRICT"), nullable=False
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp(), nullable=False
    )
    revision: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("1")
    )
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp(), nullable=False
    )
    # Keep the full, top-level transaction ID: xmin can be a subtransaction ID,
    # and PostgreSQL eventually discards historical transaction status.
    recorded_transaction_id: Mapped[int] = mapped_column(
        BigInteger, server_default=text("txid_current()"), nullable=False
    )
    recorded_by_account_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT")
    )
    correction_reason: Mapped[str | None] = mapped_column(Text)


class MatchLineupPlayer(Base):
    __tablename__ = "match_lineup_players"
    __table_args__ = (
        CheckConstraint("side_number IN (1, 2)", name="ck_match_lineup_players_side"),
        UniqueConstraint(
            "lineup_id", "player_id", name="uq_match_lineup_players_player"
        ),
        Index("ix_match_lineup_players_lineup_id", "lineup_id"),
        Index("ix_match_lineup_players_player_id", "player_id"),
        Index("ix_match_lineup_players_entry_member_id", "entry_member_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    lineup_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("match_lineups.id", ondelete="CASCADE"), nullable=False
    )
    side_number: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    entry_member_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tournament_entry_members.id", ondelete="RESTRICT"), nullable=False
    )
    player_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("players.id", ondelete="RESTRICT"), nullable=False
    )
