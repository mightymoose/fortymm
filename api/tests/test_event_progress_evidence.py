"""Direct SQL must preserve both progress evidence and its event ownership."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.models import TournamentStatus
from tests._helpers import make_user
from tests.test_entry_members import seed_doubles_match
from tests.test_tournament_lifecycle import _make_tournament_at, _one_event


async def test_sql_start_requires_recorded_play_or_known_start(
    db_session, default_league
):
    owner = await make_user(db_session, "event-start-evidence")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.published,
        with_event=True,
    )
    event = await _one_event(db_session, tournament.id)
    with pytest.raises(IntegrityError, match="evidence"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_events SET lifecycle_state='in_progress' "
                    "WHERE id=:id"
                ),
                {"id": event.id},
            )
    assert (
        await db_session.scalar(
            text(
                "SELECT count(*) FROM tournament_event_lifecycle_history "
                "WHERE event_id=:id"
            ),
            {"id": event.id},
        )
        == 0
    )


@pytest.mark.parametrize("operation", ["unlink", "delete"])
async def test_cleared_game_preserves_recorded_fixture_ownership(db_session, operation):
    _, _, _, match, _ = await seed_doubles_match(db_session)
    assert (
        await db_session.scalar(
            text("SELECT count(*) FROM match_lineups WHERE match_id=:id"),
            {"id": match.id},
        )
        == 0
    )
    game_id = await db_session.scalar(
        text(
            "INSERT INTO match_games (match_id,game_number) VALUES (:id,1) RETURNING id"
        ),
        {"id": match.id},
    )
    await db_session.execute(
        text(
            "INSERT INTO match_game_scores "
            "(match_game_id,side_1_points,side_2_points) VALUES (:id,11,5)"
        ),
        {"id": game_id},
    )
    await db_session.execute(
        text("DELETE FROM match_games WHERE id=:id"), {"id": game_id}
    )
    statement = (
        "UPDATE tournament_fixtures SET match_id=NULL WHERE match_id=:id"
        if operation == "unlink"
        else "DELETE FROM tournament_fixtures WHERE match_id=:id"
    )
    with pytest.raises(IntegrityError, match="retained"):
        async with db_session.begin_nested():
            await db_session.execute(text(statement), {"id": match.id})
