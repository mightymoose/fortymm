"""Archived tournament composition cannot acquire new events."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.models import TournamentStatus
from app.tournament_errors import TournamentArchivedError
from app.tournament_events import create_event
from tests._helpers import make_user
from tests.test_tournament_events import _add_event, _event_payload, _make_tournament


@pytest.mark.parametrize("writer", ["domain", "sql_insert", "sql_move"])
async def test_archived_parent_rejects_event_additions(
    db_session, default_league, writer
):
    owner = await make_user(db_session, "archived-event-addition")
    target = await _make_tournament(db_session, owner=owner, league=default_league)
    target.status = TournamentStatus.archived
    await db_session.commit()
    if writer == "domain":
        with pytest.raises(TournamentArchivedError, match="archived tournament"):
            await create_event(
                db_session,
                tournament_id=target.id,
                actor=owner,
                payload=_event_payload(),
            )
    elif writer == "sql_insert":
        with pytest.raises(IntegrityError, match="archived tournament"):
            await _add_event(db_session, target)
    else:
        source = await _make_tournament(db_session, owner=owner, league=default_league)
        event = await _add_event(db_session, source)
        with pytest.raises(IntegrityError, match="archived tournament"):
            async with db_session.begin_nested():
                await db_session.execute(
                    text(
                        "UPDATE tournament_events SET tournament_id=:target "
                        "WHERE id=:id"
                    ),
                    {"target": target.id, "id": event.id},
                )
                await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_archived_event_creation_returns_http_conflict(
    api_client, db_session, default_league
):
    from tests._helpers import start_session
    from tests.test_tournament_events import _event_body

    owner = await start_session(api_client, db_session)
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament.status = TournamentStatus.archived
    await db_session.commit()
    response = await api_client.post(
        f"/v1/tournaments/{tournament.id}/events", json=_event_body()
    )
    assert response.status_code == 409
    assert (
        response.json()["detail"] == "An archived tournament cannot accept new events."
    )
