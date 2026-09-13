"""A tournament's retained archive decision, independent of event progress."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class TournamentArchiveHistory(Base):
    __tablename__ = "tournament_archive_history"

    tournament_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tournaments.id", ondelete="RESTRICT"), primary_key=True
    )
    observed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    occurred_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
