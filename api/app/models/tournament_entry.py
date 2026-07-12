import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

if TYPE_CHECKING:
    from app.models.tournament import TournamentEvent


class TournamentEntryStatus(enum.Enum):
    entered = "entered"
    withdrawn = "withdrawn"


class TournamentEntry(Base):
    """One player's registration in a tournament event.

    **Withdrawal is a soft-delete**: withdrawing flips ``status`` to
    ``withdrawn`` and keeps the row, so an event's entry history survives. That
    is why the uniqueness guard below is a *partial* unique index rather than a
    plain one — a plain unique index on ``(event_id, user_id)`` would let the
    withdrawn row permanently block the same player from ever re-entering. The
    invariant we actually want is "at most one **active** entry per player per
    event", with any number of historical withdrawn rows alongside it.

    An event's ``entered`` count is derived from a live count of active entries;
    it is not a stored column.
    """

    __tablename__ = "tournament_entries"
    __table_args__ = (
        # At most one *active* entry per player per event. Partial on
        # ``status = 'entered'`` so withdrawing frees the (event, user) pair for
        # re-entry while the withdrawn row stays on the books. A duplicate
        # active entry raises IntegrityError, which the route turns into a 409 —
        # race-free, because the database (not a read-then-write check) decides.
        Index(
            "uq_tournament_entries_event_id_user_id_active",
            "event_id",
            "user_id",
            unique=True,
            postgresql_where=text("status = 'entered'"),
        ),
        Index("ix_tournament_entries_event_id", "event_id"),
        Index("ix_tournament_entries_user_id", "user_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tournament_events.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    seed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[TournamentEntryStatus] = mapped_column(
        Enum(
            TournamentEntryStatus,
            name="tournament_entry_status",
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
        server_default=TournamentEntryStatus.entered.value,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    event: Mapped["TournamentEvent"] = relationship(back_populates="entries")
