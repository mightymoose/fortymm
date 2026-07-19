"""The transport-neutral core of the per-game scratchpad score writes.

The three per-game score mutations — create, update, delete — used to live
inline in the ``app.matches`` router handlers. They're extracted here as a leaf
module so a second caller (the MCP server, a script, a worker) can drive the
same "save / clear scratchpad state" flow without an HTTP request.

This module owns the **entire FastAPI-free write path**, in two layers:

- The high-level entry points (:func:`enter_game_score`, :func:`update_game_score`,
  :func:`delete_game_score`) take a ``match_id`` + ``user_id`` and drive the full
  flow — load+lock+participant (:func:`load_match_for_write`), scorability
  (:func:`ensure_scorable`), best-of range and no-overrun guards, then the
  mutation — raising a family of domain exceptions instead of ``HTTPException``.
  Both the HTTP handlers in ``app.matches`` and the MCP tools call these; each
  adapts the domain exceptions to its transport (the HTTP adapter reproduces the
  exact status + body it produced before, so the wire contract is unchanged).
- The low-level ``_*_locked`` helpers take an already-loaded, row-locked,
  participation-checked, guard-passed :class:`Match`, mutate the board, and
  return the reloaded :class:`Match` ready to serialise. They own the one race
  the guards can't pre-empt: the concurrent-participant score conflict, signalled
  with the domain :class:`ScoreConflictError` (carrying the committed score).

Following ``api/CLAUDE.md``'s rule of thumb, each is a plain module-level async
function taking ``db`` rather than a class-plus-provider: none has a collaborator
worth injecting.
"""

import uuid
from collections.abc import Awaitable
from typing import Any, Protocol, cast

from sqlalchemy import CursorResult, select, update
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.base import ExecutableOption

from app.match_errors import (
    MatchNotFoundError,
    MatchNotScorableError,
    ScoreConflictError,
    ScoreNotAllowedError,
)
from app.match_queries import match_eager_options
from app.match_serialization import (
    _first_decider,
    _games_payload_from_match,
    _is_participant,
    _is_scorable,
    _score_view,
)
from app.models import Match, MatchGame, MatchGameScore, MatchStatus
from app.result_acceptance import _games_to_win
from app.schemas.match import MatchDetailsScore, MatchResultsGameWrite

# ----- load + lock ---------------------------------------------------------


class MatchLockUnavailable(Exception):
    """``SELECT ... FOR UPDATE NOWAIT`` found the match row already locked by a
    concurrent negotiation transaction. Raised by ``_lock_match_row(nowait=True)``
    so the caller can translate it into a fast, clean 409 instead of blocking
    on the lock (see ``post_match_result``)."""


# Postgres SQLSTATE for a ``NOWAIT`` lock that could not be acquired.
_LOCK_NOT_AVAILABLE = "55P03"


async def _lock_match_row(
    db: AsyncSession, match_id: uuid.UUID, *, nowait: bool = False
) -> None:
    """Take a transaction-scoped row lock on the ``matches`` row so the
    negotiation transitions (``/results`` propose, ``/results/{id}/acceptance``)
    and the score writes serialize against each other.

    Without this, a participant firing two acceptances (or a propose racing an
    acceptance) concurrently lets both transactions pass their standing-result
    guard on the same pre-image and both commit — finalizing the match twice and
    applying a rating change more than once (issue #365). The lock forces the
    second transaction to wait for the first to commit and then re-read the
    post-image, so its guard returns a clean 409.

    It's a thin ``SELECT matches.id ... FOR UPDATE`` rather than adding
    ``.with_for_update()`` to the eager load query: a narrow lock-only select is
    cheaper than re-running ``match_eager_options`` (which fans out into a
    selectinload query per relationship) just to take the lock, and acquiring it
    on its own line makes the lock-then-read ordering explicit — the subsequent
    load sees the serialized state. Locking just the parent row is enough — every
    negotiation transition reads and writes that match's children under cover of
    this lock.

    ``nowait=True`` adds ``NOWAIT``: if the row is already locked, Postgres
    raises immediately instead of blocking, which we surface as
    ``MatchLockUnavailable``. ``post_match_result`` uses this so a double-tapped
    finalize doesn't park a request (and its pooled DB connection) on the lock
    for the full duration of the in-flight post — the pile-up that wedged the
    whole instance under a stray double-click (issue #641). The blocking form
    is kept for /results/{id}/acceptance, where a second concurrent caller is a
    *legitimate* acceptor that must wait, re-read, and proceed."""
    stmt = select(Match.id).where(Match.id == match_id).with_for_update(nowait=nowait)
    try:
        await db.execute(stmt)
    except DBAPIError as exc:
        if nowait and getattr(exc.orig, "sqlstate", None) == _LOCK_NOT_AVAILABLE:
            raise MatchLockUnavailable from exc
        raise


