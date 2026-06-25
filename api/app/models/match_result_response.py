import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    DateTime,
    Enum,
    ForeignKey,
    Index,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.match_result import MatchResult
    from app.models.user import User


class ResultResponseKind(enum.Enum):
    confirm = "confirm"
    dispute = "dispute"


class MatchResultResponse(Base):
    """A participant's response (confirm | dispute) to a specific posted result.

    Replaces the old ``match_signatures`` table: a sign-off is no longer "an
    attestation floating on the match" but a response to one ``MatchResult``.
    The submitter's own ``confirm`` is recorded at post time (mirroring the old
    "poster's signature on post"); the other side confirms or disputes. When
    every side has a ``confirm`` on the pending result, the confirmation handler
    flips the result to ``confirmed``, the match to ``completed``, and applies
    the rating update — exactly once.
    """

    __tablename__ = "match_result_responses"
    __table_args__ = (
        UniqueConstraint(
            "result_id",
            "user_id",
            name="uq_match_result_responses_result_id_user_id",
        ),
        Index("ix_match_result_responses_result_id", "result_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    result_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("match_results.id", ondelete="CASCADE"),
        nullable=False,
    )
    # RESTRICT (not CASCADE) so an ephemeral-user delete during account merge
    # can't silently drop a response row; the merge service repoints user_id
    # explicitly. See app/account_merge.py.
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    kind: Mapped[ResultResponseKind] = mapped_column(
        Enum(ResultResponseKind, name="result_response_kind"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    result: Mapped["MatchResult"] = relationship(back_populates="responses")
    user: Mapped["User"] = relationship("User")
