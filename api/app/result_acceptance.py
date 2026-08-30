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
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

if TYPE_CHECKING:
    from app.match_scoring import _MatchWriteLoader

from app.match_errors import (
    CannotAcceptOwnProposalError,
    MatchClosedError,
    MatchNotFoundError,
    MatchNotScorableError,
    NegotiationConflictError,
    OpponentNotFoundError,
    PostedGamesNotDecisiveError,
    RatedNeedsRegisteredOpponentError,
    ResultNotFoundError,
    ScoreConflictError,
    ScoreNotAllowedError,
    SelfMatchError,
    StandingResultConflictError,
    UndecidedBoardError,
)
from app.match_realtime import stage_match_participant_hints
from app.models import (
    Match,
    MatchGameScore,
    MatchSidePlayer,
    MatchStatus,
    RatingHistory,
    RatingHistorySource,
    RatingStrategy,
    UserLeagueRating,
)
from app.ratings import (
    RatingCalculator,
    RatingStrategyMismatchError,
    get_calculator,
    parse_strategy_key,
    state_rating_value,
    validate_state,
)
from app.result_chain import standing_result
from app.tournament_advancement import on_match_completed

# The match-flow domain exception family lives in ``app.match_errors`` (a neutral
# leaf) so the services can share it without importing one another. Re-exported
# here because the module's own body raises several of them and because the
# service-unit tests import them from this module.
__all__ = [
    "CannotAcceptOwnProposalError",
    "MatchClosedError",
    "MatchNotFoundError",
    "MatchNotScorableError",
    "NegotiationConflictError",
    "OpponentNotFoundError",
    "PostedGamesNotDecisiveError",
    "RatedNeedsRegisteredOpponentError",
    "ResultNotFoundError",
    "ScoreConflictError",
    "ScoreNotAllowedError",
    "SelfMatchError",
    "StandingResultConflictError",
    "UndecidedBoardError",
    "accept_result",
    "accept_standing_result",
    "finalize_match",
    "side_win_counts",
]


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
    and ``ensure_scorable`` freezes them while a result is pending, so exactly
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


def _resolve_completion_sides(
    match: Match,
) -> tuple[MatchSidePlayer, MatchSidePlayer] | None:
    """Return ``(winner_player, loser_player)`` for a decided binary singles
    result, or ``None`` when there is no clear winner/loser or a decided side
    has no players.

    Mirrors ``_decided_sides`` in ``app.ratings.recompute``: a
    forfeit/void/partial write leaves ``MatchSide.won`` as ``None`` and never
    produced a rating delta, so we skip rather than crash on the lookup. A
    decided side with no players — the solo-match sentinel side, or a forfeit
    that stamped ``won`` on a player-less side — would otherwise ``IndexError``
    on the ``players[0]`` lookup below, so it also resolves to ``None``."""
    winning_side = next((s for s in match.sides if s.won is True), None)
    losing_side = next((s for s in match.sides if s.won is False), None)
    if winning_side is None or losing_side is None:
        return None
    if not winning_side.players or not losing_side.players:
        return None
    return winning_side.players[0], losing_side.players[0]


def _calculator_for(match: Match) -> RatingCalculator | None:
    """The automatic-rating gate: the calculator for ``match``'s league
    strategy, or ``None`` when the league runs a non-automatic strategy (a
    ``manual`` league freezes its rating rows and never reaches a calculator)
    or its key has no registered calculator. Callers short-circuit on ``None``
    before doing any rating work — in particular before the doubles tripwire,
    so that only a match that would otherwise be rated can trip it."""
    strategy = match.league.rating_strategy
    if not strategy.is_automatic:
        return None
    strategy_key = parse_strategy_key(strategy.key)
    if strategy_key is None:
        return None
    return get_calculator(strategy_key)


@dataclass(frozen=True)
class _SideRatingUpdate:
    """One side's computed singles move: the ``user_league_ratings`` row to bump
    and the values to write into it and record in ``rating_history``."""

    rating: UserLeagueRating
    user_id: uuid.UUID
    new_state: dict[str, Any]
    new_value: float
    previous_value: float | None


