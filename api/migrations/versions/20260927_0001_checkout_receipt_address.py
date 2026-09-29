"""checkout receipt address (#1809)

Revision ID: 20260927_0001
Revises: 20260925_0001
"""

import sqlalchemy as sa
from alembic import op

revision = "20260927_0001"
down_revision = "20260925_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Both nullable: NULL means "no receipt email" on the checkout, and "not
    # yet snapshotted" (or never set) on the payment. Neither previous
    # release selects this column, so it needs no default for existing rows.
    op.add_column(
        "tournament_checkouts",
        sa.Column("receipt_address", sa.String(length=320), nullable=True),
    )
    op.add_column(
        "tournament_payments",
        sa.Column("receipt_address", sa.String(length=320), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("tournament_payments", "receipt_address")
    op.drop_column("tournament_checkouts", "receipt_address")
