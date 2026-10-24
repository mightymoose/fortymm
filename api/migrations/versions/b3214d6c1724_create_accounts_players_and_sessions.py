"""Create accounts, players and sessions

Revision ID: b3214d6c1724
Revises:
Create Date: 2026-10-24 17:03:48.633422

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b3214d6c1724"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Forward-only: there's no downgrade(). Autogenerate can't see triggers,
# functions or views, so write those as op.execute(...).
def upgrade() -> None:
    op.create_table(
        "accounts",
        sa.Column(
            "id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("email", sa.Text(), nullable=True),
        sa.Column("adopted_into", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "adopted_into IS NULL OR adopted_into <> id",
            name=op.f("ck_accounts_not_adopted_into_self"),
        ),
        sa.CheckConstraint(
            "email = lower(email)", name=op.f("ck_accounts_email_lowercase")
        ),
        sa.ForeignKeyConstraint(
            ["adopted_into"],
            ["accounts.id"],
            name=op.f("fk_accounts_adopted_into_accounts"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_accounts")),
        sa.UniqueConstraint("email", name=op.f("uq_accounts_email")),
    )
    op.create_table(
        "players",
        sa.Column(
            "id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("merged_into", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "merged_into IS NULL OR merged_into <> id",
            name=op.f("ck_players_not_merged_into_self"),
        ),
        sa.ForeignKeyConstraint(
            ["merged_into"], ["players.id"], name=op.f("fk_players_merged_into_players")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_players")),
    )
    op.create_index(
        "unique_display_name",
        "players",
        [sa.literal_column("lower(display_name)")],
        unique=True,
    )
    op.execute(
        """
        CREATE FUNCTION refuse_player_delete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'players are never deleted';
        END $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER players_are_permanent BEFORE DELETE ON players
          FOR EACH ROW EXECUTE FUNCTION refuse_player_delete()
        """
    )
    op.create_table(
        "player_managers",
        sa.Column(
            "id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("player_id", sa.Uuid(), nullable=False),
        sa.Column("account_id", sa.Uuid(), nullable=False),
        sa.Column("relationship", sa.Text(), nullable=False),
        sa.Column("adopted_from", sa.Uuid(), nullable=True),
        sa.CheckConstraint(
            "relationship IN ('self', 'managed')",
            name=op.f("ck_player_managers_relationship"),
        ),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["accounts.id"],
            name=op.f("fk_player_managers_account_id_accounts"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["adopted_from"],
            ["accounts.id"],
            name=op.f("fk_player_managers_adopted_from_accounts"),
        ),
        sa.ForeignKeyConstraint(
            ["player_id"],
            ["players.id"],
            name=op.f("fk_player_managers_player_id_players"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_player_managers")),
        sa.UniqueConstraint(
            "player_id", "account_id", name=op.f("uq_player_managers_player_id")
        ),
    )
    op.create_index(
        "one_self_account_per_player",
        "player_managers",
        ["player_id"],
        unique=True,
        postgresql_where=sa.text("relationship = 'self'"),
    )
    op.create_index(
        "one_self_player_per_account",
        "player_managers",
        ["account_id"],
        unique=True,
        postgresql_where=sa.text("relationship = 'self'"),
    )
    op.create_table(
        "sessions",
        sa.Column(
            "id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("token_hash", sa.LargeBinary(), nullable=False),
        sa.Column("account_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["accounts.id"],
            name=op.f("fk_sessions_account_id_accounts"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_sessions")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_sessions_token_hash")),
    )
