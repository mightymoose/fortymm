import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.league import League
    from app.models.match import Match
    from app.models.rating_strategy import RatingStrategy
    from app.models.user import User


class RatingHistorySource(enum.Enum):
    match = "match"
    manual = "manual"
    import_ = "import"
    initial = "initial"


class RatingHistory(Base):
    """Append-only audit of every rating change. ``match_id`` is nullable so
    manual overrides, external imports, and seeded initial values are
    first-class history rows."""

    __tablename__ = "rating_history"
    __table_args__ = (
        Index(
            "ix_rating_history_league_id_user_id_created_at",
            "league_id",
            "user_id",
            text("created_at DESC"),
        ),
        Index("ix_rating_history_match_id", "match_id"),
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
    match_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("matches.id", ondelete="SET NULL"),
        nullable=True,
    )
    rating_strategy_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("rating_strategies.id", ondelete="RESTRICT"),
        nullable=False,
    )
    rating_value: Mapped[float] = mapped_column(Float, nullable=False)
    rating_state: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    previous_rating_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    source: Mapped[RatingHistorySource] = mapped_column(
        Enum(
            RatingHistorySource,
            name="rating_history_source",
            values_callable=lambda enum_cls: [m.value for m in enum_cls],
        ),
        nullable=False,
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    league: Mapped["League"] = relationship()
    user: Mapped["User"] = relationship(foreign_keys=[user_id])
    match: Mapped["Match | None"] = relationship()
    rating_strategy: Mapped["RatingStrategy"] = relationship()
    created_by: Mapped["User | None"] = relationship(foreign_keys=[created_by_user_id])