async def load_match_for_write(
    db: AsyncSession,
    match_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    lock: bool,
    nowait: bool = False,
    options: tuple[ExecutableOption, ...] | None = None,
) -> Match:
    """Load the write target for ``user_id``, optionally under the match row lock,
    and return it — the FastAPI-free core the score write path and the negotiation
    transitions share.

    ``lock`` callers take the row lock *before* the eager load so the state they
    read is the serialized one (per ADR-0009 the score endpoints lock too). The
    finalize paths pass ``options=match_rating_eager_options()`` so the rating
    hook can read ``league.rating_strategy`` without a mid-request lazy load; the
    scratchpad score endpoints take the default read chain.

    Raises :class:`MatchNotFoundError` when the match is absent *or* ``user_id``
    isn't a participant — today's score endpoints collapse both into one opaque
    404 so a non-participant can't probe existence. May raise
    :class:`MatchLockUnavailable` when ``lock`` + ``nowait`` and the row is held.
    Never an ``HTTPException`` — the caller adapts it to its transport."""
    if lock:
        await _lock_match_row(db, match_id, nowait=nowait)
    result = await db.execute(
        select(Match)
        .where(Match.id == match_id)
        .options(*(options if options is not None else match_eager_options()))
    )
    match = result.scalar_one_or_none()
    if match is None or not _is_participant(match, user_id):
        raise MatchNotFoundError()
    return match


class _MatchWriteLoader(Protocol):
    """The load seam the high-level entry points accept. Its default is
    :func:`load_match_for_write` (FastAPI-free, raising domain exceptions), but
    the HTTP score handlers inject ``matches._load_match_for_scoring`` — a thin
    wrapper that maps :class:`MatchNotFoundError` to the endpoints' historical
    ``HTTPException(404)`` — so the router's monkeypatchable load seam (the #835
    row-lock race test barriers on it) stays the one the endpoints exercise."""

    def __call__(
        self,
        db: AsyncSession,
        match_id: uuid.UUID,
        user_id: uuid.UUID,
        /,
        *,
        lock: bool,
        nowait: bool = ...,
        options: tuple[ExecutableOption, ...] | None = ...,
    ) -> Awaitable[Match]: ...


# ----- FastAPI-free write guards -------------------------------------------


def ensure_scorable(match: Match) -> None:
    """Raise :class:`MatchNotScorableError` when ``match`` can't be scored.
    ``_is_scorable`` owns the *decision*; this only picks the reason-specific
    status/message for a rejection, so the write guard can't drift from the
    ``can_score`` flag — a future gate added to ``_is_scorable`` falls through to
    the catch-all 409 rather than being silently accepted. The carried
    status+message reproduce each historical ``_enforce_scorable`` response."""
    if _is_scorable(match):
        return
    if len(match.sides) < 2:
        raise MatchNotScorableError(
            http_status=422,
            message="This match has no opponent and can't be scored.",
        )
    # Any posted result freezes the scratchpad (#715); the board now only
    # changes through propose/accept, not the score endpoints.
    if match.results:
        raise MatchNotScorableError(
            http_status=409,
            message="This match has a posted result; scores are frozen.",
        )
    # Scheduled but not yet called to a table (#1073): the schedule is
    # authoritative, so an uncalled match can't be played out-of-band.
    if match.status == MatchStatus.pending:
        raise MatchNotScorableError(
            http_status=409,
            message="This match hasn't been called to a table yet.",
        )
    # Terminal status (``completed``/``voided``) — or any future
    # ``_is_scorable`` gate without a message of its own.
    raise MatchNotScorableError(
        http_status=409, message="This match is no longer scorable."
    )


