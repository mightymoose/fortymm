"""seed match calls notification category

Revision ID: 0015
Revises: 0014
Create Date: 2026-07-16 00:02:00.000000

Seeds the "Match calls" notification category (ADR 2026-07-16 — the schedule
is solved; the call is pinned) into the ``notification_types`` lookup table,
following the migration 0009 seed pattern. In this schema a
``notification_types`` row *is* a preference category (one prefs-matrix row per
seeded key), so the three call message kinds — ``match_called``,
``match_call_moved``, ``match_call_cancelled`` — share this single ``match_calls``
prefs category; their copy lives in typed template builders
(``app.notifications.match_calls``), mirroring how ``result_confirm`` carries
multiple message shapes under one category. Keys/labels mirror
``app.notifications.taxonomy`` / the tests' conftest seed (migrations stay
self-contained and can't import app code).
"""

import uuid
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0015"
down_revision: Union[str, None] = "0014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (id, key, name, short_label, display_order) — continues the migration 0009
# NOTIFICATION_TYPE_SEED id sequence and display order.
MATCH_CALLS_TYPE_SEED = (
    "33333333-3333-3333-3333-333333330006",
    "match_calls",
    "Match calls",
    "Calls",
    6,
)


def _notification_types_table() -> sa.TableClause:
    return sa.table(
        "notification_types",
        sa.column("id", postgresql.UUID(as_uuid=True)),
        sa.column("key", sa.String()),
        sa.column("name", sa.String()),
        sa.column("short_label", sa.String()),
        sa.column("display_order", sa.Integer()),
        sa.column("is_active", sa.Boolean()),
    )


def upgrade() -> None:
    row_id, key, name, short, order = MATCH_CALLS_TYPE_SEED
    op.bulk_insert(
        _notification_types_table(),
        [
            {
                "id": uuid.UUID(row_id),
                "key": key,
                "name": name,
                "short_label": short,
                "display_order": order,
                "is_active": True,
            }
        ],
    )


def downgrade() -> None:
    _, key, *_ = MATCH_CALLS_TYPE_SEED
    # The category key is FK'd (ON DELETE RESTRICT) from notifications and
    # notification_preferences — clear dependents before removing the row.
    op.execute(
        sa.text("DELETE FROM notifications WHERE category = :key").bindparams(key=key)
    )
    op.execute(
        sa.text(
            "DELETE FROM notification_preferences WHERE category = :key"
        ).bindparams(key=key)
    )
    op.execute(
        sa.text("DELETE FROM notification_types WHERE key = :key").bindparams(key=key)
    )
