"""Result strategies cannot change beneath a stored event projection."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.event_lifecycle import reconcile_event
from app.match_creation import create_match
from app.models import TournamentEntry, User
from tests.test_match_calls import _make_tournament, _the_fixture


@pytest.mark.parametrize("scope", ["event", "stage"])
async def test_result_strategy_change_requires_reconciliation(db_session, scope):
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
    if scope == "event":
        statement = text(
            "UPDATE tournament_events SET draw_type_id="
            "(SELECT id FROM draw_types WHERE key='rr-then-ko') WHERE id=:id"
        )
        target = event_id
    else:
        statement = text(
            "UPDATE tournament_event_stages SET draw_type_id="
            "(SELECT id FROM draw_types WHERE key='single-elim') WHERE id=:id"
        )
        target = fixture.stage_id
    with pytest.raises(IntegrityError, match="requires event reconciliation"):
        async with db_session.begin_nested():
            await db_session.execute(statement, {"id": target})
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    await db_session.execute(statement, {"id": target})
    await reconcile_event(db_session, event_id)
    await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
        == "in_progress"
    )
