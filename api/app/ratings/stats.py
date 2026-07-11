"""Rating *statistics* — the derived, read-side facts about a player's rating.

Distinct from the rest of ``app.ratings``, which is about *producing* ratings
(the calculators, the registry, the recompute pass). These are the reads that
several surfaces want to display: a player's peak in a league, where they sit
in it, and how their recent results run.

They live here rather than on any one router because more than one BFF needs
them (the dashboard's rating card and the player profile's hero), and routers
must not import each other's internals.

The streak helpers are deliberately split into a *fetch* (``completed_results``)
and a *pure* fold over that sequence (``current_streak``), so a caller that
wants more than one statistic — e.g. the current run *and* the longest-ever run
— pays for a single scan and folds it twice.
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Match,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    RatingHistory,
    UserLeagueRating,
)

# How many of a player's most-recent completed matches the *current*-streak scan
# reads. A run longer than this is vanishingly rare and would only under-report
# the count, never mis-report its kind. A caller that needs an untruncated scan
# (a longest-ever streak) passes ``limit=None`` to ``completed_results``.
STREAK_SCAN_LIMIT = 100


@dataclass(frozen=True)
class Streak:
    """A run of consecutive same-result matches: ``W`` for wins, ``L`` for
    losses, ``n`` matches long. Never zero-length — the absence of a streak is
    ``None``, not ``n=0``."""

    kind: Literal["W", "L"]
    n: int


async def league_peak_rating(
    db: AsyncSession,
    user_id: uuid.UUID,
    league_id: uuid.UUID,
    current: float,
) -> float:
    """The highest rating the user has ever held in this league.

    ``current`` is the floor: a user whose rating has never been written to the
    history (their seed row) peaks at where they stand today.
    """
    history_peak = (
        await db.execute(
            select(func.max(RatingHistory.rating_value)).where(
                RatingHistory.league_id == league_id,
                RatingHistory.user_id == user_id,
            )
        )
    ).scalar()
    if history_peak is None:
        return current
    return max(current, history_peak)


async def league_percentile(
    db: AsyncSession, league_id: uuid.UUID, my_rating: float
) -> int | None:
    """ "Top N%" rank within the league: the share of rated members at or above
    the user's rating, so the strongest player reads a *small* percentage (e.g.
    "Top 1%") and weaker players a larger one. Clamped to at least 1 so the top
    player never reads "Top 0%". Returns None for leagues of one — nothing to
    compare to."""
    total, at_or_above = (
        await db.execute(
            select(
                func.count(UserLeagueRating.id),
                func.count(UserLeagueRating.id).filter(
                    UserLeagueRating.rating_value >= my_rating
                ),
            ).where(
                UserLeagueRating.league_id == league_id,
                UserLeagueRating.rating_value.is_not(None),
            )
        )
    ).one()
    if total <= 1:
        return None
    return max(1, round(int(at_or_above) / int(total) * 100))


async def completed_results(
    db: AsyncSession,
    user_id: uuid.UUID,
    *,
    limit: int | None = STREAK_SCAN_LIMIT,
) -> list[bool]:
    """The user's decided results, newest-first: ``True`` for a win, ``False``
    for a loss.

    Ordered by completion time (stable under later edits, unlike
    ``updated_at``), and capped at ``limit`` rows — pass ``limit=None`` to scan
    the whole history. One scan feeds every streak fold below.
    """
    q = (
        select(MatchSide.won)
        .join(Match, Match.id == MatchSide.match_id)
        .join(
            MatchSidePlayer,
            MatchSidePlayer.match_side_id == MatchSide.id,
        )
        .where(
            MatchSidePlayer.user_id == user_id,
            Match.status == MatchStatus.completed,
            MatchSide.won.is_not(None),
        )
        # Most-recent-completion first; stable under later edits.
        .order_by(Match.completed_at.desc())
    )
    if limit is not None:
        q = q.limit(limit)
    rows = (await db.execute(q)).scalars().all()
    # ``won`` is nullable in the DB (an undecided side), but the filter above
    # excludes those rows; the cast is what tells the type checker so.
    return [bool(won) for won in rows]


def current_streak(results: Sequence[bool]) -> Streak | None:
    """Count the run at the head of a newest-first result sequence: the
    consecutive wins (or losses) the user is on right now. ``None`` when they
    have no decided matches."""
    if not results:
        return None
    head_kind: Literal["W", "L"] = "W" if results[0] else "L"
    n = 1
    for won in results[1:]:
        kind: Literal["W", "L"] = "W" if won else "L"
        if kind != head_kind:
            break
        n += 1
    return Streak(kind=head_kind, n=n)


async def current_streak_for_user(
    db: AsyncSession, user_id: uuid.UUID
) -> Streak | None:
    """The user's current streak across every league, or ``None`` if they have
    no decided matches. Scans at most ``STREAK_SCAN_LIMIT`` matches — enough to
    count any run a real player is on."""
    return current_streak(await completed_results(db, user_id))
