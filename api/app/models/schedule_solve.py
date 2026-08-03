import enum
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class ScheduleSolveTrigger(enum.Enum):
    """What put this solve on the queue (ADR "the schedule is solved, the call is
    pinned"). Every trigger funnels into ONE coalesced enqueue per tournament, so
    the trigger recorded here is the one that *caused this row*, not a log of every
    event absorbed while it sat queued."""

    go_live = "go_live"
    match_completed = "match_completed"
    settings_changed = "settings_changed"
    manual = "manual"
    pin_tick = "pin_tick"
    rerun = "rerun"


class ScheduleSolveStatus(enum.Enum):
    """The run's lifecycle. Four terminal outcomes, and the last three are three
    different *facts* rather than three shades of failure (ADR "a time-capped
    solve is its own outcome, not a failure") — each earns its own remediation:

    * ``succeeded`` — a plan was found and applied.
    * ``infeasible`` — the solver **proved** the day does not fit (over-constrained:
      widen a window, add a table, trim a field). A designed outcome, not a failure;
      it is exactly what a pre-live solve is for.
    * ``timed_out`` — the CP-SAT time cap ran out before *any* answer, so the run
      proved **nothing at all** (make the problem smaller, or give it longer).
      Re-running the same model against the same cap cannot help.
    * ``failed`` — the job itself broke (see ``error``); retrying is the right advice
      for this one alone.

    Nothing may distinguish these by string-matching ``error``: the status *is* the
    fact.
    """

    queued = "queued"
    running = "running"
    succeeded = "succeeded"
    infeasible = "infeasible"
    timed_out = "timed_out"
    failed = "failed"


class SolverVerdict(enum.Enum):
    """CP-SAT's own answer, kept apart from ``status`` because they are different
    facts: a solve can end ``succeeded`` on a merely ``feasible`` verdict (the ADR
    accepts FEASIBLE under the time cap — mid-tournament we want a good answer now,
    not a proof), and a run that never reached the solver has no verdict at all
    (``NULL``).

    Deliberately has **no** ``unknown`` member, and the ``timed_out`` status did not
    change that (ADR "a time-capped solve is its own outcome, not a failure" layers
    on top of this decision rather than reversing it): a run whose cap ran out before
    any answer genuinely reached no verdict, so it records none — the *outcome* is
    carried by ``status`` instead."""

    optimal = "optimal"
    feasible = "feasible"
    infeasible = "infeasible"


class ScheduleSolve(Base):
    """One run of the placement solver for a tournament — a row in the solve
    ledger the admin page reads verbatim (ADR "the schedule is solved, the call
    is pinned").

    The ledger is append-mostly: a row is created ``queued``, advances through
    ``running`` to a terminal status, and is never rewritten by a later run —
    each run is its own row, so the history of the day's solves is the table
    itself.

    ``input_fingerprint`` is the hash of the snapshot the job solved against;
    the guarded apply re-reads it under row locks and discards the whole output
    on any drift (no per-fixture merging), so the fingerprint stored here names
    exactly the world the counts describe. ``fixtures_placed`` /
    ``fixtures_pinned`` are the sizes of that applied output — ``NULL`` until
    (unless) a solve reaches its apply.
    """

    __tablename__ = "schedule_solves"
    __table_args__ = (
        # The admin page's one read: "this tournament's solves, newest first".
        Index(
            "ix_schedule_solves_tournament_id_requested_at",
            "tournament_id",
            text("requested_at DESC"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    tournament_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournaments.id", ondelete="CASCADE"),
        nullable=False,
    )
    trigger: Mapped[ScheduleSolveTrigger] = mapped_column(
        Enum(
            ScheduleSolveTrigger,
            name="schedule_solve_trigger",
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )
    status: Mapped[ScheduleSolveStatus] = mapped_column(
        Enum(
            ScheduleSolveStatus,
            name="schedule_solve_status",
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
        server_default=ScheduleSolveStatus.queued.value,
    )
    #: CP-SAT's own answer; ``NULL`` until the solver has actually run (and forever,
    #: for a run that failed before reaching it).
    verdict: Mapped[SolverVerdict | None] = mapped_column(
        Enum(
            SolverVerdict,
            name="solver_verdict",
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=True,
    )
    requested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    wall_time_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fixtures_placed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fixtures_pinned: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: Whether a **live** day's plan ran past a planned pool window into the
    #: overrun (ADR "the solver stops wedging"). ``True`` only on a ``succeeded``
    #: solve whose soft window let unplayed fixtures spill past their planned end
    #: while the tournament is live — a success qualifier, never a failure. Stays
    #: ``False`` pre-live (the window is a hard constraint) and on any run that
    #: placed nothing (infeasible / timed_out / failed): an honest "this run did not
    #: overrun".
    overrunning: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    #: Hash of the input snapshot the job solved against — the drift guard's
    #: comparison key. ``NULL`` for a run that never snapshotted.
    input_fingerprint: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Human-readable detail for a run that produced no plan — why a ``failed`` run
    #: broke, and the "the cap ran out" sentence on a ``timed_out`` one. ``NULL`` on
    #: every other status. **Detail, never a discriminator**: no reader may branch on
    #: its text (ADR "a time-capped solve is its own outcome, not a failure") — the
    #: fact lives in ``status``.
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Structured reasons an ``infeasible`` solve did not fit, kept raw here; a
    #: later boundary parses this into Pydantic models. ``NULL`` on every other
    #: status — a ``timed_out`` run proved nothing, so it has no reasons to give.
    infeasibility_reasons: Mapped[list[dict[str, Any]] | None] = mapped_column(
        JSONB, nullable=True
    )
    #: Resolved in-progress-vs-in-progress placement conflicts a solve reported
    #: (ADR "overlapping in-progress matches are tolerated and reported") — ids
    #: humanized to player names and table labels, kept raw here; a later
    #: boundary parses this into Pydantic models. Distinct from
    #: ``infeasibility_reasons``: a conflict is orthogonal to the verdict, so
    #: this is written on **any** verdict where the solver ran (a placed
    #: ``optimal``/``feasible`` board can still carry conflicts) — ``[]`` when
    #: there were none. ``NULL`` only before a solve reaches its apply.
    placement_conflicts: Mapped[list[dict[str, Any]] | None] = mapped_column(
        JSONB, nullable=True
    )
    #: The coalesced enqueue's second arm: a trigger that lands while this row is
    #: ``running`` cannot be absorbed by a queued row (there isn't one) and must
    #: not enqueue a second job (one solve in flight per tournament) — so it sets
    #: this flag, and the job clears it at finish and immediately re-queues
    #: (trigger ``rerun``). Meaningless (and always false) on terminal rows.
    rerun_requested: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
