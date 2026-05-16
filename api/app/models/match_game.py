import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    SmallInteger,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.match import Match
    from app.models.match_game_score import MatchGameScore


class MatchGame(Base):
    """Lifecycle row for one game inside a match. The score is a separate row
    that exists only once the game has been completed and reported."""

    __tablename__ = "match_games"
    __table_args__ = (
        UniqueConstraint(
            "match_id", "game_number", name="uq_match_games_match_id_game_number"
        ),
        CheckConstraint("game_number >= 1", name="ck_match_games_game_number"),
        Index("ix_match_games_match_id", "match_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    match_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("matches.id", ondelete="CASCADE"),
        nullable=False,
    )
    game_number: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    match: Mapped["Match"] = relationship(back_populates="games")
    score: Mapped["MatchGameScore | None"] = relationship(
        back_populates="match_game",
        uselist=False,
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
