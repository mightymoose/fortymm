"""Direct SQL cannot rewrite a cancelled event's retained placement."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.event_lifecycle import cancel_event
from app.models import Tournament, User
from tests.test_match_calls import BASE, _make_tournament, _place_fixture


@pytest.mark.parametrize(
    "change", ["table_id=NULL", "scheduled_start=NULL", "pinned_at=clock_timestamp()"]
)
async def test_cancelled_event_retains_placement(db_session, change):
    tournament_id, event_id = await _make_tournament(db_session)
    fixture_id = await _place_fixture(db_session, event_id, table_id="t1", start=BASE)
    tournament = await db_session.get(Tournament, tournament_id)
    owner = await db_session.get(User, tournament.owner_account_id)
    await cancel_event(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    await db_session.commit()
    with pytest.raises(
        IntegrityError, match="cancelled event fixture must be retained"
    ):
        async with db_session.begin_nested():
            await db_session.execute(
                text(f"UPDATE tournament_fixtures SET {change} WHERE id=:id"),
                {"id": fixture_id},
            )
