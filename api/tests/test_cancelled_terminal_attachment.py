"""Cancellation rejects new terminal results even without game scores."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.event_lifecycle import cancel_event, reconcile_event
from app.match_creation import create_match
from app.models import TournamentEntry, User
from tests.test_match_calls import _make_tournament, _the_fixture


@pytest.mark.parametrize("status", ["completed", "voided"])
async def test_cancelled_event_rejects_new_scoreless_terminal_attachment(
    db_session, status
):
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
        best_of=1,
        rated=False,
    )
    await db_session.execute(
        text(
            "UPDATE matches SET status=:status, ending='walkover', "
            "completed_at=clock_timestamp() WHERE id=:id"
        ),
        {"status": status, "id": match.id},
    )
    await db_session.commit()
    from app.models import Tournament

    tournament = await db_session.get(Tournament, tournament_id)
    owner = await db_session.get(User, tournament.created_by_user_id)
    await cancel_event(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    await db_session.commit()
    with pytest.raises(IntegrityError, match="cancelled events cannot attach"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_fixtures SET match_id=:match WHERE id=:fixture"
                ),
                {"match": match.id, "fixture": fixture.id},
            )
            await reconcile_event(db_session, event_id)
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
