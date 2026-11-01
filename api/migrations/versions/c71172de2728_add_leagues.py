"""Add leagues

Revision ID: c71172de2728
Revises: f9a766362b60
Create Date: 2026-11-01 13:48:49.560835

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c71172de2728"
down_revision: str | Sequence[str] | None = "f9a766362b60"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Forward-only: there's no downgrade(). Autogenerate can't see triggers,
# functions or views, so write those as op.execute(...).
def upgrade() -> None:
    op.create_table(
        "leagues",
        sa.Column(
            "id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column(
            "is_default", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "name = btrim(name) AND name <> ''", name=op.f("ck_leagues_name_trimmed")
        ),
        sa.CheckConstraint(
            "char_length(name) <= 50", name=op.f("ck_leagues_name_length")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_leagues")),
    )
    op.create_index(
        "one_default_league",
        "leagues",
        ["is_default"],
        unique=True,
        postgresql_where=sa.text("is_default"),
    )
    op.create_index(
        "unique_league_name", "leagues", [sa.literal_column("lower(name)")], unique=True
    )
    op.create_table(
        "league_members",
        sa.Column("league_id", sa.Uuid(), nullable=False),
        sa.Column("player_id", sa.Uuid(), nullable=False),
        sa.Column(
            "joined_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["league_id"],
            ["leagues.id"],
            name=op.f("fk_league_members_league_id_leagues"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["player_id"],
            ["players.id"],
            name=op.f("fk_league_members_player_id_players"),
        ),
        sa.PrimaryKeyConstraint(
            "league_id", "player_id", name=op.f("pk_league_members")
        ),
    )
    op.create_index(
        op.f("ix_league_members_player_id"),
        "league_members",
        ["player_id"],
        unique=False,
    )
    op.execute("INSERT INTO leagues (name, is_default) VALUES ('FortyMM', true)")
    op.execute(
        """
        CREATE FUNCTION join_default_league() RETURNS trigger AS $$
        BEGIN
          INSERT INTO league_members (league_id, player_id)
          SELECT id, NEW.id FROM leagues WHERE is_default;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'no default league';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql
        """
    )
    # Trigger before backfill: CREATE TRIGGER locks players, so no insert slips by.
    op.execute(
        """
        CREATE TRIGGER players_join_default_league AFTER INSERT ON players
          FOR EACH ROW EXECUTE FUNCTION join_default_league()
        """
    )
    # Merged players too: a merge keeps every row that names the merged player.
    op.execute(
        "INSERT INTO league_members (league_id, player_id)"
        " SELECT leagues.id, players.id FROM leagues CROSS JOIN players"
        " WHERE leagues.is_default"
    )
