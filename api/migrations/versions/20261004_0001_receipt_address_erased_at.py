"""receipt address erasure tombstone (#1810)

Revision ID: 20261004_0001
Revises: 20260927_0001
"""

import sqlalchemy as sa
from alembic import op

revision = "20261004_0001"
down_revision = "20260927_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Nullable: NULL means "never erased". The previous release does not
    # select the column, so existing rows need no default.
    op.add_column(
        "tournament_payments",
        sa.Column(
            "receipt_address_erased_at", sa.DateTime(timezone=True), nullable=True
        ),
    )
    # The previous release erased an account without touching its receipt
    # addresses, and ``erase_account`` rejects an account that is already erased,
    # so nothing could clear these later. Clean them here, before the check
    # constraint below. A payment is reached through its own payer or through
    # its checkout's payer: an account merge moves the first and not the second.
    op.execute(
        """
        UPDATE tournament_payments
        SET receipt_address = NULL, receipt_address_erased_at = clock_timestamp()
        WHERE receipt_address IS NOT NULL
          AND (
            payer_account_id IN (SELECT id FROM accounts WHERE erased_at IS NOT NULL)
            OR checkout_id IN (
              SELECT id FROM tournament_checkouts
              WHERE payer_account_id IN (
                SELECT id FROM accounts WHERE erased_at IS NOT NULL
              )
            )
          )
        """
    )
    op.execute(
        """
        UPDATE tournament_checkouts
        SET receipt_address = NULL
        WHERE receipt_address IS NOT NULL
          AND (
            payer_account_id IN (SELECT id FROM accounts WHERE erased_at IS NOT NULL)
            OR id IN (
              SELECT checkout_id FROM tournament_payments
              WHERE payer_account_id IN (
                SELECT id FROM accounts WHERE erased_at IS NOT NULL
              )
            )
          )
        """
    )
    op.create_check_constraint(
        "ck_tournament_payments_erased_receipt_has_no_address",
        "tournament_payments",
        "receipt_address IS NULL OR receipt_address_erased_at IS NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_tournament_payments_erased_receipt_has_no_address",
        "tournament_payments",
        type_="check",
    )
    op.drop_column("tournament_payments", "receipt_address_erased_at")
