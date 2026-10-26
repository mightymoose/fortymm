"""Free merged players' display names

Revision ID: eb2a2cbdde4c
Revises: 960b72810c2e
Create Date: 2026-10-26 09:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "eb2a2cbdde4c"
down_revision: str | Sequence[str] | None = "960b72810c2e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Forward-only: there's no downgrade(). Autogenerate can't see triggers,
# functions or views, so write those as op.execute(...).
def upgrade() -> None:
    # A merged player gives up its display name, so the unique index skips
    # it. Autogenerate doesn't compare an index's WHERE clause.
    op.drop_index("unique_display_name", table_name="players")
    op.create_index(
        "unique_display_name",
        "players",
        [sa.literal_column("lower(display_name)")],
        unique=True,
        postgresql_where=sa.text("merged_into IS NULL"),
    )
