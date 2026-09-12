import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.account import Account
    from app.models.league import League
    from app.models.match import Match
    from app.models.player import Player
    from app.models.rating_input import RatingInput
    from app.models.rating_strategy import RatingStrategy


class RatingHistorySource(enum.Enum):
    match = "match"
    manual = "manual"
    import_ = "import"
    initial = "initial"


class RatingHistory(Base):
    """Rebuildable current timeline; durable inputs live in rating_inputs."""

    __tablename__ = "rating_history"
    __table_args__ = (
        CheckConstraint(
            "(jsonb_typeof(rating_state) = 'object' AND "
            "jsonb_typeof(rating_state -> 'rating') = 'number' AND "
            "(rating_state ->> 'rating')::float8 = rating_value AND "
            "rating_value > '-Infinity'::float8 AND rating_value < "
            "'Infinity'::float8) IS TRUE",
            name="ck_rating_history_state_value",
        ),
        CheckConstraint(
            "(source = 'match' AND match_id IS NOT NULL AND official_result_id "
            "IS NOT NULL AND rating_input_id IS NULL) OR (source IN ('manual', "
            "'import') AND match_id IS NULL AND official_result_id IS NULL AND "
            "rating_input_id IS NOT NULL) OR (source = 'initial' AND match_id "
            "IS NULL AND official_result_id IS NULL AND rating_input_id IS "
            "NULL)",
            name="ck_rating_history_source_provenance",
        ),
        ForeignKeyConstraint(
            ["match_id", "rating_strategy_id"],
            ["match_rating_bases.match_id", "match_rating_bases.rating_strategy_id"],
            name="fk_rating_history_match_basis",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["official_result_id", "match_id"],
            ["match_official_results.id", "match_official_results.match_id"],
            name="fk_rating_history_official_result_match",
            ondelete="RESTRICT",
        ),
        Index(
            "ix_rating_history_league_id_user_id_created_at",
            "league_id",
            "user_id",
            text("created_at DESC"),
        ),
        Index("ix_rating_history_match_id", "match_id"),
        # Defense in depth against a concurrent double-completion writing two
        # history rows (and double-applying the rating) for the same match.
        # Partial on ``match_id IS NOT NULL`` so manual/import/initial rows —
        # which legitimately share a (NULL match_id, user_id) — are unaffected.
        Index(
            "uq_rating_history_match_id_user_id",
            "match_id",
            "user_id",
            unique=True,
            postgresql_where=text("match_id IS NOT NULL"),
        ),
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
        ForeignKey("players.id", ondelete="RESTRICT"),
        nullable=False,
    )
    match_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("matches.id", ondelete="RESTRICT"),
        nullable=True,
    )
    rating_input_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("rating_inputs.id", ondelete="RESTRICT"), unique=True
    )
    official_result_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
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
        ForeignKey("accounts.id", ondelete="RESTRICT"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    rating_input: Mapped["RatingInput | None"] = relationship()
    league: Mapped["League"] = relationship()
    user: Mapped["Player"] = relationship(foreign_keys=[user_id])
    match: Mapped["Match | None"] = relationship(foreign_keys=[match_id])
    rating_strategy: Mapped["RatingStrategy"] = relationship()
    created_by: Mapped["Account | None"] = relationship(
        foreign_keys=[created_by_user_id]
    )
