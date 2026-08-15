import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, Integer, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.draw_type import DRAW_TYPE_IDS
from app.models.tournament import DrawType

if TYPE_CHECKING:
    from app.models.draw_type import DrawTypeOption
    from app.models.tournament import TournamentEvent


class TournamentEventStage(Base):
    """One stage of an event's draw — a row the event owns (ADR 20260815 decision 1,
    "a stage is a row the event owns").

    A director never authors these directly: the system mints them from a template
    keyed on the event's draw type, in code, never as a column (decision 3/4) — see
    ``app.tournament_event_stages`` for the template and the mint/re-mint that write
    this table. This model only carries the row shape and the one invariant that
    belongs at this layer: a stage's own ``draw_type`` can never be ``rr_then_ko`` —
    that member names a *template*, not a runnable stage, and there is deliberately no
    "stage-runnable" flag on ``draw_types`` to check instead (decision 4). The
    :attr:`draw_type` setter below is where that refusal actually lives, so it holds
    regardless of which caller reaches it.

    ``position`` is 0-based, mirroring ``tournament_event_pools.position`` and
    ``tournament_tables.position``. Position 0 is the row the ADR calls "stage 1" — the
    one a director's pools hang off today, and the one that keeps its identity across a
    draw-type change (decision 3).
    """

    __tablename__ = "tournament_event_stages"
    __table_args__ = (
        # The target of a later composite FK — "things attached to a stage" (pools,
        # eventually) will foreign-key ``(event_id, id)``, exactly as
        # ``tournament_event_pools`` does today for the event itself. Redundant against
        # the primary key as a uniqueness claim; it exists purely as that target (ADR
        # 20260815 decision 1: "``UNIQUE (event_id, id)`` exists purely as a
        # composite-FK target, as on pools").
        UniqueConstraint(
            "event_id", "id", name="uq_tournament_event_stages_event_id_id"
        ),
        # Two stages of one event never share a place in its order. NOT deferrable,
        # unlike the sibling pool/table position constraints: those are written as a
        # client-ordered diff that can re-order and so needs the intermediate state
        # tolerated. A stage's position never swaps — the re-mint in place only ever
        # appends past the template's old length or truncates from the tail (ADR
        # 20260815 decision 3) — so nothing here ever asks for an intermediate
        # duplicate.
        UniqueConstraint(
            "event_id", "position", name="uq_tournament_event_stages_event_id_position"
        ),
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
    #: Where this stage sits in the event's draw, 0-based: position 0 feeds position 1,
    #: and so on (ADR 20260815 decision 7, "stage position defines the feed"). Minted by
    #: the template, never client-supplied.
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    # RESTRICT, exactly as ``tournament_event_draw_settings.draw_type_id`` is: a draw
    # type a stage is running cannot be deleted out from under it. FKs
    # ``draw_types.id``, not its ``key`` (ADR 20260815) — code still resolves the slug
    # through the ``draw_type_option`` join below, via the ``draw_type`` property,
    # never off this column directly.
    draw_type_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("draw_types.id", ondelete="RESTRICT"),
        nullable=False,
    )
    # Eager and joined, for the same reason ``TournamentEventDrawSettings
    # .draw_type_option`` is: async SQLAlchemy raises rather than emitting a lazy load,
    # so a reader that reaches ``stage.draw_type`` needs this to have ridden along with
    # whatever query loaded the stage. ``innerjoin=True`` because the FK is NOT NULL.
    draw_type_option: Mapped["DrawTypeOption"] = relationship(
        lazy="joined",
        innerjoin=True,
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

    # No ``lazy="selectin"`` here, unlike ``TournamentEventPool`` — deliberately.
    # Nothing reads an event's stages yet (this chore mints and re-mints only), and an
    # eager collection would move the ``EXPECTED_TOURNAMENT_*_STATEMENTS`` pins in
    # ``tests/test_tournaments.py`` for a read path this chore does not touch. The mint
    # and re-mint in ``app.tournament_event_stages`` reach these rows through explicit
    # queries, never through ``TournamentEvent.stages``, so the default (lazy) strategy
    # is never actually exercised by app code today.
    event: Mapped["TournamentEvent"] = relationship(back_populates="stages")

    @property
    def draw_type(self) -> DrawType:
        """The stage's own draw type, parsed back into the closed set the code
        dispatches on. Read through the ``draw_type_option`` join, never off
        ``draw_type_id`` directly — same shape as
        ``TournamentEventDrawSettings.draw_type``, same reason.
        """
        return DrawType(self.draw_type_option.key)

    @draw_type.setter
    def draw_type(self, draw_type: DrawType) -> None:
        """The ONE place a stage's ``draw_type_id`` is written.

        Refuses ``rr_then_ko`` outright (ADR 20260815 decision 4: "the code knows
        rr_then_ko is a template and refuses it as a stage's type at the boundary").
        ``stage_template`` in ``app.tournament_event_stages`` never produces a component
        that fails this, so the refusal never fires on the ordinary mint/re-mint path —
        it exists so a template entry that got this wrong fails loudly here, at
        construction, rather than persisting a stage no strategy can run.
        """
        if draw_type is DrawType.rr_then_ko:
            raise ValueError(
                "rr_then_ko is a template, not a runnable stage draw type "
                "(ADR 20260815 decision 4)"
            )
        self.draw_type_id = DRAW_TYPE_IDS[draw_type]
