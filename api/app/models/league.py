import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Index, String, Text, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.league_membership import LeagueMembership
    from app.models.match import Match
    from app.models.rating_strategy import RatingStrategy


class LeagueVisibility(enum.Enum):
    public = "public"
    private = "private"


class League(Base):
    __tablename__ = "leagues"
    __table_args__ = (
        # Partial unique index: at most one row may have is_default=true.
        Index(
            "uq_leagues_one_default",
            "is_default",
            unique=True,
            postgresql_where=text("is_default"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    name: Mapped[str] = mapped_column(
        String(255), unique=True, nullable=False, index=True
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    visibility: Mapped[LeagueVisibility] = mapped_column(
        Enum(LeagueVisibility, name="league_visibility"),
        nullable=False,
        server_default=LeagueVisibility.public.value,
    )
    is_default: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    rating_strategy_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("rating_strategies.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
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

    matches: Mapped[list["Match"]] = relationship(back_populates="league")
    memberships: Mapped[list["LeagueMembership"]] = relationship(
        back_populates="league",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    rating_strategy: Mapped["RatingStrategy"] = relationship(
        back_populates="leagues"
    )
