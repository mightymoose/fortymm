import enum
import uuid
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Interval,
    SmallInteger,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.match import Match


class VerificationPolicy(enum.Enum):
    none = "none"
    self_report = "self_report"
    opponent_confirms = "opponent_confirms"
    all_players_confirm = "all_players_confirm"


class MatchSettings(Base):
    """Rules and policies for a single match.

    Each match owns its own row; rows are never shared between matches.
    Values and references are immutable from creation. Tournament materialization
    copies every effective value from its retained draw revision and records that
    revision as provenance. Standalone matches record the same versioned snapshot
    without a tournament source.
    """

    __tablename__ = "match_settings"
    __table_args__ = (
        CheckConstraint("rule_version = 1", name="ck_match_settings_rule_version"),
        CheckConstraint("team_size IN (1, 2)", name="ck_match_settings_team_size"),
        CheckConstraint(
            "best_of >= 1 AND best_of % 2 = 1", name="ck_match_settings_best_of"
        ),
        CheckConstraint(
            "retirement_window IS NULL OR retirement_window > interval '0'",
            name="ck_match_settings_retirement_window_positive",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    rule_version: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default=text("1")
    )
    source_rule_revision_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tournament_draw_revisions.id", ondelete="CASCADE"), index=True
    )
    team_size: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    best_of: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    affects_rating: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    verification_policy: Mapped[VerificationPolicy] = mapped_column(
        Enum(VerificationPolicy, name="verification_policy"),
        nullable=False,
        server_default=VerificationPolicy.none.value,
    )
    retirement_window: Mapped[timedelta | None] = mapped_column(
        Interval().evaluates_none(), nullable=True, server_default=text("'7 days'")
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

    matches: Mapped[list["Match"]] = relationship(back_populates="match_settings")
