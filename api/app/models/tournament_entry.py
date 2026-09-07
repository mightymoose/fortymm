import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    BigInteger,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
    select,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, column_property, mapped_column, relationship

from app.db import Base
from app.models.tournament_entry_member import TournamentEntryMember

if TYPE_CHECKING:
    from app.models.tournament import TournamentEvent


class TournamentEntryStatus(enum.Enum):
    entered = "entered"
    withdrawn = "withdrawn"


class TournamentEntry(Base):
    """The competing unit in one event, with separately recorded Player members.

    **Withdrawal is a soft-delete**: withdrawing flips ``status`` to
    ``withdrawn`` and keeps the row, so an event's entry history survives. That
    frees its players to enter again. Deferred database checks enforce current
    membership cardinality and per-event participation, with an explicit team
    exception. Membership intervals and actual match lineups retain history;
    see ``entry_integrity`` and the entry-members ADR.

    An event's ``entered`` count is derived from a live count of active entries;
    it is not a stored column.

    ``added_by_user_id`` records **how the entry came to exist** — ``NULL`` means
    the player entered themselves, a user id means a director entered them
    (ADR-0784). That is a fact about the past which cannot be reconstructed later
    if we decline to store it now, so it is stored, not derived.
    """

    __tablename__ = "tournament_entries"
    __table_args__ = (
        UniqueConstraint("event_id", "id", name="uq_tournament_entries_event_id_id"),
        Index("ix_tournament_entries_event_id", "event_id"),
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
    # Existing singles readers keep their interface, with no second stored identity.
    # More than one current member has no singles projection.
    user_id: Mapped[uuid.UUID] = column_property(
        select(
            func.entry_canonical_player(
                func.min(TournamentEntryMember.player_id.cast(String)).cast(UUID)
            )
        )
        .where(
            TournamentEntryMember.entry_id == id,
            TournamentEntryMember.left_at.is_(None),
        )
        .having(func.count() == 1)
        .correlate_except(TournamentEntryMember)
        .scalar_subquery(),
        expire_on_flush=False,
    )
    #: Who put this player in the event. ``NULL`` is not "unknown" — it is the
    #: encoding of *self-registration*: the player entered themselves. A non-null
    #: id is the director who entered them (ADR-0784).
    #:
    #: ``RESTRICT``, like ``match_results.accepted_by_user_id``:
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
    created_transaction_id: Mapped[int] = mapped_column(
        BigInteger, server_default=text("txid_current()"), nullable=False
    )

    event: Mapped["TournamentEvent"] = relationship(back_populates="entries")
    members: Mapped[list[TournamentEntryMember]] = relationship(
        back_populates="entry", cascade="all, delete-orphan", passive_deletes=True
    )

    def __init__(self, **kwargs: Any) -> None:
        player_id = kwargs.pop("user_id", None)
        if player_id is not None:
            kwargs["members"] = [TournamentEntryMember(player_id=player_id)]
        super().__init__(**kwargs)
        if player_id is not None:
            self.user_id = player_id
