"""Background jobs for rating recomputation. Invoked by RQ workers.

The recompute itself is async (it uses ``app.ratings.recompute``), but RQ
workers are sync processes, so each entry point is a thin ``asyncio.run``
wrapper that opens its own ``async_sessionmaker`` from ``app.db.get_engine``.
"""

import asyncio
import logging
import uuid

from sqlalchemy import func, select, union
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.db import get_engine
from app.models import (
    LeagueMembership,
    Match,
    MatchSidePlayer,
    RatingInput,
    UserLeagueRating,
)
from app.ratings.recompute import recompute_league_ratings

log = logging.getLogger(__name__)

RECOMPUTE_AFTER_MERGE_JOB = "app.ratings.jobs.recompute_after_merge"


def recompute_after_merge(user_id: str) -> None:
    """Rebuild every league identified by a player's durable facts or snapshots."""
    asyncio.run(_recompute_after_merge(uuid.UUID(user_id)))


async def _recompute_after_merge(user_id: uuid.UUID) -> None:
    """Re-run and commit each affected league's rating cascade independently.

    Every query in ``recompute_league_ratings`` is scoped to a single
    ``league_id``, so leagues are independent — one league's recompute neither
    reads nor writes another's state. We therefore commit after each league
    rather than once at the end: partial progress survives, so a persistent
    error in one league no longer discards the leagues already settled before it
    (issue #248).

    Failure policy: if a league's recompute raises, the leagues committed before
    it stay committed and the exception propagates. RQ then marks the job failed
    and a retry replays every league — harmless for the already-settled ones
    because the recompute is idempotent (it rewrites state deterministically), so
    only the previously-failing league has real work left to do. Letting it
    propagate (rather than log-and-continue) keeps RQ's failed-job registry
    meaningful. The failing league's own uncommitted work is rolled back when the
    ``async with`` session context exits on the propagating exception, so the
    session is never reused after a partial statement.
    """
    sessionmaker = async_sessionmaker(get_engine(), expire_on_commit=False)
    async with sessionmaker() as session:
        # Durable inputs and sporting membership still identify leagues when
        # every derived snapshot has been deleted. Retain snapshot discovery for
        # an empty league awaiting reset after its last match was voided.
        league_ids = (
            await session.scalars(
                union(
                    select(UserLeagueRating.league_id).where(
                        UserLeagueRating.user_id == user_id
                    ),
                    select(RatingInput.league_id).where(
                        func.entry_canonical_player(RatingInput.player_id) == user_id
                    ),
                    select(LeagueMembership.league_id).where(
                        LeagueMembership.user_id == user_id
                    ),
                    select(Match.league_id)
                    .join(MatchSidePlayer, MatchSidePlayer.match_id == Match.id)
                    .where(MatchSidePlayer.user_id == user_id),
                )
            )
        ).all()
        if not league_ids:
            return
        # Commit per league so partial progress survives a mid-loop failure.
        # A stable acquisition order is belt-and-braces now: with a per-league
        # commit the job holds exactly one transaction-scoped advisory lock at a
        # time, so cross-job deadlock is impossible rather than merely
        # ordered-away. Kept for a deterministic, easy-to-reason-about order.
        for league_id in sorted(league_ids):
            await recompute_league_ratings(session, league_id, {user_id})
            await session.commit()
