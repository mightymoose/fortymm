"""The FortyMM MCP server: a FastMCP app mounted at ``/mcp`` on the FastAPI app.

Router-free (no FastAPI imports); it owns a configured :data:`mcp` ``FastMCP``
instance whose transport authentication is a :class:`FortymmTokenVerifier`. The
curated match-flow verbs are registered here as tools (starting with the
:func:`get_match` read); each reuses the shared match service + serializer so the
MCP and HTTP surfaces can never drift.

Auth reuses the exact same resolver as the HTTP bearer path
(:func:`app.api_token_auth.find_api_token_user`), wrapped in a FastMCP
``TokenVerifier`` so an unauthenticated MCP call fails **at the transport**, not
inside a tool, and the two surfaces can never drift (see the shared-services
ADR). Every tool authenticates before it runs.

Tools run outside a FastAPI request, so they cannot use the request-scoped
``get_session`` dependency — they own the session lifecycle themselves via
:func:`mcp_session` (``api/CLAUDE.md``: "outside a request you own the session
lifecycle yourself"). The verifier does the same.
"""

import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Literal

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.auth import AccessToken, TokenVerifier
from fastmcp.server.dependencies import get_access_token
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api_token_auth import find_api_token_user
from app.db import get_sessionmaker
from app.mappers.match_extras_mapper import (
    MatchDetailsExtras,
    empty_extras,
    serialize_match_extras,
)
from app.match_creation import create_match as create_match_core
from app.match_queries import match_eager_options, singles_user_ids
from app.match_scoring import MatchLockUnavailable
from app.match_scoring import delete_game_score as delete_game_score_core
from app.match_scoring import enter_game_score as enter_game_score_core
from app.match_scoring import update_game_score as update_game_score_core
from app.match_serialization import _is_participant, _serialize_details
from app.matches import _notify_result_posted
from app.models import Match, User
from app.notifications.dependencies import get_push_sender
from app.notifications.service import NotificationService
from app.repositories.match_details_repository import MatchDetailsRepository
from app.repositories.match_repository import MatchRepository
from app.result_acceptance import (
    CannotAcceptOwnProposalError,
    MatchClosedError,
    MatchNotFoundError,
    MatchNotScorableError,
    NegotiationConflictError,
    OpponentNotFoundError,
    PostedGamesNotDecisiveError,
    RatedNeedsRegisteredOpponentError,
    ResultNotFoundError,
    ScoreConflictError,
    ScoreNotAllowedError,
    SelfMatchError,
    UndecidedBoardError,
)
from app.result_acceptance import (
    accept_result as accept_result_core,
)
from app.result_proposal import propose_result as propose_result_core
from app.schemas.match import MatchDetails, MatchResultsGameWrite
from app.services.match_service import MatchService

log = logging.getLogger(__name__)

# A game number bounded to the widest ``best_of`` (7), so an out-of-range value
# is a schema-level validation error at the transport rather than a tool-body
# ``ToolError``. The per-match ``best_of`` range is still enforced inside the
# ``match_scoring`` entry points (``ScoreNotAllowedError``).
GameNumber = Annotated[int, Field(ge=1, le=7)]


@asynccontextmanager
async def mcp_session() -> AsyncIterator[AsyncSession]:
    """An owned ``AsyncSession`` for code running outside a FastAPI request.

    The shared helper every MCP tool (and the token verifier) uses to get a
    session, since ``get_session`` — the request-scoped FastAPI dependency —
    isn't available off the request path. Opens a session from the process-wide
    factory and closes it on exit.
    """
    async with get_sessionmaker()() as session:
        yield session


class FortymmTokenVerifier(TokenVerifier):
    """Authenticates every MCP request against a ``context="api"`` bearer token.

    FastMCP hands us the raw token parsed out of the ``Authorization: Bearer``
    header; we resolve it through the one shared
    :func:`~app.api_token_auth.find_api_token_user` lookup (sha256 hash → live,
    non-tombstoned ``User``). On success we return an ``AccessToken`` carrying
    the resolved user id as ``subject``/``client_id`` (and under a ``user_id``
    claim) so tools can identify the caller without re-resolving. On any failure
    — missing, unknown, or tombstoned-user token — we return ``None``, which
    FastMCP turns into a 401 at the transport before any tool body runs.
    """

    async def verify_token(self, token: str) -> AccessToken | None:
        async with mcp_session() as db:
            user = await find_api_token_user(db, token)
        if user is None:
            return None
        user_id = str(user.id)
        return AccessToken(
            token=token,
            client_id=user_id,
            subject=user_id,
            scopes=[],
            claims={"user_id": user_id},
        )


