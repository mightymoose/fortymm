"""The transport-neutral request-schedule-solve write verb (ADR "the schedule is
solved; the call is pinned").

The orchestration behind ``POST /v1/tournaments/{id}/schedule/solves`` — the
Run-scheduler button — extracted out of the router so it can run without FastAPI:
from the HTTP adapter (``app.tournaments.request_schedule_solve``) and, later, from
an MCP tool alike, and be constructed in a plain REPL with a raw session.

Per the tournament-verbs ADR (mirroring the match-flow ADR and the edit / cut-draw
verbs in ``app.tournament_edit`` / ``app.tournament_draw_service``), it signals every
refusal with a **domain exception** from ``app.tournament_errors`` — never an
``HTTPException`` — and each adapter maps it back to the exact response it produced
before:

* an absent tournament → :class:`TournamentNotFoundError` (404);
* a non-owner → :class:`NotTournamentOwnerError` (403);
* no event with a cut draw → :class:`NoDrawnEventsError` (422);
Redis failure does not reject work accepted durably by PostgreSQL.

The tournament is loaded through the same ``FOR UPDATE`` loader the edit and draw
verbs use (``app.tournament_edit._load_tournament_for_update``): the lock is not
decoration. This verb *judges* that a draw exists and then enqueues a run against it,
and ``request_solve``'s contract requires its callers to hold the tournament row lock
first (lock order: tournament → schedule_solves — ``app.schedule_solves`` module
docstring). Without the lock the "a draw exists" judgment and the enqueue would sit in
two instants: an un-cut could commit between them and a solve would be queued for a
tournament this verb just certified as drawable.
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ScheduleSolve, ScheduleSolveTrigger, User
from app.schedule_solves import request_solve, tournament_has_drawn_event
from app.tournament_edit import _load_owned_tournament_for_update
from app.tournament_errors import (
    NoDrawnEventsError,
)


async def request_schedule_solve(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    actor: User,
) -> ScheduleSolve:
    """Queue a run of the schedule solver for the tournament ``actor`` owns, and
    return the ledger row that will carry its outcome.

    Runs the same orchestration the HTTP handler used to run inline, under the
    tournament row lock (:func:`_load_tournament_for_update`), in the ordering
    ADR-0017 fixed for every tournament write (**404 → 403 → 422**):

    * **404** — an absent tournament raises :class:`TournamentNotFoundError`.
      Loaded first (and under lock), so ownership is judged only once the row
      exists and a stranger probing ids learns nothing.
    * **403** — a caller who is not the tournament's creator raises
      :class:`NotTournamentOwnerError`. Running the scheduler is owner-gated
      (``created_by_user_id == actor.id``), not RBAC-gated — the same family as
      cutting a draw — and judged before the draw's *state* is looked at, so the
      refusal never leaks whether anything is drawn.
    * **422** — a tournament with no event that has a cut draw raises
      :class:`NoDrawnEventsError`: the solver places a draw's fixtures, so with
      nothing cut there is nothing to schedule. The caller's own refusal, last.

    On success it requests a ``manual`` solve — the one coalesced enqueue every
    trigger funnels into (``request_solve``): a ``queued`` run absorbs this
    request and its row comes back; a ``running`` run gets its re-run flag set;
    only when neither exists is a fresh row inserted and the RQ job enqueued.
    The repair requirement commits atomically; dispatch follows commit.

    Commits and refreshes before returning: ``requested_at`` and the other server
    defaults were never round-tripped by the INSERT, so the row is re-read rather
    than serialized with expired attributes. Never raises ``HTTPException`` — the
    caller adapts each domain exception to its transport.
    """
    await _load_owned_tournament_for_update(db, tournament_id, actor)
    if not await tournament_has_drawn_event(db, tournament_id):
        raise NoDrawnEventsError()
    row = await request_solve(db, tournament_id, ScheduleSolveTrigger.manual)
    await db.commit()
    await db.refresh(row)
    return row
