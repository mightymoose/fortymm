"""create tournament entries table

Revision ID: 0011
Revises: 0010
Create Date: 2026-07-11 00:00:00.000000

Per the pre-deploy convention in api/CLAUDE.md, edits to this migration
happen in place. No backfill — assumes a fresh / empty DB.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0011"
down_revision: Union[str, None] = "0010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Created explicitly in upgrade() via `.create(...)` and referenced with
# create_type=False so neither op.create_table nor autogenerate creates it a
# second time (same pattern as the tournament enums in 0010).
tournament_entry_status_enum = postgresql.ENUM(
    "entered",
    "withdrawn",
    name="tournament_entry_status",
    create_type=False,
)


def upgrade() -> None:
    bind = op.get_bind()
    tournament_entry_status_enum.create(bind, checkfirst=True)

    op.create_table(
        "tournament_entries",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "event_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tournament_events.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        # Who put this player in the event. NULL means the player entered
        # themselves; a user id means a director entered them (ADR-0784). NULL is
        # the *encoding of self-registration*, not "unknown" — which is why the FK
        # is RESTRICT rather than SET NULL: nulling it on a user delete would not
        # lose a fact, it would rewrite one. (Account merge tombstones rather than
        # deletes, so ON DELETE never fires there; ``merge_user`` re-points this
        # column explicitly.)
        sa.Column(
            "added_by_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("seed", sa.Integer(), nullable=True),
        sa.Column(
            "status",
            tournament_entry_status_enum,
            nullable=False,
            server_default="entered",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    # At most one *active* entry per player per event. PARTIAL on
    # `status = 'entered'`: withdrawal is a soft-delete, so a plain unique index
    # would leave the withdrawn row squatting on the (event, user) pair and lock
    # the player out of ever re-entering. Duplicate active entries raise
    # IntegrityError, which the entry route turns into a 409.
    op.create_index(
        "uq_tournament_entries_event_id_user_id_active",
        "tournament_entries",
        ["event_id", "user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'entered'"),
    )
    op.create_index(
        "ix_tournament_entries_event_id", "tournament_entries", ["event_id"]
    )
    op.create_index("ix_tournament_entries_user_id", "tournament_entries", ["user_id"])
    # merge_user re-points this column by `WHERE added_by_user_id = :from_id` on
    # every guest sign-in, so it is a lookup key, not merely an FK.
    op.create_index(
        "ix_tournament_entries_added_by_user_id",
        "tournament_entries",
        ["added_by_user_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_tournament_entries_added_by_user_id", table_name="tournament_entries"
    )
    op.drop_index("ix_tournament_entries_user_id", table_name="tournament_entries")
    op.drop_index("ix_tournament_entries_event_id", table_name="tournament_entries")
    op.drop_index(
        "uq_tournament_entries_event_id_user_id_active",
        table_name="tournament_entries",
    )
    op.drop_table("tournament_entries")

    bind = op.get_bind()
    tournament_entry_status_enum.drop(bind, checkfirst=True)
