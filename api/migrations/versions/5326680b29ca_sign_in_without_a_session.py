"""Sign in without a session

Revision ID: 5326680b29ca
Revises: eb2a2cbdde4c
Create Date: 2026-10-26 18:03:34.993256

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5326680b29ca"
down_revision: str | Sequence[str] | None = "eb2a2cbdde4c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Forward-only: there's no downgrade(). Autogenerate can't see triggers,
# functions or views, so write those as op.execute(...).
def upgrade() -> None:
    op.alter_column(
        "login_attempts", "session_id", existing_type=sa.UUID(), nullable=True
    )
