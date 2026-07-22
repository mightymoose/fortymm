"""The transport-neutral fixture-placement write verb.

The orchestration behind
``PATCH /v1/tournaments/{id}/fixtures/{fixture_id}/placement`` (set or clear a
fixture's table + predicted start — ADR-0790), extracted out of the router so it can
run without FastAPI: from the HTTP adapter (``app.tournaments.place_fixture``) and
from the MCP ``place_fixture`` tool alike, and be constructed in a plain REPL with a
raw session.

The route is addressed by ``tournament_id`` + ``fixture_id`` (the fixture is scoped to
its tournament — there is no ``event_id`` in the path), and it is **owner-only**, like
every other tournament mutation. The whole pin/notify transition lives in
``app.match_calls.apply_manual_placement`` — the director's hand is a human commitment
the schedule solver plans around (ADR "the schedule is solved; the call is pinned") —
and this verb supplies the tournament row lock, the freeze, the ``settings_changed``
re-solve enqueue, the commit, the post-commit push/email fan-out, and the read-back.

Per the tournament-verbs ADR (mirroring ``tournament_lifecycle`` /
``tournament_events`` / ``tournament_entries`` / ``tournament_edit``), it signals every
refusal with a **domain exception** from ``app.tournament_errors`` — never an
``HTTPException`` — and each adapter maps it back to the exact response it produced
before. ``apply_manual_placement`` raises no refusal of its own (the placement is soft,
ADR-0790: an out-of-window time or a dangling ``table_id`` SAVES), so the two coded
refusals — a missing fixture (:class:`FixtureNotFoundError`) and a played-out fixture
(:class:`FixturePlacementFrozenError`) — are judged here, before it is called.
"""

import uuid
from typing import assert_never

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.match_calls import apply_manual_placement, enqueue_call_fanout
from app.models import (
    Match,
    MatchStatus,
    ScheduleSolveTrigger,
    TournamentEvent,
    TournamentFixture,
    User,
)
from app.schedule_solves import request_solve
from app.schemas.tournament import (
    TournamentFixturePlacementUpdate,
    TournamentFixtureRead,
)
from app.tournament_edit import _load_owned_tournament_for_update
from app.tournament_errors import (
    FixtureNotFoundError,
    FixturePlacementFrozenError,
)
from app.tournament_queries import fixtures_by_event


async def _load_fixture_for_placement(
    db: AsyncSession, tournament_id: uuid.UUID, fixture_id: uuid.UUID
) -> tuple[TournamentFixture, MatchStatus | None, str]:
    """The fixture named in the URL — scoped to the tournament — its linked match's
    live status (``None`` when the fixture has not materialized), and the venue
    ``timezone`` of its event (the IANA zone that anchors a placement's wall-clock
    ``scheduled_start`` to a real instant), or raise :class:`FixtureNotFoundError`.

    The FastAPI-free twin of the router's ``_get_fixture_or_404``: scoped by BOTH ids
    — fixture → event → tournament — so a fixture that exists but hangs off a
    *different* tournament is a miss, not a cross-tournament placement, exactly as
    ``_load_event`` scopes an event by its tournament. The match status rides on the
    same statement (a LEFT join on ``match_id``, one row per fixture) because it is the
    single fact the freeze judges (ADR-0790): a fixture whose match is
    ``completed``/``voided`` is history and can no longer be moved. Never an
    ``HTTPException``.
    """
    row = (
        await db.execute(
            select(TournamentFixture, Match.status, TournamentEvent.timezone)
            .join(TournamentEvent, TournamentEvent.id == TournamentFixture.event_id)
            .outerjoin(Match, Match.id == TournamentFixture.match_id)
            .where(
                TournamentFixture.id == fixture_id,
                TournamentEvent.tournament_id == tournament_id,
            )
        )
    ).one_or_none()
    if row is None:
        raise FixtureNotFoundError()
    fixture, match_status, event_timezone = row
    return fixture, match_status, event_timezone


def _enforce_fixture_placeable(match_status: MatchStatus | None) -> None:
    """Raise :class:`FixturePlacementFrozenError` unless this fixture may still be
    (re)placed — the ONE hard rule of an otherwise-soft endpoint (ADR-0790).

    A fixture whose linked match is ``completed`` or ``voided`` is **history**: its
    placement records where and when the match actually happened, so the move is
    refused. A fixture with no match yet (``None``) or a ``pending``/``in_progress`` one
    is freely (re)placeable — a round-robin match is born ``pending`` at go-live and
    only becomes ``in_progress`` when called, so neither status is the freeze trigger.
    Only ``completed``/``voided`` freezes.

    A ``match`` with ``assert_never``, not an ``in {completed, voided}`` test: a new
    ``MatchStatus`` is a type error here until somebody decides whether a fixture in it
    may be moved, rather than falling through to placeable — a freeze must never fail in
    the permissive direction.
    """
    match match_status:
        case MatchStatus.completed | MatchStatus.voided:
            raise FixturePlacementFrozenError(match_status.value)
        case MatchStatus.pending | MatchStatus.in_progress | None:
            return
        case _:
            assert_never(match_status)


