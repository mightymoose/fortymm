"""add rerun_requested to schedule_solves

Revision ID: 0014
Revises: 0013
Create Date: 2026-07-16 00:01:00.000000

The coalesced enqueue's second arm (ADR "the schedule is solved, the call is
pinned"): a trigger that lands while a solve is *running* cannot be absorbed by
the queued row (there isn't one) and must not enqueue a second job (one solve in
flight per tournament) — so it sets this flag on the running row, and the job
clears it at finish and immediately re-queues (trigger ``rerun``). No trigger is
ever lost to timing.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: Union[str, None] = "0013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "schedule_solves",
        sa.Column(
            "rerun_requested",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("schedule_solves", "rerun_requested")
