"""The transport-neutral cut / un-cut draw write verbs (ADR-0786).

The orchestration behind ``POST`` and ``DELETE
/v1/tournaments/{id}/events/{id}/draw`` — the ``FOR UPDATE`` load-lock on the
tournament, the owner gate, the event-under-tournament load, the play-evidence
gate, and the ``cut_draw`` / ``uncut_draw`` domain core — extracted out of the
router so it can run without FastAPI: from the HTTP adapters
(``app.tournaments.cut_event_draw`` / ``uncut_event_draw``) and, later, from an
MCP tool alike, and be constructed in a plain REPL with a raw session.

Per the tournament-verbs ADR (mirroring the match-flow ADR and the edit verb in
``app.tournament_edit``), it signals every refusal with a **domain exception** from
``app.tournament_errors`` — never an ``HTTPException`` — and each adapter maps it
back to the exact response it produced before:

* an absent tournament → :class:`TournamentNotFoundError` (404);
* an event that is not under it → :class:`EventNotFoundError` (404);
* a non-owner → :class:`NotTournamentOwnerError` (403);
* a draw with evidence of play → :class:`DrawUnderWayError` (409).

The :class:`~app.draws.DrawError` family (``UnsupportedDrawType`` /
``NonSinglesDraw`` / ``DegenerateDraw``) is **already** a FastAPI-free domain
family; :func:`cut_draw` raises it and this verb lets it propagate **unchanged**,
for the adapter to turn into the 422 ``_draw_refusal`` composes. A cut refused
that way rolls back first, so a 422 destroys nothing — the same rollback the
router used to do inline.

The tournament is loaded through the same ``FOR UPDATE`` loader the edit verb
uses (``app.tournament_edit._load_tournament_for_update``): the lock is not
decoration. A cut reads the event's active field and writes fixtures derived from
it, and Postgres runs READ COMMITTED, so an unlocked read would answer from its
own statement's snapshot and an entry (or a withdrawal) committing between the
read and the INSERT would leave a persisted draw that never matched any real field
of players. Every writer of the entrant field already queues on this row, so
taking it here is what puts the cut in that queue.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.draws import DrawError
from app.models import ScheduleSolveTrigger, TournamentEvent, User
from app.schedule_solves import request_solve, tournament_has_drawn_event
from app.schemas.tournament import TournamentFixtureRead
from app.tournament_draws import (
    cut_draw,
    draw_has_play,
    event_has_draw,
    uncut_draw,
)
from app.tournament_edit import _load_owned_tournament_for_update
from app.tournament_errors import (
    DrawUnderWayError,
    EventNotFoundError,
)
from app.tournament_queries import fixtures_by_event


async def _load_owned_event_for_draw(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    actor: User,
) -> TournamentEvent:
    """The event whose draw is about to be written, loaded under the tournament's row
    lock and the owner check — the refusal ordering both draw verbs share.

    **404 → 403 → 409**, the ordering ADR-0017 fixed and every tournament write
    keeps: a tournament that does not exist (:class:`TournamentNotFoundError`) or an
    event that is not under it (:class:`EventNotFoundError`) is a 404 before
    ownership is considered, so a stranger probing ids learns nothing; a non-owner
    (:class:`NotTournamentOwnerError`) is a 403 before the draw's *state* is looked
    at, so the refusal never leaks whether an event has been played. The play-evidence
    409 (:func:`_enforce_unplayed`) is the caller's own, and comes last.

    The tournament is loaded through the **locking** loader the edit, entry,
    withdrawal and transition paths all share — the same lock, on the same row, taken
    first — which is what keeps them free of a deadlock cycle. The FastAPI-free
    equivalent of the router's ``_get_owned_event_for_draw_or_404``.
    """
    await _load_owned_tournament_for_update(db, tournament_id, actor)
    # The event must belong to the named tournament — scoped by both ids so a
    # mismatched pair is a miss, not a cross-tournament draw.
    event = (
        await db.execute(
            select(TournamentEvent).where(
                TournamentEvent.id == event_id,
                TournamentEvent.tournament_id == tournament_id,
            )
        )
    ).scalar_one_or_none()
    if event is None:
        raise EventNotFoundError()
    return event


async def _enforce_unplayed(db: AsyncSession, event: TournamentEvent) -> None:
    """Raise :class:`DrawUnderWayError` once an event's draw shows **evidence of
    play** — the single gate on both cutting and un-cutting a draw (ADR-0786).

    It is what makes a re-cut safe. A cut replaces the draw wholesale, so a draw with
    a decided fixture (a recorded winner) or a materialized one (a linked match, which
    may already carry games) cannot be re-cut without throwing away results players
    actually produced. The refusal is on the *evidence*, not on the tournament's
    status: a director may cut and re-cut right up until the first fixture becomes
    real. Read under the tournament's row lock, like every other judge-then-write
    guard, so the evidence it reads is the evidence the write below is authorized by.

    One exception for both verbs, because it is one fact — a re-cut and an un-cut are
    refused for the same reason.
    """
    if await draw_has_play(db, event.id):
        raise DrawUnderWayError()


async def cut_event_draw(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    actor: User,
) -> list[TournamentFixtureRead]:
    """Cut (or re-cut) the draw of the event ``actor`` owns, and return its fixtures
    in the page's canonical **group → round → position** order.

    Runs the same orchestration the HTTP handler used to run inline, under the
    tournament row lock (:func:`_load_owned_event_for_draw`):

    * **404 / 403** — absent tournament, event not under it, or a non-owner, judged
      first so the draw's own state is never the reason a stranger's request is
      refused.
    * **409** — a draw with evidence of play raises :class:`DrawUnderWayError`, asked
      before anything is planned or deleted, so a refused re-cut leaves the standing
      draw exactly as it was.
    * **the DrawError family** — :func:`cut_draw` plans, deletes and re-inserts inside
      *this* transaction (the lock still held, so the field cannot move under it and
      the DELETE and INSERTs land together). When it refuses — an unsupported draw
      type, a non-singles event, a degenerate field — it raises
      :class:`~app.draws.DrawError` **before** the DELETE, so nothing is written; this
      verb rolls back and lets the error propagate **unchanged** for the adapter to map
      to the existing 422. It is deliberately *not* converted to an ``HTTPException``
      here.

    On success it requests a ``settings_changed`` solve in the same transaction under
    the row lock (the order ``request_solve`` requires): the fixtures just changed
    wholesale — a re-cut deleted the old rows (any pins died with them) and a first cut
    minted the day's inputs. The cut *is* the drawn event, so no drawn-event gate is
    needed; a ``None`` return (Redis down) deliberately costs the solve, never the cut.

    Commits, then reads the draw back through :func:`fixtures_by_event` — the same
    loader the detail page reads it through — so the fixtures this answers with are
    byte-for-byte the ones the page will show. Never raises ``HTTPException``.
    """
    event = await _load_owned_event_for_draw(
        db, tournament_id=tournament_id, event_id=event_id, actor=actor
    )
    await _enforce_unplayed(db, event)
    try:
        await cut_draw(db, event)
    except DrawError:
        # The domain refusing to produce a draw is not a bug — it is an answer, and it
        # is the caller's to act on. Roll back (a DrawError is raised before the DELETE,
        # so nothing is written, but the rollback clears the session and preserves the
        # router's inline behaviour) and let the error propagate: the adapter composes
        # the 422 sentence, the core stays FastAPI-free.
        await db.rollback()
        raise
    await request_solve(db, tournament_id, ScheduleSolveTrigger.settings_changed)
    await db.commit()
    return (await fixtures_by_event(db, [event.id]))[event.id]


async def uncut_event_draw(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    actor: User,
) -> None:
    """Un-cut the draw of the event ``actor`` owns: delete its fixtures, leaving the
    event with no draw.

    The same 404 → 403 → 409 ordering, and the same row lock, as
    :func:`cut_event_draw`: this verb deletes what that verb writes, and the guard that
    protects the fixtures cannot depend on which caller is asking. An event with **no
    draw is already in the state this asks for**, so un-cutting a never-cut draw
    deletes nothing and is a success (the router answers 204 either way) — which is
    why the solve trigger is read off ``had_draw`` below, not assumed.

    On a real un-cut of a draw it requests a ``settings_changed`` solve in the same
    transaction under the row lock, gated on a drawn event **surviving** the un-cut
    (``tournament_has_drawn_event``): un-cutting the only draw leaves nothing to place,
    and a solve over an empty board is a no-op ledger entry. A ``None`` return (Redis
    down) deliberately costs the solve, never the un-cut. Never raises an
    ``HTTPException``.
    """
    event = await _load_owned_event_for_draw(
        db, tournament_id=tournament_id, event_id=event_id, actor=actor
    )
    await _enforce_unplayed(db, event)
    # Read before the DELETE: whether this verb is about to change anything at all. The
    # idempotent un-cut of a never-cut draw deletes nothing and must trigger nothing.
    had_draw = await event_has_draw(db, event.id)
    await uncut_draw(db, [event.id])
    if had_draw and await tournament_has_drawn_event(db, tournament_id):
        await request_solve(db, tournament_id, ScheduleSolveTrigger.settings_changed)
    await db.commit()
