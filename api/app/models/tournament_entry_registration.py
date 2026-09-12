"""Registration intervals belonging to a durable event entry."""

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    String,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.tournament_entry_participation import WithdrawalReason


class TournamentEntryRegistration(Base):
    __tablename__ = "tournament_entry_registrations"
    __table_args__ = (
        CheckConstraint(
            "withdrawn_at IS NULL OR withdrawn_at >= registered_at",
            name="ck_registration_interval",
        ),
        CheckConstraint(
            "(withdrawn_at IS NULL AND withdrawn_by_account_id IS NULL AND "
            "withdrawal_reason IS NULL AND withdrawal_explanation IS NULL) "
            "OR (withdrawn_at IS NOT NULL AND withdrawn_by_account_id IS NOT "
            "NULL AND withdrawal_reason IS NOT NULL)",
            name="ck_registration_withdrawal_provenance",
        ),
        CheckConstraint(
            "withdrawal_reason IN ('self_withdrawal', 'director_removal', "
            "'identity_reconciliation')",
            name="ck_registration_withdrawal_reason",
        ),
        Index(
            "uq_registration_current_entry",
            "entry_id",
            unique=True,
            postgresql_where=text("withdrawn_at IS NULL"),
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()")
    )
    entry_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tournament_entries.id", ondelete="CASCADE"), nullable=False
    )
    registered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp(), nullable=False
    )
    registered_by_account_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=False
    )
    withdrawn_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    withdrawn_by_account_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT")
    )
    withdrawal_reason: Mapped[WithdrawalReason | None] = mapped_column(
        Enum(WithdrawalReason, native_enum=False, length=None)
    )
    withdrawal_explanation: Mapped[str | None] = mapped_column(String)
