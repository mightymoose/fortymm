"""create user_tokens table

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-11 00:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user_tokens",
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
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_user_tokens_user_id", "user_tokens", ["user_id"]
    )
    # Every cookie validation and every magic-link click looks up tokens by
    # (token, context). Without this index Postgres falls back to a seq scan
    # on user_tokens, which gets expensive once any session table grows.
    op.create_index(
        "ix_user_tokens_token", "user_tokens", ["token"]
    )


def downgrade() -> None:
    op.drop_index("ix_user_tokens_token", table_name="user_tokens")
    op.drop_index("ix_user_tokens_user_id", table_name="user_tokens")
    op.drop_table("user_tokens")
