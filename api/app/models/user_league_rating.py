import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import DateTime, Float, ForeignKey, Index, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.league import League
    from app.models.rating_strategy import RatingStrategy
    from app.models.user import User


class UserLeagueRating(Base):
    """Current rating per (user, league). Nullable values support manual leagues
    where a member exists but no externally-supplied rating has been imported yet."""

    __tablename__ = "user_league_ratings"
    __table_args__ = (
        # The unique index already provides a btree on (league_id, user_id),
        # which covers any league-scoped lookup.
        UniqueConstraint(
            "league_id",
            "user_id",
            name="uq_user_league_ratings_league_id_user_id",
        ),
        Index("ix_user_league_ratings_user_id", "user_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    league_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("leagues.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    rating_strategy_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("rating_strategies.id", ondelete="RESTRICT"),
        nullable=False,
    )
    rating_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    rating_state: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    league: Mapped["League"] = relationship()
    user: Mapped["User"] = relationship()
    rating_strategy: Mapped["RatingStrategy"] = relationship()

    @classmethod
    def seed_for_strategy(
        cls,
        league_id: uuid.UUID,
        user_id: uuid.UUID,
        strategy: "RatingStrategy",
    ) -> "UserLeagueRating":
        return cls(
            league_id=league_id,
            user_id=user_id,
            rating_strategy_id=strategy.id,
            rating_value=strategy.initial_rating_value,
            rating_state=(
                dict(strategy.initial_state)
                if strategy.initial_state is not None
                else None
            ),
        )