# The mounted MCP server. ``auth`` wires the verifier so authentication happens
# at the transport for every request; each tool below reads the resolved caller
# from the FastMCP auth context rather than re-parsing the bearer token.
mcp: FastMCP[None] = FastMCP("FortyMM", auth=FortymmTokenVerifier())


def _authenticated_user_id() -> uuid.UUID:
    """The resolved caller's ``users.id`` from the FastMCP auth context.

    The transport already authenticated the request (``FortymmTokenVerifier``);
    that minted an :class:`AccessToken` carrying the resolved user id under a
    ``user_id`` claim (and as ``subject``). We read it back here rather than
    re-resolving the token, so a tool body can identify its caller. A tool only
    runs after the verifier returned a token, so an absent token / claim is an
    internal invariant break, not a client error — surface it loudly as a
    ``ToolError``.
    """
    token = get_access_token()
    raw_user_id = token.claims.get("user_id") if token is not None else None
    if raw_user_id is None:
        raise ToolError("Not authenticated.")
    return uuid.UUID(raw_user_id)


async def _load_user(db: AsyncSession, user_id: uuid.UUID) -> User | None:
    """Load the live ``User`` the caller authenticated as, so the creation
    service has the ``creator`` row it needs. The transport already resolved
    this id from a live, non-tombstoned token, so a missing row is an internal
    invariant break — the tool surfaces it as a ``ToolError`` rather than a
    silent ``None``."""
    return (
        await db.execute(select(User).where(User.id == user_id))
    ).scalar_one_or_none()


async def _load_match(db: AsyncSession, match_id: uuid.UUID) -> Match | None:
    """Load the eager ``Match`` ORM row the serializer needs, mirroring the HTTP
    ``GET /v1/matches/{match_id}`` read path's eager-load chain."""
    result = await db.execute(
        select(Match).where(Match.id == match_id).options(*match_eager_options())
    )
    return result.scalar_one_or_none()


async def _view_extras(match_service: MatchService, match: Match) -> MatchDetailsExtras:
    """Participant-only extras (rating changes, recent form, head-to-head) for an
    already-loaded ``match`` — the same assembly the HTTP GET uses for a
    participant caller (#515)."""
    return serialize_match_extras(
        await match_service.load_view_extras(
            match_id=match.id,
            league_id=match.league_id,
            status=match.status,
            created_at=match.created_at,
            user_ids=singles_user_ids(match),
        )
    )


@mcp.tool
async def get_match(match_id: uuid.UUID) -> MatchDetails:
    """Read a single match as the authenticated API-token caller.

    Returns the same ``MatchDetails`` view the HTTP ``GET /v1/matches/{match_id}``
    endpoint returns for that user: viewer-relative perspective flags
    (``is_current_user_side``, ``can_score``, ``can_finalize``, the negotiation
    block) plus — only when the caller is a participant on the match — the
    history/rivalry/rating extras (recent form, head-to-head, per-side rating
    changes; a non-participant gets those empty, per #515).

    Raises a ``ToolError`` when no match has that id.
    """
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        match = await _load_match(db, match_id)
        if match is None:
            raise ToolError(f"No match found with id {match_id}.")
        service = MatchService(MatchRepository(db), MatchDetailsRepository(db))
        domain_match = await service.get_match(match_id)
        if domain_match is None:
            raise ToolError(f"No match found with id {match_id}.")
        # Gate the history/rivalry/rating payload on participation, exactly as the
        # HTTP GET does — a non-participant (spectator) still sees the scorecard,
        # but with empty extras (#515).
        is_participant = _is_participant(match, user_id)
        extras = (
            await _view_extras(service, match) if is_participant else empty_extras()
        )
        return _serialize_details(match, user_id, extras, domain_match)


