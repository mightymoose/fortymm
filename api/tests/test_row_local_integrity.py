"""Database-level row-local invariants for the pre-beta baseline (#1680).

Catalogue:

* completed matches require ``completed_at``; active matches do not, and voided
  matches may retain one;
* merge targets remain addressable, reservation windows are ordered, and numeric
  ordinals, versions, and counters respect their zero-/one-based domains;
* JSONB columns enforce only their nullable top-level object/array shape.

The checks deliberately avoid present-day availability and arbitrary cross-row
validation. Each constraint belongs in the baseline migration and the ORM metadata,
with direct PostgreSQL tests proving the database—not request validation—enforces it.
"""

from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.match_creation import create_match
from app.models import MatchGame, MatchGameScore, RatingStrategy
from tests._helpers import make_user


async def test_completed_match_requires_completion_timestamp(
    db_session: AsyncSession,
) -> None:
    creator = await make_user(db_session, "integrity-completed")
    match = await create_match(
        db_session,
        creator=creator,
        opponent_user_id=None,
        league_id=None,
        best_of=3,
        rated=False,
    )

    with pytest.raises(IntegrityError, match="ck_matches_completed_at"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE matches SET status = 'completed', completed_at = NULL "
                    "WHERE id = :match_id"
                ),
                {"match_id": match.id},
            )


async def test_completed_match_accepts_completion_timestamp(
    db_session: AsyncSession,
) -> None:
    creator = await make_user(db_session, "integrity-completed-valid")
    match = await create_match(
        db_session,
        creator=creator,
        opponent_user_id=None,
        league_id=None,
        best_of=3,
        rated=False,
    )

    completed_at = datetime.now(UTC)
    await db_session.execute(
        text(
            "UPDATE matches SET status = 'completed', completed_at = :completed_at "
            "WHERE id = :match_id"
        ),
        {"match_id": match.id, "completed_at": completed_at},
    )
    await db_session.commit()


async def test_voided_match_may_retain_completion_timestamp(
    db_session: AsyncSession,
) -> None:
    creator = await make_user(db_session, "integrity-voided")
    match = await create_match(
        db_session,
        creator=creator,
        opponent_user_id=None,
        league_id=None,
        best_of=3,
        rated=False,
    )

    await db_session.execute(
        text(
            "UPDATE matches SET status = 'voided', completed_at = :completed_at "
            "WHERE id = :match_id"
        ),
        {"match_id": match.id, "completed_at": datetime.now(UTC)},
    )
    await db_session.commit()


async def test_rating_strategy_requires_object_state_schema(
    db_session: AsyncSession,
) -> None:
    strategy = RatingStrategy(
        key="invalid-shape",
        name="Invalid shape",
        state_schema=[],  # type: ignore[arg-type]
    )
    db_session.add(strategy)

    with pytest.raises(
        IntegrityError, match="ck_rating_strategies_state_schema_object"
    ):
        await db_session.commit()


async def test_rating_strategy_allows_null_initial_state(
    db_session: AsyncSession,
) -> None:
    strategy = RatingStrategy(
        key="null-initial-state",
        name="Null initial state",
        state_schema={"type": "object"},
        initial_state=None,
    )
    db_session.add(strategy)
    await db_session.commit()


async def test_score_version_starts_at_one_and_rejects_zero(
    db_session: AsyncSession,
) -> None:
    creator = await make_user(db_session, "integrity-score-version")
    match = await create_match(
        db_session,
        creator=creator,
        opponent_user_id=None,
        league_id=None,
        best_of=3,
        rated=False,
    )
    game = MatchGame(match_id=match.id, game_number=1)
    db_session.add(game)
    await db_session.flush()
    score = MatchGameScore(match_game_id=game.id, side_1_points=11, side_2_points=9)
    db_session.add(score)
    await db_session.commit()
    assert score.version == 1

    with pytest.raises(IntegrityError, match="ck_match_game_scores_version"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("UPDATE match_game_scores SET version = 0 WHERE id = :score_id"),
                {"score_id": score.id},
            )
