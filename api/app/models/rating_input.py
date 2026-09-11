"""Durable, rating-only facts; projections may be rebuilt independently."""

import uuid
from datetime import datetime
from typing import Literal

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Identity,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

RatingInputSource = Literal["manual", "import"]


class RatingInput(Base):
    __tablename__ = "rating_inputs"
    __table_args__ = (
        CheckConstraint(
            "rating > '-Infinity'::float8 AND rating < 'Infinity'::float8",
            name="ck_rating_inputs_finite",
        ),
        CheckConstraint(
            "source IN ('manual', 'import')", name="ck_rating_inputs_source"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    sequence: Mapped[int] = mapped_column(
        BigInteger, Identity(always=True), unique=True, nullable=False
    )
    league_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("leagues.id", ondelete="RESTRICT")
    )
    player_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("players.id", ondelete="RESTRICT")
    )
    actor_account_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT")
    )
    rating_strategy_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("rating_strategies.id", ondelete="RESTRICT")
    )
    supersedes_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("rating_inputs.id", ondelete="RESTRICT"), unique=True
    )
    rating: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(16))
    effective_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp()
    )
    note: Mapped[str | None] = mapped_column(Text)
