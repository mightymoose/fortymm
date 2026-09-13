"""Sporting rulings on unrated matches do not require a working calculator."""

import pytest

from app.models import MatchStatus, RatingStrategy
from app.official_results import correct_result, official_history, void_official_match
from app.result_proposal import propose_result
from tests._helpers import directed_tournament_match
from tests.test_official_results import board


@pytest.mark.parametrize("action", ["correct", "void"])
async def test_unrated_ruling_ignores_unsupported_rating_strategy(db_session, action):
    match, director = await directed_tournament_match(
        db_session, tag=f"unrated-{action}", best_of=1, rated=False
    )
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    (root,) = await official_history(db_session, match.id)
    old = match.league.rating_strategy
    unavailable = RatingStrategy(
        key=old.key,
        version=999,
        name="Unavailable formula",
        state_schema=old.state_schema,
        initial_state=old.initial_state,
        initial_rating_value=old.initial_rating_value,
        is_automatic=True,
    )
    db_session.add(unavailable)
    await db_session.flush()
    match.league.rating_strategy = unavailable
    await db_session.commit()
    if action == "correct":
        await correct_result(
            db_session,
            match.id,
            director.id,
            expected_revision_id=root.id,
            games=board(2),
            reason="Correct an unrated score",
        )
    else:
        await void_official_match(
            db_session, match.id, director.id, reason="Void an unrated duplicate"
        )
    await db_session.commit()
    history = await official_history(db_session, match.id)
    assert len(history) == (2 if action == "correct" else 1)
    assert match.status == (
        MatchStatus.completed if action == "correct" else MatchStatus.voided
    )
