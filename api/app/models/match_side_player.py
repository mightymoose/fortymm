import uuid
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, Index, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.match import Match
    from app.models.match_side import MatchSide
    from app.models.user import User


class MatchSidePlayer(Base):
    """Join row placing a user on a side of a match.

    One row per side for singles, two for doubles. ``match_id`` is denormalized
    so a user can be constrained to a single side of a given match.
    """

    __tablename__ = "match_side_players"
    __table_args__ = (
        UniqueConstraint(
            "match_side_id",
            "user_id",
            name="uq_match_side_players_match_side_id_user_id",
        ),
        UniqueConstraint(
            "match_id", "user_id", name="uq_match_side_players_match_id_user_id"
        ),
        Index("ix_match_side_players_user_id", "user_id"),
        Index("ix_match_side_players_match_side_id", "match_side_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    match_side_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("match_sides.id", ondelete="CASCADE"),
        nullable=False,
    )
    match_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("matches.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    )

    match_side: Mapped["MatchSide"] = relationship(back_populates="players")
    match: Mapped["Match"] = relationship(back_populates="side_players")
    user: Mapped["User"] = relationship("User")
