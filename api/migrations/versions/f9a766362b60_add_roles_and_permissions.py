"""Add roles and permissions

Revision ID: f9a766362b60
Revises: e88c34e67214
Create Date: 2026-11-01 11:21:09.114034

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f9a766362b60"
down_revision: str | Sequence[str] | None = "e88c34e67214"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Forward-only: there's no downgrade(). Autogenerate can't see triggers,
# functions or views, so write those as op.execute(...).
def upgrade() -> None:
    op.create_table(
        "permissions",
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), server_default="", nullable=False),
        sa.Column(
            "built_in", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            r"key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'",
            name=op.f("ck_permissions_key_format"),
        ),
        sa.CheckConstraint(
            "char_length(key) <= 64", name=op.f("ck_permissions_key_length")
        ),
        sa.PrimaryKeyConstraint("key", name=op.f("pk_permissions")),
    )
    op.create_table(
        "roles",
        sa.Column(
            "id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), server_default="", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "name = btrim(name) AND name <> ''", name=op.f("ck_roles_name_trimmed")
        ),
        sa.CheckConstraint(
            "char_length(name) <= 50", name=op.f("ck_roles_name_length")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_roles")),
    )
    op.create_index(
        "unique_role_name", "roles", [sa.literal_column("lower(name)")], unique=True
    )
    op.create_table(
        "account_roles",
        sa.Column("account_id", sa.Uuid(), nullable=False),
        sa.Column("role_id", sa.Uuid(), nullable=False),
        sa.Column(
            "granted_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("granted_by", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["accounts.id"],
            name=op.f("fk_account_roles_account_id_accounts"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["granted_by"],
            ["accounts.id"],
            name=op.f("fk_account_roles_granted_by_accounts"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["role_id"],
            ["roles.id"],
            name=op.f("fk_account_roles_role_id_roles"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("account_id", "role_id", name=op.f("pk_account_roles")),
    )
    op.create_table(
        "email_role_grants",
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("role_id", sa.Uuid(), nullable=False),
        sa.CheckConstraint(
            "email = lower(email)", name=op.f("ck_email_role_grants_email_lowercase")
        ),
        sa.ForeignKeyConstraint(
            ["role_id"],
            ["roles.id"],
            name=op.f("fk_email_role_grants_role_id_roles"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("email", "role_id", name=op.f("pk_email_role_grants")),
    )
    op.create_table(
        "role_permissions",
        sa.Column("role_id", sa.Uuid(), nullable=False),
        sa.Column("permission_key", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(
            ["permission_key"],
            ["permissions.key"],
            name=op.f("fk_role_permissions_permission_key_permissions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["role_id"],
            ["roles.id"],
            name=op.f("fk_role_permissions_role_id_roles"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "role_id", "permission_key", name=op.f("pk_role_permissions")
        ),
    )
    # The built-in permissions: the members of Permission in this revision.
    op.bulk_insert(
        sa.table(
            "permissions",
            sa.column("key"),
            sa.column("description"),
            sa.column("built_in", sa.Boolean()),
        ),
        [
            {
                "key": "admin.view",
                "built_in": True,
                "description": "Open the admin page, and list roles, permissions"
                " and accounts.",
            },
            {
                "key": "roles.manage",
                "built_in": True,
                "description": "Create, edit and delete roles and the permissions"
                " they grant.",
            },
            {
                "key": "account_roles.manage",
                "built_in": True,
                "description": "Grant and revoke roles on accounts.",
            },
        ],
    )
    op.execute(
        "INSERT INTO roles (name, description) VALUES"
        " ('Administrator', 'Manages roles, permissions and who holds them.')"
    )
    op.execute(
        "INSERT INTO role_permissions (role_id, permission_key)"
        " SELECT roles.id, permissions.key FROM roles, permissions"
        " WHERE roles.name = 'Administrator'"
    )
    # The first administrator. Their account holds the role if it exists, or
    # else their first sign-in claims it.
    op.execute(
        "INSERT INTO account_roles (account_id, role_id)"
        " SELECT accounts.id, roles.id FROM accounts, roles"
        " WHERE accounts.email = 'mightymoose@fortymm.com'"
        " AND accounts.adopted_into IS NULL AND roles.name = 'Administrator'"
    )
    op.execute(
        "INSERT INTO email_role_grants (email, role_id)"
        " SELECT 'mightymoose@fortymm.com', roles.id FROM roles"
        " WHERE roles.name = 'Administrator' AND NOT EXISTS"
        " (SELECT FROM account_roles WHERE role_id = roles.id)"
    )
