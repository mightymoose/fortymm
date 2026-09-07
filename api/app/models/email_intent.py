"""Pending email state has no bearer credential and does not expire."""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Enum, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.user_token import EmailPurpose


class EmailIntent(Base):
    __tablename__ = "account_email_intents"
    __table_args__ = (
        CheckConstraint(
            "target_account_id <> user_id",
            name="ck_account_email_intents_distinct_accounts",
        ),
        CheckConstraint(
            "purpose IN ('change', 'merge')", name="ck_account_email_intents_purpose"
        ),
        CheckConstraint(
            "(purpose = 'change' AND target_account_id IS NULL) OR (purpose "
            "= 'merge' AND target_account_id IS NOT NULL AND prior_email IS "
            "NULL)",
            name="ck_account_email_intents_payload",
        ),
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="CASCADE"),
        primary_key=True,
    )
    purpose: Mapped[EmailPurpose] = mapped_column(
        Enum(EmailPurpose, native_enum=False), nullable=False
    )
    sent_to: Mapped[str] = mapped_column(String(254), nullable=False)
    prior_email: Mapped[str | None] = mapped_column(String(254), nullable=True)
    target_account_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="CASCADE"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class FirstSignInIntent(Base):
    __tablename__ = "account_first_sign_in_intents"
    __table_args__ = (
        CheckConstraint(
            "email = lower(email)",
            name="ck_account_first_sign_in_intents_normalized_email",
        ),
    )
    email: Mapped[str] = mapped_column(String(254), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
