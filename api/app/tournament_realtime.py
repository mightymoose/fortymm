"""Who a tournament write's dashboard hint goes to.

The dashboard's tournament panel is scoped, in ``app.dashboard_tournaments``, to
"every live tournament the caller holds an **active entry** in". So the audience
of a tournament write's ``dashboard.changed`` hint is that same set, read the
other way round: the **active entrants of the affected event** (ADR "realtime
topics are per-user, and the server resolves who is affected"). Not the
director, who sees no panel unless they entered; not a spectator, who is not in
the projection at all; and emphatically not a **withdrawn** entrant, whose panel
the withdrawal already removed — "ever entered" and "holds an entry" are
different sets, and the second one is the one that has a dashboard to refresh.

That is why the entrant set is read through
:func:`~app.tournament_queries.active_entrants_by_event` rather than a WHERE
clause written here: it is the one loader the entrants list, the derived entry
count and the panel itself already agree on, so the hint audience cannot come to
disagree with the projection it exists to invalidate. It costs no query of this
module's own, and it is batched over every affected event at once — a per-entrant
read inside a solve-apply loop would grow with the field it is describing.

Hints are **staged**, never published, because every caller here runs inside a
transaction it does not own the boundary of (``on_match_completed`` and
``place_fixture`` run under the tournament row lock; the solve apply runs in the
RQ worker's own session). :func:`~app.realtime.outbox.stage_event` ties each hint
to that transaction's fate, so a rolled-back placement tells nobody their panel
moved.

No live-status gate, deliberately. A hint is an *invalidation*, not a payload —
the worst a pre-live one costs is a refetch that finds the same dashboard — and a
second, subtly different definition of "who cares" living here is exactly the
kind of thing that drifts away from the panel's own scoping. The one place status
matters is that a tournament *changing* status (going live, being archived) is
itself a panel change, which is why the transition verb hints on every edge
rather than only on ``published → live``.
"""

import uuid
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import TournamentEvent
from app.player_accounts import managing_account_ids
from app.realtime import EventKind, stage_event
from app.tournament_queries import active_entrants_by_event


async def stage_event_entrant_hints(
    db: AsyncSession, event_ids: Sequence[uuid.UUID]
) -> None:
    """Stage a ``dashboard.changed`` hint for every active entrant of ``event_ids``.

    One batched read for the whole set (none at all when the set is empty, which
    is the common "nothing actually moved" case), and staging is idempotent per
    ``(user_id, kind)`` — so a player entered in two of the named events is
    hinted once, not twice.
    """
    if not event_ids:
        return
    entrants = await active_entrants_by_event(db, event_ids)
    player_ids = [
        entrant.user_id for entries in entrants.values() for entrant in entries
    ]
    for account_id in await managing_account_ids(db, player_ids):
        stage_event(db, account_id, EventKind.dashboard_changed)


async def stage_tournament_entrant_hints(
    db: AsyncSession, tournament_id: uuid.UUID
) -> None:
    """Stage a ``dashboard.changed`` hint for every active entrant of every event
    of ``tournament_id`` — the audience of a whole-tournament change.

    A lifecycle transition is not scoped to one event: going live makes the panel
    *appear* for everybody entered anywhere in the tournament, and archiving makes
    it disappear again. The event ids are read here, in one narrow statement, so
    the caller does not have to gather them (and so the two callers that already
    load events for other reasons are not tempted to grow a second entrant query
    off the rows they happen to be holding).
    """
    event_ids = list(
        (
            await db.execute(
                select(TournamentEvent.id).where(
                    TournamentEvent.tournament_id == tournament_id
                )
            )
        )
        .scalars()
        .all()
    )
    await stage_event_entrant_hints(db, event_ids)
