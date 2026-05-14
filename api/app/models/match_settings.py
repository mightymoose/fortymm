import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, CheckConstraint, DateTime, Enum, SmallInteger, func, text
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
    Future templates (tournament events, club ladders) will hold their own
    rows that get copied at match-creation time.
    """

    __tablename__ = "match_settings"
    __table_args__ = (
        CheckConstraint("team_size IN (1, 2)", name="ck_match_settings_team_size"),
        CheckConstraint(
            "best_of >= 1 AND best_of % 2 = 1", name="ck_match_settings_best_of"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
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