def ensure_game_in_range(match: Match, game_number: int) -> None:
    """Reject (:class:`ScoreNotAllowedError`, 422-equivalent) a write to a game
    number the match's ``best_of`` can never reach."""
    best_of = match.match_settings.best_of
    if game_number > best_of:
        raise ScoreNotAllowedError(
            f"This match is best of {best_of}; game {game_number} can't exist."
        )


def _overrun_decided_at(games: list[MatchResultsGameWrite], best_of: int) -> int | None:
    """The game number at which the match was already decided when there are
    scored games numbered *after* it ("overrun"). Returns ``None`` for empty,
    still-undecided, or exactly-decided-at-the-last-game boards — all legal
    scratchpad states.

    Gap-tolerant on purpose: it shares the decider core with the finalize
    validator but does **not** require ``1..N`` contiguity, so legitimate
    out-of-order / gappy entry (e.g. scoring game 3 first) is allowed right up
    until a side actually clinches *before* the highest-numbered scored game."""
    if not games:
        return None
    decider = _first_decider(games, _games_to_win(best_of))
    if decider is None:
        return None
    _, decided_at = decider
    if decided_at < max(g.game_number for g in games):
        return decided_at
    return None


def ensure_no_overrun(
    games: list[MatchResultsGameWrite], best_of: int, game_number: int
) -> None:
    """Reject a scratchpad write (:class:`ScoreNotAllowedError`, 422-equivalent)
    when the prospective board ``games`` would leave the match decided before its
    last scored game. Shared by both score-write paths so the check and message
    can't drift; each caller builds its own prospective board then hands it here."""
    decided_at = _overrun_decided_at(games, best_of)
    if decided_at is not None:
        raise ScoreNotAllowedError(
            f"The match was already decided at game {decided_at}; "
            f"game {game_number} can't be played."
        )


def _game_by_number(match: Match, game_number: int) -> MatchGame | None:
    return next((g for g in match.games if g.game_number == game_number), None)


async def _reload_match(db: AsyncSession, match_id: uuid.UUID) -> Match:
    """Reload the just-written match with the full read eager-load chain.

    Returns a non-optional :class:`Match`: the row was committed one statement
    earlier in the same session, so its absence is a genuine invariant
    violation, not a client-handleable ``None`` (``api/CLAUDE.md``)."""
    match = (
        await db.execute(
            select(Match).where(Match.id == match_id).options(*match_eager_options())
        )
    ).scalar_one_or_none()
    if match is None:
        raise RuntimeError(f"just-written match {match_id} vanished before reload")
    return match


async def _committed_score(
    db: AsyncSession, match_id: uuid.UUID, game_number: int
) -> MatchDetailsScore | None:
    """The game's score as it actually stands now — for the conflict body after
    a create lost the unique-constraint race (the committed row belongs to a
    different transaction, so it isn't on our in-memory ``match``)."""
    reloaded = (
        await db.execute(
            select(Match).where(Match.id == match_id).options(*match_eager_options())
        )
    ).scalar_one_or_none()
    if reloaded is None:
        return None
    game = _game_by_number(reloaded, game_number)
    return _score_view(game.score) if game and game.score else None


async def _enter_game_score_locked(
    db: AsyncSession,
    match: Match,
    *,
    game_number: int,
    side_1_points: int,
    side_2_points: int,
) -> Match:
    """Save the first score for ``game_number`` on ``match`` and return it
    reloaded. Lazily inserts the ``MatchGame`` row (the FE deeplinks straight
    into ``/games/N/scores/new`` before the game exists).

    Raises :class:`ScoreConflictError` when a concurrent participant already
    saved this game — either the in-memory board already carries a committed
    score (the common case under the router's blocking lock), or the commit
    trips ``uq_match_games_match_id_game_number`` / ``uq_match_game_scores`` as
    a residual same-game insert backstop. Both carry the committed score for the
    conflict body. Never touches ``match.status``, ``side.won``, or ratings.

    Assumes the caller loaded ``match`` under the match row lock and has already
    enforced scorability, ``game_number <= best_of``, and the no-overrun guard."""
    game = _game_by_number(match, game_number)
    if game is None:
        game = MatchGame(game_number=game_number)
        match.games.append(game)
    elif game.score is not None:
        # A concurrent participant already created this game's score — the same
        # conflict the update path guards against, just on first write. Hand
        # back the committed score so the client surfaces it for review instead
        # of overwriting it.
        raise ScoreConflictError(committed_score=_score_view(game.score))

    game.score = MatchGameScore(
        side_1_points=side_1_points,
        side_2_points=side_2_points,
    )

    try:
        await db.commit()
    except IntegrityError as exc:
        # Two participants on the same game-entry page submitting at once both
        # lazily insert the same game row (uq_match_games_match_id_game_number)
        # and/or its score (uq_match_game_scores_match_game_id). The pre-checks
        # above pass for both before either commits, so the loser of the race
        # trips a unique constraint. The committed row belongs to the winner's
        # transaction, so reload to read it for the conflict body.
        await db.rollback()
        raise ScoreConflictError(
            committed_score=await _committed_score(db, match.id, game_number)
        ) from exc

    return await _reload_match(db, match.id)


