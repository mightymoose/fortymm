import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Enum, ForeignKey, Index, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.match_settings import MatchSettings

if TYPE_CHECKING:
    from app.models.account import Account
    from app.models.league import League
    from app.models.match_game import MatchGame
    from app.models.match_result import MatchResult
    from app.models.match_side import MatchSide
    from app.models.match_side_player import MatchSidePlayer


class MatchStatus(enum.Enum):
    pending = "pending"
    in_progress = "in_progress"
    completed = "completed"
    voided = "voided"


class MatchEnding(enum.Enum):
    walkover = "walkover"
    stopped_during_play = "stopped_during_play"


class Match(Base):
    """Top-level match record. Thin by design; most data lives in related tables."""

    __tablename__ = "matches"
    __table_args__ = (
        Index(
            "ix_matches_created_by_user_id_created_at",
            "created_by_user_id",
            text("created_at DESC"),
        ),
        Index(
            "ix_matches_status_created_at",
            "status",
            text("created_at DESC"),
        ),
        Index(
            "ix_matches_status_updated_at",
            "status",
            text("updated_at DESC"),
        ),
        Index(
            "ix_matches_status_completed_at",
            "status",
            text("completed_at DESC"),
        ),
        Index("ix_matches_league_id", "league_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    match_settings_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("match_settings.id", ondelete="RESTRICT"),
        nullable=False,
    )
    league_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("leagues.id", ondelete="RESTRICT"),
        nullable=False,
    )
    status: Mapped[MatchStatus] = mapped_column(
        Enum(MatchStatus, name="match_status"),
        nullable=False,
        server_default=MatchStatus.pending.value,
    )
    # Database-only special endings. NULL retains ordinary result negotiation.
    # "Retirement" already means automatic result acceptance in this codebase.
    ending: Mapped[MatchEnding | None] = mapped_column(
        Enum(MatchEnding, name="match_ending"), nullable=True
    )
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="RESTRICT"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    # Stamped once the match reaches ``completed`` and kept stable thereafter —
    # editing a completed match (which bumps ``updated_at``) must not move it in
    # or out of another match's historical window. Cleared back to NULL when a
    # match is un-completed and re-stamped on the next completion.
    # NULL for any match that hasn't completed. History/form/H2H queries anchor
    # on this, not on the mutable ``updated_at``.
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    def mark_completed(self) -> None:
        """Flip to ``completed`` and stamp the stable completion time in one
        step, so the "completed ⟹ ``completed_at`` is set" invariant the
        history/form/H2H windows rely on can't be half-applied by a caller that
        sets the status but forgets the stamp."""
        self.status = MatchStatus.completed
        self.completed_at = func.now()

    match_settings: Mapped[MatchSettings] = relationship(back_populates="matches")
    league: Mapped["League"] = relationship(back_populates="matches")
    created_by: Mapped["Account"] = relationship("Account")
    sides: Mapped[list["MatchSide"]] = relationship(
        back_populates="match",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    games: Mapped[list["MatchGame"]] = relationship(
        back_populates="match",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    # A side player is "owned" by its MatchSide (which carries delete-orphan);
    # this denormalized convenience collection only needs delete cascade so a
    # deleted match takes its side players with it via the DB ON DELETE CASCADE.
    side_players: Mapped[list["MatchSidePlayer"]] = relationship(
        back_populates="match",
        cascade="all",
        passive_deletes=True,
    )
    results: Mapped[list["MatchResult"]] = relationship(
        back_populates="match",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="MatchResult.submitted_at",
    )
