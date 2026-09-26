"""One Stripe PaymentIntent per checkout, and its per-event outcomes (#1816).

``TournamentPayment`` maps one-to-one onto a
:class:`~app.models.tournament_checkout.TournamentCheckout`. Each
``TournamentPaymentLine`` mirrors one checkout line and carries that line's own
outcome (admitted, or refund-due) — a multi-event checkout can partially admit,
so the outcome cannot live on the payment as a whole.

``TournamentPaymentProviderEvent`` and ``TournamentPaymentRefundObligation`` are
the durable evidence trail: every Stripe webhook event Fortymm has ever seen
(keyed uniquely on the Stripe event id, so a replay is a no-op), and every
refund Fortymm owes a payer but has not yet executed (#1813 executes them; this
ticket only records them). Deletion guards elsewhere (``app.tournament_events``)
keep an event with payment evidence from being deleted out from under it.
"""

import enum
import secrets
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
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
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

#: Crockford base32 — no ``I``/``L``/``O``/``U``, so a support agent reading a
#: reference off a screenshot or over the phone can't confuse it with a digit.
_CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def generate_payment_reference() -> str:
    """``PAY-`` plus 8 Crockford base32 characters, generated in Python —
    never derived from any Stripe id (#1816 constraint), so a support
    reference stays stable across a provider migration or a Connect payee
    change."""
    return "PAY-" + "".join(secrets.choice(_CROCKFORD_ALPHABET) for _ in range(8))


class TournamentPaymentProviderCreateState(enum.Enum):
    """The provider-create obligation, committed BEFORE any Stripe call
    (#1816: "the server commits the provider-create obligation before any
    Stripe call"), so a crash between commit and the Stripe response leaves a
    durable record that a create was owed rather than losing it entirely."""

    not_started = "not_started"
    committed = "committed"
    created = "created"


class TournamentPaymentStatus(enum.Enum):
    """Fortymm's own payment lifecycle — a superset of the 8 API-facing
    states (``app.schemas.tournament_checkout.TournamentCheckoutPaymentState``)
    with two additional internal-only members that the API read maps down
    onto an existing public state rather than exposing directly."""

    preparing = "preparing"
    ready = "ready"
    checking = "checking"
    action_required = "action_required"
    succeeded = "succeeded"
    failed = "failed"
    expired = "expired"
    canceled = "canceled"
    #: A director entered the player while this payment was still open
    #: (``app.tournament_checkouts.invalidate_checkout_for_entrant_event``).
    #: The RQ cancel job has been enqueued but Stripe has not yet confirmed
    #: the cancellation. The director's action is authoritative and
    #: irreversible (module docstring), so the API reports this as
    #: ``canceled`` rather than exposing a ninth state.
    cancel_requested = "cancel_requested"
    #: Reconcile's validation failed (wrong account/mode/amount/currency, or
    #: an unmatched PaymentIntent id/metadata). Admits nobody; a refund
    #: obligation is recorded for the verified captured amount. The API
    #: reports this as ``failed`` — exactly as terminal, with a safe generic
    #: message rather than the raw validation reason.
    quarantined = "quarantined"


class TournamentPaymentLineOutcome(enum.Enum):
    pending = "pending"
    admitted = "admitted"
    refund_due = "refund_due"


class TournamentPaymentRefundReason(enum.Enum):
    quarantine = "quarantine"
    line_could_not_admit = "line_could_not_admit"
    superseded_by_director_entry = "superseded_by_director_entry"


