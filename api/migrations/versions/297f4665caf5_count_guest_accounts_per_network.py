"""Count guest accounts per network

Revision ID: 297f4665caf5
Revises: b3214d6c1724
Create Date: 2026-10-25 08:49:58.369460

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "297f4665caf5"
down_revision: str | Sequence[str] | None = "b3214d6c1724"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Forward-only: there's no downgrade(). Autogenerate can't see triggers,
# functions or views, so write those as op.execute(...).
def upgrade() -> None:
    op.create_table(
        "guest_account_counts",
        sa.Column("network", postgresql.CIDR(), nullable=False),
        sa.Column("window_ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("network", name=op.f("pk_guest_account_counts")),
    )
    op.create_index(
        op.f("ix_guest_account_counts_window_ends_at"),
        "guest_account_counts",
        ["window_ends_at"],
        unique=False,
    )
