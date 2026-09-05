"""Unit tests for the transport-neutral per-game score service
(``app.match_scoring``), constructed directly with a ``db_session`` — no
FastAPI, no HTTP client.

The high-level entry points (:func:`enter_game_score`, :func:`update_game_score`,
:func:`delete_game_score`) drive the full FastAPI-free write path from a
``match_id`` + ``user_id``: load+lock+participant, scorability, best-of range,
no-overrun, then the mutation. They trade in the domain ``Match`` and the domain
exception family (``MatchNotFoundError`` / ``MatchNotScorableError`` /
``ScoreNotAllowedError`` / ``ScoreConflictError``), never ``HTTPException`` — the
HTTP adapter maps each back to its exact status + body, and ``test_matches.py``
covers that wire contract separately.
"""

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.match_creation import create_match
from app.match_queries import match_eager_options
from app.match_scoring import (
    delete_game_score,
    ensure_scorable,
    enter_game_score,
    update_game_score,
)
from app.models import Match, MatchResult, MatchStatus
from app.result_acceptance import (
    MatchNotFoundError,
    MatchNotScorableError,
    ScoreConflictError,
    ScoreNotAllowedError,
)
from tests._helpers import directed_tournament_match, make_user


async def _rated_match(db_session: AsyncSession, tag: str) -> Match:
    """A fresh rated best-of-5 match between two registered users, loaded with
    the read eager-load chain. ``match.created_by_user_id`` is the side-1
    participant every write test acts as."""
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


# ----- happy paths ---------------------------------------------------------


