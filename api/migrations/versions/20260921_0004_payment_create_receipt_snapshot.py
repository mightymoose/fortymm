"""persist the immutable provider-create receipt destination

Revision ID: 20260921_0004
Revises: 20260921_0003
"""

import sqlalchemy as sa
from alembic import op

revision = "20260921_0004"
down_revision = "20260921_0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tournament_payments",
        sa.Column("create_receipt_email", sa.String(length=320), nullable=True),
    )
    # Only a never-attempted obligation can prove that its current mutable
    # receipt destination is also the create-time value. An in-flight/uncertain
    # legacy create may already exist at Stripe with an older address; guessing
    # here would make an idempotent replay use different parameters.
    op.execute(
        "UPDATE tournament_payments "
        "SET create_receipt_email = receipt_email "
        "WHERE provider_payment_id IS NULL AND provider_status IS NULL"
    )
    op.execute(
        "UPDATE tournament_payments "
        "SET provider_status = 'create_parameters_unknown', "
        "state = 'checking', create_receipt_email = NULL "
        "WHERE provider_payment_id IS NULL "
        "AND provider_status IN ('create_in_flight', 'create_uncertain')"
    )
    op.drop_index(
        "ix_tournament_payments_reconciliation_pending_created_at_id",
        table_name="tournament_payments",
    )
    op.create_index(
        "ix_tournament_payments_reconciliation_pending_created_at_id",
        "tournament_payments",
        ["created_at", "id"],
        postgresql_where=sa.text(
            "state IN ('preparing', 'ready', 'action_required', 'checking') "
            "OR (state = 'expired' AND provider_payment_id IS NOT NULL) "
            "OR (provider_payment_id IS NULL "
            "AND provider_status IN ('create_in_flight', "
            "'create_uncertain', 'create_parameters_unknown')) "
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


def downgrade() -> None:
    op.execute(
        "UPDATE tournament_payments "
        "SET provider_status = 'create_uncertain' "
        "WHERE provider_payment_id IS NULL "
        "AND provider_status = 'create_parameters_unknown'"
    )
    op.drop_index(
        "ix_tournament_payments_reconciliation_pending_created_at_id",
        table_name="tournament_payments",
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
    op.drop_column("tournament_payments", "create_receipt_email")
