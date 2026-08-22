"""create users table

Revision ID: 0001
Revises:
Create Date: 2026-05-10 00:00:00.000000

``last_seen_at`` (the #1438 anti-enumeration stamp) is folded into this
migration rather than added as its own revision, per the pre-deploy
edit-in-place convention in ``api/CLAUDE.md``: no production deploy exists, so
every database is wiped and re-run from empty. There is deliberately NO
backfill step: a wipe-and-rebuild deploy has no rows to backfill, which
discharges the "no listed user may disappear on deploy" requirement by
mechanism. Any database that already applied the pre-fold revision (UAT's
volume, a live QA stack) must be wiped and re-migrated — Alembic will not
re-run ``0001`` on its own.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("username", sa.String(length=255), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=True),
        sa.Column(
            "confirmed_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        # When a session cookie last resolved this row through the auth
        # resolver, throttled to one write per window. NULL means no person has
        # ever browsed the account (a pending first-sign-in mint or an
        # abandoned token consume), so public listings must omit it — see
        # ``app.listed.is_listed_player`` (#1438). Not stamped at mint.
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        # Tombstone for an ephemeral user folded into another account by the
        # merge service. Soft-delete (rather than DROP) so the guest's session
        # token still resolves and `GET /v1/session` can tell the holder their
        # session was merged, instead of silently minting a fresh guest.
        sa.Column(
            "merged_into_user_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
        sa.Column(
            "merged_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        # Binds a fortymm user to an Auth0 subject (``sub``) via the in-session
        # link flow. The binding is one-to-one: at most one user may carry a
        # given ``sub`` (unique constraint), and a user carries at most one
        # ``sub``. NULL until the user explicitly links. See ADR
        # ``20260722-the-mcp-server-is-an-oauth-resource-server-trusting-auth0``.
        sa.Column("auth0_sub", sa.String(length=255), nullable=True),
        # When ``auth0_sub`` was first bound — the moment an Auth0 identity became
        # linked to this account, so the agent-access settings surface can say
        # "Connected <date>". Written only at the two bind sites in
        # ``app.auth0_provisioning``; the steady-state resolve-by-``sub`` path
        # never rewrites it. NULL for an account that has never linked.
        sa.Column(
            "agent_access_linked_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        # When the player switched agent access off. The user's own revocation,
        # distinct from the operator's RBAC ``mcp.access`` grant and from the
        # ``auth0_sub`` binding; enforced at the MCP transport after the token
        # resolves to a user, so it holds against an already-issued, still-valid
        # Auth0 JWT. NULL means agent access is not revoked. See ADR
        # ``20260728-disconnecting-an-agent-is-a-user-held-revocation-checked-at-the-mcp-transport``.
        sa.Column(
            "agent_access_revoked_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.UniqueConstraint("username", name="uq_users_username"),
        sa.UniqueConstraint("email", name="uq_users_email"),
        sa.UniqueConstraint("auth0_sub", name="uq_users_auth0_sub"),
        sa.ForeignKeyConstraint(
            ["merged_into_user_id"],
            ["users.id"],
            name="fk_users_merged_into_user_id_users",
            ondelete="SET NULL",
        ),
    )
    op.create_index("ix_users_username", "users", ["username"])
    op.create_index("ix_users_email", "users", ["email"])
    op.create_index(
        "ix_users_merged_into_user_id", "users", ["merged_into_user_id"]
    )
    op.create_index("ix_users_auth0_sub", "users", ["auth0_sub"])


def downgrade() -> None:
    op.drop_index("ix_users_auth0_sub", table_name="users")
    op.drop_index("ix_users_merged_into_user_id", table_name="users")
    op.drop_index("ix_users_email", table_name="users")
    op.drop_index("ix_users_username", table_name="users")
    op.drop_table("users")
