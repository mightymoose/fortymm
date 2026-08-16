import uuid
from datetime import datetime
from typing import TYPE_CHECKING, cast

from sqlalchemy import DateTime, ForeignKey, Integer, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.draw_type import DRAW_TYPE_IDS, DRAW_TYPES_BY_ID, StageDrawType
from app.models.tournament import DrawType

if TYPE_CHECKING:
    from app.models.tournament import TournamentEvent
    from app.models.tournament_event_stage_group import TournamentEventStageGroup
    from app.models.tournament_fixture import TournamentFixture


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

    ``position`` is 0-based, mirroring ``tournament_event_stage_groups.position`` and
    ``tournament_tables.position``. Position 0 is the row the ADR calls "stage 1" — the
    one a director's groups hang off today, and the one that keeps its identity across a
    draw-type change (decision 3).
    """

    __tablename__ = "tournament_event_stages"
    __table_args__ = (
        # The target of a later composite FK — "things attached to a stage" (groups,
        # eventually) will foreign-key ``(event_id, id)``, exactly as
        # ``tournament_event_stage_groups`` does for the stage itself. Redundant against
        # the primary key as a uniqueness claim; it exists purely as that target (ADR
        # 20260815 decision 1: "``UNIQUE (event_id, id)`` exists purely as a
        # composite-FK target, as on groups").
        UniqueConstraint(
            "event_id", "id", name="uq_tournament_event_stages_event_id_id"
        ),
        # Two stages of one event never share a place in its order. NOT deferrable,
        # unlike the sibling group/table position constraints: those are written as a
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
    # through :data:`~app.models.draw_type.DRAW_TYPES_BY_ID`, a plain dict lookup, via
    # the ``draw_type`` property, never off this column directly.
    draw_type_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("draw_types.id", ondelete="RESTRICT"),
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

    # The eager-loading rationale for the collection this is the other side of lives on
    # ``TournamentEvent.stages`` (``lazy="selectin"``), not here — the mint and re-mint
    # in ``app.tournament_event_stages`` still reach these rows through explicit
    # queries, never through that relationship, so nothing here needs its own strategy.
    event: Mapped["TournamentEvent"] = relationship(back_populates="stages")

    # A stage's GROUPS, as rows — what this relationship called ``groups`` held until
    # the group row split in two. The half that stayed here is the group (ADR 20260815,
    # "Sequencing with #1338": "the pool's group face therefore re-parents to the
    # stage"); the half that carries the tables and the window is a reservation, and it
    # hangs off the event instead (``TournamentEvent.reservations``). In practice this
    # is only ever populated on the stage at position 0 (a director's groups always hang
    # off stage 1, decision 3), but nothing on this relationship enforces that placement
    # — ``app.tournament_reservations`` does, by resolving the event's first stage
    # before it writes. Deliberately **not** eager, unlike the VIEWONLY
    # ``TournamentEvent.groups`` (``lazy="selectin"``, declared on that model), which is
    # the one mechanism every ordinary reader goes through. Making BOTH eager would
    # double-load: any statement that also eager-loads ``TournamentEvent.stages`` (the
    # detail read's stage-serving option) would chain THIS collection's own selectin
    # load off of it, on top of the one ``TournamentEvent.groups`` already issues,
    # costing a redundant statement nobody asked for. The one direct reader of
    # ``stage.groups`` — ``app.tournament_reservations.apply_event_reservations``, which
    # needs the CURRENT rows to diff against — asks for it explicitly
    # (``selectinload(TournamentEventStage.groups)`` on its own query) rather than
    # leaning on a default here. ``delete-orphan`` still applies regardless of load
    # strategy: a group dropped from a diff is removed by taking it out of whatever
    # collection is in hand, loaded or not.
    groups: Mapped[list["TournamentEventStageGroup"]] = relationship(
        back_populates="stage",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="TournamentEventStageGroup.position",
    )

    # A stage's fixtures — re-parented here from ``TournamentEvent.fixtures`` (ADR
    # 20260815 decision 5: "a fixture names its stage"). Unlike groups, BOTH stages of
    # an rr-then-ko event hold fixtures (the group stage's round-robin fixtures, the
    # position-1 stage's knockout bracket) — see ``app.tournament_draws.cut_draw``, the
    # one write seam that decides a fixture's ``stage_id``.
    #
    # Deliberately **not** eager, mirroring ``TournamentEvent.fixtures`` before this
    # move (and unlike ``groups`` above): every production read of a draw already goes
    # through the batched ``fixtures_by_event`` loader, never through an ORM
    # relationship walk, so an eager option here would add a statement to every stage
    # read for a path nothing exercises. ``cut_draw`` / ``uncut_draw`` write fixtures
    # through bulk ``INSERT`` / ``DELETE`` statements, not through this collection.
    fixtures: Mapped[list["TournamentFixture"]] = relationship(
        back_populates="stage",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by=(
            "TournamentFixture.group_id.asc().nulls_last(), "
            "TournamentFixture.round, TournamentFixture.position"
        ),
    )

    @property
    def draw_type(self) -> StageDrawType:
        """The stage's own draw type, parsed back into the closed set the code
        dispatches on. A plain dict lookup on
        :data:`~app.models.draw_type.DRAW_TYPES_BY_ID`, keyed by ``draw_type_id`` —
        never a join or a relationship walk, and no loaded relationship or lazy load
        needed — same shape as ``TournamentEventDrawSettings.draw_type``, same reason
        (ADR 20260815 retired the join this used to make).

        Narrowed to :data:`~app.models.draw_type.StageDrawType`, not the full
        :class:`DrawType`. The ``cast`` is safe, not a suppression: the setter below
        is the ONLY writer of ``draw_type_id`` and refuses ``rr_then_ko`` outright, so
        ``DRAW_TYPES_BY_ID[self.draw_type_id]`` can never actually resolve to that
        member here.
        """
        return cast(StageDrawType, DRAW_TYPES_BY_ID[self.draw_type_id])

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
