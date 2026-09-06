import uuid
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, ForeignKeyConstraint, Index, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.match import Match
    from app.models.match_side import MatchSide
    from app.models.player import Player


class MatchSidePlayer(Base):
    """Join row placing a Player on a side of a match.

    One row per side for singles, two for doubles. ``match_id`` is denormalized
    so a Player can be constrained to a single side of a given match.
    """

    __tablename__ = "match_side_players"
    __table_args__ = (
        ForeignKeyConstraint(
            ["match_side_id", "match_id"],
            ["match_sides.id", "match_sides.match_id"],
            name="fk_match_side_players_side_match",
            ondelete="CASCADE",
        ),
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
        nullable=False,
    )
    match_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("matches.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("players.id", ondelete="RESTRICT"),
        nullable=False,
    )

    # The side writes only its ID; match writes match_id independently so
    # contradictory assignments reach the database and fail instead of healing.
    match_side: Mapped["MatchSide"] = relationship(
        back_populates="players", foreign_keys=[match_side_id]
    )
    match: Mapped["Match"] = relationship(back_populates="side_players")
    user: Mapped["Player"] = relationship("Player")
