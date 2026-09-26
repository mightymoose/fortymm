"""Durable, immutable quotes that temporarily reserve tournament capacity."""

import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.tournament import Tournament


class TournamentCheckoutStatus(enum.Enum):
    active = "active"
    cancelled = "cancelled"
    expired = "expired"
    invalidated = "invalidated"
    #: A verified payment converted this checkout's hold into registrations
    #: (#1816). Like every non-active status, it no longer counts toward
    #: capacity.
    completed = "completed"


class TournamentCheckout(Base):
    """One resumable ten-minute quote for one Player in one tournament."""

    __tablename__ = "tournament_checkouts"
    __table_args__ = (
        CheckConstraint(
            "total_cents > 0", name="ck_tournament_checkouts_total_positive"
        ),
        CheckConstraint(
            "currency = 'USD'", name="ck_tournament_checkouts_currency_usd"
        ),
        CheckConstraint(
            "expires_at > created_at",
            name="ck_tournament_checkouts_deadline_after_create",
        ),
        UniqueConstraint(
            "payer_account_id",
            "request_id",
            name="uq_tournament_checkouts_payer_request",
        ),
        Index(
            "uq_tournament_checkouts_active_player_tournament",
            "entrant_player_id",
            "tournament_id",
            unique=True,
            postgresql_where=text("status = 'active'"),
        ),
        Index("ix_tournament_checkouts_tournament_id", "tournament_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    payer_account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="RESTRICT"),
        nullable=False,
    )
    entrant_player_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("players.id", ondelete="RESTRICT"),
        nullable=False,
    )
    tournament_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournaments.id", ondelete="RESTRICT"),
        nullable=False,
    )
    merchant_account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="RESTRICT"),
        nullable=False,
    )
    registration_generation: Mapped[int] = mapped_column(Integer, nullable=False)
    currency: Mapped[str] = mapped_column(
        String(3), nullable=False, server_default="USD"
    )
    total_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    status: Mapped[TournamentCheckoutStatus] = mapped_column(
        Enum(
            TournamentCheckoutStatus,
            name="tournament_checkout_status",
            values_callable=lambda values: [value.value for value in values],
        ),
        nullable=False,
        server_default=TournamentCheckoutStatus.active.value,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("clock_timestamp()"),
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("clock_timestamp() + interval '10 minutes'"),
    )
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    tournament: Mapped["Tournament"] = relationship()
    lines: Mapped[list["TournamentCheckoutLine"]] = relationship(
        back_populates="checkout",
        cascade="all, delete-orphan",
        passive_deletes=True,
        lazy="selectin",
        order_by="TournamentCheckoutLine.event_id",
    )


class TournamentCheckoutLine(Base):
    """The immutable event and exact price reserved by a checkout."""

    __tablename__ = "tournament_checkout_lines"
    __table_args__ = (
        CheckConstraint(
            "price_cents >= 50", name="ck_tournament_checkout_lines_minimum_price"
        ),
        UniqueConstraint(
            "checkout_id", "event_id", name="uq_tournament_checkout_lines_event"
        ),
        Index("ix_tournament_checkout_lines_event_id", "event_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    checkout_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournament_checkouts.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Snapshot identity, deliberately not a foreign key: an unplayed event remains
    # deletable after a cancelled/expired quote, while checkout history preserves
    # exactly which UUID, name, and price the payer was shown.
    event_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    event_name: Mapped[str] = mapped_column(String(255), nullable=False)
    price_cents: Mapped[int] = mapped_column(Integer, nullable=False)

    checkout: Mapped[TournamentCheckout] = relationship(back_populates="lines")
