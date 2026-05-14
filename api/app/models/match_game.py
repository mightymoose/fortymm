import uuid
from typing import TYPE_CHECKING

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    Index,
    SmallInteger,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.match import Match


class MatchGame(Base):
    """Per-game scores within a match. Each row is one game."""

    __tablename__ = "match_games"
    __table_args__ = (
        UniqueConstraint(
            "match_id", "game_number", name="uq_match_games_match_id_game_number"
        ),
        CheckConstraint("game_number >= 1", name="ck_match_games_game_number"),
        CheckConstraint("side_1_points >= 0", name="ck_match_games_side_1_points"),
        CheckConstraint("side_2_points >= 0", name="ck_match_games_side_2_points"),
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
    side_1_points: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    side_2_points: Mapped[int] = mapped_column(SmallInteger, nullable=False)

    match: Mapped["Match"] = relationship(back_populates="games")
