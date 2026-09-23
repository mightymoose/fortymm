"""durable tournament payment receipts and payment notifications

Revision ID: 20260921_0001
Revises: 20260921_0000
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20260921_0001"
down_revision = "20260921_0000"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TYPE tournament_refund_state ADD VALUE IF NOT EXISTS 'resolved'")
    op.add_column(
        "tournament_refund_obligations",
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "tournament_payments",
        sa.Column("settlement_notified_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "tournament_payments",
        sa.Column("attention_notified_state", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "tournament_payments",
        sa.Column("provider_mismatch_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "tournament_payments",
        sa.Column("receipt_sync_failed_at", sa.DateTime(timezone=True), nullable=True),
    )
    receipt_state = postgresql.ENUM(
        "pending",
        "retry_scheduled",
        "sent",
        "failed",
        "canceled",
        name="tournament_receipt_state",
    )
    receipt_state.create(op.get_bind())
    receipt_state_column = postgresql.ENUM(
        "pending",
        "retry_scheduled",
        "sent",
        "failed",
        "canceled",
        name="tournament_receipt_state",
        create_type=False,
    )
    op.create_table(
        "tournament_payment_receipts",
        sa.Column(
            "id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("payment_id", sa.UUID(), nullable=False),
        sa.Column("recipient_email", sa.String(length=320), nullable=True),
        sa.Column("outcomes", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "state", receipt_state_column, server_default="pending", nullable=False
        ),
        sa.Column("attempt_count", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("retry_deadline_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failure_kind", sa.String(length=64), nullable=True),
        sa.Column("support_reference", sa.String(length=32), nullable=True),
        sa.Column("pii_erased_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["payment_id"], ["tournament_payments.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "payment_id", name="uq_tournament_payment_receipts_payment"
        ),
        sa.UniqueConstraint("support_reference"),
    )
    op.create_index(
        "ix_tournament_payment_receipts_next_attempt",
        "tournament_payment_receipts",
        ["next_attempt_at"],
    )
    op.execute(
        sa.text(
            """
            INSERT INTO notification_types
                (id, key, name, short_label, description, display_order,
                 is_active, created_at, updated_at)
            VALUES
                (gen_random_uuid(), 'payments', 'Payments', 'Payments',
                 'Payment confirmation, review, and refund updates.', 7,
                 true, now(), now())
            ON CONFLICT (key) DO NOTHING
            """
        )
    )


def downgrade() -> None:
    # The type is the parent of both persisted delivery preferences and notification
    # history. Remove only this migration's category dependents before removing their
    # type; unrelated notification categories and their rows must survive downgrade.
    op.execute("DELETE FROM notification_preferences WHERE category = 'payments'")
    op.execute("DELETE FROM notifications WHERE category = 'payments'")
    op.execute("DELETE FROM notification_types WHERE key = 'payments'")
    op.drop_index(
        "ix_tournament_payment_receipts_next_attempt",
        table_name="tournament_payment_receipts",
    )
    op.drop_table("tournament_payment_receipts")
    postgresql.ENUM(name="tournament_receipt_state").drop(op.get_bind())
    op.drop_column("tournament_payments", "receipt_sync_failed_at")
    op.drop_column("tournament_payments", "provider_mismatch_at")
    op.drop_column("tournament_payments", "attention_notified_state")
    op.drop_column("tournament_payments", "settlement_notified_at")
    op.drop_column("tournament_refund_obligations", "resolved_at")
    # PostgreSQL cannot remove one enum value without rebuilding the type. A
    # downgrade leaves the harmless value available to old code.
