"""Destructive HTTP actions preserve explicitly unknown advancement history."""

import pytest
from sqlalchemy import func, select

from app.advancement_decisions import advancement_history
from app.leagues import get_default_league
from app.models import (
    AdvancementDecision,
    DrawType,
    EventFormat,
    Match,
    MatchGame,
    MatchLineup,
    Tournament,
    TournamentEntry,
    TournamentEvent,
    TournamentEventStage,
    TournamentEventStageGroup,
    TournamentFixture,
)
from tests._helpers import event_draw_settings, start_session


async def seed_unknown_draw(api_client, db):
    actor = await start_session(api_client, db)
    league = await get_default_league(db)
    tournament = Tournament(
        name="Imported Open", league_id=league.id, created_by_user_id=actor.id
    )
    db.add(tournament)
    await db.flush()
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Singles",
        entry_fee=0,
        format=EventFormat.singles,
        draw_settings=event_draw_settings(DrawType.single_elim),
        timezone="America/Chicago",
        slot={"date": "2030-01-01", "start": "09:00", "end": "17:00"},
        match_settings={"rated": False, "length_games": 1},
    )
    db.add(event)
    await db.flush()
    stage = TournamentEventStage(event_id=event.id, position=0)
    stage.draw_type = DrawType.single_elim
    entry = TournamentEntry(event_id=event.id, user_id=actor.player_id)
    db.add_all([stage, entry])
    await db.flush()
    group = TournamentEventStageGroup(stage_id=stage.id, position=0)
    db.add(group)
    await db.flush()
    target = TournamentFixture(
        stage_id=stage.id, group_id=group.id, round=2, position=1, entry_a_id=entry.id
    )
    db.add(target)
    await db.flush()
    db.add(
        AdvancementDecision(
            fixture_id=target.id,
            side="a",
            entry_id=entry.id,
            rule_version="unknown",
            rule_settings={},
            evidence_count=0,
            unknown_reason="Imported bracket did not retain its results",
        )
    )
    await db.commit()
    for model in (Match, MatchGame, MatchLineup):
        assert await db.scalar(select(func.count()).select_from(model)) == 0
    fixtures = (await db.scalars(select(TournamentFixture))).all()
    assert all(f.match_id is None and f.winner_entry_id is None for f in fixtures)
    return event, target, {f.id for f in fixtures}


@pytest.mark.parametrize("method", ["delete", "post"])
async def test_replace_or_remove_draw_preserves_unknown_advancement(
    api_client, db_session, method
):
    event, target, fixture_ids = await seed_unknown_draw(api_client, db_session)
    response = await api_client.request(
        method, f"/v1/tournaments/{event.tournament_id}/events/{event.id}/draw"
    )
    assert response.status_code == 409, response.text
    assert "Advancement history must be preserved" in response.json()["detail"]
    (decision,) = await advancement_history(db_session, target.id, "a")
    assert decision.evidence_status == "unknown" and decision.current
    assert set(await db_session.scalars(select(TournamentFixture.id))) == fixture_ids


@pytest.mark.parametrize("parent", ["event", "tournament"])
async def test_delete_parent_preserves_unknown_advancement(
    api_client, db_session, parent
):
    event, target, fixture_ids = await seed_unknown_draw(api_client, db_session)
    url = f"/v1/tournaments/{event.tournament_id}"
    if parent == "event":
        url += f"/events/{event.id}"
    response = await api_client.delete(url)
    assert response.status_code == 409, response.text
    assert "Advancement history must be preserved" in response.json()["detail"]
    (decision,) = await advancement_history(db_session, target.id, "a")
    assert decision.evidence_status == "unknown" and decision.current
    assert set(await db_session.scalars(select(TournamentFixture.id))) == fixture_ids
