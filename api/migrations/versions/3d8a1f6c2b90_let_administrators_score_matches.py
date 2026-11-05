"""let administrators score matches

Revision ID: 3d8a1f6c2b90
Revises: ecc7bbfa7c64
Create Date: 2026-11-05 15:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "3d8a1f6c2b90"
down_revision: str | Sequence[str] | None = "ecc7bbfa7c64"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Forward-only: there's no downgrade(). Autogenerate can't see triggers,
# functions or views, so write those as op.execute(...).
def upgrade() -> None:
    op.execute(
        "INSERT INTO permissions (key, description, built_in) VALUES"
        " ('matches.score', 'Send a match''s boards and signed results.', true)"
    )
    # A role that grants roles could already grant itself this. The default
    # role doesn't get it, so scoring stays off for everyone else until an
    # admin grants it.
    op.execute(
        "INSERT INTO role_permissions (role_id, permission_key)"
        " SELECT role_id, 'matches.score' FROM role_permissions"
        " WHERE permission_key = 'account_roles.manage'"
    )
