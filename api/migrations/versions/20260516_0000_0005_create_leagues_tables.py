"""create leagues + rating strategies tables

Revision ID: 0005
Revises: 0004
Create Date: 2026-05-16 00:00:00.000000

Per the pre-deploy convention in api/CLAUDE.md, edits to this migration
happen in place. ``matches.league_id`` and ``leagues.rating_strategy_id``
are both NOT NULL with no backfill — assumes a fresh / empty DB.
"""
import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


league_visibility_enum = postgresql.ENUM(
    "public",
    "private",
    name="league_visibility",
    create_type=False,
)


GLICKO2_STRATEGY_ID = uuid.UUID("11111111-1111-1111-1111-111111110001")
MANUAL_STRATEGY_ID = uuid.UUID("11111111-1111-1111-1111-111111110002")

GLICKO2_STATE_SCHEMA = {
    "type": "object",
    "required": ["rating", "rd", "volatility"],
    "properties": {
        "rating": {"type": "number"},
        "rd": {"type": "number"},
        "volatility": {"type": "number"},
    },
    "additionalProperties": False,
}
GLICKO2_INITIAL_STATE = {"rating": 1500.0, "rd": 350.0, "volatility": 0.06}

MANUAL_STATE_SCHEMA = {
    "type": "object",
    "required": ["rating"],
    "properties": {"rating": {"type": "number"}},
    "additionalProperties": False,
}


def upgrade() -> None:
    bind = op.get_bind()
    league_visibility_enum.create(bind, checkfirst=True)

    rating_strategies = op.create_table(
        "rating_strategies",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "state_schema",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column(
            "initial_state",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column("initial_rating_value", sa.Float(), nullable=True),
        sa.Column(
            "is_automatic",
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
    op.create_index(
        "ix_rating_strategies_key", "rating_strategies", ["key"], unique=True
    )

    op.bulk_insert(
        rating_strategies,
        [
            {
                "id": GLICKO2_STRATEGY_ID,
                "key": "glicko2",
                "name": "Glicko-2",
                "description": (
                    "Glicko-2 — tracks both skill (rating) and uncertainty (RD + volatility). "
                    "Updated automatically on each rated match."
                ),
                "state_schema": GLICKO2_STATE_SCHEMA,
                "initial_state": GLICKO2_INITIAL_STATE,
                "initial_rating_value": 1500.0,
                "is_automatic": True,
            },
            {
                "id": MANUAL_STRATEGY_ID,
                "key": "manual",
                "name": "Manual / external",
                "description": (
                    "Ratings supplied externally (e.g. USATT) or by admin entry. "
                    "Match completion does not change ratings in a manual league."
                ),
                "state_schema": MANUAL_STATE_SCHEMA,
                "initial_state": None,
                "initial_rating_value": None,
                "is_automatic": False,
            },
        ],
    )

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
            "rating_strategy_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("rating_strategies.id", ondelete="RESTRICT"),
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
    )
    op.create_index("ix_leagues_name", "leagues", ["name"], unique=True)
    op.create_index(
        "ix_leagues_rating_strategy_id", "leagues", ["rating_strategy_id"]
    )
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
    op.drop_index("ix_leagues_rating_strategy_id", table_name="leagues")
    op.drop_index("ix_leagues_name", table_name="leagues")
    op.drop_table("leagues")

    op.drop_index("ix_rating_strategies_key", table_name="rating_strategies")
    op.drop_table("rating_strategies")

    bind = op.get_bind()
    league_visibility_enum.drop(bind, checkfirst=True)
