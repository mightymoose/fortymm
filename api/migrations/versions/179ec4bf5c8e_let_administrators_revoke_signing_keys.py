"""Let administrators revoke signing keys

Revision ID: 179ec4bf5c8e
Revises: bb0605636f12
Create Date: 2026-11-03 09:39:41.720302

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "179ec4bf5c8e"
down_revision: str | Sequence[str] | None = "bb0605636f12"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Forward-only: there's no downgrade(). Autogenerate can't see triggers,
# functions or views, so write those as op.execute(...).
def upgrade() -> None:
    op.add_column("signing_keys", sa.Column("revoked_by", sa.Uuid(), nullable=True))
    op.execute(
        "UPDATE signing_keys SET revoked_by = account_id WHERE revoked_at IS NOT NULL"
    )
    op.create_foreign_key(
        op.f("fk_signing_keys_revoked_by_accounts"),
        "signing_keys",
        "accounts",
        ["revoked_by"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_check_constraint(
        op.f("ck_signing_keys_revoked_by_with_revoked_at"),
        "signing_keys",
        "(revoked_at IS NULL) = (revoked_by IS NULL)",
    )
    op.execute(
        "INSERT INTO permissions (key, description, built_in) VALUES"
        " ('signing_keys.revoke', 'Revoke any account''s device signing key.', true)"
    )
    op.execute(
        "INSERT INTO role_permissions (role_id, permission_key)"
        " SELECT role_id, 'signing_keys.revoke' FROM role_permissions"
        " WHERE permission_key = 'account_roles.manage'"
    )
