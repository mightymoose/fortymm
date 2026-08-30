"""The transport-neutral core of proposing a match result (first + counter).

The first verb of the two-verb negotiation (propose → accept) used to live
inline in the ``app.matches`` router handler (``post_match_result``): ~130 lines
of row-locking, board compaction, the first-post-vs-counter negotiation gates,
``finalize_match``, and fire-and-forget notifications. It's extracted here as a
leaf module — the propose counterpart of ``app.result_acceptance``'s
``accept_standing_result`` — so a second caller (the MCP server, a script, a
worker) can drive the same flow without an HTTP request.

Following ``api/CLAUDE.md``'s rule of thumb, propose is a plain module-level
async function taking ``db`` rather than a class-plus-provider: none of its
collaborators is worth injecting. It returns the reloaded domain :class:`Match`
plus whether acceptance is now awaited (:class:`ProposedResult`), and signals
every rejection with a domain exception from ``app.match_errors`` —
:class:`MatchClosedError`, :class:`UndecidedBoardError`,
:class:`NegotiationConflictError` (carrying the loaded ``Match`` so an adapter
can rebuild the viewer-relative snapshot), and the already-existing
:class:`MatchLockUnavailable` (from ``app.match_scoring``) — never
``HTTPException``. The HTTP handler is a
thin adapter that maps each back to the exact status and body it produced
before; the MCP adapter maps the same exceptions to ``ToolError``s.

This module also hosts the small pure helpers the propose path owns — the
finalize-superset eager-load (:func:`match_rating_eager_options`), the canonical
board commit + snapshot (:func:`_commit_canonical_games` /
:func:`_result_games_snapshot`), and the rated-round-trip predicate
(:func:`_requires_confirmation`) — so both the service and the router import them
from one place rather than the router owning them.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlalchemy.sql.base import ExecutableOption

from app.match_errors import (
    MatchClosedError,
    MatchNotFoundError,
    NegotiationConflictError,
    UndecidedBoardError,
)
from app.match_queries import match_eager_options
from app.match_realtime import stage_match_participant_hints
from app.match_scoring import (
    MatchLockUnavailable,  # re-exported for the router adapter
    _MatchWriteLoader,
    load_match_for_write,
)
from app.match_serialization import (
    compact_games,
    is_participant,
    validate_finalize_games,
)
from app.models import (
    League,
    Match,
    MatchGame,
    MatchGameScore,
    MatchResult,
    MatchStatus,
)
from app.result_acceptance import finalize_match
from app.result_chain import standing_result
from app.schemas.match import MatchResultsGameWrite

__all__ = [
    "MatchLockUnavailable",
    "ProposedResult",
    "match_rating_eager_options",
    "propose_result",
]


# A match that has reached one of these states is read-only — closed to new
# proposals. A completed match has an accepted head, so the result-existence
# gates would 409 a first-post against it anyway; but a match voided *before* any
# result was posted has no results to gate on, so the status guard is what keeps
# a first-post from silently un-voiding it.
_TERMINAL_STATUSES = {
    MatchStatus.completed,
    MatchStatus.voided,
}


# The finalize/score-write superset: everything a read needs, plus the league's
# rating strategy that ``_apply_rating_update`` reads when a completing match
# applies ratings. Under async SQLAlchemy a lazy access on the unloaded
# ``league.rating_strategy`` would raise ``MissingGreenlet`` mid-request, so the
# two paths that finalize a match must load it up front rather than rely on the
# shared read chain.
def match_rating_eager_options() -> tuple[ExecutableOption, ...]:
    return (
        *match_eager_options(),
        selectinload(Match.league).selectinload(League.rating_strategy),
    )


def _all_sides_have_players(match: Match) -> bool:
    """Solo matches (no opponent picked) carry one player-less sentinel side.
    The acceptance flow needs a second human, so solo matches skip it entirely;
    this is the predicate that detects that case."""
    return len(match.sides) >= 2 and all(side.players for side in match.sides)


def _requires_confirmation(match: Match, submitted_by_user_id: uuid.UUID) -> bool:
    """Only a rated match, proposed BY A PARTICIPANT, goes through the accept
    round-trip. Acceptance exists to protect ratings from one-sided claims; an
    unrated match has no stakes worth a second party's consent, and a solo
    match has no second human to accept anyway (rated already implies a
    registered opponent at creation — the player check is defensive).

    The submitter-is-a-participant conjunct is what makes a tournament
    director's result authoritative (#1523): a director is not a side, so the
    round trip that exists to protect a claim FROM a side doesn't apply to a
    claim made BY someone who isn't one. A director-submitted proposal (first
    post or a supersede of a player's standing one) always self-finalizes
    through the same branch below a solo/unrated match already takes — never a
    second completion path, and never left standing for anyone to "accept" on
    the director's behalf. This is also the invariant the three
    submitter-relative reads downstream (``result_acceptance``'s
    submitter-side accept guard, the retirement sweep's owing-side resolution,
    the dashboard/list waiting-vs-actionable split) all lean on: none of them
    ever sees a standing result whose submitter isn't a participant."""
    return (
        match.match_settings.affects_rating
        and _all_sides_have_players(match)
        and is_participant(match, submitted_by_user_id)
    )


