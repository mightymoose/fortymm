"""Session credentials and purpose-constrained email credentials."""

import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    LargeBinary,
    String,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.account import Account


class EmailPurpose(StrEnum):
    login = "login"
    first_sign_in = "first_sign_in"
    change = "change"
    merge = "merge"


class SessionToken(Base):
    __tablename__ = "account_session_tokens"
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    token: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, unique=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    user: Mapped[Account] = relationship(Account)


class EmailToken(Base):
    __tablename__ = "account_email_tokens"
    __table_args__ = (
        CheckConstraint(
            "target_account_id <> user_id AND guest_account_id <> user_id",
            name="ck_account_email_tokens_distinct_accounts",
        ),
        CheckConstraint(
            "(replaced_at IS NULL AND sent_to IS NOT NULL) OR (replaced_at "
            "IS NOT NULL AND sent_to IS NULL AND prior_email IS NULL AND "
            "target_account_id IS NULL AND guest_account_id IS NULL)",
            name="ck_account_email_tokens_live_payload",
        ),
        CheckConstraint(
            "purpose = 'change' OR prior_email IS NULL",
            name="ck_account_email_tokens_prior_email",
        ),
        CheckConstraint(
            "(purpose = 'merge' AND (replaced_at IS NOT NULL OR "
            "target_account_id IS NOT NULL)) OR (purpose <> 'merge' AND "
            "target_account_id IS NULL)",
            name="ck_account_email_tokens_merge_target",
        ),
        CheckConstraint(
            "purpose IN ('login', 'first_sign_in') OR guest_account_id IS NULL",
            name="ck_account_email_tokens_guest_source",
        ),
        Index("ix_account_email_tokens_created_at", "created_at"),
        Index(
            "uq_account_email_tokens_active_login",
            "user_id",
            unique=True,
            postgresql_where=text(
                "replaced_at IS NULL AND purpose IN ('login', 'first_sign_in')"
            ),
        ),
        Index(
            "uq_account_email_tokens_active_confirmation",
            "user_id",
            unique=True,
            postgresql_where=text(
                "replaced_at IS NULL AND purpose IN ('change', 'merge')"
            ),
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    token: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, unique=True)
    purpose: Mapped[EmailPurpose] = mapped_column(
        Enum(
            EmailPurpose,
            native_enum=False,
            create_constraint=True,
            name="ck_account_email_tokens_purpose",
        ),
        nullable=False,
    )
    sent_to: Mapped[str | None] = mapped_column(String(254), nullable=True)
    prior_email: Mapped[str | None] = mapped_column(String(254), nullable=True)
    target_account_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="CASCADE"), nullable=True
    )
    guest_account_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="CASCADE"), nullable=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    replaced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    user: Mapped[Account] = relationship(Account, foreign_keys=[user_id])
