"""Unit tests for the transport-neutral per-game score service
(``app.match_scoring``), constructed directly with a ``db_session`` — no
FastAPI, no HTTP client. The HTTP wire contract (the 201/409 bodies) is covered
separately by ``test_matches.py``; here we prove each service function returns
the reloaded domain ``Match`` on the happy paths and raises the domain
``ScoreConflictError`` (carrying the committed score, never ``HTTPException``)
on the concurrent-participant races the HTTP adapter maps to its 409."""

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.match_creation import create_match
from app.match_queries import match_eager_options
from app.match_scoring import delete_game_score, enter_game_score, update_game_score
from app.models import Match
from app.result_acceptance import ScoreConflictError
from tests._helpers import make_user


async def _rated_match(db_session: AsyncSession, tag: str) -> Match:
    """A fresh rated best-of-5 match between two registered users, loaded with
    the read eager-load chain the score service expects."""
    creator = await make_user(db_session, f"{tag}-creator")
    opponent = await make_user(db_session, f"{tag}-opponent")
    return await create_match(
        db_session,
        creator=creator,
        opponent_user_id=opponent.id,
        league_id=None,
        best_of=5,
        rated=True,
    )


async def _reload(db_session: AsyncSession, match_id: uuid.UUID) -> Match:
    match = (
        await db_session.execute(
            select(Match).where(Match.id == match_id).options(*match_eager_options())
        )
    ).scalar_one_or_none()
    assert match is not None
    return match


def _score_for(match: Match, game_number: int) -> object:
    game = next(g for g in match.games if g.game_number == game_number)
    assert game.score is not None
    return game.score


async def test_enter_game_score_saves_the_first_score(
    db_session: AsyncSession,
) -> None:
    match = await _rated_match(db_session, "enter")

    updated = await enter_game_score(
        db_session, match, game_number=1, side_1_points=11, side_2_points=4
    )

    assert isinstance(updated, Match)
    score = _score_for(updated, 1)
    assert score.side_1_points == 11
    assert score.side_2_points == 4
    # A freshly created score is version 1.
    assert score.version == 1


async def test_update_game_score_with_the_right_version_replaces_it(
    db_session: AsyncSession,
) -> None:
    match = await _rated_match(db_session, "update-ok")
    match = await enter_game_score(
        db_session, match, game_number=1, side_1_points=11, side_2_points=4
    )

    updated = await update_game_score(
        db_session,
        match,
        game_number=1,
        side_1_points=11,
        side_2_points=9,
        expected_version=1,
    )

    score = _score_for(updated, 1)
    assert score.side_1_points == 11
    assert score.side_2_points == 9
    # The optimistic-concurrency token advances on a successful write.
    assert score.version == 2


async def test_update_game_score_with_a_stale_version_raises_score_conflict(
    db_session: AsyncSession,
) -> None:
    match = await _rated_match(db_session, "update-stale")
    match = await enter_game_score(
        db_session, match, game_number=1, side_1_points=11, side_2_points=4
    )
    # A first participant's edit advances the committed row to version 2.
    match = await update_game_score(
        db_session,
        match,
        game_number=1,
        side_1_points=11,
        side_2_points=8,
        expected_version=1,
    )

    # A second participant still holding version 1 loses the race.
    with pytest.raises(ScoreConflictError) as excinfo:
        await update_game_score(
            db_session,
            match,
            game_number=1,
            side_1_points=5,
            side_2_points=11,
            expected_version=1,
        )

    committed = excinfo.value.committed_score
    assert committed is not None
    # The conflict carries the score as it actually stands now (version 2),
    # not the stale write, so the adapter can surface "yours vs. committed".
    assert committed.version == 2
    assert committed.side_1_points == 11
    assert committed.side_2_points == 8


async def test_enter_game_score_on_an_already_scored_game_raises_score_conflict(
    db_session: AsyncSession,
) -> None:
    match = await _rated_match(db_session, "concurrent-create")
    match = await enter_game_score(
        db_session, match, game_number=1, side_1_points=11, side_2_points=4
    )
    # Re-read the committed state a second participant would be holding, then
    # try to create the same game again — the in-memory pre-check the router's
    # blocking lock funnels the concurrent create into.
    match = await _reload(db_session, match.id)

    with pytest.raises(ScoreConflictError) as excinfo:
        await enter_game_score(
            db_session, match, game_number=1, side_1_points=11, side_2_points=6
        )

    committed = excinfo.value.committed_score
    assert committed is not None
    # The conflict hands back the winner's committed score (11–4), not the
    # loser's attempted overwrite.
    assert committed.side_1_points == 11
    assert committed.side_2_points == 4
    assert committed.version == 1


async def test_delete_game_score_clears_the_score_and_keeps_the_game(
    db_session: AsyncSession,
) -> None:
    match = await _rated_match(db_session, "delete")
    match = await enter_game_score(
        db_session, match, game_number=1, side_1_points=11, side_2_points=4
    )

    updated = await delete_game_score(db_session, match, game_number=1)

    game = next(g for g in updated.games if g.game_number == 1)
    # The score row is gone but the MatchGame stays so a fresh score can attach.
    assert game.score is None
