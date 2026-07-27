import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, String, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.tournament import DrawType

if TYPE_CHECKING:
    from app.models.tournament import TournamentEvent


class TournamentEventDrawSettings(Base):
    """One event's draw configuration — the row an event's ``draw_settings_id``
    points at (ADR "an event's draw configuration is a row, not a column").

    This is the ``MatchSettings`` shape, deliberately: the settings row owns its
    own ``id`` and the PARENT (``tournament_events.draw_settings_id``) holds the
    ``NOT NULL`` FK. There is no ``event_id`` here, and that direction is the
    whole point. Moving a mandatory attribute into a 1:1 side table normally
    makes it optional at the schema level — SQL cannot express "exactly one child
    row" — and every reader then has to handle an absence that should be
    impossible. A ``NOT NULL`` FK on the parent keeps it mandatory in the
    database instead.

    ``draw_type_key`` is a ``NOT NULL`` FK to ``draw_types.key`` with
    ``ON DELETE RESTRICT``, so a settings row can only ever name a draw type that
    has a seeded row — i.e. one ``app.draws.strategy_for`` can actually dispatch —
    and a seeded row cannot be deleted out from under an event that uses it.

    Thin for now: it holds exactly the draw type. The follow-on pools ticket moves
    ``TournamentEvent.pools`` in here, and #787 adds ``qualifiers_per_pool``.
    """

    __tablename__ = "tournament_event_draw_settings"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    # The slug, not the enum: the FK target is ``draw_types.key``, so this column
    # is the varchar that table's primary key is. ``RESTRICT`` because a draw type
    # an event is configured with must not be deletable — the reference table is
    # the enforcement, not decoration.
    draw_type_key: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("draw_types.key", ondelete="RESTRICT"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    # Mirrors ``MatchSettings.matches``: a list, because the FK lives on the other
    # side and SQL cannot say "at most one". In practice rows are never shared —
    # every event builds its own, and the other side's ``single_parent=True`` is
    # now what says so.
    #
    # Nothing in the database reaps a row here when its event goes away: the FK
    # points event → settings, so there is no ``event_id`` to cascade along. The
    # two paths that remove events each clean up explicitly — see
    # ``app.tournament_draw_settings``.
    events: Mapped[list["TournamentEvent"]] = relationship(
        back_populates="draw_settings"
    )

    @classmethod
    def for_draw_type(cls, draw_type: DrawType) -> "TournamentEventDrawSettings":
        """Build the settings row for ``draw_type``.

        The ONE place a :class:`DrawType` member becomes the persisted slug, so
        every construction site names the draw type once and no site can invent a
        key the reference table has never heard of.
        """
        return cls(draw_type_key=draw_type.value)

    @property
    def draw_type(self) -> DrawType:
        """The configured draw type, parsed back into the closed set the code
        dispatches on.

        The column is the FK slug; readers want the enum. Raises ``ValueError`` on
        a slug with no ``DrawType`` member — which the FK plus the seed-vs-enum
        migration test make unreachable, and which is the loud failure we want if
        they ever stop agreeing.
        """
        return DrawType(self.draw_type_key)
