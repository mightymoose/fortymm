"""Terminal fixture result inputs invalidate earlier progress assertions."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.event_lifecycle import reconcile_event
from app.match_creation import create_match
from app.models import TournamentEntry, User
from tests.test_match_calls import _make_tournament, _the_fixture


@pytest.mark.parametrize(
    "change", ["entry_a_id=NULL", "entry_b_id=NULL", "round=round+1"]
)
async def test_terminal_fixture_inputs_require_reconciliation(
    db_session: AsyncSession, change: str
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
    await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
        == "finished"
    )
    statement = text("UPDATE tournament_fixtures SET " + change + " WHERE id=:id")
    with pytest.raises(IntegrityError, match="requires event reconciliation"):
        async with db_session.begin_nested():
            await reconcile_event(db_session, event_id)
            await db_session.execute(statement, {"id": fixture.id})
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    await db_session.execute(statement, {"id": fixture.id})
    await reconcile_event(db_session, event_id)
    await db_session.commit()
    assert await db_session.scalar(
        text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
        {"id": event_id},
    ) == ("finished" if change.startswith("round") else "in_progress")
