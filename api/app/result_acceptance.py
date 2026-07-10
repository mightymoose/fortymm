"""The worker-safe core of accepting a standing match result.

The second verb of the two-verb negotiation (propose → accept) used to live
inline in the ``app.matches`` router handler. It's extracted here as a leaf
module so it can run outside an HTTP request — e.g. from an RQ worker that
auto-accepts a stale proposal — where there is no ``HTTPException`` to raise and
no ``current_user`` to read.

Because it must be constructible without FastAPI (api/CLAUDE.md service-layer
rules), the core:

- takes ``accepted_by_user_id`` as an explicit parameter (never derived from
  ``players[0]``, so doubles works at the call site), and
- signals the two "the world moved on" conditions with plain domain exceptions
  (mirroring ``PushNotConfiguredError``) instead of ``HTTPException``. The router
  maps each back to the exact HTTP response it produced before, so behaviour is
  identical.

This module also hosts the small scoring primitives the accept core needs
(``side_win_counts`` / ``_games_to_win`` / ``_game_winner_side``) and the
finalize-time rating helpers (``_set_side_won`` / ``_apply_rating_update``).
They belong in a shared leaf both the router and a future worker import — they
can't live on the router the worker would otherwise have to import. The
``app.matches`` router re-imports the ones it still calls directly.
"""

import math
import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Match,
    MatchGameScore,
    MatchStatus,
    RatingHistory,
    RatingHistorySource,
    RatingStrategy,
    UserLeagueRating,
)
from app.ratings import (
    RatingStrategyMismatchError,
    get_calculator,
    parse_strategy_key,
    state_rating_value,
    validate_state,
)
from app.result_chain import standing_result


class StandingResultConflictError(Exception):
    """Raised when the ``result_id`` handed to :func:`accept_standing_result` is
    no longer the live standing proposal — a concurrent counter superseded it,
    it was already accepted, or there is no standing proposal at all. The router
    maps this to the existing 409 carrying the moved-on negotiation state."""


class PostedGamesNotDecisiveError(Exception):
    """Raised when the match's committed games no longer decide a winner at the
    moment of acceptance. Practically unreachable (a result only stands once its
    board is decided, and the board is frozen while it stands), but the core
    stays total rather than silently stamping no winner. The router maps this to
    the existing 409 ``"The posted games no longer decide this match."``."""


def _games_to_win(best_of: int) -> int:
    return math.ceil(best_of / 2)


def _game_winner_side(score: MatchGameScore) -> int:
    # Ties are blocked by MatchGameScoreWrite; defensive fallback maps to side 2.
    return 1 if score.side_1_points > score.side_2_points else 2


def side_win_counts(match: Match) -> dict[int, int]:
    counts = {side.side_number: 0 for side in match.sides}
    for game in match.games:
        if game.score is None:
            continue
        winner = _game_winner_side(game.score)
        counts[winner] = counts.get(winner, 0) + 1
    return counts


def _posted_decided_side(match: Match) -> int:
    """Winner side number per the committed canonical games. Only meaningful
    once a result has been posted: /results validated the games as decided,
    and ``_enforce_scorable`` freezes them while a result is pending, so exactly
    one side has clinched by the time acceptance reads this."""
    target = _games_to_win(match.match_settings.best_of)
    for side_number, count in sorted(side_win_counts(match).items()):
        if count >= target:
            return side_number
    raise PostedGamesNotDecisiveError


def _set_side_won(match: Match, decided_side: int) -> None:
    """Stamp the W/L outcome on each side. Called only at the moment a match
    becomes ``completed`` — /results for matches that skip acceptance,
    /results/{id}/acceptance for rated ones — so a profile never shows a
    WIN/LOSS for a result the opponent hasn't accepted yet (issue #485)."""
    for side in match.sides:
        side.won = side.side_number == decided_side


