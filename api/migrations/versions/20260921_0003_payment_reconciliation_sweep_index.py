"""index pending tournament payment reconciliation obligations

Revision ID: 20260921_0003
Revises: 20260921_0002
"""

import sqlalchemy as sa
from alembic import op

revision = "20260921_0003"
down_revision = "20260921_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint(
        "uq_tournament_payments_provider_payment",
        "tournament_payments",
        type_="unique",
    )
    op.create_index(
        "uq_tournament_payments_provider_payment",
        "tournament_payments",
        ["provider_payment_id"],
        unique=True,
        postgresql_where=sa.text("provider_payment_id IS NOT NULL"),
    )
    op.create_index(
        "ix_tournament_payments_reconciliation_pending_created_at_id",
        "tournament_payments",
        ["created_at", "id"],
        postgresql_where=sa.text(
            "state IN ('preparing', 'ready', 'action_required', 'checking') "
            "OR (state = 'expired' AND provider_payment_id IS NOT NULL) "
            "OR (provider_payment_id IS NULL "
            "AND provider_status = 'create_in_flight') "
            "OR (state = 'succeeded' "
            "AND (receipt_sync_pending IS TRUE "
            "OR settlement_notified_at IS NULL)) "
            "OR (state = 'failed' "
            "AND (receipt_sync_pending IS TRUE "
            "OR (provider_status = 'create_rejected' "
            "AND attention_notified_state IS DISTINCT FROM 'create_rejected') "
            "OR (provider_mismatch_at IS NOT NULL "
            "AND attention_notified_state IS DISTINCT FROM "
            "'provider_mismatch'))) "
            "OR (state = 'canceled' "
            "AND provider_payment_id IS NOT NULL "
            "AND receipt_sync_pending IS TRUE)"
        ),
    )
    op.create_index(
        "ix_tournament_payment_allocations_refund_pending_payment_id",
        "tournament_payment_allocations",
        ["payment_id"],
        postgresql_where=sa.text("outcome = 'refund_pending'"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_tournament_payment_allocations_refund_pending_payment_id",
        table_name="tournament_payment_allocations",
    )
    op.drop_index(
        "ix_tournament_payments_reconciliation_pending_created_at_id",
        table_name="tournament_payments",
    )
    op.drop_index(
        "uq_tournament_payments_provider_payment",
        table_name="tournament_payments",
    )
    op.create_unique_constraint(
        "uq_tournament_payments_provider_payment",
        "tournament_payments",
        ["provider_payment_id"],
    )
