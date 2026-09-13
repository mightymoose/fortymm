"""Event first-play evidence is independent of score/attachment insertion order."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text

from app.event_lifecycle import reconcile_event
from app.match_creation import create_match
from app.models import TournamentEntry, User
from tests.test_match_calls import _make_tournament, _the_fixture


@pytest.mark.parametrize("attach_first", [True, False])
async def test_past_score_observation_uses_earliest_retained_creation_time(
    db_session, attach_first
):
    _, event_id = await _make_tournament(db_session)
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
    if attach_first:
        fixture.match_id = match.id
        await db_session.flush()
    recorded_at = datetime.now(UTC) - timedelta(days=2)
    history = None
    for number, timestamp in enumerate(
        [recorded_at, recorded_at - timedelta(days=1)], start=1
    ):
        game_id = await db_session.scalar(
            text(
                "INSERT INTO match_games (match_id,game_number) "
                "VALUES (:match,:number) RETURNING id"
            ),
            {"match": match.id, "number": number},
        )
        await db_session.execute(
            text(
                "INSERT INTO match_game_scores "
                "(match_game_id,side_1_points,side_2_points,created_at) "
                "VALUES (:game,11,4,:timestamp)"
            ),
            {"game": game_id, "timestamp": timestamp},
        )
        if not attach_first and number == 1:
            fixture.match_id = match.id
        await reconcile_event(db_session, event_id)
        await db_session.commit()
        observed, actual = (
            await db_session.execute(
                text(
                    "SELECT first_recorded_play_at,started_at "
                    "FROM tournament_events WHERE id=:id"
                ),
                {"id": event_id},
            )
        ).one()
        assert observed == timestamp
        assert actual is None
        current_history = (
            await db_session.execute(
                text(
                    "SELECT * FROM tournament_event_lifecycle_history "
                    "WHERE event_id=:id ORDER BY version"
                ),
                {"id": event_id},
            )
        ).all()
        if history is not None:
            assert current_history == history
        history = current_history
