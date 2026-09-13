"""Result-derived event states require an explicit reconciliation assertion."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.event_lifecycle import reconcile_event
from app.match_scoring import enter_game_score
from tests._helpers import directed_tournament_match


@pytest.mark.parametrize("with_play", [False, True])
async def test_sql_finish_requires_reconciliation(db_session, with_play):
    match, director = await directed_tournament_match(
        db_session, tag="sql-finish-assertion", best_of=3, rated=False
    )
    if with_play:
        await enter_game_score(
            db_session,
            match.id,
            director.id,
            game_number=1,
            side_1_points=11,
            side_2_points=5,
        )
    event_id = await db_session.scalar(
        text("SELECT scope_event_id FROM tournament_fixtures WHERE match_id=:id"),
        {"id": match.id},
    )
    statement = text(
        "UPDATE tournament_events SET lifecycle_state='finished' WHERE id=:id"
    )
    with pytest.raises(IntegrityError, match="requires event reconciliation"):
        async with db_session.begin_nested():
            await db_session.execute(statement, {"id": event_id})
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    await db_session.execute(statement, {"id": event_id})
    await reconcile_event(db_session, event_id)
    await db_session.commit()
    assert (
        await db_session.scalar(
            text("SELECT lifecycle_state FROM tournament_events WHERE id=:id"),
            {"id": event_id},
        )
        == "in_progress"
    )
