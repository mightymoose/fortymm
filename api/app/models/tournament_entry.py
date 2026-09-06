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

    ``added_by_user_id`` records **how the entry came to exist** — ``NULL`` means
    the player entered themselves, a user id means a director entered them
    (ADR-0784). That is a fact about the past which cannot be reconstructed later
    if we decline to store it now, so it is stored, not derived.
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
        Index("ix_tournament_entries_added_by_user_id", "added_by_user_id"),
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
        ForeignKey("players.id", ondelete="RESTRICT"),
        nullable=False,
    )
    #: Who put this player in the event. ``NULL`` is not "unknown" — it is the
    #: encoding of *self-registration*: the player entered themselves. A non-null
    #: id is the director who entered them (ADR-0784).
    #:
    #: ``RESTRICT``, like ``user_id`` above and ``match_results.accepted_by_user_id``:
    #: deliberately NOT ``SET NULL``, because nulling this column on a user delete
    #: would not lose a fact, it would *rewrite* one — a director-added entry would
    #: silently start claiming the player registered themselves. Account merge
    #: tombstones rather than deletes, so ``ON DELETE`` never fires on the path that
    #: actually happens; the original acting Account remains recorded.
    added_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="RESTRICT"),
        nullable=True,
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
