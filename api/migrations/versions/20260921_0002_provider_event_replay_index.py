"""index unprocessed provider events in replay order

Revision ID: 20260921_0002
Revises: 20260921_0001
"""

import sqlalchemy as sa
from alembic import op

revision = "20260921_0002"
down_revision = "20260921_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_tournament_provider_events_unprocessed_received_at",
        "tournament_provider_events",
        ["received_at"],
        postgresql_where=sa.text("processed_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_tournament_provider_events_unprocessed_received_at",
        table_name="tournament_provider_events",
    )
