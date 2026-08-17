"""create schedule solves table

Revision ID: 0013
Revises: 0012
Create Date: 2026-07-16 00:00:00.000000

The solve ledger (ADR "the schedule is solved, the call is pinned"): every
solver run is a row in ``schedule_solves`` and the admin page reads the ledger
verbatim. The matching pin facts on the fixture itself (``pinned_at``,
``call_notified_count``) live in 0012, which creates that table. Per the
pre-deploy convention in api/CLAUDE.md, edits to this migration happen in
place. No backfill — assumes a fresh / empty DB.
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
        # Whether a live day's plan ran past a planned reservation window into the
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
        # Structured reasons an ``infeasible`` solve did not fit — raw JSONB
        # here, parsed into Pydantic at a later boundary. NULL on every other
        # status.
        sa.Column("infeasibility_reasons", postgresql.JSONB(), nullable=True),
        # The coalesced enqueue's second arm: a trigger that lands while a solve
        # is *running* cannot be absorbed by the queued row (there isn't one) and
        # must not enqueue a second job (one solve in flight per tournament) — so
        # it sets this flag on the running row, and the job clears it at finish
        # and immediately re-queues (trigger ``rerun``). No trigger is ever lost
        # to timing.
        sa.Column(
            "rerun_requested",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        # A solve's *resolved* in-progress-vs-in-progress placement conflicts
        # (ADR "overlapping in-progress matches are tolerated and reported").
        # Parallel to ``infeasibility_reasons`` but orthogonal to the verdict:
        # two matches recorded on one table (or one human in two) are
        # contradictory data the solver tolerates rather than letting them blank
        # the board (#1144), and a fully-placed ``optimal``/``feasible`` solve can
        # still carry them. Written on any verdict where the solver ran (``[]``
        # when there were none), NULL only before a solve reaches its apply.
        sa.Column("placement_conflicts", postgresql.JSONB(), nullable=True),
    )
    # The admin page's one read: "this tournament's solves, newest first".
    op.create_index(
        "ix_schedule_solves_tournament_id_requested_at",
        "schedule_solves",
        ["tournament_id", sa.text("requested_at DESC")],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_schedule_solves_tournament_id_requested_at", table_name="schedule_solves"
    )
    op.drop_table("schedule_solves")

    bind = op.get_bind()
    solver_verdict_enum.drop(bind, checkfirst=True)
    schedule_solve_status_enum.drop(bind, checkfirst=True)
    schedule_solve_trigger_enum.drop(bind, checkfirst=True)
