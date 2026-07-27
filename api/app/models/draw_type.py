from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class DrawTypeOption(Base):
    """Lookup row for one draw type — the DB backing for
    ``app.models.tournament.DrawType``.

    A row here means "this draw type has an implementation": the seed set is
    exactly the set ``app.draws.strategy_for`` can dispatch (ADR "a draw type is
    a seeded row, and the enum holds only what runs"). It is not a roadmap, so
    there is deliberately **no** ``is_active`` column — a type the product cannot
    run has no row at all, which is what lets the FK on the event's draw settings
    be the enforcement rather than decoration.

    The enum stays the code source of truth (validation + OpenAPI values); this
    table carries the display copy — ``name`` / ``description`` /
    ``display_order`` — that the draw-type picker renders, so adding a draw type
    needs no client change.

    Named ``DrawTypeOption`` rather than ``DrawType`` only because the enum of
    that name is already exported from ``app.models``.
    """

    __tablename__ = "draw_types"

    # The slug is the primary key, and the FK target for
    # ``tournament_event_draw_settings.draw_type_key``. Changing a slug is
    # therefore a migration — the friction we want, since the slug is what binds
    # this table to ``DrawType`` members and to both generated clients.
    key: Mapped[str] = mapped_column(String(32), primary_key=True)
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
