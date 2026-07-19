"""The transport-neutral core of the per-game scratchpad score writes.

The three per-game score mutations — create, update, delete — used to live
inline in the ``app.matches`` router handlers. They're extracted here as a leaf
module so a second caller (the MCP server, a script, a worker) can drive the
same "save / clear scratchpad state" flow without an HTTP request.

Following ``api/CLAUDE.md``'s rule of thumb, each is a plain module-level async
function taking ``db`` rather than a class-plus-provider: none has a collaborator
worth injecting. Each takes the already-loaded, row-locked, participation-checked
domain :class:`Match` (the router still owns the ``_load_match_for_scoring`` lock
and the scorability / overrun guards, exactly as ``accept_standing_result``'s
router owns its load and pre-guards), mutates the board, and returns the reloaded
:class:`Match` ready to serialise.

The one race these functions own is the concurrent-participant score conflict:
they signal it with the domain :class:`ScoreConflictError` (carrying the
committed score) instead of an ``HTTPException``. The HTTP handler maps it back
to the exact 409 ``MatchGameScoreConflict`` body it produced before, so the wire
contract is unchanged.
"""

import uuid
from typing import Any, cast

from sqlalchemy import CursorResult, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.match_queries import match_eager_options
from app.match_serialization import _score_view
from app.models import Match, MatchGame, MatchGameScore
from app.result_acceptance import ScoreConflictError
from app.schemas.match import MatchDetailsScore


async def _reload_match(db: AsyncSession, match_id: uuid.UUID) -> Match:
    """Reload the just-written match with the full read eager-load chain.

    Returns a non-optional :class:`Match`: the row was committed one statement
    earlier in the same session, so its absence is a genuine invariant
    violation, not a client-handleable ``None`` (``api/CLAUDE.md``)."""
    match = (
        await db.execute(
            select(Match).where(Match.id == match_id).options(*match_eager_options())
        )
    ).scalar_one_or_none()
    if match is None:
        raise RuntimeError(f"just-written match {match_id} vanished before reload")
    return match


async def _committed_score(
    db: AsyncSession, match_id: uuid.UUID, game_number: int
) -> MatchDetailsScore | None:
    """The game's score as it actually stands now — for the conflict body after
    a create lost the unique-constraint race (the committed row belongs to a
    different transaction, so it isn't on our in-memory ``match``)."""
    reloaded = (
        await db.execute(
            select(Match).where(Match.id == match_id).options(*match_eager_options())
        )
    ).scalar_one_or_none()
    if reloaded is None:
        return None
    game = next((g for g in reloaded.games if g.game_number == game_number), None)
    return _score_view(game.score) if game and game.score else None


async def enter_game_score(
    db: AsyncSession,
    match: Match,
    *,
    game_number: int,
    side_1_points: int,
    side_2_points: int,
) -> Match:
    """Save the first score for ``game_number`` on ``match`` and return it
    reloaded. Lazily inserts the ``MatchGame`` row (the FE deeplinks straight
    into ``/games/N/scores/new`` before the game exists).

    Raises :class:`ScoreConflictError` when a concurrent participant already
    saved this game — either the in-memory board already carries a committed
    score (the common case under the router's blocking lock), or the commit
    trips ``uq_match_games_match_id_game_number`` / ``uq_match_game_scores`` as
    a residual same-game insert backstop. Both carry the committed score for the
    conflict body. Never touches ``match.status``, ``side.won``, or ratings.

    Assumes the caller loaded ``match`` under the match row lock and has already
    enforced scorability, ``game_number <= best_of``, and the no-overrun guard."""
    game = next((g for g in match.games if g.game_number == game_number), None)
    if game is None:
        game = MatchGame(game_number=game_number)
        match.games.append(game)
    elif game.score is not None:
        # A concurrent participant already created this game's score — the same
        # conflict the update path guards against, just on first write. Hand
        # back the committed score so the client surfaces it for review instead
        # of overwriting it.
        raise ScoreConflictError(committed_score=_score_view(game.score))

    game.score = MatchGameScore(
        side_1_points=side_1_points,
        side_2_points=side_2_points,
    )

    try:
        await db.commit()
    except IntegrityError as exc:
        # Two participants on the same game-entry page submitting at once both
        # lazily insert the same game row (uq_match_games_match_id_game_number)
        # and/or its score (uq_match_game_scores_match_game_id). The pre-checks
        # above pass for both before either commits, so the loser of the race
        # trips a unique constraint. The committed row belongs to the winner's
        # transaction, so reload to read it for the conflict body.
        await db.rollback()
        raise ScoreConflictError(
            committed_score=await _committed_score(db, match.id, game_number)
        ) from exc

    return await _reload_match(db, match.id)


async def update_game_score(
    db: AsyncSession,
    match: Match,
    *,
    game_number: int,
    side_1_points: int,
    side_2_points: int,
    expected_version: int,
) -> Match:
    """Replace the committed score for ``game_number`` on ``match`` under
    optimistic concurrency and return it reloaded.

    The ``WHERE version = expected_version`` clause is the whole guard: if a
    concurrent participant has saved this game since the caller last read it,
    zero rows match and we raise :class:`ScoreConflictError` (carrying the score
    as it actually stands now) rather than overwrite their save. Never touches
    ``match.status``, ``side.won``, or ratings.

    Assumes the caller loaded ``match`` under the match row lock and has already
    enforced scorability, the score's existence (404), and the no-overrun
    guard on the prospective board."""
    game = next((g for g in match.games if g.game_number == game_number), None)
    if game is None or game.score is None:
        # The router guards this with a 404 before delegating; reaching here is
        # an invariant violation, not a client-handleable case.
        raise RuntimeError(
            f"update_game_score for match {match.id} game {game_number} "
            "without a committed score; caller must guard"
        )

    # Optimistic concurrency: replace the points only while the committed row is
    # still at the version the caller last read.
    result = await db.execute(
        update(MatchGameScore)
        .where(
            MatchGameScore.id == game.score.id,
            MatchGameScore.version == expected_version,
        )
        .values(
            side_1_points=side_1_points,
            side_2_points=side_2_points,
            version=MatchGameScore.version + 1,
        )
    )
    if cast(CursorResult[Any], result).rowcount == 0:
        # Lost the race: a concurrent participant saved this game since the
        # caller last read it, so the conditional UPDATE matched no row. The
        # update changed nothing, so there's nothing to undo — refresh the score
        # to the value as it actually stands now and signal the conflict (the
        # caller's transaction teardown rolls the no-op transaction back).
        await db.refresh(game.score)
        raise ScoreConflictError(committed_score=_score_view(game.score))

    await db.commit()

    return await _reload_match(db, match.id)


async def delete_game_score(
    db: AsyncSession,
    match: Match,
    *,
    game_number: int,
) -> Match:
    """Clear the committed score for ``game_number`` on ``match`` and return it
    reloaded. The ``MatchGame`` row stays so a subsequent
    ``POST .../scores/new`` for the same number just attaches a fresh score row;
    delete-orphan on ``MatchGame.score`` removes the score row on flush. Never
    touches ``match.status``, ``side.won``, or ratings.

    Assumes the caller loaded ``match`` under the match row lock and has already
    enforced scorability and the score's existence (404)."""
    game = next((g for g in match.games if g.game_number == game_number), None)
    if game is None or game.score is None:
        # The router guards this with a 404 before delegating; reaching here is
        # an invariant violation, not a client-handleable case.
        raise RuntimeError(
            f"delete_game_score for match {match.id} game {game_number} "
            "without a committed score; caller must guard"
        )

    game.score = None
    await db.commit()

    return await _reload_match(db, match.id)
