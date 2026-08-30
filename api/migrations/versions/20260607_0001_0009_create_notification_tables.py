"""create notification tables

Revision ID: 0009
Revises: 0008
Create Date: 2026-06-07 00:01:00.000000

The notification lookup tables (notification_types, notification_channels) plus
persisted in-app notifications and the two sparse preference tables (per-channel
master toggles and per-(category, channel) cells). The lookup tables are created
and seeded first so the category/channel columns can carry FKs to them. Per the
pre-deploy convention in api/CLAUDE.md, edits to this migration happen in place.
No backfill — assumes a fresh / empty DB.

``notifications.result_id`` (issue #1583) was folded in here from a
since-deleted standalone ``add_column`` revision, per the same pre-deploy
rollup convention — ``match_results`` (0004) and this table both already
exist by the time that column was added, so there's no ordering reason to
keep it as a separate revision. It binds a *hideable* prompt (e.g. "Accept
your match result") to the specific ``MatchResult`` it's asking about, so
``NotificationService.list_feed`` / ``_unread_count`` can hide the row once
that result is no longer live — accepted, superseded, or auto-accepted by
the retirement sweep — without deleting it. ``NULL`` for every other
notification, including the FYI notices that must never disappear.
"""
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0009"
down_revision: Union[str, None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Seeded lookup rows. Keys mirror app.notifications.taxonomy enums; names /
# short labels mirror the (former) client-side CATEGORY_META / CHANNEL_META.
NOTIFICATION_TYPE_SEED = [
    ("33333333-3333-3333-3333-333333330001", "match_reminder", "Match reminders", "Match"),
    ("33333333-3333-3333-3333-333333330002", "rating_change", "Rating changes", "Rating"),
    ("33333333-3333-3333-3333-333333330003", "tournament", "Tournament news", "Tourney"),
    ("33333333-3333-3333-3333-333333330004", "opponent", "Challenges & friends", "Social"),
    ("33333333-3333-3333-3333-333333330005", "result_confirm", "Score acceptances", "Scores"),
    # A ``notification_types`` row *is* a preference category (one prefs-matrix
    # row per seeded key), so the three call message kinds — ``match_called``,
    # ``match_call_moved``, ``match_call_cancelled`` — share this single
    # ``match_calls`` category; their copy lives in typed template builders
    # (``app.notifications.match_calls``), mirroring how ``result_confirm``
    # carries multiple message shapes under one category. See the 2026-07-16
    # ADR "the schedule is solved; the call is pinned".
    ("33333333-3333-3333-3333-333333330006", "match_calls", "Match calls", "Calls"),
]

NOTIFICATION_CHANNEL_SEED = [
    ("44444444-4444-4444-4444-444444440001", "in_app", "In-app", True),
    ("44444444-4444-4444-4444-444444440002", "push", "Push", True),
    ("44444444-4444-4444-4444-444444440003", "email", "Email", True),
    ("44444444-4444-4444-4444-444444440004", "sms", "SMS", False),
]


def upgrade() -> None:
    notification_types = op.create_table(
        "notification_types",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("key", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("short_label", sa.String(length=32), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "display_order", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")
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
        "ix_notification_types_key", "notification_types", ["key"], unique=True
    )
    op.bulk_insert(
        notification_types,
        [
            {
                "id": uuid.UUID(row_id),
                "key": key,
                "name": name,
                "short_label": short,
                "display_order": order,
                "is_active": True,
            }
            for order, (row_id, key, name, short) in enumerate(
                NOTIFICATION_TYPE_SEED, start=1
            )
        ],
    )

    notification_channels = op.create_table(
        "notification_channels",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("key", sa.String(length=16), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "display_order", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        sa.Column(
            "is_available",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
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
        "ix_notification_channels_key", "notification_channels", ["key"], unique=True
    )
    op.bulk_insert(
        notification_channels,
        [
            {
                "id": uuid.UUID(row_id),
                "key": key,
                "name": name,
                "display_order": order,
                "is_active": True,
                "is_available": available,
            }
            for order, (row_id, key, name, available) in enumerate(
                NOTIFICATION_CHANNEL_SEED, start=1
            )
        ],
    )

    op.create_table(
        "notifications",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "category",
            sa.String(length=32),
            sa.ForeignKey("notification_types.key", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("body", sa.String(length=500), nullable=False),
        sa.Column("link", sa.String(length=512), nullable=True),
        sa.Column("action_label", sa.String(length=40), nullable=True),
        sa.Column("delta", sa.String(length=16), nullable=True),
        sa.Column(
            "result_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("match_results.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    # Serves the feed query: WHERE user_id = ? ORDER BY created_at DESC.
    op.create_index(
        "ix_notifications_user_id_created_at",
        "notifications",
        ["user_id", "created_at"],
    )
    # Postgres does not auto-index a FK column (unlike its referenced PK side).
    # Without this, every match_results delete (including one cascaded from a
    # matches delete) would force a sequential scan of notifications to find
    # the ON DELETE SET NULL rows to touch.
    op.create_index(
        "ix_notifications_result_id", "notifications", ["result_id"]
    )

    op.create_table(
        "notification_channel_settings",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "channel",
            sa.String(length=16),
            sa.ForeignKey("notification_channels.key", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("enabled", sa.Boolean(), nullable=False),
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
        # One master row per (user, channel); the upsert keys on this constraint.
        sa.UniqueConstraint(
            "user_id",
            "channel",
            name="uq_notification_channel_settings_user_channel",
        ),
    )

    op.create_table(
        "notification_preferences",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "category",
            sa.String(length=32),
            sa.ForeignKey("notification_types.key", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "channel",
            sa.String(length=16),
            sa.ForeignKey("notification_channels.key", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("enabled", sa.Boolean(), nullable=False),
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
        # One cell row per (user, category, channel); the upsert keys on this.
        sa.UniqueConstraint(
            "user_id",
            "category",
            "channel",
            name="uq_notification_preferences_user_category_channel",
        ),
    )


def downgrade() -> None:
    op.drop_table("notification_preferences")
    op.drop_table("notification_channel_settings")
    op.drop_index("ix_notifications_result_id", table_name="notifications")
    op.drop_index("ix_notifications_user_id_created_at", table_name="notifications")
    op.drop_table("notifications")
    op.drop_index(
        "ix_notification_channels_key", table_name="notification_channels"
    )
    op.drop_table("notification_channels")
    op.drop_index("ix_notification_types_key", table_name="notification_types")
    op.drop_table("notification_types")
