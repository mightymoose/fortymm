"""Data access for the tournament read path.

The one thing worth stating up front: an event's registration count is **not a
stored column** (ADR-0016). It is derived from the event's live *active* entries,
which are the same rows the read model lists as its entrants — so the count and
the list are read together, once, and cannot disagree.

The tournament LIST endpoint returns every tournament with all of its events, so
the loader below is batched over **all** the event ids at once: one statement,
regardless of how many events there are. A per-event count would be an N+1, and
``tests/test_tournaments.py`` pins the statement count to keep it that way.
"""

import uuid
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import TournamentEntry, TournamentEntryStatus, User
from app.schemas.tournament import TournamentEntrantRead


async def active_entrants_by_event(
    db: AsyncSession, event_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, list[TournamentEntrantRead]]:
    """The active entrants of every event in ``event_ids``, keyed by event id.

    ONE statement for the whole batch (none at all when there are no events).
    Every id gets a key, so an event nobody has entered maps to ``[]`` — the
    caller never has to guess whether a missing key means "no entrants" or "not
    loaded". Withdrawn entries are filtered out here, at the only place that
    reads them, so they can reach neither the entrants list nor the count that is
    derived from it.
    """
    entrants: dict[uuid.UUID, list[TournamentEntrantRead]] = {
        event_id: [] for event_id in event_ids
    }
    if not entrants:
        return entrants
    rows = (
        await db.execute(
            select(
                TournamentEntry.id,
                TournamentEntry.event_id,
                TournamentEntry.user_id,
                User.username,
                TournamentEntry.seed,
            )
            .join(User, User.id == TournamentEntry.user_id)
            .where(
                TournamentEntry.event_id.in_(entrants.keys()),
                TournamentEntry.status == TournamentEntryStatus.entered,
            )
            # Oldest entry first, matching the event's ``entries`` relationship,
            # so the list is stable across reads.
            .order_by(TournamentEntry.created_at, TournamentEntry.id)
        )
    ).all()
    for entry_id, event_id, user_id, username, seed in rows:
        entrants[event_id].append(
            TournamentEntrantRead(
                id=entry_id, user_id=user_id, username=username, seed=seed
            )
        )
    return entrants
