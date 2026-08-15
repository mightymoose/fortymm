import uuid
from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.tournament import DrawType

# Fixed ids, one per seeded slug — NOT ``gen_random_uuid()`` for these four rows,
# even though the column's own default (below) is. ``TournamentEventDrawSettings
# .draw_type``'s SETTER writes ``draw_type_id`` from a ``DrawType`` member as a
# plain, synchronous property assignment reached from dozens of call sites with no
# database session in scope — most of them test fixtures that build a whole
# ``TournamentEvent`` in one expression, and none of them can afford to become an
# async lookup. A fixed id per draw type is what keeps that assignment DB-free.
#
# This is the FIRST app-side seeded-id map in the codebase, not another instance of
# an existing pattern. Migration 0005's ``GLICKO2_STRATEGY_ID`` / ``MANUAL_STRATEGY_ID``
# are the closest-looking precedent, and they are NOT one: those two constants live
# only inside that migration's own module — nothing on the app side ever needs to
# write a ``rating_strategies`` id without a session, so no app-side copy of them
# exists. Migration 0010 hand-copies these literal uuids into its OWN seed ``INSERT``
# for the mirror-image reason — migrations cannot import app code, so the two copies
# cannot share a source and would drift silently with nothing to catch it.
# ``tests/test_draw_type_seed_migration.py`` is what pins them together: it migrates a
# real database with Alembic and asserts the seeded ids equal this map.
DRAW_TYPE_IDS: dict[DrawType, uuid.UUID] = {
    DrawType.round_robin: uuid.UUID("22222222-2222-2222-2222-222222220001"),
    DrawType.single_elim: uuid.UUID("22222222-2222-2222-2222-222222220002"),
    DrawType.rr_then_ko: uuid.UUID("22222222-2222-2222-2222-222222220003"),
    DrawType.swiss: uuid.UUID("22222222-2222-2222-2222-222222220004"),
}

DRAW_TYPES_BY_ID: dict[uuid.UUID, DrawType] = {
    draw_type_id: draw_type for draw_type, draw_type_id in DRAW_TYPE_IDS.items()
}
"""The reverse of :data:`DRAW_TYPE_IDS` — what
``TournamentEventDrawSettings.draw_type``'s GETTER reads.

A plain dict lookup on ``draw_type_id``, not a join through ``DrawTypeOption``: the
FK to ``draw_types.id`` is what already makes a settings row's ``draw_type_id``
trustworthy — no OTHER id is representable there — so a join back onto ``draw_types``
would only be re-proving what the schema already guarantees. Total on a transient,
pending or freshly flushed row alike, since it reads a plain column and never a
relationship, and needs no database session to do it — this is the read-direction
counterpart of why :data:`DRAW_TYPE_IDS` exists on the write side.
"""


class DrawTypeOption(Base):
    """Lookup row for one draw type — the DB backing for
    ``app.models.tournament.DrawType``.

    A row here means "this draw type has an implementation": the seed set is
    exactly the set ``app.draws.strategy_for`` can dispatch (ADR "a draw type is
    a seeded row, and the enum holds only what runs"). It is not a roadmap, so
    there is deliberately **no** ``is_active`` column — a type the product cannot
    run has no row at all, which is what lets the FK on the event's draw settings
    be the enforcement rather than decoration.

    ``id`` is a surrogate uuid primary key (ADR 20260815 "draw_types gains a
    surrogate id primary key"), and it — not ``key`` — is the FK target for
    ``tournament_event_draw_settings.draw_type_id``. This supersedes the
    slug-as-PK stance of the ADR that originally seeded this table: ``key``
    stays a UNIQUE NOT NULL slug, and code still resolves strategies and the
    ``DrawType`` enum by it — through :data:`DRAW_TYPES_BY_ID` on the settings
    row's ``draw_type`` getter, or a join elsewhere (e.g. the director-facing
    picker in ``app.tournament_queries``), never by ``id`` alone. Renaming a
    slug is therefore still a migration (both here and in :data:`DRAW_TYPE_IDS`),
    even though it is no longer a primary-key change.

    The enum stays the code source of truth (validation + OpenAPI values); this
    table carries the display copy — ``name`` / ``description`` /
    ``display_order`` — that the draw-type picker renders, so adding a draw type
    needs no client change.

    Named ``DrawTypeOption`` rather than ``DrawType`` only because the enum of
    that name is already exported from ``app.models``.
    """

    __tablename__ = "draw_types"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    # UNIQUE, not the primary key (ADR 20260815) — the FK target moved to ``id``, but
    # this is still the only spelling ``DrawType`` binds on, so changing it is still a
    # migration, and no two rows may claim the same slug.
    key: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    # NOT NULL, unlike the ``notification_types`` / ``rating_strategies``
    # precedents: every row is rendered in the director's picker as label + help
    # text, so a description-less option is a state no surface can display well.
    description: Mapped[str] = mapped_column(Text, nullable=False)
    display_order: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
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
