"""Durable provider work created from an immutable tournament checkout."""

import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.tournament_payment_receipt_outcomes import TournamentReceiptOutcomeJson

if TYPE_CHECKING:
    from app.models.tournament_checkout import (
        TournamentCheckout,
        TournamentCheckoutLine,
    )


class TournamentPaymentState(enum.Enum):
    preparing = "preparing"
    ready = "ready"
    checking = "checking"
    action_required = "action_required"
    succeeded = "succeeded"
    failed = "failed"
    expired = "expired"
    canceled = "canceled"


class TournamentPaymentLineOutcome(enum.Enum):
    confirmed = "confirmed"
    refund_pending = "refund_pending"


class TournamentRefundState(enum.Enum):
    pending = "pending"
    resolved = "resolved"


class TournamentReceiptState(enum.Enum):
    pending = "pending"
    retry_scheduled = "retry_scheduled"
    sent = "sent"
    failed = "failed"
    canceled = "canceled"


class TournamentPayment(Base):
    """One processor payment and its stable create obligation per checkout."""

    __tablename__ = "tournament_payments"
    __table_args__ = (
        CheckConstraint(
            "amount_cents > 0", name="ck_tournament_payments_amount_positive"
        ),
        CheckConstraint("currency = 'USD'", name="ck_tournament_payments_currency_usd"),
        UniqueConstraint("checkout_id", name="uq_tournament_payments_checkout"),
        UniqueConstraint(
            "id", "checkout_id", name="uq_tournament_payments_id_checkout"
        ),
        UniqueConstraint("durable_identity", name="uq_tournament_payments_identity"),
        UniqueConstraint(
            "provider_payment_id", name="uq_tournament_payments_provider_payment"
        ),
        Index("ix_tournament_payments_checkout_id", "checkout_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    checkout_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournament_checkouts.id", ondelete="RESTRICT"),
        nullable=False,
    )
    provider: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default="stripe"
    )
    durable_identity: Mapped[str] = mapped_column(String(255), nullable=False)
    provider_payment_id: Mapped[str | None] = mapped_column(String(255))
    provider_status: Mapped[str | None] = mapped_column(String(64))
    provider_evidence_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    support_reference: Mapped[str | None] = mapped_column(String(32), unique=True)
    settlement_notified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    attention_notified_state: Mapped[str | None] = mapped_column(String(32))
    provider_mismatch_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    # This value is intentionally never serialized by a generic checkout read.
    client_secret: Mapped[str | None] = mapped_column(String(512))
    receipt_email: Mapped[str | None] = mapped_column(String(320))
    receipt_sync_pending: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    currency: Mapped[str] = mapped_column(
        String(3), nullable=False, server_default="USD"
    )
    amount_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    state: Mapped[TournamentPaymentState] = mapped_column(
        Enum(
            TournamentPaymentState,
            name="tournament_payment_state",
            values_callable=lambda values: [value.value for value in values],
        ),
        nullable=False,
        server_default=TournamentPaymentState.preparing.value,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("clock_timestamp()"),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("clock_timestamp()"),
    )

    checkout: Mapped["TournamentCheckout"] = relationship(back_populates="payment")
    allocations: Mapped[list["TournamentPaymentAllocation"]] = relationship(
        back_populates="payment",
        cascade="all, delete-orphan",
        passive_deletes=True,
        lazy="selectin",
        order_by="TournamentPaymentAllocation.checkout_line_id",
    )
    receipt: Mapped["TournamentPaymentReceipt | None"] = relationship(
        back_populates="payment", uselist=False
    )


