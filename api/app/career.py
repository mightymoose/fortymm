"""A player's CAREER — their lifetime record across every league they play in.

Career is a fact about the *person*, not about a ladder (CONTEXT.md, "Career";
ADR-0915). Nothing in this module takes a ``league_id``, and nothing in it may
grow one: the profile's rating half is league-scoped, and this half is the
deliberate counterweight to it.

Two numbers here are easy to confuse with neighbours on the same page, so both
are stated once, here:

* ``decided`` counts only matches with a win or a loss. The profile's
  ``match_total`` counts the *all-inclusive* history (ADR-0008) — every match the
  player is a side of, in play or voided or solo. ``decided <= match_total``, and
  they differ on purpose.
* ``games_won_pct`` is a share of *games*, not of matches. A 3-2 win and a 3-0
  win are one win each in the W-L column and very different here — that is the
  whole reason the statistic exists.

It lives in its own module rather than in the profile router because it is domain
logic, not HTTP shaping, and because head-to-head (the other cross-league read of
the same match rows) will want to sit next to it.
"""

import uuid

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.leagues import count_league_memberships
from app.models import (
    Match,
    MatchGame,
    MatchGameScore,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
)
from app.ratings.stats import Streak, best_win_streak, completed_results, current_streak
from app.schemas.player import PlayerCareer, PlayerStreak


def _share(part: int, whole: int) -> float | None:
    """``part / whole`` as a share in [0, 1] — ``None``, never ``0.0``, when the
    denominator is empty. A player who has decided nothing has no win rate; a
    zero would claim they win none of the matches they play."""
    if whole == 0:
        return None
    return part / whole


async def _games_tally(db: AsyncSession, user_id: uuid.UUID) -> tuple[int, int]:
    """One round trip: ``(games this player took, games played)`` across their
    DECIDED matches — the numerator and denominator of ``games_won_pct``.

    A game belongs to the player when their side outscored the other on it, which
    is why this reads ``match_game_scores`` (the per-game points) rather than
    ``MatchSide.score``: the side-level score is the count of games taken in the
    match the row belongs to, and summing it would still be a *match*-shaped
    read, blind to unscored games.

    Gated on the same population as ``completed_results`` — completed matches
    with a decided side — so the share is honestly "across their decided
    matches": a live match's already-scored games are not yet part of anyone's
    career, and a voided match's are no longer.
    """
    mine_took_it = or_(
        and_(
            MatchSide.side_number == 1,
            MatchGameScore.side_1_points > MatchGameScore.side_2_points,
        ),
        and_(
            MatchSide.side_number == 2,
            MatchGameScore.side_2_points > MatchGameScore.side_1_points,
        ),
    )
    won, played = (
        await db.execute(
            select(
                func.count().filter(mine_took_it),
                func.count(),
            )
            .select_from(MatchSidePlayer)
            .join(MatchSide, MatchSide.id == MatchSidePlayer.match_side_id)
            .join(Match, Match.id == MatchSide.match_id)
            .join(MatchGame, MatchGame.match_id == Match.id)
            .join(MatchGameScore, MatchGameScore.match_game_id == MatchGame.id)
            .where(
                MatchSidePlayer.user_id == user_id,
                Match.status == MatchStatus.completed,
                MatchSide.won.is_not(None),
            )
        )
    ).one()
    return int(won), int(played)


def _wire(streak: Streak | None) -> PlayerStreak | None:
    return None if streak is None else PlayerStreak(kind=streak.kind, n=streak.n)


async def player_career(db: AsyncSession, user_id: uuid.UUID) -> PlayerCareer:
    """The player's cross-league career block for the profile bundle.

    Three round trips, whatever the size of the history: the decided-results
    scan, the games tally, and the league count.

    The results scan is ``limit=None`` — UNCAPPED, unlike the dashboard's
    current-streak read, which stops at ``STREAK_SCAN_LIMIT``. Best streak is an
    all-time fact: a run that ended 120 matches ago is still the best run they
    ever put together, and a capped scan would silently answer "best streak in
    the last 100 matches" instead. That one list is then folded four ways (W-L,
    current run, best run) rather than re-queried per statistic — which is why
    ``app.ratings.stats`` splits the fetch from the folds.
    """
    results = await completed_results(db, user_id, limit=None)
    wins = sum(results)
    decided = len(results)
    games_won, games_played = await _games_tally(db, user_id)
    return PlayerCareer(
        decided=decided,
        wins=wins,
        losses=decided - wins,
        win_rate=_share(wins, decided),
        games_won_pct=_share(games_won, games_played),
        current_streak=_wire(current_streak(results)),
        best_streak=_wire(best_win_streak(results)),
        league_count=await count_league_memberships(db, user_id),
    )
