"""Let administrators view matches and players

Revision ID: 7b3d9e1f2a64
Revises: c1a5ce3c897f
Create Date: 2026-11-05 12:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "7b3d9e1f2a64"
down_revision: str | Sequence[str] | None = "c1a5ce3c897f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Forward-only: there's no downgrade(). Autogenerate can't see triggers,
# functions or views, so write those as op.execute(...).
def upgrade() -> None:
    op.execute(
        "INSERT INTO permissions (key, description, built_in) VALUES"
        " ('matches.view', 'See the matches page.', true),"
        " ('players.view', 'See the players page.', true)"
    )
    op.execute(
        "INSERT INTO role_permissions (role_id, permission_key)"
        " SELECT role_id, key FROM role_permissions"
        " CROSS JOIN (VALUES ('matches.view'), ('players.view')) AS new (key)"
        " WHERE permission_key = 'account_roles.manage'"
    )
