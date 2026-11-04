"""Add the default user role

Revision ID: c1a5ce3c897f
Revises: 5c1e0a7d93b2
Create Date: 2026-11-04 23:07:23.724321

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c1a5ce3c897f"
down_revision: str | Sequence[str] | None = "5c1e0a7d93b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Forward-only: there's no downgrade(). Autogenerate can't see triggers,
# functions or views, so write those as op.execute(...).
def upgrade() -> None:
    op.add_column(
        "roles",
        sa.Column(
            "is_default", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
    )
    op.create_index(
        "one_default_role",
        "roles",
        ["is_default"],
        unique=True,
        postgresql_where=sa.text("is_default"),
    )
    # Every account holds it with no account_roles row, so it starts with no
    # permissions and an admin turns features on for everyone.
    op.execute(
        "INSERT INTO roles (name, description, is_default) VALUES"
        " ('User', 'Every account holds this role, guests too.', true)"
    )
