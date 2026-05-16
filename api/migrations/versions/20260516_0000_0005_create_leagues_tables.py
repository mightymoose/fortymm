"""create leagues tables

Revision ID: 0005
Revises: 0004
Create Date: 2026-05-16 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


league_visibility_enum = postgresql.ENUM(
    "public",
    "private",
    name="league_visibility",
    create_type=False,
)


def upgrade() -> None:
    bind = op.get_bind()
    league_visibility_enum.create(bind, checkfirst=True)

    op.create_table(
        "leagues",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "visibility",
            league_visibility_enum,
            nullable=False,
            server_default="public",
        ),
        sa.Column(
            "is_default",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
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
    )
    op.create_index("ix_leagues_name", "leagues", ["name"], unique=True)
    # Partial unique index: at most one league row may have is_default=true.
    op.create_index(
        "uq_leagues_one_default",
        "leagues",
        ["is_default"],
        unique=True,
        postgresql_where=sa.text("is_default"),
    )

    op.create_table(
        "league_memberships",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "league_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("leagues.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
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
        sa.UniqueConstraint(
            "league_id",
            "user_id",
            name="uq_league_memberships_league_id_user_id",
        ),
    )
    op.create_index(
        "ix_league_memberships_user_id", "league_memberships", ["user_id"]
    )

    op.add_column(
        "matches",
        sa.Column(
            "league_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("leagues.id", ondelete="RESTRICT"),
            nullable=False,
        ),
    )
    op.create_index("ix_matches_league_id", "matches", ["league_id"])


def downgrade() -> None:
    op.drop_index("ix_matches_league_id", table_name="matches")
    op.drop_column("matches", "league_id")

    op.drop_index(
        "ix_league_memberships_user_id", table_name="league_memberships"
    )
    op.drop_table("league_memberships")

    op.drop_index("uq_leagues_one_default", table_name="leagues")
    op.drop_index("ix_leagues_name", table_name="leagues")
    op.drop_table("leagues")

    bind = op.get_bind()
    league_visibility_enum.drop(bind, checkfirst=True)
