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

The dependency points **one way**: this imports the match models, the draw layer and the
materializer; nothing in the match or draw domain imports it, and it is imported only by
``app.result_acceptance``, so there is no cycle.

For round-robin — the only draw type with a strategy today — the pool is already whole
at go-live, so ``advance()`` after a completion is empty and nothing new materializes:
the seam records the winner and does no more. That is the uniform seam being *honestly*
empty, not dead code — the same call seats a single-elim winner into the next round the
moment #785 lands.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Match, Tournament, TournamentEvent, TournamentFixture
from app.tournament_materialization import materialize_event


async def on_match_completed(db: AsyncSession, match: Match) -> None:
    """Advance the draw a just-completed ``match`` belongs to (ADR-0788).

    Looks the fixture up by ``match_id`` (indexed) and **returns early on a miss** — the
    common case, since almost no match is a tournament match. Otherwise it writes the
    fixture's ``winner_entry_id`` from the winning side (**side 1 → ``entry_a``, side 2
    → ``entry_b``**, the fixed materialization convention of #788), then re-runs the
    draw's ``advance()`` and materializes anything newly ready via
    :func:`~app.tournament_materialization.materialize_event`.

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
    """
    fixture = (
        await db.execute(
            select(TournamentFixture).where(TournamentFixture.match_id == match.id)
        )
    ).scalar_one_or_none()
    if fixture is None:
        return

    winning_side = next((side for side in match.sides if side.won is True), None)
    if winning_side is not None:
        fixture.winner_entry_id = (
            fixture.entry_a_id if winning_side.side_number == 1 else fixture.entry_b_id
        )

    event = (
        await db.execute(
            select(TournamentEvent).where(TournamentEvent.id == fixture.event_id)
        )
    ).scalar_one()
    tournament = (
        await db.execute(select(Tournament).where(Tournament.id == event.tournament_id))
    ).scalar_one()
    await materialize_event(db, tournament, event)
