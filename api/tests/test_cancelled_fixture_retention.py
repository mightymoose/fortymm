"""Cancellation retains even fixtures with no recorded play."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.event_lifecycle import cancel_event
from app.match_creation import create_match
from app.models import Tournament, TournamentEntry, User
from tests.test_match_calls import _make_tournament, _the_fixture


@pytest.mark.parametrize("operation", ["delete", "detach"])
async def test_cancelled_event_retains_unplayed_fixture(db_session, operation):
    tournament_id, event_id = await _make_tournament(db_session)
    fixture = await _the_fixture(db_session, event_id)
    a = await db_session.get(TournamentEntry, fixture.entry_a_id)
    b = await db_session.get(TournamentEntry, fixture.entry_b_id)
    player = await db_session.get(User, a.user_id)
    match = await create_match(
        db_session,
        creator=player,
        opponent_user_id=b.user_id,
        league_id=None,
        best_of=3,
        rated=False,
    )
    fixture.match_id = match.id
    await db_session.commit()
    tournament = await db_session.get(Tournament, tournament_id)
    owner = await db_session.get(User, tournament.created_by_user_id)
    await cancel_event(
        db_session,
        tournament_id=tournament_id,
        event_id=event_id,
        actor=owner,
    )
    await db_session.commit()
    statement = (
        "DELETE FROM tournament_fixtures WHERE id=:id"
        if operation == "delete"
        else "UPDATE tournament_fixtures SET match_id=NULL WHERE id=:id"
    )
    with pytest.raises(
        IntegrityError, match="cancelled event fixture must be retained"
    ):
        async with db_session.begin_nested():
            await db_session.execute(text(statement), {"id": fixture.id})
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
