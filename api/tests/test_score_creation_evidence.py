"""Saved score timestamps remain trustworthy lifecycle observations."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.match_creation import create_match
from app.match_scoring import enter_game_score, update_game_score
from tests._helpers import make_user


async def test_score_correction_preserves_original_recording_time(db_session):
    player = await make_user(db_session, "score-clock-player")
    opponent = await make_user(db_session, "score-clock-opponent")
    match = await create_match(
        db_session,
        creator=player,
        opponent_user_id=opponent.id,
        league_id=None,
        best_of=3,
        rated=False,
    )
    await enter_game_score(
        db_session,
        match.id,
        player.id,
        game_number=1,
        side_1_points=11,
        side_2_points=5,
    )
    original = (
        await db_session.execute(
            text(
                "SELECT s.id, s.created_at FROM match_game_scores s "
                "JOIN match_games g ON g.id=s.match_game_id WHERE g.match_id=:id"
            ),
            {"id": match.id},
        )
    ).one()
    with pytest.raises(IntegrityError, match="creation time is immutable"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE match_game_scores "
                    "SET created_at=created_at - interval '1 day' "
                    "WHERE id=:id"
                ),
                {"id": original.id},
            )
    await update_game_score(
        db_session,
        match.id,
        player.id,
        game_number=1,
        side_1_points=11,
        side_2_points=7,
        expected_version=1,
    )
    assert (
        await db_session.scalar(
            text("SELECT created_at FROM match_game_scores WHERE id=:id"),
            {"id": original.id},
        )
        == original.created_at
    )


async def test_score_cannot_claim_a_future_recording_time(db_session):
    player = await make_user(db_session, "future-score-player")
    opponent = await make_user(db_session, "future-score-opponent")
    match = await create_match(
        db_session,
        creator=player,
        opponent_user_id=opponent.id,
        league_id=None,
        best_of=3,
        rated=False,
    )
    game_id = await db_session.scalar(
        text(
            "INSERT INTO match_games (match_id,game_number) VALUES (:id,1) RETURNING id"
        ),
        {"id": match.id},
    )
    with pytest.raises(IntegrityError, match="creation time cannot be in the future"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO match_game_scores "
                    "(match_game_id,side_1_points,side_2_points,created_at) "
                    "VALUES (:id,11,5,clock_timestamp() + interval '1 day')"
                ),
                {"id": game_id},
            )
