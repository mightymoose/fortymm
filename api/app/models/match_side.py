import uuid
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
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
    from app.models.match_side_player import MatchSidePlayer


class MatchSide(Base):
    """One of the two sides of a match. The unit the rating system operates on."""

    __tablename__ = "match_sides"
    __table_args__ = (
        UniqueConstraint(
            "match_id", "side_number", name="uq_match_sides_match_id_side_number"
        ),
        CheckConstraint("side_number IN (1, 2)", name="ck_match_sides_side_number"),
        CheckConstraint("score >= 0", name="ck_match_sides_score"),
        Index("ix_match_sides_match_id", "match_id"),
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
    side_number: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    score: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default=text("0")
    )
    won: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    match: Mapped["Match"] = relationship(back_populates="sides")
    players: Mapped[list["MatchSidePlayer"]] = relationship(
        back_populates="match_side",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
