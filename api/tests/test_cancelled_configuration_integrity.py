"""SQL preserves the configuration retained by terminal cancellation."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.event_lifecycle import cancel_event
from app.models import Tournament, User
from tests.test_match_calls import _make_tournament


@pytest.mark.parametrize("change", ["name='Rewritten'", "timezone='America/Denver'"])
async def test_cancelled_event_configuration_is_immutable(db_session, change):
    tournament_id, event_id = await _make_tournament(db_session)
    tournament = await db_session.get(Tournament, tournament_id)
    owner = await db_session.get(User, tournament.owner_account_id)
    await cancel_event(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=owner
    )
    await db_session.commit()
    with pytest.raises(
        IntegrityError, match="cancelled event configuration is immutable"
    ):
        async with db_session.begin_nested():
            await db_session.execute(
                text(f"UPDATE tournament_events SET {change} WHERE id=:id"),
                {"id": event_id},
            )
