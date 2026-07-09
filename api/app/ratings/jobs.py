"""Background jobs for rating recomputation. Invoked by RQ workers.

The recompute itself is async (it uses ``app.ratings.recompute``), but RQ
workers are sync processes, so each entry point is a thin ``asyncio.run``
wrapper that opens its own ``async_sessionmaker`` from ``app.db.get_engine``.
"""

import asyncio
import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.db import get_engine
from app.models import UserLeagueRating
from app.ratings.recompute import recompute_league_ratings

log = logging.getLogger(__name__)

RECOMPUTE_AFTER_MERGE_JOB = "app.ratings.jobs.recompute_after_merge"


def recompute_after_merge(user_id: str) -> None:
    """RQ entry point. Re-runs the rating cascade in every league where
    ``user_id`` has a rating row — i.e. every league whose timeline the
    just-completed merge could have disturbed. Discovery keys off the rating
    row, not off "has a completed rated match", so a league whose only rated
    match the merge just voided (leaving an empty timeline to reset back to the
    strategy's initial state) is still reached.
    """
    asyncio.run(_recompute_after_merge(uuid.UUID(user_id)))


async def _recompute_after_merge(user_id: uuid.UUID) -> None:
    sessionmaker = async_sessionmaker(get_engine(), expire_on_commit=False)
    async with sessionmaker() as session:
        # Discover leagues by rating row, not by "has a completed rated match".
        # Voiding a user's only rated match empties their timeline: the old
        # match-based discovery then found no league and returned before the
        # cascade could reset the stale rating. Every member has a rating row
        # from ``seed_user_league_rating``, so this reaches the empty-timeline
        # league (where ``recompute_league_ratings`` resets it to initial). The
        # rating-row set is a superset of the completed-match set — a completed
        # rated match always leaves a rating row — so no league is lost.
        league_ids = (
            (
                await session.execute(
                    select(UserLeagueRating.league_id)
                    .where(UserLeagueRating.user_id == user_id)
                    .distinct()
                )
            )
            .scalars()
            .all()
        )
        if not league_ids:
            return
        # Consistent acquisition order prevents deadlocks when two concurrent
        # jobs for different users share overlapping league sets.
        for league_id in sorted(league_ids):
            await recompute_league_ratings(session, league_id, {user_id})
        await session.commit()
