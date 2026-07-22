"""add auth0_sub to users

Revision ID: 0017
Revises: 0016
Create Date: 2026-07-22 00:00:00.000000

A nullable, unique ``auth0_sub`` column binds a fortymm user to an Auth0
subject (``sub``) via the in-session link flow. The binding is one-to-one: at
most one user may carry a given ``sub`` (unique constraint), and a user carries
at most one ``sub``. NULL until the user explicitly links. See ADR
``20260722-the-mcp-server-is-an-oauth-resource-server-trusting-auth0``.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0017"
down_revision: Union[str, None] = "0016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("auth0_sub", sa.String(length=255), nullable=True),
    )
    op.create_unique_constraint("uq_users_auth0_sub", "users", ["auth0_sub"])
    op.create_index("ix_users_auth0_sub", "users", ["auth0_sub"])


def downgrade() -> None:
    op.drop_index("ix_users_auth0_sub", table_name="users")
    op.drop_constraint("uq_users_auth0_sub", "users", type_="unique")
    op.drop_column("users", "auth0_sub")