class TournamentPayment(Base):
    """One Stripe PaymentIntent, one-to-one with a
    :class:`~app.models.tournament_checkout.TournamentCheckout`."""

    __tablename__ = "tournament_payments"
    __table_args__ = (
        CheckConstraint(
            "amount_cents > 0", name="ck_tournament_payments_amount_positive"
        ),
        CheckConstraint("currency = 'USD'", name="ck_tournament_payments_currency_usd"),
        UniqueConstraint("checkout_id", name="uq_tournament_payments_checkout"),
        UniqueConstraint("reference", name="uq_tournament_payments_reference"),
        UniqueConstraint(
            "idempotency_key", name="uq_tournament_payments_idempotency_key"
        ),
        UniqueConstraint(
            "provider_payment_intent_id",
            name="uq_tournament_payments_provider_intent",
        ),
        Index("ix_tournament_payments_payer_account_id", "payer_account_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    checkout_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournament_checkouts.id", ondelete="RESTRICT"),
        nullable=False,
    )
    payer_account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="RESTRICT"),
        nullable=False,
    )
    tournament_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournaments.id", ondelete="RESTRICT"),
        nullable=False,
    )
    #: ``NULL`` means the platform account — today's only posture. Stripe
    #: Connect (#1819) populates this with the organizer's connected account.
    payee_stripe_account: Mapped[str | None] = mapped_column(String(255))
    #: The Fortymm account with financial authority over this payment at the
    #: time it was created (today always the configured merchant account).
    payee_fortymm_account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="RESTRICT"),
        nullable=False,
    )
    reference: Mapped[str] = mapped_column(
        String(12), nullable=False, default=generate_payment_reference
    )
    #: Durable across retries of the SAME logical create — never regenerated
    #: once committed (see ``TournamentPaymentProviderCreateState``).
    idempotency_key: Mapped[str] = mapped_column(String(255), nullable=False)
    provider_create_state: Mapped[TournamentPaymentProviderCreateState] = mapped_column(
        Enum(
            TournamentPaymentProviderCreateState,
            name="tournament_payment_provider_create_state",
            values_callable=lambda values: [value.value for value in values],
        ),
        nullable=False,
        server_default=TournamentPaymentProviderCreateState.not_started.value,
    )
    provider_payment_intent_id: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[TournamentPaymentStatus] = mapped_column(
        Enum(
            TournamentPaymentStatus,
            name="tournament_payment_status",
            values_callable=lambda values: [value.value for value in values],
        ),
        nullable=False,
        server_default=TournamentPaymentStatus.preparing.value,
    )
    amount_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(
        String(3), nullable=False, server_default="USD"
    )
    #: A safe, allowlisted decline code (never Stripe's raw decline_code or
    #: message — #1816's player-facing-errors constraint).
    last_error_code: Mapped[str | None] = mapped_column(String(64))
    #: Set when quarantine's retrieval fails or the PaymentIntent is on
    #: another account: no refund obligation could be recorded because the
    #: captured amount could not be verified (#1816 acceptance criteria).
    amount_unverified: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    cancel_requested_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("clock_timestamp()"),
    )

    lines: Mapped[list["TournamentPaymentLine"]] = relationship(
        back_populates="payment",
        cascade="all, delete-orphan",
        passive_deletes=True,
        lazy="selectin",
        order_by="TournamentPaymentLine.event_id",
    )
    refund_obligations: Mapped[list["TournamentPaymentRefundObligation"]] = (
        relationship(
            back_populates="payment",
            cascade="all, delete-orphan",
            passive_deletes=True,
            lazy="selectin",
        )
    )


class TournamentPaymentLine(Base):
    """The immutable per-event allocation of a payment, and that event's own
    admission outcome."""

    __tablename__ = "tournament_payment_lines"
    __table_args__ = (
        UniqueConstraint(
            "payment_id", "event_id", name="uq_tournament_payment_lines_event"
        ),
        Index("ix_tournament_payment_lines_event_id", "event_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    payment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournament_payments.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Deliberately a REAL foreign key — unlike TournamentCheckoutLine's
    # deliberate non-FK event snapshot. Once a payment line exists the event
    # carries financial evidence and must not be deletable out from under it
    # (the #1816 deletion guard in app.tournament_events).
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournament_events.id", ondelete="RESTRICT"),
        nullable=False,
    )
    price_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    outcome: Mapped[TournamentPaymentLineOutcome] = mapped_column(
        Enum(
            TournamentPaymentLineOutcome,
            name="tournament_payment_line_outcome",
            values_callable=lambda values: [value.value for value in values],
        ),
        nullable=False,
        server_default=TournamentPaymentLineOutcome.pending.value,
    )
    entry_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tournament_entries.id", ondelete="RESTRICT")
    )

    payment: Mapped[TournamentPayment] = relationship(back_populates="lines")


class TournamentPaymentRefundObligation(Base):
    """A refund Fortymm owes but has not yet executed (#1813 executes;
    this ticket only records). ``event_id is None`` means a whole-payment
    obligation (quarantine); otherwise it is scoped to one line."""

    __tablename__ = "tournament_payment_refund_obligations"
    __table_args__ = (
        CheckConstraint(
            "amount_cents > 0", name="ck_tournament_payment_refund_obligations_amount"
        ),
        Index("ix_tournament_payment_refund_obligations_payment_id", "payment_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    payment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournament_payments.id", ondelete="RESTRICT"),
        nullable=False,
    )
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tournament_events.id", ondelete="RESTRICT")
    )
    amount_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    reason: Mapped[TournamentPaymentRefundReason] = mapped_column(
        Enum(
            TournamentPaymentRefundReason,
            name="tournament_payment_refund_reason",
            values_callable=lambda values: [value.value for value in values],
        ),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("clock_timestamp()"),
    )

    payment: Mapped[TournamentPayment] = relationship(
        back_populates="refund_obligations"
    )


class TournamentPaymentProviderEvent(Base):
    """Every Stripe webhook event Fortymm has ever seen, keyed uniquely on
    the Stripe event id so a replay is a durable no-op (#1816: "persists each
    provider event uniquely before it acknowledges it"). ``payload`` is
    write-only forensic evidence — replayed for support/audit, never read
    back into business logic (contrast the JSONB anti-pattern
    ``api/CLAUDE.md`` warns against for ``rating_state``)."""

    __tablename__ = "tournament_payment_provider_events"
    __table_args__ = (
        UniqueConstraint(
            "provider_event_id", name="uq_tournament_payment_provider_events_id"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    provider_event_id: Mapped[str] = mapped_column(String(255), nullable=False)
    event_type: Mapped[str] = mapped_column(String(255), nullable=False)
    # Nullable: an event type Fortymm doesn't act on, or one whose metadata
    # matched no payment row Fortymm created, is still persisted and
    # acknowledged (#1816) — it simply carries no payment association.
    payment_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tournament_payments.id", ondelete="RESTRICT")
    )
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("clock_timestamp()"),
    )
