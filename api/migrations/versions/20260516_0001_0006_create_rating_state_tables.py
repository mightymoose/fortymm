"""create rating state tables (user_league_ratings + rating_history)

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-16 00:01:00.000000

Per the pre-deploy convention in api/CLAUDE.md, edits to this migration
happen in place. No backfill — assumes a fresh / empty DB.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


rating_history_source_enum = postgresql.ENUM(
    "match",
    "manual",
    "import",
    "initial",
    name="rating_history_source",
    create_type=False,
)


def upgrade() -> None:
    bind = op.get_bind()
    rating_history_source_enum.create(bind, checkfirst=True)

    op.create_table(
        "user_league_ratings",
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
            "rating_strategy_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("rating_strategies.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("rating_value", sa.Float(), nullable=True),
        sa.Column(
            "rating_state",
            postgresql.JSONB(astext_type=sa.Text()),
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
        sa.UniqueConstraint(
            "league_id",
            "user_id",
            name="uq_user_league_ratings_league_id_user_id",
        ),
    )
    op.create_index(
        "ix_user_league_ratings_user_id", "user_league_ratings", ["user_id"]
    )

    op.create_table(
        "rating_history",
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
            "match_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("matches.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "rating_strategy_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("rating_strategies.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("rating_value", sa.Float(), nullable=False),
        sa.Column(
            "rating_state",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("previous_rating_value", sa.Float(), nullable=True),
        sa.Column("source", rating_history_source_enum, nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "created_by_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_rating_history_league_id_user_id_created_at",
        "rating_history",
        ["league_id", "user_id", sa.text("created_at DESC")],
    )
    op.create_index("ix_rating_history_match_id", "rating_history", ["match_id"])
    op.create_index(
        "uq_rating_history_match_id_user_id",
        "rating_history",
        ["match_id", "user_id"],
        unique=True,
        postgresql_where=sa.text("match_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_rating_history_match_id_user_id", table_name="rating_history"
    )
    op.drop_index("ix_rating_history_match_id", table_name="rating_history")
    op.drop_index(
        "ix_rating_history_league_id_user_id_created_at",
        table_name="rating_history",
    )
    op.drop_table("rating_history")

    op.drop_index(
        "ix_user_league_ratings_user_id", table_name="user_league_ratings"
    )
    op.drop_table("user_league_ratings")

    bind = op.get_bind()
    rating_history_source_enum.drop(bind, checkfirst=True)
