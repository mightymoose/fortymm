"""The completion→advance seam (ADR-0788): when a match completes, move its draw.

A tournament match is an ordinary :class:`~app.models.match.Match` that a fixture
materialized into (#788). When one *completes*, the draw it belongs to has to reflect
it: the fixture's ``winner_entry_id`` is written, the draw is re-``advance()``d, and any
fixture the result just made ready becomes a match in turn. :func:`on_match_completed`
is that one synchronous call, run **inside the completion transaction** the score
endpoints already hold (ADR-0009's match row lock) — so "result accepted ⟹ the draw
reflects it" is atomic, not eventually-consistent, and there is no queue or event bus to
reason about for a mechanism with exactly one consumer.

It is called from a single :func:`~app.result_acceptance.finalize_match` helper that
both completion sites funnel through — the rated accept/retire path and the unrated
immediate-self-accept path — so a future third path cannot forget the hook.

The dependency points **one way**: this imports the match models, the draw layer, the
materializer and the solve-request seam (``app.schedule_solves``); nothing in the match,
draw or scheduling domain imports it, and it is imported only by
``app.result_acceptance``, so there is no cycle.

For round-robin — the only draw type with a strategy today — the pool is already whole
at go-live, so ``advance()`` after a completion is empty and nothing new materializes:
the seam records the winner and does no more. That is the uniform seam being *honestly*
empty, not dead code — the same call seats a single-elim winner into the next round the
moment #785 lands.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Match,
    ScheduleSolveTrigger,
    Tournament,
    TournamentEvent,
    TournamentFixture,
)
from app.schedule_solves import request_solve
from app.tournament_materialization import materialize_event
from app.tournament_realtime import stage_event_entrant_hints


async def on_match_completed(db: AsyncSession, match: Match) -> None:
    """Advance the draw a just-completed ``match`` belongs to (ADR-0788).

    Looks the fixture up by ``match_id`` (indexed) and **returns early on a miss** — the
    common case, since almost no match is a tournament match. Otherwise it writes the
    fixture's ``winner_entry_id`` from the winning side (**side 1 → ``entry_a``, side 2
    → ``entry_b``**, the fixed materialization convention of #788), then re-runs the
    draw's ``advance()`` and materializes anything newly ready via
    :func:`~app.tournament_materialization.materialize_event`.

    Every **active entrant of the event** — not merely the two who played — gets a
    staged ``dashboard.changed`` hint, because the panel's standings are projected
    from the whole pool, so a completion moves the position of players who were not
    in it (:func:`app.tournament_realtime.stage_event_entrant_hints`). It is staged
    rather than published for the same reason the function does not commit: the
    caller owns the transaction boundary, and only a commit makes the advance true.
    The early return above is what keeps an ordinary ladder match from hinting a
    tournament audience it has none of.

    Runs in the caller's transaction under the match row lock; does **not** commit. The
    match's sides carry their ``won`` flags already — ``finalize_match`` stamped them
    immediately before calling this — so the winning side is read straight off the
    loaded match with no extra query.

    ``winner_entry_id`` is written on every completion for the uniform mechanism (and as
    the substrate single-elim's ``advance()`` will plan from), even though **no
    round-robin read path reads it** — the standings derive from the live matches for
    correction-safety (ADR-0788). It is written-but-unread in round-robin, the accepted
    price of one seam; a correction that un-completes the match simply stops
    re-advancing it until it is re-accepted.

    A completed tournament match is also a **scheduling input** (ADR "the schedule is
    solved; the call is pinned"): its table frees, so a ``match_completed`` re-solve is
    requested last, through the one coalesced :func:`~app.schedule_solves.request_solve`
    funnel — a burst of finishes collapses onto one queued run. ``request_solve``'s
    contract asks its caller to hold the tournament row lock first (lock order:
    tournament → schedule_solves → tournament_fixtures, the order the solve job's
    guarded apply takes), and ``finalize_match`` holds only the *match* row lock — so
    this function takes the tournament lock itself, **before any fixture write
    flushes**. That ordering is load-bearing: the winner write below reaches Postgres
    at the next autoflush, and a fixture row lock taken before the tournament lock
    would run fixtures → tournament against the apply's tournament → fixtures — a
    deadlock waiting for a busy venue. (No solve-side transaction ever locks a match
    row, so the match lock this runs under joins no cycle.) The lock also serializes
    the winner write itself against a mid-flight apply, which the pre-solver code
    never guaranteed. A ``None`` from ``request_solve`` (Redis down: it logged, and
    took its row back out) is DELIBERATELY tolerated — the accepted result must stand
    whether or not the scheduler heard about it; the pin tick and the Run-scheduler
    button re-request the missing solve.
    """
    fixture = (
        await db.execute(
            select(TournamentFixture).where(TournamentFixture.match_id == match.id)
        )
    ).scalar_one_or_none()
    if fixture is None:
        return

    event = (
        await db.execute(
            select(TournamentEvent).where(TournamentEvent.id == fixture.event_id)
        )
    ).scalar_one()
    # The tournament row lock, and it must come before the winner assignment:
    # once ``fixture`` is dirty, the next SELECT autoflushes the UPDATE and
    # takes the fixture's row lock — which must never precede the tournament's
    # (see the docstring's lock-order paragraph).
    tournament = (
        await db.execute(
            select(Tournament)
            .where(Tournament.id == event.tournament_id)
            .with_for_update()
        )
    ).scalar_one()

    winning_side = next((side for side in match.sides if side.won is True), None)
    if winning_side is not None:
        fixture.winner_entry_id = (
            fixture.entry_a_id if winning_side.side_number == 1 else fixture.entry_b_id
        )

    await materialize_event(db, tournament, event)
    # The advance moved everyone's panel in this event, not just the two who played
    # it: the standings table the panel shows is projected from the event's whole
    # pool (ADR-0788), so a third player's position can change without them
    # touching a bat. Their participants-only hint (``finalize_match`` stages that
    # one) would never reach them. Staged, not published — this function runs in
    # the caller's transaction and deliberately does not commit, so publishing here
    # would announce a completion that a later rollback un-did.
    await stage_event_entrant_hints(db, [event.id])
    await request_solve(db, tournament.id, ScheduleSolveTrigger.match_completed)