async def place_fixture(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    fixture_id: uuid.UUID,
    actor: User,
    placement: TournamentFixturePlacementUpdate,
) -> TournamentFixtureRead:
    """Set (or clear) a fixture's **placement** — its table and its predicted start
    (ADR-0790) — for a fixture under the tournament ``actor`` owns, and return the
    updated :class:`TournamentFixtureRead`.

    Runs the same orchestration the HTTP handler used to run inline, in the same order
    and under the same lock (see the module docstring):

    * **Load-lock, then owner-gate (404 → 403).** The tournament is loaded through the
      shared :func:`_load_owned_tournament_for_update` (the ``FOR UPDATE`` row lock,
      raising :class:`TournamentNotFoundError`, then the owner gate raising
      :class:`NotTournamentOwnerError`), so a stranger's refusal never leaks whether an
      absent id existed. The lock is essential: this route WRITES ``TournamentFixture``
      rows, and ``cut_draw``/``uncut_draw`` delete-and-replace an event's fixtures
      wholesale under this same tournament lock — without it, a concurrent cut can turn
      the UPDATE into a ``StaleDataError`` 500. Same lock, same row, taken first, as the
      transition, entry, and draw verbs: one lock, one order, so no pair can deadlock.
    * **404** — the fixture is loaded scoped to this tournament
      (:func:`_load_fixture_for_placement`); a mismatched pair raises
      :class:`FixtureNotFoundError`, alongside its match's live status and its event's
      timezone.
    * **409** — the one hard rule, before anything is written: a played-out
      (``completed``/``voided``) fixture keeps its placement
      (:func:`_enforce_fixture_placeable`, raising
      :class:`FixturePlacementFrozenError`). Everything else — an odd time, a dangling
      table ref — saves (the write is soft, ADR-0790).

    Then the whole pin/notify transition runs through
    :func:`app.match_calls.apply_manual_placement` on this open transaction (a
    full placement pins and, while live, notifies both entrants; anything less unpins),
    a ``settings_changed`` re-solve is queued (the director changed the solver's
    inputs), the transaction commits, and the returned push/email fan-out is enqueued
    **post-commit** (best-effort — the pin and its in-app rows are already durable). A
    ``None`` return from ``request_solve`` (Redis down) is deliberately ignored: the
    placement is what the director asked for, and the missing solve self-heals via the
    pin tick / Run-scheduler button.

    Reads the placed fixture back through the SAME :func:`fixtures_by_event` loader the
    detail page reads fixtures through, so the answer is byte-for-byte the one the page
    will show. Never raises ``HTTPException`` — the caller adapts each domain exception
    to its transport.
    """
    # 404 → 403: the locked owner-load welds the tournament 404 to the row lock, then
    # the owner gate, before the fixture — let alone its placement state — is looked at.
    tournament = await _load_owned_tournament_for_update(db, tournament_id, actor)
    # The fixture, scoped to this tournament (a mismatched pair is a 404), and its
    # match's live status — the single fact the freeze judges.
    fixture, match_status, event_timezone = await _load_fixture_for_placement(
        db, tournament_id, fixture_id
    )
    # The one hard rule, before anything is written: a played-out fixture keeps its
    # placement. Everything else — an odd time, a dangling table ref — saves.
    _enforce_fixture_placeable(match_status)
    # The whole pin/notify transition — columns, ``pinned_at``, in-app rows — on this
    # open transaction (the atomicity contract of ``app.match_calls``: a call and its
    # durable record commit together); the returned push/email fan-out is enqueued
    # only after the commit below. The tournament row lock held above is the lock every
    # pin writer takes first, so this write serializes with a concurrent pin tick.
    fanout = await apply_manual_placement(
        db,
        tournament,
        fixture,
        table_id=placement.table_id,
        scheduled_start=placement.scheduled_start,
        event_timezone=event_timezone,
    )
    # Scheduling-input trigger: the director just changed the solver's inputs — a new
    # pin to plan around, or a freed slot — so the board re-plans (ADR). Same
    # transaction, under the tournament row lock (the order ``request_solve`` requires);
    # no drawn-event gate, because a fixture in hand means a draw is cut by definition.
    # A ``None`` return (Redis down) deliberately costs the solve, never the placement.
    await request_solve(db, tournament_id, ScheduleSolveTrigger.settings_changed)
    await db.commit()
    # Post-commit, by design: the pin and its in-app rows are durable; push/email
    # fan-out is best-effort (``app.match_calls``'s atomicity contract).
    enqueue_call_fanout(fanout)
    # Read back through the SAME loader the detail page reads fixtures through, so the
    # placed fixture this answers with is byte-for-byte the one the page will show. The
    # fixture is in the batch we just committed, so the lookup always finds it.
    fixtures = (await fixtures_by_event(db, [fixture.event_id]))[fixture.event_id]
    return next(f for f in fixtures if f.id == fixture.id)
