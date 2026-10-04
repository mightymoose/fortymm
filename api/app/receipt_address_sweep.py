"""Daily cleanup of receipt addresses (#1810).

A receipt address is erased 30 days after the tournament's end milestone. Run
with ``python -m app.receipt_address_sweep``. The sweep is idempotent: a second
run finds nothing left to erase.
"""

import asyncio
import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db import get_engine
from app.models import (
    EventLifecycleHistory,
    EventLifecycleState,
    Tournament,
    TournamentCheckout,
    TournamentEvent,
    TournamentPayment,
    TournamentPaymentRefundObligation,
)
from app.receipt_addresses import UNSETTLED_PAYMENT_STATUSES, erase_receipt_address
from app.tournament_authority import lock_tournament

logger = logging.getLogger(__name__)

#: How long an address outlives the tournament's end milestone (#1765).
RETENTION = timedelta(days=30)

_TERMINAL_STATES = (EventLifecycleState.finished, EventLifecycleState.cancelled)


async def _completion_milestone(
    db: AsyncSession, tournament_id: uuid.UUID
) -> datetime | None:
    """The tournament is complete when it has events and every one is finished
    or cancelled right now. Its milestone is the latest time the database
    observed an event enter one of those states. A reopened event ends
    completion, so a recheck at sweep time sees the new state."""
    events = (
        await db.execute(
            select(
                func.count(TournamentEvent.id),
                func.count(TournamentEvent.id).filter(
                    TournamentEvent.lifecycle_state.in_(_TERMINAL_STATES)
                ),
            ).where(TournamentEvent.tournament_id == tournament_id)
        )
    ).one()
    total, terminal = events
    if total == 0 or total != terminal:
        return None
    latest: datetime | None = await db.scalar(
        select(func.max(EventLifecycleHistory.observed_at))
        .join(TournamentEvent, TournamentEvent.id == EventLifecycleHistory.event_id)
        .where(
            TournamentEvent.tournament_id == tournament_id,
            EventLifecycleHistory.to_state.in_(_TERMINAL_STATES),
        )
    )
    return latest


async def _end_milestone(db: AsyncSession, tournament_id: uuid.UUID) -> datetime | None:
    """The earlier of archival and completion, as the database observed them.
    ``None`` while neither has happened."""
    archived = await db.scalar(
        select(Tournament.archive_observed_at).where(Tournament.id == tournament_id)
    )
    completed = await _completion_milestone(db, tournament_id)
    reached = [moment for moment in (archived, completed) if moment is not None]
    return min(reached) if reached else None


async def _payments_are_resolved(db: AsyncSession, tournament_id: uuid.UUID) -> bool:
    """Every payment of the tournament is terminal, owes no refund, and hides
    none behind an unverified amount. A quarantine that captured nothing owes
    nothing. Callers hold the tournament lock, the one reconciliation takes
    before it records a refund."""
    owes = await db.scalar(
        select(TournamentPayment.id)
        .outerjoin(
            TournamentPaymentRefundObligation,
            TournamentPaymentRefundObligation.payment_id == TournamentPayment.id,
        )
        .where(
            TournamentPayment.tournament_id == tournament_id,
            or_(
                TournamentPaymentRefundObligation.id.is_not(None),
                TournamentPayment.amount_unverified.is_(True),
                TournamentPayment.status.in_(UNSETTLED_PAYMENT_STATUSES),
            ),
        )
        .limit(1)
    )
    return owes is None


async def sweep_receipt_addresses(
    db: AsyncSession, *, now: datetime | None = None
) -> int:
    """Erase every receipt address that is due. Returns how many checkouts
    lost one. Commits once per tournament, and logs only that count."""
    now = now or datetime.now(UTC)
    tournament_ids = list(
        await db.scalars(
            select(TournamentCheckout.tournament_id)
            .where(TournamentCheckout.receipt_address.is_not(None))
            .distinct()
        )
    )
    erased = 0
    for tournament_id in tournament_ids:
        # Reconciliation takes this lock before it records a refund or admits a
        # late success. Holding it across the check and every erase means no
        # refund can appear between them, and a partial sweep cannot happen.
        await lock_tournament(db, tournament_id)
        milestone = await _end_milestone(db, tournament_id)
        if (
            milestone is None
            or now < milestone + RETENTION
            or not await _payments_are_resolved(db, tournament_id)
        ):
            await db.rollback()
            continue
        checkout_ids = list(
            await db.scalars(
                select(TournamentCheckout.id)
                .where(
                    TournamentCheckout.tournament_id == tournament_id,
                    TournamentCheckout.receipt_address.is_not(None),
                )
                .order_by(TournamentCheckout.id)
            )
        )
        for checkout_id in checkout_ids:
            if await erase_receipt_address(
                db, checkout_id=checkout_id, only_if_resolved=True
            ):
                erased += 1
        await db.commit()
    logger.info("Receipt-address sweep: erased %d addresses", erased)
    return erased


def run_receipt_address_sweep() -> None:
    asyncio.run(_run_receipt_address_sweep())


async def _run_receipt_address_sweep() -> None:
    sessionmaker = async_sessionmaker(get_engine(), expire_on_commit=False)
    async with sessionmaker() as db:
        await sweep_receipt_addresses(db)


def main() -> None:
    run_receipt_address_sweep()


if __name__ == "__main__":
    main()
