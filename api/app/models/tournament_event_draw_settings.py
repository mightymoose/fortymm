import uuid
from collections.abc import Mapping
from datetime import datetime
from types import MappingProxyType
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.draw_type import DRAW_TYPE_IDS, DRAW_TYPES_BY_ID
from app.models.tournament import DrawType

if TYPE_CHECKING:
    from app.models.tournament import TournamentEvent


NO_SETTINGS: Mapping[str, Any] = MappingProxyType({})
"""What a draw type that takes no configuration stores: the **empty object**.

Not ``None`` (ADR "a draw type's settings are one NOT NULL JSON object"). An empty
object and a ``NULL`` would read the same to every caller, so only one of them may be
representable, and the empty object is the one every reader already expects — nothing
has to test for absence before it reads.

A ``MappingProxyType``, so the shared default cannot be mutated by whoever receives it.
"""


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

    ``draw_type_id`` is a ``NOT NULL`` FK to ``draw_types.id`` with
    ``ON DELETE RESTRICT`` (ADR 20260815 "draw_types gains a surrogate id primary
    key" — supersedes the slug-as-PK stance of the ADR that originally named this
    column ``draw_type_key``), so a settings row can only ever name a draw type
    that has a seeded row — i.e. one ``app.draws.strategy_for`` can actually
    dispatch — and a seeded row cannot be deleted out from under an event that
    uses it. Code still resolves the draw type by its ``key`` slug, never by
    ``id`` — see the ``draw_type`` property below, which maps the id back to the
    slug through ``app.models.draw_type.DRAW_TYPES_BY_ID``, a plain dict lookup,
    not a join.

    Two columns of configuration today: the draw type, and the ``settings`` object
    beside it — the serialized form of the draw type's own settings arm (ADR "a draw
    type's settings are one NOT NULL JSON object"). The follow-on pools ticket moves
    ``TournamentEvent.groups`` in here.
    """

    __tablename__ = "tournament_event_draw_settings"
    __table_args__ = (
        # All the database has an opinion on now: ``settings`` is a JSON **object**.
        # A list, a number, a string or a JSON ``null`` would each parse as "settings"
        # and mean nothing, so they are refused here rather than deep in a reader.
        #
        # It is deliberately weaker than the ``CASE`` constraint it replaces, which
        # paired a nullable ``qualifiers_per_pool`` column with the one draw type that
        # has one. Which settings belong to which draw type is no longer a storage
        # fact — it is the discriminated union at the request boundary
        # (``app.schemas.tournament.DrawSettingsWrite``), which refuses a qualifier
        # count on a round-robin event with a 422. That is the loss the ADR accepts on
        # purpose: the constraint grew one branch per draw type per setting, and the
        # union already says the same thing in one place.
        CheckConstraint(
            "jsonb_typeof(settings) = 'object'",
            name="ck_tournament_event_draw_settings_settings_object",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    # The surrogate id, not the slug (ADR 20260815): the FK target is
    # ``draw_types.id``. ``RESTRICT`` because a draw type an event is configured
    # with must not be deletable — the reference table is the enforcement, not
    # decoration. The ``draw_type`` property below reads this column back through
    # ``app.models.draw_type.DRAW_TYPES_BY_ID``, a plain dict lookup — no
    # relationship, no join, and so no loader state to depend on.
    draw_type_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("draw_types.id", ondelete="RESTRICT"),
        nullable=False,
    )
    # The draw type's settings, as one NOT NULL JSON object (ADR "a draw type's
    # settings are one NOT NULL JSON object"). ``{}`` for a draw type that takes no
    # configuration — ``round-robin`` and ``single-elim`` today —
    # ``{"qualifiers_per_pool": K}`` for ``rr-then-ko``, and ``{"rounds": R}`` for
    # ``swiss``.
    #
    # This is the **serialized form of a union**: which keys are in here depends
    # entirely on the draw type beside it, which is what a wide row of nullable
    # columns could only express with a ``CASE`` constraint that grew a branch per
    # setting per draw type. Adding a draw type's settings is now an arm in
    # ``app.schemas.tournament.DrawSettingsWriteArm`` and no migration at all.
    #
    # A ``dict`` is what SQLAlchemy hands back. ``app.tournament_draw_settings`` is the
    # boundary that parses it — it hands the blob to
    # ``app.schemas.tournament.draw_settings_from_storage``, which is where the union
    # actually validates, since the model cannot import the schemas. What matters is the
    # property that holds either way: no CALLER of that module ever receives an untyped
    # blob (api/CLAUDE.md, "parse, don't validate"). App writers go through
    # ``configure`` below, never through this attribute.
    #
    # The server default is for the raw-SQL writer (tests, psql) — every writer in
    # the app supplies the object — and it is ``{}`` rather than ``NULL`` for the
    # reason ``NO_SETTINGS`` gives.
    settings: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
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
    def for_draw_type(
        cls, draw_type: DrawType, *, settings: Mapping[str, Any] = NO_SETTINGS
    ) -> "TournamentEventDrawSettings":
        """Build the settings row for ``draw_type``, carrying ``settings``.

        **Test seeding only, and it does NOT parse.** No app code calls this: the create
        path builds its row through ``app.tournament_draw_settings.draw_settings_row``
        and the edit path through ``store_draw_settings``, both of which take an already
        parsed :data:`~app.schemas.tournament.DrawSettingsWriteArm`. This method takes a
        raw mapping and writes it straight through, so it is the one door onto
        ``settings`` that the union does not stand behind. That matters more than it
        used to: the ``CASE`` ``CHECK`` that once refused a configured draw type with no
        settings is gone, so ``for_draw_type(DrawType.rr_then_ko)`` now writes ``{}``
        happily and fails at *read* instead, when the arm cannot be parsed. Seed through
        ``tests/_helpers.event_draw_settings``, which routes the same pair through the
        parse, unless the point of the test is to write a blob the union would refuse.

        It takes the draw type and a plain mapping rather than the parsed union arm
        (``app.schemas.tournament.DrawSettingsWrite``), and that is a **layering**
        choice, not an oversight: the schemas import the models, so a model naming a
        schema inverts the direction the rest of the package points in. The arm is
        serialized one layer up, by ``app.tournament_draw_settings.draw_settings_row``
        (and ``store_draw_settings`` on the edit path), which is the module that owns
        both directions of this column.

        ``settings`` defaults to :data:`NO_SETTINGS` — the empty object — because that
        is what every draw type but one carries, and it keeps each construction site
        that names a configuration-free draw type reading as it always did.
        """
        row = cls()
        row.configure(draw_type, settings=settings)
        return row

    def configure(self, draw_type: DrawType, *, settings: Mapping[str, Any]) -> None:
        """Write this row's whole draw configuration — the ONE place the pair is set.

        Every writer goes through here: ``app.tournament_draw_settings``'s
        :func:`~app.tournament_draw_settings.store_draw_settings` on both the create and
        the edit path, and :meth:`for_draw_type` when a test seeds a row. The two
        columns are written
        **together**, because they are one fact: setting the draw type without
        replacing the settings object beside it is how a round-robin row ends up
        carrying an ``rr-then-ko``'s qualifier count — and it is the edit path (draw
        type patched from ``rr-then-ko`` back to ``round-robin``) where that would
        happen. So ``settings`` is a **required** keyword here, unlike on
        :meth:`for_draw_type`: at create "no configuration" is the common case, at edit
        an omitted settings object is the bug this method exists to prevent.

        Copied into a plain ``dict`` on the way in, because the value the caller passes
        may be the shared :data:`NO_SETTINGS` proxy and the column's value belongs to
        this row alone.
        """
        self.draw_type = draw_type
        self.settings = dict(settings)

    @property
    def draw_type(self) -> DrawType:
        """The configured draw type, parsed back into the closed set the code
        dispatches on.

        A plain dict lookup on :data:`~app.models.draw_type.DRAW_TYPES_BY_ID`,
        keyed by ``draw_type_id`` — never a join or a relationship walk (ADR
        20260815 retired the join this used to make). Total on a transient,
        pending or freshly flushed row alike, and needs no loaded relationship
        and no lazy load, because it reads a plain column that is always
        present once the row exists. Raises ``KeyError`` on an id with no
        ``DrawType`` member — which the FK plus the seed-vs-enum migration test
        make unreachable, and which is the loud failure we want if they ever
        stop agreeing.
        """
        return DRAW_TYPES_BY_ID[self.draw_type_id]

    @draw_type.setter
    def draw_type(self, draw_type: DrawType) -> None:
        """The ONE place a :class:`DrawType` member becomes the persisted FK.

        Every writer goes through here, via :meth:`configure` above. Without a
        setter the edit path had to reach past the property and write
        ``draw_settings.draw_type_id = DRAW_TYPE_IDS[draw_type]`` itself, which
        gave enum→id conversion a second home to drift in and made the "ONE
        place" claim above false.

        Writes the column directly, from the fixed :data:`DRAW_TYPE_IDS` map
        (see that map's docstring for why this assignment has no session to do
        a lookup with).
        """
        self.draw_type_id = DRAW_TYPE_IDS[draw_type]
