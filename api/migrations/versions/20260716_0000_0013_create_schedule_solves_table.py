"""create schedule solves table and pin columns on fixtures

Revision ID: 0013
Revises: 0012
Create Date: 2026-07-16 00:00:00.000000

The solve ledger and the pin facts (ADR "the schedule is solved, the call is
pinned"): every solver run is a row in ``schedule_solves`` — the admin page
reads the ledger verbatim — and a *called* fixture carries ``pinned_at`` (the
promise) plus ``call_notified_count`` (how many times the players were told).
Per the pre-deploy convention in api/CLAUDE.md, edits to this migration happen
in place. No backfill — assumes a fresh / empty DB.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0013"
down_revision: Union[str, None] = "0012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Enum types are created explicitly in upgrade() via `.create(...)` and
# referenced with create_type=False so neither op.create_table nor Alembic
# autogenerate attempts to create them a second time (same pattern as 0010).
# The ORM persists the enum *value*, not the member name, via values_callable.
schedule_solve_trigger_enum = postgresql.ENUM(
    "go_live",
    "match_completed",
    "settings_changed",
    "manual",
    "pin_tick",
    "rerun",
    name="schedule_solve_trigger",
    create_type=False,
)
schedule_solve_status_enum = postgresql.ENUM(
    "queued",
    "running",
    "succeeded",
    "infeasible",
    "failed",
    name="schedule_solve_status",
    create_type=False,
)
# Kept apart from status because they are different facts: a solve can end
# ``succeeded`` on a merely ``feasible`` verdict (the ADR accepts FEASIBLE under
# the time cap), and a run that never reached the solver has no verdict at all.
solver_verdict_enum = postgresql.ENUM(
    "optimal",
    "feasible",
    "infeasible",
    name="solver_verdict",
    create_type=False,
)


def upgrade() -> None:
    bind = op.get_bind()
    schedule_solve_trigger_enum.create(bind, checkfirst=True)
    schedule_solve_status_enum.create(bind, checkfirst=True)
    solver_verdict_enum.create(bind, checkfirst=True)

    op.create_table(
        "schedule_solves",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "tournament_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tournaments.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("trigger", schedule_solve_trigger_enum, nullable=False),
        sa.Column(
            "status",
            schedule_solve_status_enum,
            nullable=False,
            server_default="queued",
        ),
        # NULL until the solver has actually run (and forever, for a run that
        # failed before reaching it).
        sa.Column("verdict", solver_verdict_enum, nullable=True),
        sa.Column(
            "requested_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("wall_time_ms", sa.Integer(), nullable=True),
        # The sizes of the applied output — NULL until (unless) a solve reaches
        # its guarded apply.
        sa.Column("fixtures_placed", sa.Integer(), nullable=True),
        sa.Column("fixtures_pinned", sa.Integer(), nullable=True),
        # Whether a live day's plan ran past a planned pool window into the
        # overrun (ADR "the solver stops wedging"). A success qualifier on a
        # ``succeeded`` solve while live; false pre-live and on any run that
        # placed nothing.
        sa.Column(
            "overrunning",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        # Hash of the input snapshot the job solved against — the drift guard's
        # comparison key. NULL for a run that never snapshotted.
        sa.Column("input_fingerprint", sa.Text(), nullable=True),
        # Why a ``failed`` run failed. NULL on every other status.
        sa.Column("error", sa.Text(), nullable=True),
    )
    # The admin page's one read: "this tournament's solves, newest first".
    op.create_index(
        "ix_schedule_solves_tournament_id_requested_at",
        "schedule_solves",
        ["tournament_id", sa.text("requested_at DESC")],
    )

    # The pin facts on the fixture itself. ``pinned_at`` is a ``timestamptz``
    # instant (TIMESTAMP WITH TIME ZONE) — the call's ``now`` — like the
    # ``scheduled_start`` beside it. The 2026-07-19 ADR "tournament times are
    # timezone-aware instants" supersedes ADR-0790's naive exemption and moves
    # both onto timezone-aware instants. NULL = unpinned.
    op.add_column(
        "tournament_fixtures",
        sa.Column("pinned_at", sa.DateTime(timezone=True), nullable=True),
    )
    # How many times the players were told about this fixture's placement —
    # the initial call plus every moved/cancelled correction. 0 = never.
    op.add_column(
        "tournament_fixtures",
        sa.Column(
            "call_notified_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )


def downgrade() -> None:
    op.drop_column("tournament_fixtures", "call_notified_count")
    op.drop_column("tournament_fixtures", "pinned_at")

    op.drop_index(
        "ix_schedule_solves_tournament_id_requested_at", table_name="schedule_solves"
    )
    op.drop_table("schedule_solves")

    bind = op.get_bind()
    solver_verdict_enum.drop(bind, checkfirst=True)
    schedule_solve_status_enum.drop(bind, checkfirst=True)
    schedule_solve_trigger_enum.drop(bind, checkfirst=True)
