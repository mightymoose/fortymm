"""Retained fixture ownership still supplies cancellation scoring policy."""

import pytest
from sqlalchemy import text

from app.event_lifecycle import cancel_event
from app.match_errors import ScoreNotAllowedError
from app.match_scoring import enter_game_score
from app.result_proposal import MatchClosedError, propose_result
from app.tournament_draws import uncut_draw
from tests._helpers import directed_tournament_match
from tests.test_official_results import board


@pytest.mark.parametrize("writer", ["game", "proposal"])
async def test_retired_cancelled_match_reports_new_play_refusal(db_session, writer):
    match, director = await directed_tournament_match(
        db_session,
        tag="retired-cancel-scoring",
        best_of=3,
        rated=False,
        director_is_participant=True,
    )
    await enter_game_score(
        db_session,
        match.id,
        director.id,
        game_number=1,
        side_1_points=11,
        side_2_points=5,
    )
    event_id, tournament_id = (
        await db_session.execute(
            text(
                "SELECT scope_event_id,scope_tournament_id "
                "FROM tournament_fixtures WHERE match_id=:id"
            ),
            {"id": match.id},
        )
    ).one()
    await uncut_draw(db_session, [event_id])
    await cancel_event(
        db_session, tournament_id=tournament_id, event_id=event_id, actor=director
    )
    await db_session.commit()
    error = ScoreNotAllowedError if writer == "game" else MatchClosedError
    with pytest.raises(error, match="event is cancelled"):
        if writer == "game":
            await enter_game_score(
                db_session,
                match.id,
                director.id,
                game_number=2,
                side_1_points=11,
                side_2_points=5,
            )
        else:
            game = board()[0]
            await propose_result(
                db_session,
                match.id,
                director.id,
                games=[game, game.model_copy(update={"game_number": 2})],
                supersedes_result_id=None,
            )
