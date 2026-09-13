"""SQL cannot start new matches after their event is cancelled."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.event_lifecycle import cancel_event
from app.models import Tournament, User
from app.tournament_materialization import materialize_live_draw
from tests.test_match_calls import _make_tournament, _the_fixture


@pytest.mark.parametrize(
    "statement,reason",
    [
        ("UPDATE matches SET status='in_progress' WHERE id=:id", "start matches"),
        ("INSERT INTO match_lineups (match_id) VALUES (:id)", "record a first lineup"),
    ],
)
async def test_cancelled_event_rejects_new_call_evidence(db_session, statement, reason):
    tournament_id, event_id = await _make_tournament(db_session)
    tournament = await db_session.get(Tournament, tournament_id)
    await materialize_live_draw(db_session, tournament)
    fixture = await _the_fixture(db_session, event_id)
    assert fixture.match_id is not None
    owner = await db_session.get(User, tournament.owner_account_id)
    await cancel_event(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    await db_session.commit()
    with pytest.raises(IntegrityError, match=f"cancelled events cannot {reason}"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(statement),
                {"id": fixture.match_id},
            )
