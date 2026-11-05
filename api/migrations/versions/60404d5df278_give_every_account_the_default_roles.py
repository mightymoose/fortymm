"""Give every account the default roles

Revision ID: 60404d5df278
Revises: c1a5ce3c897f
Create Date: 2026-11-04 12:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "60404d5df278"
down_revision: str | Sequence[str] | None = "c1a5ce3c897f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Forward-only: there's no downgrade(). Autogenerate can't see triggers,
# functions or views, so write those as op.execute(...).
def upgrade() -> None:
    # Every account held the default role with no account_roles row. Now a
    # new account gets a row for each default role, so the accounts made
    # before this get theirs here.
    op.execute(
        "INSERT INTO account_roles (account_id, role_id)"
        " SELECT accounts.id, roles.id FROM accounts CROSS JOIN roles"
        " WHERE roles.is_default"
        " ON CONFLICT DO NOTHING"
    )
    op.execute(
        "UPDATE roles SET description = 'Every new account gets this role,"
        " guests too.'"
        " WHERE is_default"
        " AND description = 'Every account holds this role, guests too.'"
    )
