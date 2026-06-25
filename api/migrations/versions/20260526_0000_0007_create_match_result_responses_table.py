"""create match_result_responses table

Revision ID: 0007
Revises: 0006
Create Date: 2026-05-26 00:00:00.000000

Per the pre-deploy convention in api/CLAUDE.md, edits to this migration
happen in place. No backfill — assumes a fresh / empty DB.

A response (confirm | dispute) to a specific posted result (``match_results``,
created in revision 0004). Was ``match_signatures`` (an attestation floating on
the match); now every sign-off hangs off one result so the per-result history
survives a dispute.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Confirm vs. dispute. See app/models/match_result_response.py:ResultResponseKind.
result_response_kind_enum = postgresql.ENUM(
    "confirm",
    "dispute",
    name="result_response_kind",
    create_type=False,
)


def upgrade() -> None:
    bind = op.get_bind()
    result_response_kind_enum.create(bind, checkfirst=True)

    op.create_table(
        "match_result_responses",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "result_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("match_results.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # RESTRICT (not CASCADE) so an ephemeral-user delete during account
        # merge can't silently drop a response row; the merge service repoints
        # user_id explicitly. See app/account_merge.py.
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("kind", result_response_kind_enum, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "result_id",
            "user_id",
            name="uq_match_result_responses_result_id_user_id",
        ),
    )
    op.create_index(
        "ix_match_result_responses_result_id",
        "match_result_responses",
        ["result_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_match_result_responses_result_id",
        table_name="match_result_responses",
    )
    op.drop_table("match_result_responses")

    bind = op.get_bind()
    result_response_kind_enum.drop(bind, checkfirst=True)
