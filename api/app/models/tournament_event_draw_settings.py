import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    func,
    text,
)
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

    Two columns of configuration today: the draw type, and ``qualifiers_per_pool``
    — the **K** of "the top K from each pool advance", which only ``rr-then-ko``
    has (#1227). The follow-on pools ticket moves ``TournamentEvent.pools`` in
    here.
    """

    __tablename__ = "tournament_event_draw_settings"
    __table_args__ = (
        # ``qualifiers_per_pool`` belongs to exactly one draw type, and this is
        # what says so at the storage layer: it is NOT NULL and at least 1 when
        # the row names ``rr-then-ko``, and NULL for every other draw type. A
        # round-robin row carrying a qualifier count is not a row Postgres will
        # accept, so the pairing cannot drift no matter which writer produced it.
        #
        # The slug is spelled out in the DDL on purpose. It is the same
        # hand-copied seed data migration 0010 already carries (``DRAW_TYPE_SEED``)
        # — a constraint cannot import ``DrawType``, and a lookup-driven
        # "does this draw type take qualifiers?" column on ``draw_types`` would be
        # a second, mutable home for a fact the code already dispatches on.
        CheckConstraint(
            "CASE WHEN draw_type_key = 'rr-then-ko'"
            " THEN qualifiers_per_pool IS NOT NULL AND qualifiers_per_pool >= 1"
            " ELSE qualifiers_per_pool IS NULL"
            " END",
            name="ck_tournament_event_draw_settings_qualifiers_per_pool",
        ),
    )

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
    # **K** — how many of each pool's finishers advance into the knockout stage of
    # an ``rr-then-ko`` draw (ADR "rr-then-ko cuts both stages upfront and seeds
    # qualifiers rematch-free"). The knockout bracket's size is
    # ``next_power_of_two(P × K)`` and is DERIVED at the cut, never stored beside
    # this — carrying both lets them contradict.
    #
    # Nullable because it is meaningless for every other draw type: a round-robin
    # event has no cut to size and a single-elim event has no pools to cut from,
    # so ``NULL`` here is "this draw type takes no qualifier count", not "unknown".
    # The ``CASE`` constraint above is what keeps NULL and the draw type in step.
    #
    # ``K >= 1`` is the STATIC half of the ADR's legal configuration space and so
    # is enforced here (and at the request boundary). The two bounds that move with
    # the entrant count — ``P × K >= 2`` and ``K <= ⌊N/P⌋`` — are refused at the cut
    # as ``DegenerateDraw``, because a row that was legal when it was written must
    # not become unwritable when a player withdraws.
    qualifiers_per_pool: Mapped[int | None] = mapped_column(Integer, nullable=True)
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
    def for_draw_type(
        cls, draw_type: DrawType, *, qualifiers_per_pool: int | None = None
    ) -> "TournamentEventDrawSettings":
        """Build the settings row for ``draw_type``, configured as ``draw_type``
        configures.

        The create path's door onto :meth:`configure` below, which is the ONE place a
        :class:`DrawType` member becomes the persisted slug and the qualifier count
        beside it.

        It takes the draw type and the count as two values rather than the request
        boundary's parsed union arm (``app.schemas.tournament.DrawSettingsWrite``), and
        that is a **layering** choice, not an oversight: the schemas import the models,
        so a model naming a request schema inverts the direction the rest of the package
        points in. The union arm is consumed one layer up, in
        ``app.tournament_events``, which already holds both — so the pair reaching here
        has been parsed, and "a round-robin row with a qualifier count" was refused at
        the boundary before it could be spelled. The ``CHECK`` on this table is the
        second, unconditional lock: a caller that assembles an illegal pair by hand gets
        an ``IntegrityError``, not a stored contradiction.

        ``qualifiers_per_pool`` defaults to ``None`` because that is what all but one
        draw type carry, and it keeps every construction site that names a
        configuration-free draw type reading as it always did.
        """
        settings = cls()
        settings.configure(draw_type, qualifiers_per_pool=qualifiers_per_pool)
        return settings

    def configure(
        self, draw_type: DrawType, *, qualifiers_per_pool: int | None = None
    ) -> None:
        """Write this row's whole draw configuration — the ONE place the pair is set.

        Both writers go through here: :meth:`for_draw_type` at create, and
        ``app.tournament_events.update_event`` at edit. The two columns are written
        **together**, because they are one fact: setting the draw type without clearing
        the qualifier count beside it is how a round-robin row ends up carrying a ``K``
        the ``CHECK`` refuses — and it is the edit path (draw type patched from
        ``rr-then-ko`` back to ``round-robin``) where that would happen.
        """
        self.draw_type = draw_type
        self.qualifiers_per_pool = qualifiers_per_pool

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

    @draw_type.setter
    def draw_type(self, draw_type: DrawType) -> None:
        """The ONE place a :class:`DrawType` member becomes the persisted slug.

        Every writer goes through here, via :meth:`configure` above. Without a
        setter the edit path had to reach past the property and write
        ``draw_settings.draw_type_key = draw_type.value`` itself, which gave
        enum→slug conversion a second home to drift in and made the "ONE place"
        claim above false.
        """
        self.draw_type_key = draw_type.value
