"""Lifecycle intervals use PostgreSQL time even when an API clock lags."""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app import tournament_participation
from app.models import (
    TournamentEntry,
    TournamentEntryParticipation,
    TournamentEntryRegistration,
    TournamentEntryStatus,
)
from app.tournament_participation import WithdrawalReason, close_registration
from tests.test_draw_history_integrity import drawn_history as drawn_history


class _LaggingClock:
    @staticmethod
    def now(tz: object = None) -> datetime:
        return datetime(2000, 1, 1, tzinfo=UTC)


async def test_registration_withdrawal_uses_database_clock(
    db_session: AsyncSession,
    drawn_history: dict[str, uuid.UUID],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    participation = await db_session.get(
        TournamentEntryParticipation, drawn_history["participation_id"]
    )
    assert participation is not None
    entry_id = participation.entry_id
    db_session.add(
        TournamentEntryRegistration(
            entry_id=entry_id, registered_by_account_id=drawn_history["owner_id"]
        )
    )
    await db_session.flush()
    monkeypatch.setattr(
        tournament_participation, "datetime", _LaggingClock, raising=False
    )

    await close_registration(
        db_session,
        entry_id,
        drawn_history["owner_id"],
        WithdrawalReason.director_removal,
    )
    await db_session.execute(
        update(TournamentEntry)
        .where(TournamentEntry.id == entry_id)
        .values(status=TournamentEntryStatus.withdrawn)
    )
    await db_session.commit()

    registration = await db_session.scalar(
        select(TournamentEntryRegistration).where(
            TournamentEntryRegistration.entry_id == entry_id
        )
    )
    assert registration is not None
    assert registration.withdrawn_at is not None
    assert registration.withdrawn_at >= registration.registered_at
    await db_session.refresh(participation)
    assert participation.ended_at is not None
    assert participation.ended_at >= participation.started_at


@pytest.mark.parametrize("transition", ["stage_withdrawal", "completion"])
async def test_participation_end_uses_database_clock(
    db_session: AsyncSession,
    drawn_history: dict[str, uuid.UUID],
    monkeypatch: pytest.MonkeyPatch,
    transition: str,
) -> None:
    participation = await db_session.get(
        TournamentEntryParticipation, drawn_history["participation_id"]
    )
    assert participation is not None
    monkeypatch.setattr(
        tournament_participation, "datetime", _LaggingClock, raising=False
    )
    if transition == "stage_withdrawal":
        await tournament_participation.withdraw_competition(
            db_session,
            participation.entry_id,
            drawn_history["owner_id"],
            WithdrawalReason.director_removal,
            stage_id=participation.stage_id,
        )
    else:
        await tournament_participation.complete_stage_participation(
            db_session, [participation.stage_id]
        )
    await db_session.commit()
    await db_session.refresh(participation)
    assert participation.ended_at is not None
    assert participation.ended_at >= participation.started_at


async def test_eligibility_restoration_uses_database_clock(
    db_session: AsyncSession,
    drawn_history: dict[str, uuid.UUID],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.models import TournamentEntryWithdrawal

    participation = await db_session.get(
        TournamentEntryParticipation, drawn_history["participation_id"]
    )
    assert participation is not None
    entry_id = participation.entry_id
    await tournament_participation.withdraw_competition(
        db_session,
        entry_id,
        drawn_history["owner_id"],
        WithdrawalReason.director_removal,
    )
    await db_session.commit()
    monkeypatch.setattr(
        tournament_participation, "datetime", _LaggingClock, raising=False
    )

    await tournament_participation.restore_event_eligibility(
        db_session, entry_id, drawn_history["owner_id"]
    )
    await db_session.commit()

    withdrawal = await db_session.scalar(
        select(TournamentEntryWithdrawal).where(
            TournamentEntryWithdrawal.entry_id == entry_id
        )
    )
    assert withdrawal is not None
    assert withdrawal.restored_at is not None
    assert withdrawal.restored_at >= withdrawal.withdrawn_at


async def test_stage_retirement_uses_database_clock(
    db_session: AsyncSession,
    drawn_history: dict[str, uuid.UUID],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from sqlalchemy import text

    from app import tournament_event_stages
    from tests.test_draw_history_integrity import _uncut

    monkeypatch.setattr(
        tournament_event_stages, "datetime", _LaggingClock, raising=False
    )
    await _uncut(db_session, drawn_history)
    stage = (
        await db_session.execute(
            text(
                "SELECT s.created_at, s.retired_at, "
                "r.retired_at AS revision_retired_at "
                "FROM tournament_fixtures f "
                "JOIN tournament_event_stages s ON s.id=f.stage_id "
                "JOIN tournament_draw_revisions r ON r.id=f.draw_revision_id "
                "WHERE f.id=:id"
            ),
            {"id": drawn_history["fixture_id"]},
        )
    ).one()
    assert stage.retired_at is not None
    assert stage.retired_at >= stage.created_at
    assert stage.retired_at >= stage.revision_retired_at
