"""create match_signatures table

Revision ID: 0007
Revises: 0006
Create Date: 2026-05-26 00:00:00.000000

Per the pre-deploy convention in api/CLAUDE.md, edits to this migration
happen in place. No backfill — assumes a fresh / empty DB.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "match_signatures",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "match_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("matches.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # RESTRICT (not CASCADE) so an ephemeral-user delete during account
        # merge can't silently drop a signature row; the merge service
        # repoints user_id explicitly. See app/account_merge.py.
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        # Placeholder for an eventual cryptographic blob attesting to the
        # canonical scores. Nothing reads or writes it yet — presence of the
        # row is the signal.
        sa.Column("signature", sa.LargeBinary(), nullable=True),
        sa.Column(
            "signed_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "match_id",
            "user_id",
            name="uq_match_signatures_match_id_user_id",
        ),
    )
    op.create_index(
        "ix_match_signatures_match_id", "match_signatures", ["match_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_match_signatures_match_id", table_name="match_signatures")
    op.drop_table("match_signatures")
