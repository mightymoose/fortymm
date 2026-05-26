import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    LargeBinary,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.match import Match
    from app.models.user import User


class MatchSignature(Base):
    """Sign-off by a match participant on the canonical posted result.

    Inserted on ``POST /v1/matches/{id}/results`` (first signer) and
    ``POST /v1/matches/{id}/confirmation`` (subsequent signers). When every
    side has at least one row here for one of its players, the confirmation
    handler flips ``Match.status`` to ``completed`` and applies the rating
    update — exactly once.

    ``signature`` is a forward-looking placeholder for a cryptographic blob;
    until that exists, the row's presence is the attestation.
    """

    __tablename__ = "match_signatures"
    __table_args__ = (
        UniqueConstraint(
            "match_id", "user_id", name="uq_match_signatures_match_id_user_id"
        ),
        Index("ix_match_signatures_match_id", "match_id"),
    )

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
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    signature: Mapped[bytes | None] = mapped_column(LargeBinary(), nullable=True)
    signed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    match: Mapped["Match"] = relationship(back_populates="signatures")
    user: Mapped["User"] = relationship("User")