class TournamentPaymentAllocation(Base):
    """The immutable part of a combined charge assigned to one quoted event."""

    __tablename__ = "tournament_payment_allocations"
    __table_args__ = (
        CheckConstraint(
            "amount_cents > 0", name="ck_tournament_payment_allocations_amount_positive"
        ),
        UniqueConstraint(
            "payment_id",
            "checkout_line_id",
            name="uq_tournament_payment_allocations_line",
        ),
        ForeignKeyConstraint(
            ["payment_id", "checkout_id"],
            ["tournament_payments.id", "tournament_payments.checkout_id"],
            ondelete="CASCADE",
            name="fk_tournament_payment_allocations_payment_checkout",
        ),
        ForeignKeyConstraint(
            ["checkout_line_id", "checkout_id"],
            ["tournament_checkout_lines.id", "tournament_checkout_lines.checkout_id"],
            ondelete="RESTRICT",
            name="fk_tournament_payment_allocations_line_checkout",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    payment_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    checkout_line_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False
    )
    checkout_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    amount_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    outcome: Mapped[TournamentPaymentLineOutcome | None] = mapped_column(
        Enum(
            TournamentPaymentLineOutcome,
            name="tournament_payment_line_outcome",
            values_callable=lambda values: [value.value for value in values],
        )
    )
    refund_amount_cents: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="0"
    )

    payment: Mapped[TournamentPayment] = relationship(back_populates="allocations")
    checkout_line: Mapped["TournamentCheckoutLine"] = relationship(viewonly=True)


class TournamentProviderEvent(Base):
    """One signature-verified provider event, durable before acknowledgement."""

    __tablename__ = "tournament_provider_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    provider_event_id: Mapped[str] = mapped_column(
        String(255), unique=True, nullable=False
    )
    event_type: Mapped[str] = mapped_column(String(128), nullable=False)
    provider_payment_id: Mapped[str] = mapped_column(String(255), nullable=False)
    evidence_json: Mapped[str] = mapped_column(Text, nullable=False)
    provider_created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("clock_timestamp()"),
    )
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TournamentRefundObligation(Base):
    """Money captured without admission that a later slice must refund."""

    __tablename__ = "tournament_refund_obligations"
    __table_args__ = (
        CheckConstraint(
            "amount_cents > 0",
            name="ck_tournament_refund_obligations_amount_positive",
        ),
        UniqueConstraint(
            "payment_id",
            "checkout_line_id",
            name="uq_tournament_refund_obligations_line",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    payment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournament_payments.id", ondelete="RESTRICT"),
        nullable=False,
    )
    checkout_line_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournament_checkout_lines.id", ondelete="RESTRICT"),
    )
    amount_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    reason: Mapped[str] = mapped_column(String(64), nullable=False)
    state: Mapped[TournamentRefundState] = mapped_column(
        Enum(
            TournamentRefundState,
            name="tournament_refund_state",
            values_callable=lambda values: [value.value for value in values],
        ),
        nullable=False,
        server_default=TournamentRefundState.pending.value,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("clock_timestamp()"),
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TournamentPaymentReceipt(Base):
    """A durable, payment-specific admission confirmation delivery obligation.

    The checkout email is copied here only after provider success. Queue jobs carry
    this row's id, so an address edit/erasure can invalidate work already in Redis.
    """

    __tablename__ = "tournament_payment_receipts"
    __table_args__ = (
        UniqueConstraint("payment_id", name="uq_tournament_payment_receipts_payment"),
        Index("ix_tournament_payment_receipts_next_attempt", "next_attempt_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    payment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournament_payments.id", ondelete="RESTRICT"),
        nullable=False,
    )
    recipient_email: Mapped[str | None] = mapped_column(String(320))
    outcomes: Mapped[list[TournamentReceiptOutcomeJson]] = mapped_column(
        JSONB, nullable=False
    )
    state: Mapped[TournamentReceiptState] = mapped_column(
        Enum(
            TournamentReceiptState,
            name="tournament_receipt_state",
            values_callable=lambda values: [value.value for value in values],
        ),
        nullable=False,
        server_default=TournamentReceiptState.pending.value,
    )
    attempt_count: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="0"
    )
    retry_deadline_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failure_kind: Mapped[str | None] = mapped_column(String(64))
    support_reference: Mapped[str | None] = mapped_column(String(32), unique=True)
    pii_erased_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("clock_timestamp()"),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("clock_timestamp()"),
    )
    payment: Mapped[TournamentPayment] = relationship(back_populates="receipt")
