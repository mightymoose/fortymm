"""add notifications.result_id

Revision ID: 0014
Revises: 0013
Create Date: 2026-08-28 00:00:00.000000

Binds a *hideable* in-app notification (the "Accept your match result" prompt
and the retirement "A result is waiting for you" reminder) to the specific
``match_results.id`` it's asking about, so the feed/unread-count queries can
hide the row once that result is no longer live — accepted, superseded by a
counter, or auto-accepted by the retirement sweep — without deleting it
(issue #1583). Nullable and ``ON DELETE SET NULL``: every other notification
(including the "Your result was accepted" / "Match finalized" FYI notices)
leaves it unset, and losing the ``match_results`` row just un-hides the
notification rather than orphaning it. Per the pre-deploy convention in
api/CLAUDE.md, edits to this migration happen in place. No backfill — assumes
a fresh / empty DB.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0014"
down_revision: Union[str, None] = "0013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "notifications",
        sa.Column(
            "result_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("match_results.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("ix_notifications_result_id", "notifications", ["result_id"])


def downgrade() -> None:
    op.drop_index("ix_notifications_result_id", table_name="notifications")
    op.drop_column("notifications", "result_id")
