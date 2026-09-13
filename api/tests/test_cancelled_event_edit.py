"""Cancelled event edits refuse before changing retained placements."""

from datetime import UTC, datetime

from sqlalchemy import select

from app.event_lifecycle import cancel_event
from app.models import TournamentFixture
from tests._helpers import start_session
from tests.test_tournament_events import _add_cut_event, _make_tournament


async def test_cancelled_event_timezone_patch_returns_conflict_without_changes(
    api_client, db_session, default_league
):
    owner = await start_session(api_client, db_session)
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    placed_at = datetime(2026, 6, 13, 23, tzinfo=UTC)
    event = await _add_cut_event(db_session, tournament, scheduled_start=placed_at)
    await cancel_event(
        db_session, tournament_id=tournament.id, event_id=event.id, actor=owner
    )
    await db_session.commit()
    version = event.lock_version
    response = await api_client.patch(
        f"/v1/tournaments/{tournament.id}/events/{event.id}",
        json={"timezone": "America/Denver", "lock_version": version},
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "A cancelled event cannot be edited."
    await db_session.refresh(event)
    fixture = await db_session.scalar(
        select(TournamentFixture).where(TournamentFixture.scope_event_id == event.id)
    )
    assert event.timezone == "America/Chicago"
    assert event.lock_version == version
    assert fixture.scheduled_start == placed_at