async def _get_or_create_user_league_rating(
    db: AsyncSession,
    league_id: uuid.UUID,
    user_id: uuid.UUID,
    strategy: RatingStrategy,
) -> UserLeagueRating:
    existing = (
        await db.execute(
            select(UserLeagueRating).where(
                UserLeagueRating.league_id == league_id,
                UserLeagueRating.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        # Snapshot guard (issue #184). A row that pre-existed this call holds
        # ``rating_state`` in the shape of the strategy it was snapshotted under.
        # If the league has since switched strategies, that state must not be
        # reinterpreted under the new one — refuse loudly rather than corrupt it.
        # The caller (``_apply_rating_update``) only reaches here for an
        # ``is_automatic`` league, so this fires on automatic->automatic switches;
        # a switch to a manual strategy early-returns before the rating hook and
        # its rows simply freeze at their last automatic value (accepted; #184).
        # A freshly-seeded row (the branch below) can't mismatch — it's stamped
        # with the current ``strategy.id`` — so the guard is scoped to existing
        # rows only.
        if existing.rating_strategy_id != strategy.id:
            raise RatingStrategyMismatchError(
                league_id=league_id,
                user_id=user_id,
                row_strategy_id=existing.rating_strategy_id,
                league_strategy_id=strategy.id,
            )
        return existing
    rating = UserLeagueRating.seed_for_strategy(league_id, user_id, strategy)
    db.add(rating)
    await db.flush()
    return rating


async def _apply_rating_update(db: AsyncSession, match: Match) -> None:
    """When ``match`` has just transitioned to completed and its league runs an
    automatic rating strategy, compute the singles update and persist a
    ``rating_history`` row + bump ``user_league_ratings`` for each side.

    Idempotent on subsequent score edits: if any history row already exists for
    this match, we skip. Re-applying ratings after a score correction is its own
    feature (tied to void flows, which aren't wired up yet)."""
    if match.status != MatchStatus.completed:
        return
    if not match.match_settings.affects_rating:
        return

    league = match.league
    strategy = league.rating_strategy
    if not strategy.is_automatic:
        return
    strategy_key = parse_strategy_key(strategy.key)
    if strategy_key is None:
        return
    calculator = get_calculator(strategy_key)
    if calculator is None:
        return

    # Doubles tripwire. This match would have received an automatic rating
    # update (completed + rated + automatic strategy + calculator present) but
    # the calculator only knows ``update_singles``. Fail loud rather than
    # silently skip — a doubles match that completes without moving ratings is
    # an easy bug to miss. Unreachable today (match creation hardcodes
    # team_size=1), this trips the moment doubles support lands without a
    # doubles-aware calculator. See https://github.com/mightymoose/fortymm/issues/183
    if match.match_settings.team_size != 1:
        raise NotImplementedError(
            "Rating updates for doubles (team_size != 1) are not implemented; "
            "add a doubles-aware calculator before enabling doubles matches "
            "(see issue #183)."
        )

    already_applied = (
        await db.execute(
            select(RatingHistory.id).where(RatingHistory.match_id == match.id).limit(1)
        )
    ).scalar_one_or_none()
    if already_applied is not None:
        return

    winning_side = next((s for s in match.sides if s.won is True), None)
    losing_side = next((s for s in match.sides if s.won is False), None)
    if winning_side is None or losing_side is None:
        return
    if not winning_side.players or not losing_side.players:
        return

    winner_player = winning_side.players[0]
    loser_player = losing_side.players[0]

    winner_rating = await _get_or_create_user_league_rating(
        db, league.id, winner_player.user_id, strategy
    )
    loser_rating = await _get_or_create_user_league_rating(
        db, league.id, loser_player.user_id, strategy
    )
    if winner_rating.rating_state is None or loser_rating.rating_state is None:
        return

    prev_winner_value = winner_rating.rating_value
    prev_loser_value = loser_rating.rating_value

    new_winner_state, new_loser_state = calculator.update_singles(
        winner_rating.rating_state, loser_rating.rating_state
    )
    validate_state(new_winner_state, strategy)
    validate_state(new_loser_state, strategy)

    new_winner_value = state_rating_value(new_winner_state)
    new_loser_value = state_rating_value(new_loser_state)

    winner_rating.rating_state = new_winner_state
    winner_rating.rating_value = new_winner_value
    loser_rating.rating_state = new_loser_state
    loser_rating.rating_value = new_loser_value

    db.add(
        RatingHistory(
            league_id=league.id,
            user_id=winner_player.user_id,
            match_id=match.id,
            rating_strategy_id=strategy.id,
            rating_value=new_winner_value,
            rating_state=new_winner_state,
            previous_rating_value=prev_winner_value,
            source=RatingHistorySource.match,
        )
    )
    db.add(
        RatingHistory(
            league_id=league.id,
            user_id=loser_player.user_id,
            match_id=match.id,
            rating_strategy_id=strategy.id,
            rating_value=new_loser_value,
            rating_state=new_loser_state,
            previous_rating_value=prev_loser_value,
            source=RatingHistorySource.match,
        )
    )


async def accept_standing_result(
    db: AsyncSession,
    match: Match,
    *,
    result_id: uuid.UUID,
    accepted_by_user_id: uuid.UUID,
) -> None:
    """Accept the standing proposal ``result_id`` on ``match`` and finalize it.

    Assumes the caller already holds the match row lock (``_lock_match_row``) so
    this serializes against concurrent propose/accept transitions, and that
    ``match`` was loaded under that lock. Stamps the acceptance on the standing
    result, completes the match, stamps ``side.won`` from the agreed games, and
    runs the rating update. Does **not** commit — the caller owns the
    transaction boundary.

    ``accepted_by_user_id`` is the accepting user; it is never inferred from the
    match, so doubles (any participant on the opposing side) works at the call
    site.

    Raises :class:`StandingResultConflictError` if ``result_id`` is no longer the
    live standing proposal (superseded, already accepted, or none standing), and
    :class:`PostedGamesNotDecisiveError` if the committed games no longer decide
    a winner. It never raises ``HTTPException`` — it has no HTTP context."""
    standing = standing_result(match)
    if standing is None or standing.id != result_id:
        raise StandingResultConflictError

    standing.accepted_by_user_id = accepted_by_user_id
    standing.accepted_at = datetime.now(UTC)
    match.mark_completed()
    _set_side_won(match, _posted_decided_side(match))
    await _apply_rating_update(db, match)