def _result_games_snapshot(
    games: list[MatchResultsGameWrite],
) -> list[dict[str, int]]:
    """The immutable JSONB snapshot stored on a ``MatchResult`` — the claimed
    board frozen at post time, ordered by game number."""
    return [
        {
            "game_number": g.game_number,
            "side_1_points": g.side_1_points,
            "side_2_points": g.side_2_points,
        }
        for g in sorted(games, key=lambda g: g.game_number)
    ]


async def _commit_canonical_games(
    db: AsyncSession,
    match: Match,
    games: list[MatchResultsGameWrite],
) -> None:
    """Replace ``match.games`` (and the attached score rows) with the canonical
    board and set ``side.score`` from it. **Does not change ``match.status`` or
    ``side.won``** — the caller picks whether the result is final (solo/unrated:
    immediately at propose) or awaiting acceptance (rated), and stamps
    ``side.won`` via ``_set_side_won`` only at that final moment."""
    # ``Match.games`` cascades ``all, delete-orphan``; clearing the collection
    # marks each existing MatchGame (and via MatchGame.score's own cascade, the
    # MatchGameScore) for delete. We must flush the deletes before inserting new
    # games at the same numbers, otherwise the
    # ``uq_match_games_match_id_game_number`` constraint trips during autoflush.
    match.games.clear()
    await db.flush()

    for game in sorted(games, key=lambda g: g.game_number):
        match.games.append(
            MatchGame(
                game_number=game.game_number,
                score=MatchGameScore(
                    side_1_points=game.side_1_points,
                    side_2_points=game.side_2_points,
                ),
            )
        )

    new_wins: dict[int, int] = {1: 0, 2: 0}
    for g in games:
        new_wins[1 if g.side_1_points > g.side_2_points else 2] += 1
    for side in match.sides:
        side.score = new_wins.get(side.side_number, 0)


async def _load_match(db: AsyncSession, match_id: uuid.UUID) -> Match | None:
    """Reload a match with the full read eager-load chain (nullable — used for
    the concurrent-counter conflict reload, where the match's absence collapses
    to today's 404)."""
    result = await db.execute(
        select(Match).where(Match.id == match_id).options(*match_eager_options())
    )
    return result.scalar_one_or_none()


async def _reload_proposed_match(db: AsyncSession, match_id: uuid.UUID) -> Match:
    """Reload the just-committed match with the full read eager-load chain.

    Returns a non-optional :class:`Match`: the row was committed one statement
    earlier in the same session, so its absence is a genuine invariant violation,
    not a client-handleable ``None`` (``api/CLAUDE.md``)."""
    match = await _load_match(db, match_id)
    if match is None:
        raise RuntimeError(f"just-proposed match {match_id} vanished before reload")
    return match


@dataclass(frozen=True)
class ProposedResult:
    """The outcome of :func:`propose_result`: the reloaded domain ``match``
    (ready to serialise) and ``awaiting_acceptance`` — ``True`` only for a rated
    two-human match that now leaves the opposing side owing an acceptance, so the
    adapter knows whether to fire the accept/counter notification."""

    match: Match
    awaiting_acceptance: bool