@mcp.tool
async def create_match(
    best_of: Literal[1, 3, 5, 7],
    opponent_user_id: uuid.UUID | None = None,
    league_id: uuid.UUID | None = None,
    rated: bool = True,
) -> MatchDetails:
    """Start a match as the authenticated API-token caller and return it.

    Mirrors ``POST /v1/matches``: it reuses the shared creation service and
    serializer, so the MCP and HTTP surfaces can never drift. ``best_of`` is the
    total games to play and must be one of 1, 3, 5, or 7. ``opponent_user_id`` is
    optional — omit it for a solo match, which gets a player-less "No opponent"
    sentinel side (still scorable) and is always unrated, so it must be created
    with ``rated=False``. ``league_id`` is optional; when omitted the match binds
    to the default league. Returns the created ``MatchDetails`` from the
    creator's perspective (the same view ``get_match`` reads back).

    Raises a ``ToolError`` when the opponent is yourself, when
    ``opponent_user_id`` matches no live registered player, or when a rated match
    is requested with no registered opponent.
    """
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        creator = await _load_user(db, user_id)
        if creator is None:
            raise ToolError("Not authenticated.")
        try:
            created = await create_match_core(
                db,
                creator=creator,
                opponent_user_id=opponent_user_id,
                league_id=league_id,
                best_of=best_of,
                rated=rated,
            )
        except SelfMatchError as err:
            raise ToolError("You cannot start a match against yourself.") from err
        except OpponentNotFoundError as err:
            raise ToolError(
                f"No live registered player found with id {opponent_user_id}."
            ) from err
        except RatedNeedsRegisteredOpponentError as err:
            raise ToolError(
                "A rated match needs a registered opponent. Pass an "
                "opponent_user_id, or set rated=False for a solo match."
            ) from err
        return _serialize_details(created, creator.id)


# The per-game score-write domain family the ``match_scoring`` entry points
# raise. ``MatchLockUnavailable`` is included defensively — the entry points take
# the *blocking* row lock, so it won't fire today, but mapping it keeps the
# adapter honest if a caller ever drives them with ``nowait``.
_SCORE_WRITE_ERRORS = (
    MatchNotFoundError,
    MatchNotScorableError,
    ScoreNotAllowedError,
    ScoreConflictError,
    MatchLockUnavailable,
)


def _map_score_write_tool_error(exc: Exception) -> ToolError:
    """Adapt a score-write domain exception to an actionable ``ToolError``.

    Mirrors the HTTP adapter (``matches._map_score_write_error``) but speaks the
    agent's language instead of HTTP status codes: a lost optimistic-concurrency
    race names ``get_match`` as the recovery path (re-read the committed score,
    then retry with the current version), and a held lock asks for a retry."""
    if isinstance(exc, MatchNotFoundError):
        # "Match not found." collapses absent-match and non-participant into one
        # opaque reason (a non-participant can't probe existence); "Score not
        # found." is the update/delete missing-score case — surface each as-is,
        # naming participation for the former.
        if exc.message == "Match not found.":
            return ToolError("Match not found, or you are not a participant.")
        return ToolError(exc.message)
    if isinstance(exc, MatchNotScorableError):
        return ToolError(exc.message)
    if isinstance(exc, ScoreNotAllowedError):
        return ToolError(str(exc))
    if isinstance(exc, ScoreConflictError):
        return ToolError(
            "This game's score changed under you — call get_match to see the "
            "committed score, then retry with the current version."
        )
    if isinstance(exc, MatchLockUnavailable):
        return ToolError("Another write is in progress for this match, retry.")
    return ToolError(str(exc))


async def _serialize_written_match(
    db: AsyncSession, match: Match, user_id: uuid.UUID
) -> MatchDetails:
    """Serialize a just-written match from the participant caller's perspective.

    The ``match_scoring`` entry points only return to a participant (a
    non-participant is rejected at load with ``MatchNotFoundError``), so the
    history/rivalry/rating extras are always assembled — the same view the HTTP
    score handlers return for the acting user."""
    service = MatchService(MatchRepository(db), MatchDetailsRepository(db))
    extras = await _view_extras(service, match)
    return _serialize_details(match, user_id, extras)


@mcp.tool
async def enter_game_score(
    match_id: uuid.UUID,
    game_number: GameNumber,
    side_1_points: int,
    side_2_points: int,
) -> MatchDetails:
    """Save the first score for a game as the authenticated API-token caller and
    return the updated match.

    Mirrors ``POST /v1/matches/{match_id}/games/{game_number}/scores/new``: it
    reuses the shared ``match_scoring`` write path (blocking row lock,
    scorability + best-of-range + no-overrun guards, then the insert) so the MCP
    and HTTP surfaces can never drift. ``game_number`` is 1-based and at most 7.
    Returns the reloaded ``MatchDetails`` from the caller's perspective (the same
    view ``get_match`` reads back).

    Raises a ``ToolError`` when the match doesn't exist or you're not a
    participant, when the match isn't scorable (no opponent, a posted result, not
    yet called to a table, or terminal), when the game is out of the ``best_of``
    range or would overrun a decided match, or when a concurrent participant
    already scored this game (call ``get_match``, then retry)."""
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        try:
            reloaded = await enter_game_score_core(
                db,
                match_id,
                user_id,
                game_number=game_number,
                side_1_points=side_1_points,
                side_2_points=side_2_points,
            )
        except _SCORE_WRITE_ERRORS as exc:
            raise _map_score_write_tool_error(exc) from exc
        return await _serialize_written_match(db, reloaded, user_id)


