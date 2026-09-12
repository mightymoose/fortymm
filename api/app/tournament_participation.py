"""Registration and competition lifecycles behind the existing tournament verbs.

Callers hold the tournament lock and own the transaction. Closing registration
never changes membership or rewrites any fixture's sporting identity.
"""

import uuid
from collections.abc import Collection

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.tournament_entry import TournamentEntry
from app.models.tournament_entry_participation import (
    TournamentEntryParticipation,
)
from app.models.tournament_entry_participation import (
    WithdrawalReason as WithdrawalReason,
)
from app.models.tournament_entry_registration import TournamentEntryRegistration
from app.models.tournament_entry_withdrawal import TournamentEntryWithdrawal


async def close_entry_participation(
    db: AsyncSession,
    entry_id: uuid.UUID,
    actor_account_id: uuid.UUID,
    reason: WithdrawalReason,
    explanation: str | None = None,
) -> None:
    await db.execute(
        update(TournamentEntryParticipation)
        .where(
            TournamentEntryParticipation.entry_id == entry_id,
            TournamentEntryParticipation.ended_at.is_(None),
        )
        .values(
            ended_at=func.clock_timestamp(),
            ended_by_account_id=actor_account_id,
            end_reason=reason.value,
            end_explanation=explanation,
        )
    )


async def close_registration(
    db: AsyncSession,
    entry_id: uuid.UUID,
    actor_account_id: uuid.UUID,
    reason: WithdrawalReason,
    explanation: str | None = None,
) -> None:
    await db.execute(
        update(TournamentEntryRegistration)
        .where(
            TournamentEntryRegistration.entry_id == entry_id,
            TournamentEntryRegistration.withdrawn_at.is_(None),
        )
        .values(
            withdrawn_at=func.clock_timestamp(),
            withdrawn_by_account_id=actor_account_id,
            withdrawal_reason=reason.value,
            withdrawal_explanation=explanation,
        )
    )
    await withdraw_competition(
        db, entry_id, actor_account_id, reason, explanation=explanation
    )


async def withdraw_competition(
    db: AsyncSession,
    entry_id: uuid.UUID,
    actor_account_id: uuid.UUID,
    reason: WithdrawalReason,
    *,
    stage_id: uuid.UUID | None = None,
    explanation: str | None = None,
) -> None:
    existing = await db.scalar(
        select(TournamentEntryWithdrawal.id).where(
            TournamentEntryWithdrawal.entry_id == entry_id,
            TournamentEntryWithdrawal.stage_id == stage_id,
            TournamentEntryWithdrawal.restored_at.is_(None),
        )
    )
    if existing is None:
        event_id = await db.scalar(
            select(TournamentEntry.event_id).where(TournamentEntry.id == entry_id)
        )
        if event_id is None:
            raise ValueError("Competition withdrawal requires an existing entry")
        db.add(
            TournamentEntryWithdrawal(
                event_id=event_id,
                entry_id=entry_id,
                stage_id=stage_id,
                actor_account_id=actor_account_id,
                reason=reason,
                explanation=explanation,
            )
        )
    if stage_id is None:
        await close_entry_participation(
            db, entry_id, actor_account_id, reason, explanation
        )
    else:
        await db.execute(
            update(TournamentEntryParticipation)
            .where(
                TournamentEntryParticipation.entry_id == entry_id,
                TournamentEntryParticipation.stage_id == stage_id,
                TournamentEntryParticipation.ended_at.is_(None),
            )
            .values(
                ended_at=func.clock_timestamp(),
                ended_by_account_id=actor_account_id,
                end_reason=reason.value,
                end_explanation=explanation,
            )
        )


async def restore_event_eligibility(
    db: AsyncSession, entry_id: uuid.UUID, actor_account_id: uuid.UUID
) -> None:
    await db.execute(
        update(TournamentEntryWithdrawal)
        .where(
            TournamentEntryWithdrawal.entry_id == entry_id,
            TournamentEntryWithdrawal.stage_id.is_(None),
            TournamentEntryWithdrawal.restored_at.is_(None),
        )
        .values(
            restored_at=func.clock_timestamp(), restored_by_account_id=actor_account_id
        )
    )


async def complete_stage_participation(
    db: AsyncSession, stage_ids: Collection[uuid.UUID]
) -> None:
    if not stage_ids:
        return
    await db.execute(
        update(TournamentEntryParticipation)
        .where(
            TournamentEntryParticipation.stage_id.in_(stage_ids),
            TournamentEntryParticipation.ended_at.is_(None),
        )
        .values(ended_at=func.clock_timestamp(), end_reason="stage_completed")
    )