async def _update_game_score_locked(
    db: AsyncSession,
    match: Match,
    *,
    game_number: int,
    side_1_points: int,
    side_2_points: int,
    expected_version: int,
) -> Match:
    """Replace the committed score for ``game_number`` on ``match`` under
    optimistic concurrency and return it reloaded.

    The ``WHERE version = expected_version`` clause is the whole guard: if a
    concurrent participant has saved this game since the caller last read it,
    zero rows match and we raise :class:`ScoreConflictError` (carrying the score
    as it actually stands now) rather than overwrite their save. Never touches
    ``match.status``, ``side.won``, or ratings.

    Assumes the caller loaded ``match`` under the match row lock and has already
    enforced scorability, the score's existence (404), and the no-overrun
    guard on the prospective board."""
    game = _game_by_number(match, game_number)
    if game is None or game.score is None:
        # The router guards this with a 404 before delegating; reaching here is
        # an invariant violation, not a client-handleable case.
        raise RuntimeError(
            f"update_game_score for match {match.id} game {game_number} "
            "without a committed score; caller must guard"
        )

    # Optimistic concurrency: replace the points only while the committed row is
    # still at the version the caller last read.
    result = await db.execute(
        update(MatchGameScore)
        .where(
            MatchGameScore.id == game.score.id,
            MatchGameScore.version == expected_version,
        )
        .values(
            side_1_points=side_1_points,
            side_2_points=side_2_points,
            version=MatchGameScore.version + 1,
        )
    )
    if cast(CursorResult[Any], result).rowcount == 0:
        # Lost the race: a concurrent participant saved this game since the
        # caller last read it, so the conditional UPDATE matched no row. The
        # update changed nothing, so there's nothing to undo — refresh the score
        # to the value as it actually stands now and signal the conflict (the
        # caller's transaction teardown rolls the no-op transaction back).
        await db.refresh(game.score)
        raise ScoreConflictError(committed_score=_score_view(game.score))

    await db.commit()

    return await _reload_match(db, match.id)


async def _delete_game_score_locked(
    db: AsyncSession,
    match: Match,
    *,
    game_number: int,
) -> Match:
    """Clear the committed score for ``game_number`` on ``match`` and return it
    reloaded. The ``MatchGame`` row stays so a subsequent
    ``POST .../scores/new`` for the same number just attaches a fresh score row;
    delete-orphan on ``MatchGame.score`` removes the score row on flush. Never
    touches ``match.status``, ``side.won``, or ratings.

    Assumes the caller loaded ``match`` under the match row lock and has already
    enforced scorability and the score's existence (404)."""
    game = _game_by_number(match, game_number)
    if game is None or game.score is None:
        # The router guards this with a 404 before delegating; reaching here is
        # an invariant violation, not a client-handleable case.
        raise RuntimeError(
            f"delete_game_score for match {match.id} game {game_number} "
            "without a committed score; caller must guard"
        )

    game.score = None
    await db.commit()

    return await _reload_match(db, match.id)


# ----- high-level entry points ---------------------------------------------
#
# The full FastAPI-free write path both the HTTP handlers and the MCP tools
# drive: load+lock+participant, scorability, best-of range, no-overrun, then the
# mutation — raising the domain exceptions the caller adapts to its transport.
# ``load_match`` defaults to the FastAPI-free ``load_match_for_write``; the HTTP
# handlers inject ``matches._load_match_for_scoring`` so the router's
# monkeypatchable, HTTPException-mapping load seam stays the one they exercise.


