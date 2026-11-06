"""let administrators override match results

Revision ID: ecc7bbfa7c64
Revises: 7b3d9e1f2a64
Create Date: 2026-11-04 10:44:53.081081

"""

from collections.abc import Sequence

from alembic import op

revision: str = "ecc7bbfa7c64"
down_revision: str | Sequence[str] | None = "7b3d9e1f2a64"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Forward-only: there's no downgrade(). Autogenerate can't see triggers,
# functions or views, so write those as op.execute(...).
def upgrade() -> None:
    op.execute(
        "INSERT INTO permissions (key, description, built_in) VALUES"
        " ('matches.override', 'Impose a match''s result, with a reason.', true)"
    )
    # A role that grants roles could already grant itself this.
    op.execute(
        "INSERT INTO role_permissions (role_id, permission_key)"
        " SELECT role_id, 'matches.override' FROM role_permissions"
        " WHERE permission_key = 'account_roles.manage'"
    )
