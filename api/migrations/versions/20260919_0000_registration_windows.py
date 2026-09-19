"""explicit published-registration windows

Revision ID: 20260919_0000
Revises: 20260905_0000
"""

import sqlalchemy as sa
from alembic import op

revision = "20260919_0000"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tournaments", sa.Column("registration_open", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("tournaments", sa.Column("registration_generation", sa.Integer(), nullable=False, server_default=sa.text("0")))
    op.execute("UPDATE tournaments SET registration_open = (status = 'published'), registration_generation = CASE WHEN status = 'published' THEN 1 ELSE 0 END")
    op.create_table(
        "tournament_registration_window_changes",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("tournament_id", sa.UUID(), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("is_open", sa.Boolean(), nullable=False),
        sa.Column("changed_at", sa.DateTime(timezone=True), server_default=sa.text("clock_timestamp()"), nullable=False),
        sa.ForeignKeyConstraint(["tournament_id"], ["tournaments.id"]),
        sa.ForeignKeyConstraint(["actor_id"], ["accounts.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_tournament_registration_window_changes_tournament_id", "tournament_registration_window_changes", ["tournament_id"])


def downgrade() -> None:
    op.drop_index("ix_tournament_registration_window_changes_tournament_id", table_name="tournament_registration_window_changes")
    op.drop_table("tournament_registration_window_changes")
    op.drop_column("tournaments", "registration_generation")
    op.drop_column("tournaments", "registration_open")
