"""Direct SQL corrections must reconcile rated projections before commit."""

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.official_results import official_history
from app.result_proposal import propose_result
from tests._helpers import directed_tournament_match
from tests.test_official_results import board


@pytest.mark.parametrize(
    "projection_state",
    ["stale", "deleted", "missing_snapshot", "stale_snapshot", "reconciled", "unrated"],
)
async def test_sql_rated_correction_requires_reconciliation(
    db_session, projection_state
):
    match, director = await directed_tournament_match(
        db_session,
        tag="rating-sql-reconcile",
        best_of=1,
        rated=projection_state != "unrated",
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    (original,) = await official_history(db_session, match.id)
    await db_session.commit()
    await db_session.execute(
        text("""
            INSERT INTO match_official_results
            (id, match_id, revision, predecessor_id, resolution_method,
             actor_account_id, reason, tournament_id, owner_revision, games)
            SELECT :new, match_id, revision + 1, id, 'administrator_ruling',
                   actor_account_id, 'Database correction', tournament_id,
                   owner_revision,
                   '[{"game_number": 1,
                      "side_1_points": 4, "side_2_points": 11}]'::jsonb
            FROM match_official_results WHERE id = :original
        """),
        {"new": uuid.uuid4(), "original": original.id},
    )
    if projection_state == "deleted":
        await db_session.execute(text("DELETE FROM rating_history"))
        await db_session.execute(text("DELETE FROM user_league_ratings"))
    elif projection_state in ("missing_snapshot", "stale_snapshot", "reconciled"):
        from app.ratings.recompute import recompute_league_ratings

        await recompute_league_ratings(
            db_session, match.league_id, {match.sides[0].players[0].user_id}
        )
        if projection_state == "missing_snapshot":
            await db_session.execute(text("DELETE FROM user_league_ratings"))
        elif projection_state == "stale_snapshot":
            await db_session.execute(
                text("""
                UPDATE user_league_ratings SET rating_value = 1234,
                rating_state = jsonb_set(rating_state, '{rating}', '1234')
            """)
            )
    if projection_state in ("reconciled", "unrated"):
        await db_session.commit()
    else:
        with pytest.raises(IntegrityError, match="rating.*reconcil"):
            await db_session.commit()
        await db_session.rollback()
