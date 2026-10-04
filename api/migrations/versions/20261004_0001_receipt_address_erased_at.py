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
