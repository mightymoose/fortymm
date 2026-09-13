"""Retained reconciliation assertions produce the domain deletion refusal."""

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Tournament, User
from app.tournament_errors import RecordedPlayDeletionError
from app.tournament_events import delete_event
from tests.test_match_calls import _make_tournament


async def test_unstarted_event_with_retained_assertion_refuses_deletion(
    db_session: AsyncSession,
) -> None:
    tournament_id, event_id = await _make_tournament(db_session)
    tournament = await db_session.get(Tournament, tournament_id)
    assert tournament is not None
    owner = await db_session.get(User, tournament.created_by_user_id)
    assert owner is not None
    # SQL maintenance can explicitly assert an unchanged, incomplete projection.
    await db_session.execute(
        text(
            "INSERT INTO tournament_event_reconciliations "
            "(event_id,transaction_id,lifecycle_state,lifecycle_version) "
            "SELECT id,pg_current_xact_id()::text::bigint,lifecycle_state,"
            "lifecycle_version FROM tournament_events WHERE id=:id"
        ),
        {"id": event_id},
    )
    await db_session.commit()
    with pytest.raises(RecordedPlayDeletionError, match="reconciliation history"):
        await delete_event(
            db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
        )
