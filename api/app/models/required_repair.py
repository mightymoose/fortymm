"""Durable, coalesced repair requirements with typed target ownership."""

import enum
import uuid
from datetime import datetime
from typing import Literal

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class RepairState(enum.Enum):
    pending = "pending"
    running = "running"
    completed = "completed"
    failed = "failed"


class RequiredRepair(Base):
    __tablename__ = "required_repairs"
    __table_args__ = (
        Index("ix_required_repairs_recovery", "state", "dispatch_after"),
        CheckConstraint("failures >= 0", name="ck_required_repairs_failures"),
        CheckConstraint(
            "(state = 'running') = (claim_token IS NOT NULL "
            "AND lease_until IS NOT NULL) AND "
            "((claim_token IS NULL) = (lease_until IS NULL))",
            name="ck_required_repairs_lease",
        ),
        CheckConstraint(
            "(state = 'completed') = (requested_generation = completed_generation) "
            "AND ((state = 'completed') = (completed_at IS NOT NULL))",
            name="ck_required_repairs_completion",
        ),
        CheckConstraint(
            "num_nonnulls(player_id, tournament_id) = 1",
            name="ck_required_repairs_target",
        ),
        CheckConstraint(
            "requested_generation > 0 AND completed_generation >= 0 "
            "AND completed_generation <= requested_generation",
            name="ck_required_repairs_generations",
        ),
        UniqueConstraint("player_id", name="uq_required_repairs_player"),
        UniqueConstraint("tournament_id", name="uq_required_repairs_tournament"),
    )
    dispatch_after: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    available_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    failures: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    last_error: Mapped[str | None] = mapped_column(Text)
    state: Mapped[RepairState] = mapped_column(
        Enum(RepairState, name="repair_state"), nullable=False, server_default="pending"
    )
    claim_token: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    player_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("players.id", ondelete="RESTRICT")
    )
    tournament_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tournaments.id", ondelete="CASCADE")
    )
    requested_generation: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="1"
    )
    completed_generation: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )


class RepairAttempt(Base):
    __tablename__ = "required_repair_attempts"
    __table_args__ = (
        CheckConstraint(
            "generation > 0", name="ck_required_repair_attempts_generation"
        ),
        CheckConstraint(
            "outcome IN ('running', 'completed', 'expired', 'transient', 'permanent')",
            name="ck_required_repair_attempts_outcome",
        ),
        CheckConstraint(
            "(outcome = 'running') = (finished_at IS NULL)",
            name="ck_required_repair_attempts_finished",
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    repair_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("required_repairs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    generation: Mapped[int] = mapped_column(Integer, nullable=False)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    outcome: Mapped[
        Literal["running", "completed", "expired", "transient", "permanent"]
    ] = mapped_column(Text, nullable=False, server_default="running")
    error: Mapped[str | None] = mapped_column(Text)