async def enter_game_score(
    db: AsyncSession,
    match_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    game_number: int,
    side_1_points: int,
    side_2_points: int,
    load_match: _MatchWriteLoader = load_match_for_write,
) -> Match:
    """Save the first score for ``game_number`` and return the reloaded match.

    Loads under the blocking match row lock, enforces scorability and the
    best-of range, then — only when this game has no committed score yet — the
    no-overrun guard against the prospective board (a pre-existing committed
    score short-circuits to :class:`ScoreConflictError` below without running
    overrun, preserving the historical conflict-before-overrun ordering). The
    prospective board is the currently-scored games plus this write.

    Raises :class:`MatchNotFoundError` (absent match / non-participant),
    :class:`MatchNotScorableError`, :class:`ScoreNotAllowedError` (range or
    overrun), or :class:`ScoreConflictError` (a concurrent participant already
    scored this game)."""
    match = await load_match(db, match_id, user_id, lock=True)
    ensure_scorable(match)
    ensure_game_in_range(match, game_number)

    game = _game_by_number(match, game_number)
    if game is None or game.score is None:
        prospective = [
            g for g in _games_payload_from_match(match) if g.game_number != game_number
        ] + [
            MatchResultsGameWrite(
                game_number=game_number,
                side_1_points=side_1_points,
                side_2_points=side_2_points,
            )
        ]
        ensure_no_overrun(prospective, match.match_settings.best_of, game_number)

    return await _enter_game_score_locked(
        db,
        match,
        game_number=game_number,
        side_1_points=side_1_points,
        side_2_points=side_2_points,
    )


async def update_game_score(
    db: AsyncSession,
    match_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    game_number: int,
    side_1_points: int,
    side_2_points: int,
    expected_version: int,
    load_match: _MatchWriteLoader = load_match_for_write,
) -> Match:
    """Replace the committed score for ``game_number`` under optimistic
    concurrency and return the reloaded match.

    Loads under the blocking match row lock, enforces scorability and the
    score's existence, then the no-overrun guard on the prospective board built
    by substituting the payload points for this game (the mutation runs in raw
    SQL, so in-memory ``match.games`` still holds the OLD score).

    Raises :class:`MatchNotFoundError` — ``"Match not found."`` for an absent
    match / non-participant, ``"Score not found."`` for a missing game score —
    plus :class:`MatchNotScorableError`, :class:`ScoreNotAllowedError`, or
    :class:`ScoreConflictError` (a stale ``expected_version``)."""
    match = await load_match(db, match_id, user_id, lock=True)
    ensure_scorable(match)

    game = _game_by_number(match, game_number)
    if game is None or game.score is None:
        raise MatchNotFoundError("Score not found.")

    prospective = [
        g
        if g.game_number != game_number
        else MatchResultsGameWrite(
            game_number=game_number,
            side_1_points=side_1_points,
            side_2_points=side_2_points,
        )
        for g in _games_payload_from_match(match)
    ]
    ensure_no_overrun(prospective, match.match_settings.best_of, game_number)

    return await _update_game_score_locked(
        db,
        match,
        game_number=game_number,
        side_1_points=side_1_points,
        side_2_points=side_2_points,
        expected_version=expected_version,
    )


async def delete_game_score(
    db: AsyncSession,
    match_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    game_number: int,
    load_match: _MatchWriteLoader = load_match_for_write,
) -> Match:
    """Clear the committed score for ``game_number`` and return the reloaded
    match. Loads under the blocking match row lock and enforces scorability and
    the score's existence.

    Raises :class:`MatchNotFoundError` — ``"Match not found."`` for an absent
    match / non-participant, ``"Score not found."`` for a missing game score —
    or :class:`MatchNotScorableError`."""
    match = await load_match(db, match_id, user_id, lock=True)
    ensure_scorable(match)

    game = _game_by_number(match, game_number)
    if game is None or game.score is None:
        raise MatchNotFoundError("Score not found.")

    return await _delete_game_score_locked(db, match, game_number=game_number)
