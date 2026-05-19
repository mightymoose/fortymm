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
from app.models import Match, MatchSettings, MatchSidePlayer, MatchStatus
from app.ratings.recompute import recompute_league_ratings

log = logging.getLogger(__name__)


def recompute_after_merge(user_id: str) -> None:
    """RQ entry point. Re-runs the rating cascade in every league where
    ``user_id`` has at least one completed rated match — i.e. every league
    whose timeline could have been disturbed by the just-completed merge.

    Idempotent: the recompute reads current state and rewrites it deterministically,
    so a retried job lands on the same result.
    """
    asyncio.run(_recompute_after_merge(uuid.UUID(user_id)))


async def _recompute_after_merge(user_id: uuid.UUID) -> None:
    sessionmaker = async_sessionmaker(get_engine(), expire_on_commit=False)
    async with sessionmaker() as session:
        league_ids = (
            (
                await session.execute(
                    select(Match.league_id)
                    .join(
                        MatchSidePlayer,
                        MatchSidePlayer.match_id == Match.id,
                    )
                    .join(
                        MatchSettings,
                        MatchSettings.id == Match.match_settings_id,
                    )
                    .where(
                        MatchSidePlayer.user_id == user_id,
                        Match.status == MatchStatus.completed,
                        MatchSettings.affects_rating.is_(True),
                    )
                    .distinct()
                )
            )
            .scalars()
            .all()
        )
        if not league_ids:
            return
        for league_id in league_ids:
            await recompute_league_ratings(session, league_id, {user_id})
        await session.commit()