async def test_enter_game_score_saves_the_first_score(
    db_session: AsyncSession,
) -> None:
    match = await _rated_match(db_session, "enter")

    updated = await enter_game_score(
        db_session,
        match.id,
        match.created_by_user_id,
        game_number=1,
        side_1_points=11,
        side_2_points=4,
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
    await enter_game_score(
        db_session,
        match.id,
        match.created_by_user_id,
        game_number=1,
        side_1_points=11,
        side_2_points=4,
    )

    updated = await update_game_score(
        db_session,
        match.id,
        match.created_by_user_id,
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


async def test_delete_game_score_clears_the_score_and_keeps_the_game(
    db_session: AsyncSession,
) -> None:
    match = await _rated_match(db_session, "delete")
    await enter_game_score(
        db_session,
        match.id,
        match.created_by_user_id,
        game_number=1,
        side_1_points=11,
        side_2_points=4,
    )

    updated = await delete_game_score(
        db_session, match.id, match.created_by_user_id, game_number=1
    )

    game = next(g for g in updated.games if g.game_number == 1)
    # The score row is gone but the MatchGame stays so a fresh score can attach.
    assert game.score is None


# ----- load + participation (MatchNotFoundError) ---------------------------


async def test_enter_game_score_for_a_non_participant_raises_match_not_found(
    db_session: AsyncSession,
) -> None:
    match = await _rated_match(db_session, "enter-outsider")
    outsider = await make_user(db_session, "enter-outsider-3p")

    with pytest.raises(MatchNotFoundError) as excinfo:
        await enter_game_score(
            db_session,
            match.id,
            outsider.id,
            game_number=1,
            side_1_points=11,
            side_2_points=4,
        )

    # A non-participant is opaque-404'd exactly like an absent match, so they
    # can't probe existence.
    assert excinfo.value.message == "Match not found."


async def test_enter_game_score_for_an_absent_match_raises_match_not_found(
    db_session: AsyncSession,
) -> None:
    with pytest.raises(MatchNotFoundError) as excinfo:
        await enter_game_score(
            db_session,
            uuid.uuid4(),
            uuid.uuid4(),
            game_number=1,
            side_1_points=11,
            side_2_points=4,
        )

    assert excinfo.value.message == "Match not found."


async def test_update_game_score_without_a_committed_score_raises_score_not_found(
    db_session: AsyncSession,
) -> None:
    match = await _rated_match(db_session, "update-missing")

    with pytest.raises(MatchNotFoundError) as excinfo:
        await update_game_score(
            db_session,
            match.id,
            match.created_by_user_id,
            game_number=1,
            side_1_points=11,
            side_2_points=9,
            expected_version=1,
        )

    # Distinct 404 copy from match-not-found: the match resolved, the game score
    # didn't.
    assert excinfo.value.message == "Score not found."


async def test_delete_game_score_without_a_committed_score_raises_score_not_found(
    db_session: AsyncSession,
) -> None:
    match = await _rated_match(db_session, "delete-missing")

    with pytest.raises(MatchNotFoundError) as excinfo:
        await delete_game_score(
            db_session, match.id, match.created_by_user_id, game_number=1
        )

    assert excinfo.value.message == "Score not found."


# ----- director authorization (#1523) ---------------------------------------


async def test_director_can_enter_score_on_a_called_match_in_their_tournament(
    db_session: AsyncSession,
) -> None:
    match, director = await directed_tournament_match(db_session, tag="dir-enter")

    updated = await enter_game_score(
        db_session,
        match.id,
        director.id,
        game_number=1,
        side_1_points=11,
        side_2_points=4,
    )

    score = _score_for(updated, 1)
    assert score.side_1_points == 11
    assert score.side_2_points == 4


async def test_director_can_update_score_on_a_called_match_in_their_tournament(
    db_session: AsyncSession,
) -> None:
    match, director = await directed_tournament_match(db_session, tag="dir-update")
    await enter_game_score(
        db_session,
        match.id,
        director.id,
        game_number=1,
        side_1_points=11,
        side_2_points=4,
    )

    updated = await update_game_score(
        db_session,
        match.id,
        director.id,
        game_number=1,
        side_1_points=11,
        side_2_points=9,
        expected_version=1,
    )

    score = _score_for(updated, 1)
    assert score.side_2_points == 9


async def test_director_can_delete_score_on_a_called_match_in_their_tournament(
    db_session: AsyncSession,
) -> None:
    match, director = await directed_tournament_match(db_session, tag="dir-delete")
    await enter_game_score(
        db_session,
        match.id,
        director.id,
        game_number=1,
        side_1_points=11,
        side_2_points=4,
    )

    updated = await delete_game_score(db_session, match.id, director.id, game_number=1)

    game = next(g for g in updated.games if g.game_number == 1)
    assert game.score is None


async def test_a_stranger_who_is_neither_participant_nor_director_gets_match_not_found(
    db_session: AsyncSession,
) -> None:
    """A caller who is not a participant and not the tournament's director still
    gets the existing opaque 404 (AC "unchanged refusals")."""
    match, _director = await directed_tournament_match(db_session, tag="dir-stranger")
    stranger = await make_user(db_session, "dir-stranger-outsider")

    with pytest.raises(MatchNotFoundError) as excinfo:
        await enter_game_score(
            db_session,
            match.id,
            stranger.id,
            game_number=1,
            side_1_points=11,
            side_2_points=4,
        )

    assert excinfo.value.message == "Match not found."


async def test_the_owner_of_a_different_tournament_still_gets_match_not_found(
    db_session: AsyncSession,
) -> None:
    """A caller who directs some OTHER tournament — not the one this match
    belongs to — is not this match's director, and still 404s. This is the
    case that catches a broken join (a query that forgot to scope by this
    match's own tournament)."""
    match, _director = await directed_tournament_match(db_session, tag="dir-a")
    _other_match, other_director = await directed_tournament_match(
        db_session, tag="dir-b"
    )

    with pytest.raises(MatchNotFoundError) as excinfo:
        await enter_game_score(
            db_session,
            match.id,
            other_director.id,
            game_number=1,
            side_1_points=11,
            side_2_points=4,
        )

    assert excinfo.value.message == "Match not found."


async def test_a_completed_tournament_match_stays_closed_to_the_director(
    db_session: AsyncSession,
) -> None:
    """A completed/voided match stays closed to the director, with the existing
    refusal copy — the director gets no special treatment past the terminal
    gate."""
    match, director = await directed_tournament_match(db_session, tag="dir-completed")
    match.status = MatchStatus.completed
    await db_session.commit()

    with pytest.raises(MatchNotScorableError) as excinfo:
        await enter_game_score(
            db_session,
            match.id,
            director.id,
            game_number=1,
            side_1_points=11,
            side_2_points=4,
        )

    assert excinfo.value.http_status == 409
    assert excinfo.value.message == "This match is no longer scorable."


async def test_an_uncalled_tournament_match_stays_refused_for_the_director(
    db_session: AsyncSession,
) -> None:
    """A match nobody has called to a table stays refused for the director too
    — the schedule is authoritative regardless of who is asking."""
    match, director = await directed_tournament_match(db_session, tag="dir-uncalled")
    match.status = MatchStatus.pending
    await db_session.commit()

    with pytest.raises(MatchNotScorableError) as excinfo:
        await enter_game_score(
            db_session,
            match.id,
            director.id,
            game_number=1,
            side_1_points=11,
            side_2_points=4,
        )

    assert excinfo.value.http_status == 409
    assert excinfo.value.message == "This match hasn't been called to a table yet."


# ----- scorability (MatchNotScorableError) ---------------------------------


async def test_enter_game_score_on_a_pending_match_raises_not_scorable(
    db_session: AsyncSession,
) -> None:
    match = await _rated_match(db_session, "pending")
    # A scheduled-but-uncalled match: the schedule is authoritative, so an
    # out-of-band score is refused. Commit so the high-level reload sees it.
    match.status = MatchStatus.pending
    await db_session.commit()

    with pytest.raises(MatchNotScorableError) as excinfo:
        await enter_game_score(
            db_session,
            match.id,
            match.created_by_user_id,
            game_number=1,
            side_1_points=11,
            side_2_points=4,
        )

    assert excinfo.value.http_status == 409
    assert excinfo.value.message == "This match hasn't been called to a table yet."


def test_ensure_scorable_no_opponent_is_422() -> None:
    # A one-sided match (defensive: creation always builds a sentinel side 2).
    match = Match()
    match.status = MatchStatus.in_progress
    with pytest.raises(MatchNotScorableError) as excinfo:
        ensure_scorable(match)
    assert excinfo.value.http_status == 422
    assert excinfo.value.message == "This match has no opponent and can't be scored."


async def test_ensure_scorable_posted_result_is_409(
    db_session: AsyncSession,
) -> None:
    match = await _rated_match(db_session, "posted")
    # A posted result freezes the scratchpad (#715); the board now only moves
    # via propose/accept. Appended in memory — the truthiness of ``results`` is
    # the whole gate.
    match.results.append(
        MatchResult(submitted_by_user_id=match.created_by_user_id, games=[])
    )
    with pytest.raises(MatchNotScorableError) as excinfo:
        ensure_scorable(match)
    assert excinfo.value.http_status == 409
    assert excinfo.value.message == "This match has a posted result; scores are frozen."


async def test_ensure_scorable_pending_is_409(db_session: AsyncSession) -> None:
    match = await _rated_match(db_session, "pending-direct")
    match.status = MatchStatus.pending
    with pytest.raises(MatchNotScorableError) as excinfo:
        ensure_scorable(match)
    assert excinfo.value.http_status == 409
    assert excinfo.value.message == "This match hasn't been called to a table yet."


async def test_ensure_scorable_completed_is_409(db_session: AsyncSession) -> None:
    match = await _rated_match(db_session, "completed")
    match.status = MatchStatus.completed
    with pytest.raises(MatchNotScorableError) as excinfo:
        ensure_scorable(match)
    assert excinfo.value.http_status == 409
    assert excinfo.value.message == "This match is no longer scorable."


# ----- range + overrun (ScoreNotAllowedError) ------------------------------


async def test_enter_game_score_past_best_of_raises_not_allowed(
    db_session: AsyncSession,
) -> None:
    match = await _rated_match(db_session, "range")

    with pytest.raises(ScoreNotAllowedError) as excinfo:
        # best_of is 5; game 6 can never exist.
        await enter_game_score(
            db_session,
            match.id,
            match.created_by_user_id,
            game_number=6,
            side_1_points=11,
            side_2_points=4,
        )

    assert str(excinfo.value) == "This match is best of 5; game 6 can't exist."


async def test_enter_game_score_overrunning_the_decider_raises_not_allowed(
    db_session: AsyncSession,
) -> None:
    match = await _rated_match(db_session, "overrun")
    # Side 1 clinches best-of-5 by sweeping games 1-3 (3 wins = target).
    for game_number in (1, 2, 3):
        await enter_game_score(
            db_session,
            match.id,
            match.created_by_user_id,
            game_number=game_number,
            side_1_points=11,
            side_2_points=4,
        )

    with pytest.raises(ScoreNotAllowedError) as excinfo:
        # Game 4 can't have been played — the match was already decided at 3.
        await enter_game_score(
            db_session,
            match.id,
            match.created_by_user_id,
            game_number=4,
            side_1_points=11,
            side_2_points=4,
        )

    assert (
        str(excinfo.value)
        == "The match was already decided at game 3; game 4 can't be played."
    )


# ----- the scratchpad is contiguous (ADR "the scratchpad is contiguous") ---


async def test_enter_game_score_past_a_gap_raises_not_allowed(
    db_session: AsyncSession,
) -> None:
    match = await _rated_match(db_session, "gap-save")

    with pytest.raises(ScoreNotAllowedError) as excinfo:
        # Game 1 was never saved, so game 3 can't be either.
        await enter_game_score(
            db_session,
            match.id,
            match.created_by_user_id,
            game_number=3,
            side_1_points=11,
            side_2_points=7,
        )

    assert str(excinfo.value) == "Save game 1 before game 3."


async def test_enter_game_score_names_the_first_unsaved_game(
    db_session: AsyncSession,
) -> None:
    match = await _rated_match(db_session, "gap-save-first-unsaved")
    await enter_game_score(
        db_session,
        match.id,
        match.created_by_user_id,
        game_number=1,
        side_1_points=11,
        side_2_points=7,
    )

    with pytest.raises(ScoreNotAllowedError) as excinfo:
        # Game 1 is saved, game 2 is not: game 4 names game 2, not game 3.
        await enter_game_score(
            db_session,
            match.id,
            match.created_by_user_id,
            game_number=4,
            side_1_points=11,
            side_2_points=7,
        )

    assert str(excinfo.value) == "Save game 2 before game 4."


async def test_enter_game_score_in_order_saves(db_session: AsyncSession) -> None:
    match = await _rated_match(db_session, "gap-save-in-order")
    await enter_game_score(
        db_session,
        match.id,
        match.created_by_user_id,
        game_number=1,
        side_1_points=11,
        side_2_points=7,
    )

    updated = await enter_game_score(
        db_session,
        match.id,
        match.created_by_user_id,
        game_number=2,
        side_1_points=11,
        side_2_points=8,
    )

    assert sorted(g.game_number for g in updated.games) == [1, 2]


async def test_delete_game_score_under_a_later_saved_game_raises_not_allowed(
    db_session: AsyncSession,
) -> None:
    match = await _rated_match(db_session, "gap-delete")
    await enter_game_score(
        db_session,
        match.id,
        match.created_by_user_id,
        game_number=1,
        side_1_points=11,
        side_2_points=7,
    )
    await enter_game_score(
        db_session,
        match.id,
        match.created_by_user_id,
        game_number=2,
        side_1_points=11,
        side_2_points=8,
    )

    with pytest.raises(ScoreNotAllowedError) as excinfo:
        # Game 2 is still saved: clearing game 1 would leave a hole.
        await delete_game_score(
            db_session, match.id, match.created_by_user_id, game_number=1
        )

    assert str(excinfo.value) == "Clear game 2 first, or edit game 1 instead."


async def test_delete_game_score_last_game_clears(db_session: AsyncSession) -> None:
    match = await _rated_match(db_session, "gap-delete-last")
    await enter_game_score(
        db_session,
        match.id,
        match.created_by_user_id,
        game_number=1,
        side_1_points=11,
        side_2_points=7,
    )
    await enter_game_score(
        db_session,
        match.id,
        match.created_by_user_id,
        game_number=2,
        side_1_points=11,
        side_2_points=8,
    )

    updated = await delete_game_score(
        db_session, match.id, match.created_by_user_id, game_number=2
    )
    game = next(g for g in updated.games if g.game_number == 2)
    assert game.score is None

    # Now game 1 is the last saved game — it clears too.
    updated = await delete_game_score(
        db_session, match.id, match.created_by_user_id, game_number=1
    )
    game = next(g for g in updated.games if g.game_number == 1)
    assert game.score is None


async def test_update_game_score_does_not_require_contiguity(
    db_session: AsyncSession,
) -> None:
    """``update_game_score`` edits a game already on the board in place — it
    cannot open a gap, so it carries no contiguity guard of its own. This is
    just ``test_update_game_score_with_the_right_version_replaces_it``'s
    scenario restated to pin the "unaffected" half of the ADR."""
    match = await _rated_match(db_session, "gap-update-unaffected")
    await enter_game_score(
        db_session,
        match.id,
        match.created_by_user_id,
        game_number=1,
        side_1_points=11,
        side_2_points=4,
    )

    updated = await update_game_score(
        db_session,
        match.id,
        match.created_by_user_id,
        game_number=1,
        side_1_points=11,
        side_2_points=9,
        expected_version=1,
    )

    score = _score_for(updated, 1)
    assert score.side_1_points == 11
    assert score.side_2_points == 9


# ----- concurrent-participant conflicts (ScoreConflictError) ---------------


async def test_update_game_score_with_a_stale_version_raises_score_conflict(
    db_session: AsyncSession,
) -> None:
    match = await _rated_match(db_session, "update-stale")
    await enter_game_score(
        db_session,
        match.id,
        match.created_by_user_id,
        game_number=1,
        side_1_points=11,
        side_2_points=4,
    )
    # A first participant's edit advances the committed row to version 2.
    await update_game_score(
        db_session,
        match.id,
        match.created_by_user_id,
        game_number=1,
        side_1_points=11,
        side_2_points=8,
        expected_version=1,
    )

    # A second participant still holding version 1 loses the race.
    with pytest.raises(ScoreConflictError) as excinfo:
        await update_game_score(
            db_session,
            match.id,
            match.created_by_user_id,
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
    await enter_game_score(
        db_session,
        match.id,
        match.created_by_user_id,
        game_number=1,
        side_1_points=11,
        side_2_points=4,
    )

    # A concurrent participant tries to create the same game again — the
    # in-memory pre-check the router's blocking lock funnels the race into.
    with pytest.raises(ScoreConflictError) as excinfo:
        await enter_game_score(
            db_session,
            match.id,
            match.created_by_user_id,
            game_number=1,
            side_1_points=11,
            side_2_points=6,
        )

    committed = excinfo.value.committed_score
    assert committed is not None
    # The conflict hands back the winner's committed score (11-4), not the
    # loser's attempted overwrite, and runs *before* any overrun check.
    assert committed.side_1_points == 11
    assert committed.side_2_points == 4
    assert committed.version == 1