def _write_match_rating_history(
    db: AsyncSession,
    *,
    league_id: uuid.UUID,
    match_id: uuid.UUID,
    strategy: RatingStrategy,
    winner: _SideRatingUpdate,
    loser: _SideRatingUpdate,
) -> None:
    """Persist the computed singles update: bump each side's
    ``user_league_ratings`` row to its new state/value, then append the two
    ``rating_history`` rows (winner then loser) recording the move."""
    for update in (winner, loser):
        update.rating.rating_state = update.new_state
        update.rating.rating_value = update.new_value

    db.add(
        RatingHistory(
            league_id=league_id,
            user_id=winner.user_id,
            match_id=match_id,
            rating_strategy_id=strategy.id,
            rating_value=winner.new_value,
            rating_state=winner.new_state,
            previous_rating_value=winner.previous_value,
            source=RatingHistorySource.match,
        )
    )
    db.add(
        RatingHistory(
            league_id=league_id,
            user_id=loser.user_id,
            match_id=match_id,
            rating_strategy_id=strategy.id,
            rating_value=loser.new_value,
            rating_state=loser.new_state,
            previous_rating_value=loser.previous_value,
            source=RatingHistorySource.match,
        )
    )


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

    calculator = _calculator_for(match)
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

    sides = _resolve_completion_sides(match)
    if sides is None:
        return
    winner_player, loser_player = sides

    league = match.league
    strategy = league.rating_strategy

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

    _write_match_rating_history(
        db,
        league_id=league.id,
        match_id=match.id,
        strategy=strategy,
        winner=_SideRatingUpdate(
            rating=winner_rating,
            user_id=winner_player.user_id,
            new_state=new_winner_state,
            new_value=state_rating_value(new_winner_state),
            previous_value=prev_winner_value,
        ),
        loser=_SideRatingUpdate(
            rating=loser_rating,
            user_id=loser_player.user_id,
            new_state=new_loser_state,
            new_value=state_rating_value(new_loser_state),
            previous_value=prev_loser_value,
        ),
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
    await finalize_match(db, match, _posted_decided_side(match))


async def finalize_match(db: AsyncSession, match: Match, decided_side: int) -> None:
    """Complete a match: stamp it done, record the W/L, run the rating update, and
    advance any tournament draw it belongs to (ADR-0788).

    **The one place a match becomes ``completed``.** Both completion sites funnel
    through here — the rated accept/retire path (:func:`accept_standing_result`) and the
    unrated immediate-self-accept path (``app.result_proposal``'s ``propose_result``,
    which calls ``finalize_match``) — so the four things a
    completion must do happen together and in one order, and a future third completion
    path cannot do three of them and forget the fourth. ``decided_side`` is the winning
    side number, computed by the caller from the agreed board (``_posted_decided_side``
    on accept, the finalize validator's ``decided_side`` on the unrated post).

    The tournament hook runs **last and unconditionally**: :func:`on_match_completed`
    early-returns on a non-tournament match (the overwhelmingly common case), so a plain
    ladder match pays only an indexed lookup that misses. Runs in the caller's
    transaction under the match row lock; does **not** commit.

    Because it does not commit, the realtime hint for the participants is *staged*
    rather than published (:func:`app.realtime.outbox.stage_event`): whoever owns the
    transaction boundary decides whether this completion is real, and the outbox's
    ``after_commit`` listener publishes only if it is."""
    match.mark_completed()
    _set_side_won(match, decided_side)
    await _apply_rating_update(db, match)
    await on_match_completed(db, match)
    stage_match_participant_hints(db, match)


async def _reload_accepted_match(db: AsyncSession, match_id: uuid.UUID) -> Match:
    """Reload the just-accepted match with the full read eager-load chain.

    Returns a non-optional :class:`Match`: the row was committed one statement
    earlier in the same session, so its absence is a genuine invariant violation,
    not a client-handleable ``None`` (``api/CLAUDE.md``)."""
    # Imported lazily: ``app.match_queries`` imports this module at its top
    # (``_games_to_win`` / ``side_win_counts``), so a module-level import here
    # would be a cycle. This leaf stays importable before its higher-level
    # collaborators finish loading.
    from app.match_queries import match_eager_options

    match = (
        await db.execute(
            select(Match).where(Match.id == match_id).options(*match_eager_options())
        )
    ).scalar_one_or_none()
    if match is None:
        raise RuntimeError(f"just-accepted match {match_id} vanished before reload")
    return match


async def accept_result(
    db: AsyncSession,
    match_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    result_id: uuid.UUID,
    load_match: "_MatchWriteLoader | None" = None,
) -> Match:
    """Accept a standing proposal — the second verb of the propose/accept
    negotiation — and return the reloaded, finalized domain :class:`Match`.

    Loads under the blocking match row lock (so this serializes against a
    concurrent propose/accept transition, #365) with the finalize eager-load
    superset, then runs the two adapter-independent guards the router used to run
    inline: the target ``result_id`` must be a result on the match at all
    (:class:`ResultNotFoundError` → the historical 404), and — while it's still
    the live standing proposal — the accepting user must not be on the submitter's
    side (:class:`CannotAcceptOwnProposalError` → the historical 409; the
    proposing side already consented by proposing). It then delegates to
    :func:`accept_standing_result`, translating its
    :class:`StandingResultConflictError` into :class:`NegotiationConflictError`
    (carrying the loaded ``match`` so an adapter can rebuild the viewer-relative
    moved-on snapshot) and letting :class:`PostedGamesNotDecisiveError` propagate.
    Finally it commits and returns the reloaded match.

    ``load_match`` defaults to the FastAPI-free :func:`load_match_for_write`; the
    HTTP handler injects ``matches._load_match_for_scoring`` so the router's
    monkeypatchable, ``HTTPException``-mapping load seam (the #835 row-lock race
    test barriers on it) stays the one it exercises. Never raises
    ``HTTPException`` — the caller adapts it to its transport."""
    # Lazy imports: ``app.match_scoring``, ``app.result_proposal`` and
    # ``app.match_queries`` all import this module at their top (``match_scoring``
    # and ``match_queries`` for the scoring primitives ``_games_to_win`` /
    # ``side_win_counts`` defined here), so module-level imports of their symbols
    # here would be cycles. These are only needed at call time, so this leaf
    # stays importable ahead of them.
    from app.match_queries import my_side
    from app.match_scoring import load_match_for_write
    from app.result_proposal import match_rating_eager_options

    if load_match is None:
        load_match = load_match_for_write

    match = await load_match(
        db,
        match_id,
        user_id,
        lock=True,
        options=match_rating_eager_options(),
    )

    # The path ``result_id`` must exist on this match at all (404); the live
    # standing-proposal check (409 with the moved-on state) is owned by
    # ``accept_standing_result`` below so it runs identically from a worker.
    if not any(r.id == result_id for r in match.results):
        raise ResultNotFoundError

    # The proposing side already consented by proposing; only the opposing side
    # accepts. A participant on the submitter's side (in singles, the submitter
    # themselves) can't accept their own proposal. Only meaningful while the
    # targeted result is still standing — a superseded/absent one falls through
    # to the core's conflict signal below.
    #
    # The side check alone is not enough since #1523. A tournament director is
    # on neither side, so ``my_side`` returns ``None`` for a director-submitted
    # proposal and the side check does nothing — the submitting director could
    # accept their own result. ``_requires_confirmation``
    # (``app.result_proposal``) is what stops such a proposal ever standing, but
    # that is a mint-site invariant in another module, and a future path that
    # mints a standing ``MatchResult`` without going through ``propose_result``
    # would silently reopen the hole. So check the submitter's identity too:
    # nobody accepts their own proposal, side or no side.
    standing = standing_result(match)
    if standing is not None and standing.id == result_id:
        if standing.submitted_by_user_id == user_id:
            raise CannotAcceptOwnProposalError
        submitter_side = my_side(match, standing.submitted_by_user_id)
        if submitter_side is not None and any(
            p.user_id == user_id for p in submitter_side.players
        ):
            raise CannotAcceptOwnProposalError

    try:
        await accept_standing_result(
            db,
            match,
            result_id=result_id,
            accepted_by_user_id=user_id,
        )
    except StandingResultConflictError as exc:
        raise NegotiationConflictError(match) from exc

    await db.commit()
    return await _reload_accepted_match(db, match_id)