async def propose_result(
    db: AsyncSession,
    match_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    games: list[MatchResultsGameWrite],
    supersedes_result_id: uuid.UUID | None,
    load_match: _MatchWriteLoader = load_match_for_write,
) -> ProposedResult:
    """Propose a result for a match — the first verb of the propose/accept
    negotiation — and return the reloaded match plus whether acceptance is now
    awaited.

    Loads under the ``NOWAIT`` match row lock (a held lock surfaces as
    :class:`MatchLockUnavailable`, which propagates), rejects a terminal match
    (:class:`MatchClosedError`), compacts + validates the board
    (:class:`UndecidedBoardError` on an undecided/invalid board), then runs the
    first-post-vs-counter gates: a first proposal (``supersedes_result_id`` None)
    requires no result exists; a counter must target the live standing proposal —
    either miss raises :class:`NegotiationConflictError` carrying the loaded
    ``Match``. It commits the canonical board and appends the ``MatchResult``,
    self-accepting + finalizing solo/unrated matches immediately (``side.won`` and
    the rating update fire here) — as does ANY proposal submitted by a
    non-participant, i.e. the tournament's director (#1523): a director's result
    is authoritative and is never left standing for someone to accept on their
    behalf, first post or supersede alike — or leaving the result *standing*
    (status ``in_progress``) for a rated two-human match proposed by one of its
    own participants. On the ``uq_match_results_supersedes_result_id`` race it
    reloads and raises :class:`NegotiationConflictError` with the moved-on state.

    ``load_match`` defaults to the FastAPI-free :func:`load_match_for_write`; the
    HTTP handler injects ``matches._load_match_for_scoring`` so the router's
    monkeypatchable, ``HTTPException``-mapping load seam stays the one it
    exercises. Never raises ``HTTPException`` — the caller adapts it to its
    transport."""
    match = await load_match(
        db,
        match_id,
        user_id,
        lock=True,
        nowait=True,
        options=match_rating_eager_options(),
    )

    if match.status in _TERMINAL_STATUSES:
        raise MatchClosedError("This match is no longer open to results.")

    # NOTE: no scorability guard here. The scratchpad-scorable guard is false the
    # instant any result exists (#715), so a counter — which by design supersedes
    # an existing result — would be rejected before it could supersede. Propose
    # has its OWN gates below (first-post vs counter) instead.

    # Compact once, upstream of every consumer below (validate_finalize_games,
    # _commit_canonical_games, and the immutable _result_games_snapshot), so the
    # minted board is contiguous (see ``compact_games``). Covers both the first
    # proposal and the counter.
    compacted = compact_games(games)

    # Decided-board hard gate — the strict precondition: an undecided board can't
    # be a result.
    try:
        decided_side = validate_finalize_games(compacted, match.match_settings.best_of)
    except ValueError as exc:
        raise UndecidedBoardError(str(exc)) from exc

    if supersedes_result_id is None:
        # First proposal: only valid when no result exists yet. A concurrent
        # first-post (or any existing chain) loses here with the current state.
        if match.results:
            raise NegotiationConflictError(match)
    else:
        # Counter: must target the live standing proposal. If it was already
        # accepted or superseded by a concurrent counter, the id won't match.
        standing = standing_result(match)
        if standing is None or supersedes_result_id != standing.id:
            raise NegotiationConflictError(match)

    # Sync the canonical ``match_games`` to the proposed board so the scoreboard
    # ``games``/``can_score`` rendering stays correct. After the first post the
    # scratchpad is frozen, so ``match_games`` stays == the standing snapshot.
    await _commit_canonical_games(db, match, compacted)

    result = MatchResult(
        submitted_by_user_id=user_id,
        games=_result_games_snapshot(compacted),
        supersedes_result_id=supersedes_result_id,
    )
    match.results.append(result)

    # Only a rated two-human match, proposed by one of its own participants,
    # leaves the other side owing an acceptance (#1523: a director's proposal
    # never does, regardless of rated/solo — see ``_requires_confirmation``).
    awaiting_acceptance = _requires_confirmation(match, user_id)
    if not awaiting_acceptance:
        # Solo / unrated / director path: no second acceptance needed — the
        # proposer self-accepts and the match finalizes immediately (stamping
        # ``completed_at``). A solo match has no second human to accept, and a
        # director is not a side for anyone else to accept on behalf of, so
        # either way the proposer's own id is recorded as the acceptor.
        result.accepted_by_user_id = user_id
        result.accepted_at = datetime.now(UTC)
        # The one completion path shared with the rated accept (``finalize_match``):
        # mark completed, stamp ``side.won``, run the rating update, and advance
        # any tournament draw this match belongs to (#789).
        await finalize_match(db, match, decided_side)
    else:
        # Rated path: the result stays standing (unaccepted) and ``side.won``
        # stays unset until the opposing side accepts. Status is (re)set to
        # in_progress.
        match.status = MatchStatus.in_progress

    # A proposal changes both participants' dashboards even when nothing
    # completed: the proposer's match moves to "waiting on them", and the other
    # side gains the "needs your attention" review row. Staged inside this
    # transaction, so the concurrent-counter rollback below discards it — a
    # proposal that lost the race proposed nothing. The solo/unrated branch above
    # already staged the same hints inside ``finalize_match``; the outbox dedupes
    # ``(user_id, kind)``, so that path still publishes exactly once per player.
    #
    # No query: ``match.sides`` → ``players`` come loaded on
    # ``match_rating_eager_options()``.
    stage_match_participant_hints(db, match)

    try:
        await db.commit()
    except IntegrityError as exc:
        # ``uq_match_results_supersedes_result_id``: two concurrent counters
        # raced to supersede the same parent and the other one won. Reload and
        # surface the moved-on negotiation state (a vanished match collapses to
        # today's 404 via :class:`MatchNotFoundError`).
        await db.rollback()
        reloaded = await _load_match(db, match_id)
        if reloaded is None:
            raise MatchNotFoundError() from exc
        raise NegotiationConflictError(reloaded) from exc

    reloaded = await _reload_proposed_match(db, match_id)
    return ProposedResult(match=reloaded, awaiting_acceptance=awaiting_acceptance)
