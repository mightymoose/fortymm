"""Deleting a terminal match preserves its event reconciliation obligation."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.event_lifecycle import reconcile_event
from app.match_creation import create_match
from app.models import TournamentEntry, User
from tests.test_match_calls import _make_tournament, _the_fixture


@pytest.mark.parametrize("same_transaction", [False, True])
async def test_deleted_completed_match_requires_event_reconciliation(
    db_session: AsyncSession, same_transaction: bool
) -> None:
    _, event_id = await _make_tournament(db_session)
    fixture = await _the_fixture(db_session, event_id)
    entry_a = await db_session.get(TournamentEntry, fixture.entry_a_id)
    entry_b = await db_session.get(TournamentEntry, fixture.entry_b_id)
    assert entry_a is not None and entry_b is not None
    player = await db_session.get(User, entry_a.user_id)
    assert player is not None
    match = await create_match(
        db_session,
        creator=player,
        opponent_user_id=entry_b.user_id,
        league_id=None,
        best_of=1,
        rated=False,
    )
    await db_session.execute(
        text(
            "UPDATE matches SET status='completed', ending='walkover', "
            "completed_at=clock_timestamp() WHERE id=:id"
        ),
        {"id": match.id},
    )
    fixture.match_id = match.id
    await reconcile_event(db_session, event_id)
    if not same_transaction:
        await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
        == "finished"
    )
    statement = text("DELETE FROM matches WHERE id=:id")
    with pytest.raises(IntegrityError, match="requires event reconciliation"):
        async with db_session.begin_nested():
            await db_session.execute(statement, {"id": match.id})
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    await db_session.execute(statement, {"id": match.id})
    await reconcile_event(db_session, event_id)
    await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
        == "in_progress"
    )
    assert (
        await db_session.scalar(
            text("SELECT match_id FROM tournament_fixtures WHERE id=:id"),
            {"id": fixture.id},
        )
        is None
    )
