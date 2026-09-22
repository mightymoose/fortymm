"""durable tournament payment preparation

Revision ID: 20260921_0000
Revises: 20260919_0001
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20260921_0000"
down_revision = "20260919_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    payment_state = postgresql.ENUM(
        "preparing",
        "ready",
        "checking",
        "action_required",
        "succeeded",
        "failed",
        "expired",
        "canceled",
        name="tournament_payment_state",
        create_type=False,
    )
    postgresql.ENUM(
        "preparing",
        "ready",
        "checking",
        "action_required",
        "succeeded",
        "failed",
        "expired",
        "canceled",
        name="tournament_payment_state",
    ).create(op.get_bind())
    op.create_unique_constraint(
        "uq_tournament_checkout_lines_id_checkout",
        "tournament_checkout_lines",
        ["id", "checkout_id"],
    )
    op.create_table(
        "tournament_payments",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("checkout_id", sa.UUID(), nullable=False),
        sa.Column(
            "provider", sa.String(length=32), server_default="stripe", nullable=False
        ),
        sa.Column("durable_identity", sa.String(length=255), nullable=False),
        sa.Column("provider_payment_id", sa.String(length=255), nullable=True),
        sa.Column("provider_status", sa.String(length=64), nullable=True),
        sa.Column("client_secret", sa.String(length=512), nullable=True),
        sa.Column("receipt_email", sa.String(length=320), nullable=True),
        sa.Column(
            "receipt_sync_pending",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column(
            "currency", sa.String(length=3), server_default="USD", nullable=False
        ),
        sa.Column("amount_cents", sa.BigInteger(), nullable=False),
        sa.Column("state", payment_state, server_default="preparing", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "amount_cents > 0", name="ck_tournament_payments_amount_positive"
        ),
        sa.CheckConstraint(
            "currency = 'USD'", name="ck_tournament_payments_currency_usd"
        ),
        sa.ForeignKeyConstraint(
            ["checkout_id"], ["tournament_checkouts.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("checkout_id", name="uq_tournament_payments_checkout"),
        sa.UniqueConstraint("durable_identity", name="uq_tournament_payments_identity"),
        sa.UniqueConstraint(
            "provider_payment_id", name="uq_tournament_payments_provider_payment"
        ),
        sa.UniqueConstraint(
            "id", "checkout_id", name="uq_tournament_payments_id_checkout"
        ),
    )
    op.create_index(
        "ix_tournament_payments_checkout_id", "tournament_payments", ["checkout_id"]
    )
    op.create_table(
        "tournament_payment_allocations",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("payment_id", sa.UUID(), nullable=False),
        sa.Column("checkout_line_id", sa.UUID(), nullable=False),
        sa.Column("checkout_id", sa.UUID(), nullable=False),
        sa.Column("amount_cents", sa.BigInteger(), nullable=False),
        sa.Column(
            "outcome",
            sa.Enum(
                "confirmed", "refund_pending", name="tournament_payment_line_outcome"
            ),
            nullable=True,
        ),
        sa.Column(
            "refund_amount_cents", sa.BigInteger(), server_default="0", nullable=False
        ),
        sa.CheckConstraint(
            "amount_cents > 0", name="ck_tournament_payment_allocations_amount_positive"
        ),
        sa.ForeignKeyConstraint(
            ["payment_id", "checkout_id"],
            ["tournament_payments.id", "tournament_payments.checkout_id"],
            ondelete="CASCADE",
            name="fk_tournament_payment_allocations_payment_checkout",
        ),
        sa.ForeignKeyConstraint(
            ["checkout_line_id", "checkout_id"],
            ["tournament_checkout_lines.id", "tournament_checkout_lines.checkout_id"],
            ondelete="RESTRICT",
            name="fk_tournament_payment_allocations_line_checkout",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "payment_id",
            "checkout_line_id",
            name="uq_tournament_payment_allocations_line",
        ),
    )
    op.add_column(
        "tournament_payments",
        sa.Column("provider_evidence_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "tournament_payments",
        sa.Column("support_reference", sa.String(length=32), nullable=True),
    )
    op.create_unique_constraint(
        "uq_tournament_payments_support_reference",
        "tournament_payments",
        ["support_reference"],
    )
    op.create_table(
        "tournament_provider_events",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("provider_event_id", sa.String(length=255), nullable=False),
        sa.Column("event_type", sa.String(length=128), nullable=False),
        sa.Column("provider_payment_id", sa.String(length=255), nullable=False),
        sa.Column("evidence_json", sa.Text(), nullable=False),
        sa.Column("provider_created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("provider_event_id"),
    )
    op.create_table(
        "tournament_refund_obligations",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("payment_id", sa.UUID(), nullable=False),
        sa.Column("checkout_line_id", sa.UUID(), nullable=True),
        sa.Column("amount_cents", sa.BigInteger(), nullable=False),
        sa.Column("reason", sa.String(length=64), nullable=False),
        sa.Column(
            "state",
            sa.Enum("pending", name="tournament_refund_state"),
            server_default="pending",
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "amount_cents > 0",
            name="ck_tournament_refund_obligations_amount_positive",
        ),
        sa.ForeignKeyConstraint(
            ["payment_id"], ["tournament_payments.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["checkout_line_id"], ["tournament_checkout_lines.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "payment_id",
            "checkout_line_id",
            name="uq_tournament_refund_obligations_line",
        ),
    )


def downgrade() -> None:
    op.drop_table("tournament_refund_obligations")
    op.drop_table("tournament_provider_events")
    op.drop_constraint(
        "uq_tournament_payments_support_reference",
        "tournament_payments",
        type_="unique",
    )
    op.drop_column("tournament_payments", "support_reference")
    op.drop_column("tournament_payments", "provider_evidence_at")
    op.drop_table("tournament_payment_allocations")
    op.drop_index(
        "ix_tournament_payments_checkout_id", table_name="tournament_payments"
    )
    op.drop_table("tournament_payments")
    op.drop_constraint(
        "uq_tournament_checkout_lines_id_checkout",
        "tournament_checkout_lines",
        type_="unique",
    )
    sa.Enum(name="tournament_payment_state").drop(op.get_bind())
    sa.Enum(name="tournament_payment_line_outcome").drop(op.get_bind())
    sa.Enum(name="tournament_refund_state").drop(op.get_bind())
