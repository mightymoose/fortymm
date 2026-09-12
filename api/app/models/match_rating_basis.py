"""The immutable formula chosen when a match first becomes official."""

import uuid

from sqlalchemy import ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class MatchRatingBasis(Base):
    __tablename__ = "match_rating_bases"
    __table_args__ = (
        UniqueConstraint(
            "match_id",
            "rating_strategy_id",
            name="uq_match_rating_bases_match_strategy",
        ),
    )

    match_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("matches.id", ondelete="RESTRICT"), primary_key=True
    )
    rating_strategy_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("rating_strategies.id", ondelete="RESTRICT")
    )
