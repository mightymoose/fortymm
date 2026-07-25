"""Who a match write's dashboard hint goes to.

The match half of the pair whose tournament half is
:mod:`app.tournament_realtime`, and the same question at a narrower scope: the
dashboard's match rows are the caller's *own* matches, so the audience of a match
write's ``dashboard.changed`` hint is exactly that match's **participants** (ADR
"realtime topics are per-user, and the server resolves who is affected"). Where
the tournament side has to *read* its audience — active entrants of an event —
this side already holds it: the participants are on the match the write path is
mutating. Participants are a subset of the entrants the tournament side hints
when the same write also moves a draw, and both are staged into the same
per-``(user_id, kind)`` outbox, so the overlap costs one publish, not two.

It lives in its own module rather than on :mod:`app.result_acceptance` because
three write services need it — result acceptance's ``finalize_match``, the
per-game scoring writes in :mod:`app.match_scoring`, and the proposal write in
:mod:`app.result_proposal` — and a shared domain helper reached by importing
another service's private name is precisely what api/CLAUDE.md's "don't import
another router's internals" rules out.

Hints are **staged**, never published: every caller runs inside a transaction it
does not own the boundary of (all three hold the match row lock and leave the
commit to their caller), and a hint published before that commit invites the
client to refetch the pre-commit state. :func:`~app.realtime.outbox.stage_event`
ties each hint to the transaction's fate instead.
"""

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Match
from app.realtime import EventKind, stage_event


def stage_match_participant_hints(db: AsyncSession, match: Match) -> None:
    """Stage a ``dashboard.changed`` hint for each player on ``match``.

    The affected set is exactly the participants: a match write clears (or
    raises) their "needs your attention" row and, on completion, moves their
    rating; it changes nothing on anyone else's dashboard.

    No query — ``match.sides`` → ``players`` are already loaded on every path
    that reaches here (``match_rating_eager_options`` for the two router paths,
    ``retirement_jobs._eager_options`` for the sweep), which is also why
    ``_set_side_won`` can iterate them synchronously alongside this call.

    Iterates the players rather than indexing ``players[0]``: a solo match's
    sentinel side legitimately has none, and it simply contributes no hint.
    """
    for side in match.sides:
        for player in side.players:
            stage_event(db, player.user_id, EventKind.dashboard_changed)
