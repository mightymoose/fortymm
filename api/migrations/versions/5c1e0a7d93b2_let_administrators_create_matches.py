"""Let administrators create matches

Revision ID: 5c1e0a7d93b2
Revises: 4696a76ce94f
Create Date: 2026-11-04 20:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "5c1e0a7d93b2"
down_revision: str | Sequence[str] | None = "4696a76ce94f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Forward-only: there's no downgrade(). Autogenerate can't see triggers,
# functions or views, so write those as op.execute(...).
def upgrade() -> None:
    op.execute(
        "INSERT INTO permissions (key, description, built_in) VALUES"
        " ('matches.create', 'Create a match.', true)"
    )
    op.execute(
        "INSERT INTO role_permissions (role_id, permission_key)"
        " SELECT role_id, 'matches.create' FROM role_permissions"
        " WHERE permission_key = 'account_roles.manage'"
    )
