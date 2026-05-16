import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    SmallInteger,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.match_game import MatchGame


class MatchGameScore(Base):
    """Per-game point totals. Inserted when a game finishes; updated when an
    already-scored game is corrected."""

    __tablename__ = "match_game_scores"
    __table_args__ = (
        UniqueConstraint(
            "match_game_id", name="uq_match_game_scores_match_game_id"
        ),
        CheckConstraint(
            "side_1_points >= 0", name="ck_match_game_scores_side_1_points"
        ),
        CheckConstraint(
            "side_2_points >= 0", name="ck_match_game_scores_side_2_points"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    match_game_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("match_games.id", ondelete="CASCADE"),
        nullable=False,
    )
    side_1_points: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    side_2_points: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    match_game: Mapped["MatchGame"] = relationship(back_populates="score")
