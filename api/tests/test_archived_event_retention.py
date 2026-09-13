"""Archive retains unplayed child events as well as the tournament itself."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import League, TournamentStatus
from app.tournament_errors import RecordedPlayDeletionError
from app.tournament_events import delete_event
from tests._helpers import make_user
from tests.test_tournament_lifecycle import _make_tournament_at, _one_event


@pytest.mark.parametrize("writer", ["domain", "sql_delete", "sql_reparent"])
async def test_archive_preserves_unstarted_event(
    db_session: AsyncSession, default_league: League, writer: str
) -> None:
    owner = await make_user(db_session, "archived-child-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.archived,
        with_event=True,
    )
    event = await _one_event(db_session, tournament.id)
    if writer == "domain":
        with pytest.raises(RecordedPlayDeletionError, match="Archive history"):
            await delete_event(
                db_session, tournament_id=tournament.id, event_id=event.id, actor=owner
            )
    else:
        target = await _make_tournament_at(
            db_session, owner=owner, league=default_league, status=TournamentStatus.live
        )
        if writer == "sql_reparent":
            await db_session.execute(
                text(
                    "DELETE FROM tournament_event_reservation_tables WHERE event_id=:id"
                ),
                {"id": event.id},
            )
            await db_session.commit()
        statement = (
            "DELETE FROM tournament_events WHERE id=:id"
            if writer == "sql_delete"
            else "UPDATE tournament_events SET tournament_id=:target WHERE id=:id"
        )
        with pytest.raises(IntegrityError, match="archive history"):
            async with db_session.begin_nested():
                await db_session.execute(
                    text(statement), {"id": event.id, "target": target.id}
                )
                await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