@mcp.tool
async def update_game_score(
    match_id: uuid.UUID,
    game_number: GameNumber,
    side_1_points: int,
    side_2_points: int,
    expected_version: int,
) -> MatchDetails:
    """Replace a game's committed score under optimistic concurrency as the
    authenticated API-token caller and return the updated match.

    Mirrors ``PUT /v1/matches/{match_id}/games/{game_number}/scores``: it reuses
    the shared ``match_scoring`` write path (blocking row lock, scorability + the
    score's existence + no-overrun guards, then the version-guarded UPDATE) so
    the MCP and HTTP surfaces can never drift. ``expected_version`` is the
    ``version`` the caller last read for this game's score (from ``get_match``);
    the write only commits while the committed row is still at that version.

    Raises a ``ToolError`` when the match doesn't exist or you're not a
    participant, when the game score doesn't exist, when the match isn't
    scorable, when the write would overrun a decided match, or when
    ``expected_version`` is stale — a concurrent participant saved this game since
    you read it (call ``get_match`` for the committed score, then retry with the
    current version)."""
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        try:
            reloaded = await update_game_score_core(
                db,
                match_id,
                user_id,
                game_number=game_number,
                side_1_points=side_1_points,
                side_2_points=side_2_points,
                expected_version=expected_version,
            )
        except _SCORE_WRITE_ERRORS as exc:
            raise _map_score_write_tool_error(exc) from exc
        return await _serialize_written_match(db, reloaded, user_id)


# The recovery message every lost-negotiation race shares: the caller's view of
# the standing result is stale, so it must re-read before it can act again. Names
# ``get_match`` explicitly so an agent knows exactly which verb re-syncs it.
_NEGOTIATION_CONFLICT_MESSAGE = (
    "The standing result changed — call get_match to see the current standing "
    "result, then accept it or counter again."
)


async def _fire_result_notification(
    db: AsyncSession, match: Match, poster_id: uuid.UUID
) -> None:
    """Best-effort accept/counter notification to the side that now owes a
    response, mirroring the HTTP ``post_match_result`` handler.

    The result is already committed by :func:`propose_result`, so *nothing* here
    may fail the tool — not a DB error, not a delivery-side failure. Hence the
    blanket catch (the same fire-and-forget guard the HTTP handler uses): a
    notify failure is logged and swallowed, and the session is rolled back so a
    failed in-app persist leaves the session clean. The ``NotificationService``
    is constructed exactly as ``get_notification_service`` does (the owned
    session plus the process-wide push-sender singleton)."""
    notifications = NotificationService(db, get_push_sender())
    try:
        await _notify_result_posted(notifications, match, poster_id)
    except Exception:
        await db.rollback()
        log.exception(
            "Failed to record result-acceptance notification",
            extra={"match_id": str(match.id)},
        )


