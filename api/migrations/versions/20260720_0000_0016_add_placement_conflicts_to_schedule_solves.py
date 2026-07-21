"""add placement_conflicts to schedule_solves

Revision ID: 0016
Revises: 0015
Create Date: 2026-07-20 00:00:00.000000

A new JSONB column carrying a solve's *resolved* in-progress-vs-in-progress
placement conflicts (ADR "overlapping in-progress matches are tolerated and
reported"). Parallel to ``infeasibility_reasons`` but orthogonal to the
verdict: two matches recorded on one table (or one human in two) are
contradictory data the solver tolerates rather than letting them blank the
board (#1144), and a fully-placed ``optimal``/``feasible`` solve can still
carry them. Written on any verdict where the solver ran (``[]`` when there were
none), NULL only before a solve reaches its apply.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0016"
down_revision: Union[str, None] = "0015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "schedule_solves",
        sa.Column("placement_conflicts", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("schedule_solves", "placement_conflicts")
