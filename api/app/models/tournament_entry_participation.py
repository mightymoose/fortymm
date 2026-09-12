"""An entry's historical admission to a stage and group."""

import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Enum,
    FetchedValue,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class WithdrawalReason(StrEnum):
    self_withdrawal = "self_withdrawal"
    director_removal = "director_removal"
    identity_reconciliation = "identity_reconciliation"


class ParticipationEndReason(StrEnum):
    self_withdrawal = "self_withdrawal"
    director_removal = "director_removal"
    identity_reconciliation = "identity_reconciliation"
    draw_retired = "draw_retired"
    stage_completed = "stage_completed"
    group_changed = "group_changed"


class TournamentEntryParticipation(Base):
    __tablename__ = "tournament_entry_participations"
    __table_args__ = (
        ForeignKeyConstraint(
            ["event_id", "draw_revision_id"],
            ["tournament_draw_revisions.event_id", "tournament_draw_revisions.id"],
            name="fk_participation_draw_revision",
            deferrable=True,
            initially="DEFERRED",
        ),
        ForeignKeyConstraint(
            ["event_id", "entry_id"],
            ["tournament_entries.event_id", "tournament_entries.id"],
            ondelete="CASCADE",
            name="fk_participation_event_entry",
        ),
        ForeignKeyConstraint(
            ["event_id", "stage_id"],
            ["tournament_event_stages.event_id", "tournament_event_stages.id"],
            ondelete="CASCADE",
            name="fk_participation_event_stage",
        ),
        ForeignKeyConstraint(
            ["stage_id", "group_id"],
            [
                "tournament_event_stage_groups.stage_id",
                "tournament_event_stage_groups.id",
            ],
            name="fk_participation_stage_group",
            deferrable=True,
            initially="DEFERRED",
        ),
        UniqueConstraint(
            "id",
            "entry_id",
            "stage_id",
            "group_id",
            "draw_revision_id",
            name="uq_participation_fixture_scope",
        ),
        CheckConstraint(
            "ended_at IS NULL OR ended_at >= started_at",
            name="ck_participation_interval",
        ),
        CheckConstraint(
            "(ended_at IS NULL AND end_reason IS NULL AND "
            "ended_by_account_id IS NULL AND end_explanation IS NULL) OR "
            "(ended_at IS NOT NULL AND end_reason IS NOT NULL)",
            name="ck_participation_ending",
        ),
        CheckConstraint(
            "end_reason IN ('self_withdrawal', 'director_removal', "
            "'identity_reconciliation', 'draw_retired', "
            "'stage_completed', 'group_changed')",
            name="ck_participation_end_reason",
        ),
        CheckConstraint(
            "end_reason NOT IN ('self_withdrawal', 'director_removal', "
            "'identity_reconciliation') OR ended_by_account_id IS NOT NULL",
            name="ck_participation_withdrawal_actor",
        ),
        Index(
            "uq_participation_active_entry_stage",
            "entry_id",
            "stage_id",
            unique=True,
            postgresql_where=text("ended_at IS NULL"),
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()")
    )
    draw_revision_id: Mapped[uuid.UUID] = mapped_column(
        nullable=False, server_default=FetchedValue()
    )
    event_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    entry_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    stage_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    group_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp(), nullable=False
    )
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_by_account_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT")
    )
    end_reason: Mapped[ParticipationEndReason | None] = mapped_column(
        Enum(ParticipationEndReason, native_enum=False, length=None)
    )
    end_explanation: Mapped[str | None] = mapped_column(String)