@mcp.tool
async def propose_result(
    match_id: uuid.UUID,
    games: list[MatchResultsGameWrite],
    supersedes_result_id: uuid.UUID | None = None,
) -> MatchDetails:
    """Propose a result for a match as the authenticated API-token caller — the
    first verb of the propose/accept negotiation — and return the updated match.

    Mirrors ``POST /v1/matches/{match_id}/results``: it reuses the shared
    ``result_proposal`` core (the NOWAIT row lock, the terminal-status gate, the
    decided-board validator, the first-post-vs-counter negotiation gates, the
    canonical-board commit, and the self-accept/finalize vs leave-standing fork)
    so the MCP and HTTP surfaces can never drift. ``games`` is the canonical board
    (each game's per-point legality is validated); this one tool serves both the
    FIRST proposal (omit ``supersedes_result_id``) and a COUNTER/correction (set
    ``supersedes_result_id`` to the current standing result's id). A solo/unrated
    match self-accepts and finalizes immediately; a rated two-human match leaves
    the result *standing* for the opponent to ``accept_result``, and — only then —
    fires a best-effort accept/counter notification to the opponent (a notify
    failure never fails this tool). Returns the ``MatchDetails`` from the
    proposer's perspective (the same view ``get_match`` reads back).

    Raises a ``ToolError`` when the match doesn't exist or you're not a
    participant, when the match is closed to new results (completed/voided), when
    the board is undecided/invalid, when another proposal is mid-flight (retry),
    or when the standing result moved on under you — the last names ``get_match``
    as the recovery path (re-read the standing result, then accept or counter)."""
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        try:
            outcome = await propose_result_core(
                db,
                match_id,
                user_id,
                games=games,
                supersedes_result_id=supersedes_result_id,
            )
        except MatchNotFoundError as exc:
            raise ToolError("Match not found, or you are not a participant.") from exc
        except MatchClosedError as exc:
            raise ToolError(str(exc)) from exc
        except UndecidedBoardError as exc:
            raise ToolError(str(exc)) from exc
        except MatchLockUnavailable as exc:
            raise ToolError(
                "Another proposal is in progress for this match, retry."
            ) from exc
        except NegotiationConflictError as exc:
            raise ToolError(_NEGOTIATION_CONFLICT_MESSAGE) from exc

        # Record + notify the side that now owes an acceptance — only for a rated
        # two-human match that left the result standing, exactly as the HTTP
        # handler does, and only after the result is committed. Best-effort: a
        # notify failure can never fail the tool.
        if outcome.awaiting_acceptance:
            await _fire_result_notification(db, outcome.match, user_id)
        return await _serialize_written_match(db, outcome.match, user_id)


@mcp.tool
async def accept_result(
    match_id: uuid.UUID,
    result_id: uuid.UUID,
) -> MatchDetails:
    """Accept a standing proposal as the authenticated API-token caller — the
    second verb of the propose/accept negotiation — and return the completed
    match.

    Mirrors ``POST /v1/matches/{match_id}/results/{result_id}/acceptance``: it
    reuses the shared ``result_acceptance`` core (the blocking row lock, the
    result-exists gate, the submitter-side self-accept guard, the live
    standing-proposal check, and ``finalize_match`` — mark completed, stamp
    ``side.won``, apply ratings, advance any tournament draw) so the MCP and HTTP
    surfaces can never drift. ``result_id`` is the concurrency token: it must be
    the current standing proposal's id (from ``get_match``). Returns the finalized
    ``MatchDetails`` from the accepting caller's perspective.

    Raises a ``ToolError`` when no result with that id exists on the match, when
    the match doesn't exist or you're not a participant, when you try to accept
    your own proposal (only the opposing side may accept), when the agreed board
    no longer decides a winner, or when the standing result moved on under you
    (superseded by a counter or already accepted) — the last names ``get_match``
    as the recovery path (re-read the standing result, then accept or counter)."""
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        try:
            reloaded = await accept_result_core(
                db,
                match_id,
                user_id,
                result_id=result_id,
            )
        except MatchNotFoundError as exc:
            raise ToolError("Match not found, or you are not a participant.") from exc
        except ResultNotFoundError as exc:
            raise ToolError("No result with that id exists on this match.") from exc
        except CannotAcceptOwnProposalError as exc:
            raise ToolError("You can't accept your own proposal.") from exc
        except PostedGamesNotDecisiveError as exc:
            raise ToolError("The posted games no longer decide this match.") from exc
        except NegotiationConflictError as exc:
            raise ToolError(_NEGOTIATION_CONFLICT_MESSAGE) from exc
        return await _serialize_written_match(db, reloaded, user_id)


@mcp.tool
async def delete_game_score(
    match_id: uuid.UUID,
    game_number: GameNumber,
) -> MatchDetails:
    """Clear a game's committed score as the authenticated API-token caller and
    return the updated match.

    Mirrors ``DELETE /v1/matches/{match_id}/games/{game_number}/scores``: it
    reuses the shared ``match_scoring`` write path (blocking row lock,
    scorability + the score's existence guards, then the clear) so the MCP and
    HTTP surfaces can never drift. The game row stays so a later
    ``enter_game_score`` for the same number attaches a fresh score. Returns the
    reloaded ``MatchDetails`` from the caller's perspective.

    Raises a ``ToolError`` when the match doesn't exist or you're not a
    participant, when the game score doesn't exist, or when the match isn't
    scorable."""
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        try:
            reloaded = await delete_game_score_core(
                db,
                match_id,
                user_id,
                game_number=game_number,
            )
        except _SCORE_WRITE_ERRORS as exc:
            raise _map_score_write_tool_error(exc) from exc
        return await _serialize_written_match(db, reloaded, user_id)
