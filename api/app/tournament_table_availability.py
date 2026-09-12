"""Record service intervals for a tournament's stable venue tables.

An outage applies to the table across every event and reservation. It is independent
from reservation membership and fixture placement, so marking or restoring a table
never rewrites either one.
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import VenueTable, VenueTableOutage

__all__ = ["mark_table_out_of_service", "restore_table"]


async def mark_table_out_of_service(
    db: AsyncSession, *, tournament_id: uuid.UUID, table_id: str
) -> VenueTableOutage:
    """Open an outage for a table, or return its already-open outage.

    Locking the stable table serializes concurrent service-state changes and also
    verifies the table belongs to this tournament. The caller owns the transaction.
    """
    table = await db.scalar(
        select(VenueTable)
        .where(
            VenueTable.tournament_id == tournament_id,
            VenueTable.id == uuid.UUID(table_id),
            VenueTable.retired_at.is_(None),
        )
        .with_for_update()
    )
    if table is None:
        raise ValueError("Table does not belong to this tournament.")

    active = await db.scalar(
        select(VenueTableOutage).where(
            VenueTableOutage.tournament_id == tournament_id,
            VenueTableOutage.table_id == table_id,
            VenueTableOutage.effective_until.is_(None),
        )
    )
    if active is not None:
        return active

    outage = VenueTableOutage(tournament_id=tournament_id, table_id=table_id)
    db.add(outage)
    await db.flush()
    return outage


async def restore_table(
    db: AsyncSession, *, tournament_id: uuid.UUID, table_id: str
) -> VenueTableOutage:
    """Close the table's active outage while preserving its history and identity."""
    table = await db.scalar(
        select(VenueTable)
        .where(
            VenueTable.tournament_id == tournament_id,
            VenueTable.id == uuid.UUID(table_id),
            VenueTable.retired_at.is_(None),
        )
        .with_for_update()
    )
    if table is None:
        raise ValueError("Table does not belong to this tournament.")

    outage = await db.scalar(
        select(VenueTableOutage)
        .where(
            VenueTableOutage.tournament_id == tournament_id,
            VenueTableOutage.table_id == table_id,
            VenueTableOutage.effective_until.is_(None),
        )
        .with_for_update()
    )
    if outage is None:
        raise ValueError("Table has no active outage.")

    now = datetime.now(UTC)
    outage.effective_until = max(now, outage.effective_from + timedelta(microseconds=1))
    await db.flush()
    return outage
