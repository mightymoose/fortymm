"""The moment a deletion completed a tournament (#1810)."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class TournamentCompletionMark(Base):
    """Records that deleting an event left every remaining event finished or
    cancelled. A deletion writes no lifecycle history, so without this the
    receipt-address retention clock would run from the last finish, however long
    ago. One row per tournament, replaced by a later deletion. It lives in its
    own table so that nothing seeds or reads ``tournaments`` differently."""

    __tablename__ = "tournament_completion_marks"

    tournament_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournaments.id", ondelete="CASCADE"),
        primary_key=True,
    )
    observed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("clock_timestamp()"),
    )
