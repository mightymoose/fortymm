import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Enum, ForeignKey, Index, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.match import Match
    from app.models.match_result_response import MatchResultResponse
    from app.models.user import User


class ResultOutcome(enum.Enum):
    """Lifecycle of a single posted result.

    ``pending`` — posted, awaiting the other side's confirm/dispute.
    ``confirmed`` — every side confirmed (or a solo/unrated short-circuit); the
    match is ``completed``.
    ``disputed`` — a participant rejected it; the match reopens for re-scoring
    and this row stays as the immutable record of what was rejected.
    ``superseded`` — a still-``pending`` result was replaced by a re-post before
    anyone acted on it. Unused by the current flow (a re-post only happens after
    a terminal dispute) but reserved so re-posting over a pending result has a
    home.
    """

    pending = "pending"
    confirmed = "confirmed"
    disputed = "disputed"
    superseded = "superseded"


class MatchResult(Base):
    """A posted result — the "claim" created by ``POST /v1/matches/{id}/results``.

    One row per posting, carrying who submitted it, when, an **immutable JSONB
    snapshot of the claimed board**, and its outcome. Confirm/dispute become
    ``MatchResultResponse`` rows hanging off this result, so the full per-result
    history survives a dispute (the rejected board is preserved in ``games``)
    instead of being mutated away on the working ``match_games`` scratchpad.
    """

    __tablename__ = "match_results"
    __table_args__ = (Index("ix_match_results_match_id", "match_id"),)

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
    # RESTRICT (not CASCADE) so an ephemeral-user delete during account merge
    # can't silently drop a result row; the merge service repoints it. See
    # app/account_merge.py.
    submitted_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    outcome: Mapped[ResultOutcome] = mapped_column(
        Enum(ResultOutcome, name="result_outcome"),
        nullable=False,
        default=ResultOutcome.pending,
        server_default=ResultOutcome.pending.value,
    )
    # Immutable snapshot of the claimed board, frozen at post time. A list of
    # ``{"game_number", "side_1_points", "side_2_points"}`` objects (decode into
    # a typed model at read time, per "parse, don't validate", when #366 first
    # reads it). The working ``match_games`` scratchpad stays the live, editable
    # board; this is the write-once record of what this posting claimed.
    games: Mapped[list[dict[str, int]]] = mapped_column(JSONB, nullable=False)

    match: Mapped["Match"] = relationship(back_populates="results")
    submitted_by: Mapped["User"] = relationship("User")
    responses: Mapped[list["MatchResultResponse"]] = relationship(
        back_populates="result",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="MatchResultResponse.created_at",
    )
