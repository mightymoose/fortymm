import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKeyConstraint,
    Index,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class VenueTableOutage(Base):
    """A period when one tournament table is unavailable across all reservations.

    An outage is historical state on the stable table identity. Restore closes the
    active period; reservation memberships are independent and remain untouched.
    """

    __tablename__ = "tournament_table_outages"
    __table_args__ = (
        CheckConstraint(
            "effective_until IS NULL OR effective_until > effective_from",
            name="ck_tournament_table_outages_effective_interval",
        ),
        ForeignKeyConstraint(
            ["tournament_id", "table_id"],
            ["tournament_tables.tournament_id", "tournament_tables.id"],
            name="fk_tournament_table_outages_tournament_id_table_id",
            ondelete="CASCADE",
        ),
        Index(
            "uq_tournament_table_outages_active_table",
            "tournament_id",
            "table_id",
            unique=True,
            postgresql_where=text("effective_until IS NULL"),
        ),
        Index(
            "ix_tournament_table_outages_tournament_id_table_id",
            "tournament_id",
            "table_id",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    tournament_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    table_id: Mapped[str] = mapped_column(UUID(as_uuid=False), nullable=False)
    effective_from: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )
    effective_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
