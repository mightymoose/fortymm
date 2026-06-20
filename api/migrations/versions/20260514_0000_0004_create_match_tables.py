"""create match tables

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-14 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Enum types are created explicitly in upgrade() via `.create(...)` and
# referenced with create_type=False so neither op.create_table nor Alembic
# autogenerate attempts to create them a second time.
verification_policy_enum = postgresql.ENUM(
    "none",
    "self_report",
    "opponent_confirms",
    "all_players_confirm",
    name="verification_policy",
    create_type=False,
)
match_status_enum = postgresql.ENUM(
    "pending",
    "in_progress",
    "completed",
    "disputed",
    "voided",
    name="match_status",
    create_type=False,
)


def upgrade() -> None:
    bind = op.get_bind()
    verification_policy_enum.create(bind, checkfirst=True)
    match_status_enum.create(bind, checkfirst=True)

    op.create_table(
        "match_settings",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("team_size", sa.SmallInteger(), nullable=False),
        sa.Column("best_of", sa.SmallInteger(), nullable=False),
        sa.Column(
            "affects_rating",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "verification_policy",
            verification_policy_enum,
            nullable=False,
            server_default="none",
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
        sa.CheckConstraint(
            "team_size IN (1, 2)", name="ck_match_settings_team_size"
        ),
        sa.CheckConstraint(
            "best_of >= 1 AND best_of % 2 = 1", name="ck_match_settings_best_of"
        ),
    )

    op.create_table(
        "matches",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "match_settings_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("match_settings.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "status",
            match_status_enum,
            nullable=False,
            server_default="pending",
        ),
        sa.Column(
            "created_by_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
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
    op.create_index(
        "ix_matches_created_by_user_id_created_at",
        "matches",
        ["created_by_user_id", sa.text("created_at DESC")],
    )
    # Supports the /v1/matches list page's status-filtered, recent-first scan
    # and the dashboard's per-status LIMIT 1 queries (pending/in_progress).
    op.create_index(
        "ix_matches_status_created_at",
        "matches",
        ["status", sa.text("created_at DESC")],
    )
    # Supports the dashboard's "last 5 completed" view, which orders by
    # updated_at (no dedicated completed_at column).
    op.create_index(
        "ix_matches_status_updated_at",
        "matches",
        ["status", sa.text("updated_at DESC")],
    )

    op.create_table(
        "match_sides",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "match_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("matches.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("side_number", sa.SmallInteger(), nullable=False),
        sa.Column(
            "score",
            sa.SmallInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("won", sa.Boolean(), nullable=True),
        sa.UniqueConstraint(
            "match_id", "side_number", name="uq_match_sides_match_id_side_number"
        ),
        sa.CheckConstraint(
            "side_number IN (1, 2)", name="ck_match_sides_side_number"
        ),
        sa.CheckConstraint("score >= 0", name="ck_match_sides_score"),
    )
    op.create_index("ix_match_sides_match_id", "match_sides", ["match_id"])

    op.create_table(
        "match_side_players",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "match_side_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("match_sides.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "match_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("matches.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "match_side_id",
            "user_id",
            name="uq_match_side_players_match_side_id_user_id",
        ),
        sa.UniqueConstraint(
            "match_id", "user_id", name="uq_match_side_players_match_id_user_id"
        ),
    )
    op.create_index(
        "ix_match_side_players_user_id", "match_side_players", ["user_id"]
    )
    op.create_index(
        "ix_match_side_players_match_side_id",
        "match_side_players",
        ["match_side_id"],
    )

    op.create_table(
        "match_games",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "match_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("matches.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("game_number", sa.SmallInteger(), nullable=False),
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
            "match_id", "game_number", name="uq_match_games_match_id_game_number"
        ),
        sa.CheckConstraint("game_number >= 1", name="ck_match_games_game_number"),
    )
    op.create_index("ix_match_games_match_id", "match_games", ["match_id"])

    op.create_table(
        "match_game_scores",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "match_game_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("match_games.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("side_1_points", sa.SmallInteger(), nullable=False),
        sa.Column("side_2_points", sa.SmallInteger(), nullable=False),
        # Optimistic-concurrency token; the conditional score PUT updates
        # ``WHERE version = <client's expected>`` so a stale concurrent writer
        # 409s instead of clobbering. New rows start at 1.
        sa.Column(
            "version",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("1"),
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
            "match_game_id", name="uq_match_game_scores_match_game_id"
        ),
        sa.CheckConstraint(
            "side_1_points >= 0", name="ck_match_game_scores_side_1_points"
        ),
        sa.CheckConstraint(
            "side_2_points >= 0", name="ck_match_game_scores_side_2_points"
        ),
    )


def downgrade() -> None:
    op.drop_table("match_game_scores")
    op.drop_table("match_games")
    op.drop_table("match_side_players")
    op.drop_table("match_sides")
    op.drop_table("matches")
    op.drop_table("match_settings")

    bind = op.get_bind()
    match_status_enum.drop(bind, checkfirst=True)
    verification_policy_enum.drop(bind, checkfirst=True)
