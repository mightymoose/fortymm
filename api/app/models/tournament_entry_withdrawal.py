"""Competition withdrawal has an explicit event-wide or stage-specific scope."""

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.tournament_entry_participation import WithdrawalReason


class TournamentEntryWithdrawal(Base):
    __tablename__ = "tournament_entry_withdrawals"
    __table_args__ = (
        CheckConstraint(
            "reason IN ('self_withdrawal', 'director_removal', "
            "'identity_reconciliation')",
            name="ck_withdrawal_reason",
        ),
        ForeignKeyConstraint(
            ["event_id", "entry_id"],
            ["tournament_entries.event_id", "tournament_entries.id"],
            name="fk_withdrawal_event_entry",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["event_id", "stage_id"],
            ["tournament_event_stages.event_id", "tournament_event_stages.id"],
            name="fk_withdrawal_event_stage",
        ),
        CheckConstraint(
            "(restored_at IS NULL) = (restored_by_account_id IS NULL)",
            name="ck_withdrawal_restoration_actor",
        ),
        CheckConstraint(
            "restored_at IS NULL OR restored_at >= withdrawn_at",
            name="ck_withdrawal_interval",
        ),
        Index(
            "uq_withdrawal_current_event",
            "entry_id",
            unique=True,
            postgresql_where=text("stage_id IS NULL AND restored_at IS NULL"),
        ),
        Index(
            "uq_withdrawal_current_stage",
            "entry_id",
            "stage_id",
            unique=True,
            postgresql_where=text("stage_id IS NOT NULL AND restored_at IS NULL"),
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()")
    )
    event_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    entry_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    stage_id: Mapped[uuid.UUID | None] = mapped_column()
    actor_account_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=False
    )
    reason: Mapped[WithdrawalReason] = mapped_column(
        Enum(WithdrawalReason, native_enum=False, length=None), nullable=False
    )
    explanation: Mapped[str | None] = mapped_column(String)
    withdrawn_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.clock_timestamp()
    )
    restored_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    restored_by_account_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT")
    )
