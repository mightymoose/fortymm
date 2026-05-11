"""create users_tokens table

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-11 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "users_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("token", sa.LargeBinary(), nullable=False),
        sa.Column("context", sa.String(length=255), nullable=False),
        sa.Column("sent_to", sa.String(length=255), nullable=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_users_tokens_user_id", "users_tokens", ["user_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_users_tokens_user_id", table_name="users_tokens")
    op.drop_table("users_tokens")
