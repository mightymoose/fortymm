"""create user_tokens table

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
        # Set when a newer login request supersedes this row — see
        # UserToken.replaced_at / app.sessions._issue_and_send_login_email.
        sa.Column("replaced_at", sa.DateTime(timezone=True), nullable=True),
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
    # The hourly scheduled sweep (app.email_token_sweep) deletes every
    # replaced pending-email token past its lifetime in ONE statement across
    # all users, keyed on context / replaced_at / created_at — a predicate no
    # index above can serve, so each run would seq-scan the whole table even
    # when there is nothing to delete, and the table is dominated by session
    # tokens the sweep must never touch. The partial predicate mirrors the
    # sweep's WHERE clause exactly, so the index holds only the tiny
    # replaced pending-email population; both prefixes must stay in step with
    # app.email_token_sweep's EMAIL_*_CONTEXT_PREFIX constants.
    op.create_index(
        "ix_user_tokens_replaced_pending_email",
        "user_tokens",
        ["created_at"],
        postgresql_where=sa.text(
            "replaced_at IS NOT NULL "
            "AND (context LIKE 'change:%' OR context LIKE 'merge:%')"
        ),
    )


def downgrade() -> None:
    op.drop_index("ix_user_tokens_replaced_pending_email", table_name="user_tokens")
    op.drop_index("ix_user_tokens_token", table_name="user_tokens")
    op.drop_index("ix_user_tokens_user_id", table_name="user_tokens")
    op.drop_table("user_tokens")
