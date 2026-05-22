import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import Boolean, DateTime, Float, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.league import League


class RatingStrategy(Base):
    """A rating algorithm definition: the JSON Schema describing the shape of
    ``rating_state``, an initial state for new players, and a flag indicating
    whether match completion triggers an automatic recompute."""

    __tablename__ = "rating_strategies"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    key: Mapped[str] = mapped_column(
        String(64), unique=True, nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    state_schema: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    initial_state: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    initial_rating_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    is_automatic: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
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

    leagues: Mapped[list["League"]] = relationship(back_populates="rating_strategy")
