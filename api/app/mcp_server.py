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
from functools import partial
from typing import Annotated, Literal

from anyio import to_thread
from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.auth import AccessToken, TokenVerifier
from fastmcp.server.dependencies import get_access_token
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api_token_auth import find_api_token_user
from app.db import get_sessionmaker
from app.draws import (
    DegenerateDraw,
    DrawError,
    NonSinglesDraw,
    UnsupportedDrawType,
)
from app.mappers.match_extras_mapper import empty_extras
from app.match_creation import create_match as create_match_core
from app.match_errors import (
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
from app.match_result_notifications import notify_result_posted
from app.match_scoring import MatchLockUnavailable
from app.match_scoring import delete_game_score as delete_game_score_core
from app.match_scoring import enter_game_score as enter_game_score_core
from app.match_scoring import update_game_score as update_game_score_core
from app.match_serialization import (
    is_participant,
    load_match_eager,
    serialize_details,
    view_extras,
)
from app.models import Match, Tournament, TournamentEvent, User
from app.notifications.dependencies import get_push_sender
from app.notifications.service import NotificationService
from app.player_matches import paginated_player_matches
from app.player_search import SEARCH_DEFAULT_LIMIT, search_players_by_username
from app.rbac import user_has_permission
from app.repositories.match_details_repository import MatchDetailsRepository
from app.repositories.match_repository import MatchRepository
from app.result_acceptance import (
    accept_result as accept_result_core,
)
from app.result_proposal import propose_result as propose_result_core
from app.schedule_preview_solve import (
    request_schedule_preview as request_schedule_preview_core,
)
from app.schedule_preview_solve import wait_for_preview
from app.schedule_solves import latest_solve
from app.schemas.match import MatchDetails, MatchResultsGameWrite
from app.schemas.player import PlayerMatchListResponse, PlayerRead
from app.schemas.schedule_preview import (
    PreviewJobStatus,
    PreviewResult,
)
from app.schemas.tournament import (
    ScheduleSolveRead,
    TournamentDetailRead,
    TournamentFixtureRead,
    TournamentRead,
    TournamentUpdate,
)
from app.services.match_service import MatchService
from app.tournament_draw_service import cut_event_draw as cut_event_draw_core
from app.tournament_draw_service import uncut_event_draw as uncut_event_draw_core
from app.tournament_edit import edit_tournament as edit_tournament_core
from app.tournament_errors import (
    DrawUnderWayError,
    EventNotFoundError,
    LeagueNotEditableError,
    LeagueNotFoundError,
    NoDrawnEventsError,
    NotTournamentOwnerError,
    ScheduleQueueUnavailableError,
    TournamentNotFoundError,
    TournamentNotPreLiveError,
)
from app.tournament_list import list_tournament_details, tournament_detail
from app.tournament_queries import (
    fixtures_by_event,
    visible_to,
)
from app.tournament_serialization import serialize
from app.tournament_solve_service import (
    request_schedule_solve as request_schedule_solve_core,
)

log = logging.getLogger(__name__)

# A game number bounded to the widest ``best_of`` (7), so an out-of-range value
# is a schema-level validation error at the transport rather than a tool-body
# ``ToolError``. The per-match ``best_of`` range is still enforced inside the
# ``match_scoring`` entry points (``ScoreNotAllowedError``).
GameNumber = Annotated[int, Field(ge=1, le=7)]

# Argument bounds for the read tools, mirroring the HTTP query-param caps so the
# two surfaces can't drift on what a valid page/limit is (``app.players``:
# ``MAX_LIMIT`` = 50 for the typeahead, ``LIST_MAX_PAGE_SIZE`` = 100 for the
# per-player match list). An out-of-range value is a schema-level validation
# error at the transport, not a tool-body ``ToolError``.
SearchLimit = Annotated[int, Field(ge=1, le=50)]
MatchPage = Annotated[int, Field(ge=1)]
MatchPageSize = Annotated[int, Field(ge=1, le=100)]

# The default page size ``list_my_matches`` uses when the caller names none,
# matching the HTTP per-player list default (``app.players.LIST_DEFAULT_PAGE_SIZE``).
MY_MATCHES_DEFAULT_PAGE_SIZE = 25

# The permission the tournament reads gate on — the same seeded RBAC name the HTTP
# router's ``require_view`` dependency enforces (``app.tournaments.TOURNAMENT_VIEW``,
# ``scripts/seed_rbac.py``). Held as a literal rather than imported from the router so
# the MCP adapter stays router-free; ``get_tournament`` asks it through the one shared
# ``user_has_permission`` (``app.rbac``), so the two surfaces gate on the same grant.
TOURNAMENT_VIEW_PERMISSION = "tournament.view"


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


async def _require_tournament_view(db: AsyncSession, user_id: uuid.UUID) -> None:
    """The tournament-read gate every read tool shares: refuse unless the caller
    holds ``tournament.view``.

    Byte-for-byte the ``ToolError`` the three read tools each raised inline, asked
    through the one shared ``user_has_permission`` the HTTP ``require_view``
    dependency asks — so the MCP and HTTP surfaces gate reads on the same grant, and
    a fourth read tool cannot grow a different message or a different permission
    name. Permission is checked first (before any visibility load), the order the
    HTTP route keeps: ``require_view`` (403) runs before the handler."""
    if not await user_has_permission(db, user_id, TOURNAMENT_VIEW_PERMISSION):
        raise ToolError("You don't have permission to view tournaments.")


async def _load_visible_tournament(
    db: AsyncSession, user_id: uuid.UUID, tournament_id: uuid.UUID
) -> Tournament:
    """The tournament ``tournament_id`` names, scoped to what ``user_id`` may see,
    or a not-found ``ToolError`` — the visibility-scoped load ``get_tournament`` and
    ``get_schedule`` share.

    ``visible_to`` rides in the same WHERE as the id lookup, so a tournament the
    caller can't see leaves by the same not-found path as an absent one — existence
    is never confirmed for an unannounced draft the caller does not own, exactly as
    the HTTP route hides it behind a 404. The ``ToolError`` message is byte-for-byte
    the one both tools raised inline."""
    tournament = (
        await db.execute(
            select(Tournament).where(
                Tournament.id == tournament_id, visible_to(user_id)
            )
        )
    ).scalar_one_or_none()
    if tournament is None:
        raise ToolError(f"No tournament found with id {tournament_id}.")
    return tournament


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
        match = await load_match_eager(db, match_id)
        if match is None:
            raise ToolError(f"No match found with id {match_id}.")
        service = MatchService(MatchRepository(db), MatchDetailsRepository(db))
        domain_match = await service.get_match(match_id)
        if domain_match is None:
            raise ToolError(f"No match found with id {match_id}.")
        # Gate the history/rivalry/rating payload on participation, exactly as the
        # HTTP GET does — a non-participant (spectator) still sees the scorecard,
        # but with empty extras (#515).
        viewer_is_participant = is_participant(match, user_id)
        extras = (
            await view_extras(service, match)
            if viewer_is_participant
            else empty_extras()
        )
        return serialize_details(match, user_id, extras, domain_match)


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
        return serialize_details(created, creator.id)


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
    extras = await view_extras(service, match)
    return serialize_details(match, user_id, extras)


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
async def get_tournament(tournament_id: uuid.UUID) -> TournamentDetailRead:
    """Read a single tournament as the authenticated API-token caller.

    Returns the same ``TournamentDetailRead`` view the HTTP
    ``GET /v1/tournaments/{tournament_id}`` endpoint returns for that user: the
    tournament's fields (with the caller's ``can_edit``), its events in creation
    order — each carrying its active entrants, its draw (fixtures), the caller's
    ``entry_state``, and its round-robin standings once played — plus the newest
    row of the schedule-solve ledger. It composes the exact same shared
    ``tournament_detail`` reader the HTTP route composes, so the two surfaces can
    never drift.

    Gated on the same ``tournament.view`` permission the HTTP route requires, and
    scoped by the same visibility rule: a draft you do not own is not yours to see,
    so it surfaces as a not-found ``ToolError`` — the same way the HTTP route hides
    it behind a 404 rather than confirming it exists.

    Raises a ``ToolError`` when you lack ``tournament.view``, and when no tournament
    with that id is visible to you (absent, or an unannounced draft you do not own).
    """
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        # Permission first, then the visibility-scoped load — the order the HTTP
        # route keeps (``require_view`` (403) runs before the handler, then
        # ``_visible_to`` scopes the row so a hidden draft leaves by not-found).
        await _require_tournament_view(db, user_id)
        tournament = await _load_visible_tournament(db, user_id, tournament_id)
        # The creator's username the shared reader needs for the aggregate. The
        # RESTRICT FK guarantees the creator row exists, so ``scalar_one`` is total.
        username = (
            await db.execute(
                select(User.username).where(User.id == tournament.created_by_user_id)
            )
        ).scalar_one()
        # The identical six-statement batched composition + ``serialize_detail`` the
        # HTTP route runs — extracted into the shared ``tournament_detail`` reader,
        # so this tool and the page can never drift on how a tournament is read.
        return await tournament_detail(
            db,
            tournament,
            created_by_username=username,
            current_user_id=user_id,
        )


class ScheduleEventGroup(BaseModel):
    """One event's slice of the schedule projection: the event's identity and its
    draw's fixtures, each carrying its placement (``table_id`` +
    ``scheduled_start``) and its pool/round/position.

    The fixtures are the exact ``TournamentFixtureRead`` the detail BFF composes —
    same fields, same **pool → round → position** order (``fixtures_by_event``) —
    reused whole rather than reshaped, so this agent-facing schedule and the
    detail page cannot disagree about a slot. Empty is the designed state of an
    event whose draw has not been cut (ADR-0786), not an error.
    """

    event_id: uuid.UUID
    name: str
    fixtures: list[TournamentFixtureRead]


class TournamentScheduleRead(BaseModel):
    """A narrow, agent-shaped SCHEDULE projection of a tournament — each event's
    placed fixtures grouped for reading, plus the tournament's latest solve.

    Deliberately NOT the whole ``TournamentDetailRead``: it drops entrants,
    standings, eligibility and the per-event write metadata an agent reading a
    schedule does not need, and keeps only what answers "what plays where and
    when, and how is the current solve doing". It is composed entirely from the
    existing detail-BFF reads — ``fixtures_by_event`` for each event's placed
    fixtures and ``latest_solve`` for the ledger's newest row — wrapping the
    unchanged ``TournamentFixtureRead`` / ``ScheduleSolveRead`` shapes so the MCP
    and HTTP surfaces read the same placement and solve facts.

    This schema is **MCP-only** and is attached to no FastAPI route, so it does
    not reach ``openapi.json`` (a mounted MCP sub-app does not contribute to the
    parent schema — see the tournament-verbs ADR).
    """

    tournament_id: uuid.UUID
    events: list[ScheduleEventGroup]
    # The newest row of the tournament's solve ledger (status + CP-SAT verdict),
    # or ``null`` when no solve has ever been requested — the same ``latest_solve``
    # read, and the same ``ScheduleSolveRead`` shape, the detail BFF's solve strip
    # renders.
    latest_schedule_solve: ScheduleSolveRead | None


@mcp.tool
async def get_schedule(tournament_id: uuid.UUID) -> TournamentScheduleRead:
    """Read a tournament's SCHEDULE as the authenticated API-token caller — a
    narrow, agent-shaped projection, not the whole tournament detail.

    Returns each event's draw fixtures with their placement (``table_id`` and the
    predicted ``scheduled_start``) and pool/round/position — grouped by event, in
    the same **pool → round → position** order the detail page uses — plus the
    tournament's latest schedule solve (its ``status`` and CP-SAT ``verdict``). It
    reuses the exact same shared reads the detail BFF composes (``fixtures_by_event``
    for the placed fixtures, ``latest_solve`` for the ledger's newest row) and the
    identical ``TournamentFixtureRead`` / ``ScheduleSolveRead`` shapes, so this
    schedule and the tournament page can never drift.

    An event whose draw has not been cut carries ``[]`` fixtures (the designed
    state, not an error), and a tournament for which no solve has ever been
    requested has ``latest_schedule_solve = null``.

    Gated on the same ``tournament.view`` permission the HTTP detail read requires,
    and scoped by the same visibility rule: a draft you do not own is not yours to
    see, so it surfaces as a not-found ``ToolError`` — existence is never confirmed
    for an unannounced draft you do not own.

    Raises a ``ToolError`` when you lack ``tournament.view``, and when no tournament
    with that id is visible to you (absent, or an unannounced draft you do not own).
    """
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        # Permission first, then the visibility-scoped load — the same shared gate
        # and loader ``get_tournament`` uses, keeping the order the HTTP detail
        # route keeps (``require_view`` (403) before the handler, then ``visible_to``
        # scoping the row so a hidden draft leaves by not-found).
        await _require_tournament_view(db, user_id)
        tournament = await _load_visible_tournament(db, user_id, tournament_id)
        # Events in creation order (as the detail read lists them), then their
        # draws in one batched read (``fixtures_by_event`` — pool → round →
        # position ordered, every event id keyed so an un-cut event maps to ``[]``)
        # and the ledger's newest row — the same shared reads the detail BFF uses.
        events = list(
            (
                await db.execute(
                    select(TournamentEvent)
                    .where(TournamentEvent.tournament_id == tournament_id)
                    .order_by(TournamentEvent.created_at)
                )
            )
            .scalars()
            .all()
        )
        event_fixtures = await fixtures_by_event(db, [event.id for event in events])
        latest_schedule_solve = await latest_solve(db, tournament.id)
        return TournamentScheduleRead(
            tournament_id=tournament.id,
            events=[
                ScheduleEventGroup(
                    event_id=event.id,
                    name=event.name,
                    fixtures=event_fixtures[event.id],
                )
                for event in events
            ],
            latest_schedule_solve=(
                ScheduleSolveRead.model_validate(latest_schedule_solve)
                if latest_schedule_solve is not None
                else None
            ),
        )


@mcp.tool
async def list_my_tournaments() -> list[TournamentDetailRead]:
    """List the tournaments the authenticated API-token caller OWNS, newest first.

    Returns the same ``TournamentDetailRead`` aggregate the HTTP
    ``GET /v1/tournaments`` list serves — each tournament with its events, their
    active entrants and their draws, the caller's ``can_edit`` / per-event
    ``entry_state`` / ladder ``rating`` — by reusing that list's exact five-query
    batched read (``list_tournament_details``), so the MCP and HTTP surfaces can
    never drift and neither runs an N+1.

    Unlike the HTTP list, which is VISIBILITY-scoped (every announced tournament
    plus your own drafts), this is OWNER-scoped: only tournaments you created
    (``created_by_user_id == you``), in ANY status. That is deliberate — the
    tournament write verbs are owner-gated, so the tournaments an agent can act on
    are exactly the ones it owns, and this is the discovery read that hands the
    agent a ``tournament_id`` to drive them (see the tournament-verbs ADR). A
    tournament you can merely *see* but do not own is excluded.

    Gated on the same ``tournament.view`` permission the HTTP list requires.

    Raises a ``ToolError`` when you lack ``tournament.view``.
    """
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        # Permission first, through the same shared gate the detail reads use
        # (mirroring the HTTP list's ``require_view`` dependency); only then the
        # owner-scoped read. Owner-scoping is by construction (the WHERE selects only
        # the caller's own rows), so there is no separate visibility gate to run — an
        # owner always sees their own tournaments.
        await _require_tournament_view(db, user_id)
        return await list_tournament_details(
            db,
            where=Tournament.created_by_user_id == user_id,
            current_user_id=user_id,
        )


@mcp.tool
async def edit_tournament(
    tournament_id: uuid.UUID,
    updates: TournamentUpdate,
) -> TournamentRead:
    """Edit a tournament you OWN as the authenticated API-token caller, and return
    the updated tournament.

    Mirrors ``PATCH /v1/tournaments/{tournament_id}``: it reuses the shared
    ``edit_tournament`` verb (the ``FOR UPDATE`` load-lock, the owner gate, the
    league-editable-only-while-draft state rule, the STRICT league lookup, the
    partial apply, and the table-catalogue-change → re-solve trigger) and the same
    ``TournamentUpdate`` schema the HTTP route validates, so the MCP and HTTP
    surfaces can never drift on what a valid edit is.

    ``updates`` is a PARTIAL patch: an OMITTED field is left unchanged; a supplied
    field replaces the current value. ``name``, ``address``, ``table_catalogue``
    and ``league_id`` back NOT NULL columns, so an explicit ``null`` for any of
    them is rejected (send them only to set a real value);
    ``description`` / ``start_date`` / ``end_date`` are nullable and may be cleared
    with ``null``. ``table_catalogue`` replaces wholesale when present.
    ``league_id`` is editable ONLY while the tournament is a ``draft`` — once it is
    published the ladder is settled. ``status`` is not editable here (it moves only
    across the guarded lifecycle transitions). Returns the updated
    ``TournamentRead`` from the owner's perspective (``can_edit`` is always true).

    Raises a ``ToolError`` when no tournament with that id exists, when you are not
    the tournament's owner (only the creator may edit it), when you try to change
    the league of a tournament that has left ``draft``, or when ``league_id`` names
    no league.
    """
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        actor = await _load_user(db, user_id)
        if actor is None:
            raise ToolError("Not authenticated.")
        try:
            tournament = await edit_tournament_core(
                db,
                tournament_id=tournament_id,
                actor=actor,
                updates=updates,
            )
        except TournamentNotFoundError as exc:
            raise ToolError(f"No tournament found with id {tournament_id}.") from exc
        except NotTournamentOwnerError as exc:
            raise ToolError("You can only edit tournaments you created.") from exc
        except LeagueNotEditableError as exc:
            raise ToolError(str(exc)) from exc
        except LeagueNotFoundError as exc:
            raise ToolError("No league found with that id.") from exc
        # The core raised ``NotTournamentOwnerError`` unless the caller is the owner,
        # so here the actor is the creator — the owner's perspective the HTTP PATCH
        # serializes from (``created_by_username`` known, ``can_edit`` true).
        return serialize(
            tournament,
            created_by_username=actor.username,
            current_user_id=actor.id,
        )


# The domain-exception family the two draw-write verbs raise for a refusal that is
# NOT a ``DrawError`` — an absent event, a non-owner, or a draw already under way. The
# ``app.draws.DrawError`` family (an un-cuttable field) is a separate hierarchy that
# only ``build_cut`` can hit, and is mapped by ``_map_draw_refusal_tool_error`` below.
_DRAW_WRITE_ERRORS = (
    TournamentNotFoundError,
    EventNotFoundError,
    NotTournamentOwnerError,
    DrawUnderWayError,
)


class DrawUncutConfirmation(BaseModel):
    """The result of tearing an event's draw down (``uncut``) — a small, agent-shaped
    confirmation rather than the HTTP route's bodiless ``204``.

    An MCP tool should answer with a meaningful value, so this names *what* was un-cut
    (the resolved ``tournament_id`` + the ``event_id``) and asserts the outcome:
    ``fixtures_remaining`` is ``0`` after a successful un-cut — the core deleted the
    draw wholesale, so the event provably has no fixtures left. Un-cutting a never-cut
    draw is an idempotent success too — it deletes nothing and still confirms ``0``
    remaining (ADR-0786).

    This schema is **MCP-only** and is attached to no FastAPI route, so it does not
    reach ``openapi.json`` (a mounted MCP sub-app does not contribute to the parent
    schema — see the tournament-verbs ADR).
    """

    tournament_id: uuid.UUID
    event_id: uuid.UUID
    fixtures_remaining: int


async def _tournament_id_for_event(db: AsyncSession, event_id: uuid.UUID) -> uuid.UUID:
    """Resolve the tournament that owns ``event_id`` — the id the shared draw cores
    need alongside the event id.

    An event id is globally unique, so a draw tool can take just the event and recover
    its tournament from the ``TournamentEvent.tournament_id`` foreign key, keeping a
    clean agent-facing signature. A missing event is a not-found ``ToolError`` here,
    before the core is called; because the resolved id comes straight off the event's
    own FK, the core's later event-under-tournament load always matches, so the owner
    gate inside the core is what actually refuses a stranger."""
    tournament_id = (
        await db.execute(
            select(TournamentEvent.tournament_id).where(TournamentEvent.id == event_id)
        )
    ).scalar_one_or_none()
    if tournament_id is None:
        raise ToolError(f"No event found with id {event_id}.")
    return tournament_id


def _map_draw_write_tool_error(exc: Exception, event_id: uuid.UUID) -> ToolError:
    """Adapt a non-``DrawError`` draw-write refusal to an actionable ``ToolError``.

    Mirrors the HTTP adapters (``tournaments.cut_event_draw`` /
    ``uncut_event_draw``) but speaks the agent's language instead of HTTP status
    codes: a tournament/event that does not resolve is one opaque not-found (the tool
    is addressed by event id), a non-owner is told the write is owner-gated, and a draw
    already under way passes through its own domain-authored sentence
    (``DrawUnderWayError`` carries the exact copy)."""
    if isinstance(exc, TournamentNotFoundError | EventNotFoundError):
        return ToolError(f"No event found with id {event_id}.")
    if isinstance(exc, NotTournamentOwnerError):
        return ToolError(
            "You can only cut or remove draws for tournaments you created."
        )
    return ToolError(str(exc))


def _map_draw_refusal_tool_error(error: DrawError) -> ToolError:
    """Adapt a ``DrawError`` — the domain refusing to produce a draw from this event —
    to an actionable ``ToolError``, mirroring the intent of the HTTP route's
    ``_draw_refusal`` but in the agent's language.

    A ``match`` over the error, not ``str(error)`` over whatever arrives, so each arm
    tells an agent which of *their* events cannot be cut and why:

    * ``UnsupportedDrawType`` carries its ``draw_type`` structurally — the event's draw
      type has no generator yet (only round-robin does today), a fact to change on the
      event, not a transient one to retry.
    * ``NonSinglesDraw`` carries its ``event_format`` structurally — a doubles/teams
      event can never be given a draw (an entry is one row per player, with nowhere to
      seat a partner or a team, ADR-0788), so the refusal names the event and is
      permanent.
    * ``DegenerateDraw``'s message is **domain-authored copy** (the strategy alone knows
      which degeneracy it hit and the numbers the director must change — "5 entrants
      across 3 pool(s)"), passed through so the agent reads exactly what a director
      would.
    * The fallback arm is a generic sentence, never a future subclass's own message —
      refusing vaguely is a bug report, leaking internals is a defect."""
    match error:
        case UnsupportedDrawType():
            return ToolError(
                f"This event's {error.draw_type.value} draw can't be cut yet — only "
                "round-robin draws are supported. Change the event's draw type to one "
                "that can, or wait for support."
            )
        case NonSinglesDraw():
            return ToolError(
                f"A {error.event_format.value} event can't be given a draw — only "
                "singles events can. A fixture seats one entrant on each side, and "
                "there's nowhere to record a doubles pairing or a team."
            )
        case DegenerateDraw():
            return ToolError(str(error))
        case _:
            return ToolError("This event's draw can't be cut as the event stands.")


@mcp.tool
async def build_cut(event_id: uuid.UUID) -> list[TournamentFixtureRead]:
    """Cut (or re-cut) an event's DRAW as the authenticated API-token caller — generate
    its fixtures from its entrants — and return them.

    Mirrors ``POST /v1/tournaments/{tournament_id}/events/{event_id}/draw``: it reuses
    the shared ``cut_event_draw`` verb (the ``FOR UPDATE`` tournament row lock, the
    owner gate, the event-under-tournament load, the play-evidence gate, the
    ``cut_draw`` domain core and the re-solve trigger) so the MCP and HTTP surfaces can
    never drift. You address the event by its globally-unique ``event_id`` alone; the
    owning tournament is resolved from it. Cutting is owner-gated (only the
    tournament's creator may cut), and it is NOT tied to status — a draw may be cut and
    re-cut freely while a director inspects the pools and the seeding. **Re-cutting
    replaces the draw wholesale**: the previous fixtures are deleted and a fresh set is
    planned from the event's current active entrants (their ids do not survive).
    Returns the created
    fixtures in **pool → round → position** order — the same ``TournamentFixtureRead``
    the detail page and ``get_schedule`` carry.

    Raises a ``ToolError`` when no event has that id, when you are not the owner of the
    event's tournament, when the draw already shows evidence of play (a fixture with a
    recorded winner or a linked match — it can no longer be cut), or when the event
    cannot produce a draw at all: its draw type has no generator yet (only round-robin
    does today), it has no pools configured for a pooled draw type, or its field is too
    small for its pools (a pool of fewer than two has nobody to play). The message names
    what to change."""
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        actor = await _load_user(db, user_id)
        if actor is None:
            raise ToolError("Not authenticated.")
        tournament_id = await _tournament_id_for_event(db, event_id)
        try:
            return await cut_event_draw_core(
                db, tournament_id=tournament_id, event_id=event_id, actor=actor
            )
        except _DRAW_WRITE_ERRORS as exc:
            raise _map_draw_write_tool_error(exc, event_id) from exc
        except DrawError as error:
            # The domain refusing to produce a draw is not a bug — it is an answer, and
            # the verb already rolled back, so nothing was written. Compose the agent's
            # sentence and surface it as a ``ToolError``.
            raise _map_draw_refusal_tool_error(error) from error


@mcp.tool
async def uncut(event_id: uuid.UUID) -> DrawUncutConfirmation:
    """Un-cut an event's DRAW as the authenticated API-token caller: delete its
    fixtures, leaving the event with no draw. Returns a confirmation carrying the
    resolved tournament, the event, and the fixtures now remaining (``0`` on success).

    Mirrors ``DELETE /v1/tournaments/{tournament_id}/events/{event_id}/draw`` (which
    answers a bodiless ``204``): it reuses the shared ``uncut_event_draw`` verb (the
    ``FOR UPDATE`` tournament row lock, the owner gate, the event-under-tournament load,
    the play-evidence gate, the ``uncut_draw`` core and the ``had_draw``-gated re-solve
    trigger) so the MCP and HTTP surfaces can never drift. You address the event by its
    globally-unique ``event_id`` alone; the owning tournament is resolved from it.
    Un-cutting is owner-gated (only the tournament's creator may). An event with **no
    draw is already in the state this asks for**, so un-cutting a never-cut draw deletes
    nothing and is still a success (``fixtures_remaining`` = ``0``) — it is idempotent.

    Raises a ``ToolError`` when no event has that id, when you are not the owner of the
    event's tournament, or when the draw already shows evidence of play (a fixture with
    a recorded winner or a linked match — it can no longer be removed)."""
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        actor = await _load_user(db, user_id)
        if actor is None:
            raise ToolError("Not authenticated.")
        tournament_id = await _tournament_id_for_event(db, event_id)
        try:
            await uncut_event_draw_core(
                db, tournament_id=tournament_id, event_id=event_id, actor=actor
            )
        except _DRAW_WRITE_ERRORS as exc:
            raise _map_draw_write_tool_error(exc, event_id) from exc
        # A successful ``uncut_event_draw`` deleted the draw wholesale (or there was
        # never one), so the event provably has no fixtures — ``fixtures_remaining``
        # is ``0`` by construction, no confirming re-read of ``fixtures_by_event``
        # needed. The idempotent un-cut of a never-cut draw lands here too, and it is
        # ``0`` for it as well (ADR-0786).
        return DrawUncutConfirmation(
            tournament_id=tournament_id,
            event_id=event_id,
            fixtures_remaining=0,
        )


@mcp.tool
async def request_schedule_solve(tournament_id: uuid.UUID) -> ScheduleSolveRead:
    """Run the SCHEDULER for a tournament you OWN as the authenticated API-token
    caller — queue a solve that places its cut draws' fixtures onto tables and
    times — and return the ledger row that will carry the outcome.

    This is NOT a match-outcome simulation: it does not play games or predict
    winners. It runs the CP-SAT placement SOLVER, which decides *when and where*
    each already-drawn fixture is played (its ``table_id`` and predicted
    ``scheduled_start``), the same run the tournament page's "Run scheduler" button
    triggers.

    It is **ASYNC**: the solve runs on a background worker, so this tool returns the
    freshly queued (or already in-flight) ``ScheduleSolveRead`` immediately — a
    ledger row whose ``status`` is ``queued`` or ``running`` and whose ``verdict`` /
    placement counts are still ``null``. Read the verdict back later via
    ``get_schedule`` (or ``get_tournament``) — its ``latest_schedule_solve`` carries
    the run's final ``status`` and CP-SAT ``verdict`` (``optimal`` / ``feasible`` /
    ``infeasible``) once the worker finishes. Poll it; do not expect the answer in
    this return value.

    Mirrors ``POST /v1/tournaments/{tournament_id}/schedule/solves``: it reuses the
    shared ``request_schedule_solve`` verb (the ``FOR UPDATE`` tournament row lock,
    the owner gate, the has-a-drawn-event gate, and the one coalesced enqueue every
    trigger funnels into) so the MCP and HTTP surfaces can never drift. **One solve
    is in flight per tournament**: if a run is already ``queued`` this request is
    absorbed by it and that row comes back; if one is ``running`` its re-run flag is
    set and the running row comes back; only when neither exists is a fresh run
    queued. Allowed in ANY tournament status, from the moment any event has a cut
    draw — pre-live solves are the point (an ``infeasible`` verdict before going live
    is how a director learns the day does not fit while there is still time).

    Raises a ``ToolError`` when no tournament with that id exists, when you are not
    the tournament's owner (only the creator may run the scheduler), when no event of
    the tournament has a cut draw yet (there is nothing to schedule — ``build_cut`` an
    event's draw first, then retry), or when the scheduler queue itself is
    unreachable (nothing was queued; the same request is safe to retry)."""
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        actor = await _load_user(db, user_id)
        if actor is None:
            raise ToolError("Not authenticated.")
        try:
            row = await request_schedule_solve_core(
                db, tournament_id=tournament_id, actor=actor
            )
        except TournamentNotFoundError as exc:
            raise ToolError(f"No tournament found with id {tournament_id}.") from exc
        except NotTournamentOwnerError as exc:
            raise ToolError(
                "You can only run the scheduler for tournaments you created."
            ) from exc
        except NoDrawnEventsError as exc:
            raise ToolError(
                "There is nothing to schedule yet: no event of this tournament has a "
                "cut draw. The scheduler places a draw's fixtures, so build_cut at "
                "least one event's draw first, then run it again."
            ) from exc
        except ScheduleQueueUnavailableError as exc:
            raise ToolError(
                "The scheduler queue is unavailable, so the solve was not queued. "
                "Try again in a moment."
            ) from exc
        # The core committed and refreshed the queued/running ledger row — serialize
        # it into the same ``ScheduleSolveRead`` the HTTP route and the schedule
        # projection carry, so the agent reads the run's status back off it.
        return ScheduleSolveRead.model_validate(row)


# How long the synchronous ``preview_schedule`` tool waits, in seconds, for the
# ephemeral preview job to reach a terminal state before it gives up and returns a
# retryable ``ToolError``. Bounded well under a minute (ADR "MCP waits internally
# with a bounded timeout") — a preview solve is cap-bounded to a few seconds
# (``preview_solver_time_cap_s`` defaults to 5s) and the MCP path is not behind the
# browser-facing nginx ~60s hop, so a generous-but-finite ceiling lets a preview
# queued behind an in-flight real solve still return in one call, while a stuck
# wait fails loud (retry) rather than hanging.
_PREVIEW_WAIT_TIMEOUT_S = 30.0


def _map_preview_draw_error(error: DrawError) -> ToolError:
    """Adapt a ``DrawError`` — the synthetic-field draw the preview tries to build
    refusing to produce fixtures for one of the tournament's events — to an
    actionable ``ToolError``.

    A preview must never invent a schedule for a format production cannot run (the
    false-confidence failure the real-engine decision exists to prevent, ADR "draw
    coverage is round-robin only; every other type is refused loud"), so an
    un-drawable event refuses the *whole* preview, never a partial grid. A ``match``
    over the error names which of the caller's events is not schedulable to preview
    and why, mirroring ``_map_draw_refusal_tool_error`` but in the preview's voice:

    * ``UnsupportedDrawType`` carries its ``draw_type`` structurally — the event's
      draw type has no schedule generator yet (only round-robin does today), a fact
      to change on the event, not a transient one to retry.
    * ``NonSinglesDraw`` carries its ``event_format`` structurally — a doubles/teams
      event can never be given a draw (ADR-0788), so it can never be previewed.
    * ``DegenerateDraw``'s message is domain-authored copy (the numbers the director
      must change), passed through so the agent reads exactly what a director would.
    * The fallback arm is a generic sentence, never a future subclass's own message.
    """
    match error:
        case UnsupportedDrawType():
            return ToolError(
                f"This tournament isn't schedulable to preview yet: an event's "
                f"{error.draw_type.value} draw has no schedule generator — only "
                "round-robin draws can be previewed. Change the event's draw type "
                "to round-robin, or wait for support."
            )
        case NonSinglesDraw():
            return ToolError(
                f"A {error.event_format.value} event can't be previewed — only "
                "singles events can be drawn and scheduled. A fixture seats one "
                "entrant on each side, with nowhere to record a doubles pairing or "
                "a team."
            )
        case DegenerateDraw():
            return ToolError(str(error))
        case _:
            return ToolError(
                "This tournament isn't schedulable to preview as its events stand."
            )


@mcp.tool
async def preview_schedule(
    tournament_id: uuid.UUID,
    overrides: dict[uuid.UUID, int] | None = None,
) -> PreviewResult:
    """Preview the SCHEDULE for a PRE-LIVE tournament you OWN as the authenticated
    API-token caller — solve a synthetic field over the tournament's real tables,
    windows and formats **before anyone has registered** — and return the whole
    result in ONE call.

    This is NOT a real solve and it persists NOTHING: no entries, no fixtures, no
    solve-ledger row. It draws a synthetic field (each event auto-filled to its cap,
    or ``overrides``) and runs the SAME CP-SAT engine a live tournament uses over the
    tournament's real ``table_catalogue`` and pool windows, so "fits / doesn't fit"
    means exactly what it will at go-live. It answers *"given my tables, time
    windows, formats and games-per-match, would the schedule even fit — and roughly
    how long is the day?"* while there is still time to change the setup.

    Unlike ``request_schedule_solve`` (async — it returns a queued ledger row you
    poll later), this tool is **SYNCHRONOUS**: it enqueues the ephemeral preview,
    waits internally (bounded, a few seconds — the preview time cap is short) and
    returns the finished ``PreviewResult`` — the ``verdict`` (``optimal`` /
    ``feasible`` = fits; ``infeasible`` = proven not to fit; ``unknown`` = the cap
    ran out, ask again), the estimated duration + wall-clock finish, the match / bye
    / peak-table counts, a per-event breakdown, the resolved infeasibility reasons
    when it does not fit, and an always-present honest-notes strip. The estimate is
    **optimistic**: the synthetic field is disjoint across events (no player is in
    two), so it ignores cross-event contention — stated in ``notes``, not hidden.

    ``overrides`` is optional: a map of event id → synthetic field size to explore a
    ``"what if N show up"`` scenario; an omitted event fills to its own cap (or the
    uncapped default). Owner-gated (only the creator may preview) and allowed only
    while the tournament is PRE-LIVE (``draft`` or ``published``); a ``live`` /
    ``archived`` tournament is refused (there is a real field and a real solve to
    look at, or it is over).

    Draw coverage is ROUND-ROBIN ONLY: an event with any other draw type (single- /
    double-elim, swiss, rr-then-ko) refuses the WHOLE preview with an actionable
    ``ToolError`` — never a partial grid — because a preview must not invent a
    schedule for a format production cannot run.

    Raises a ``ToolError`` when no tournament with that id exists, when you are not
    the tournament's owner (only the creator may preview), when the tournament is no
    longer pre-live (``live`` / ``archived``), when an event's draw type is not
    round-robin (not schedulable to preview yet — change it or wait for support),
    when the preview queue is unreachable (nothing was queued; safe to retry), or
    when the solve is still running past the internal wait (still solving — retry).
    """
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        actor = await _load_user(db, user_id)
        if actor is None:
            raise ToolError("Not authenticated.")
        try:
            enqueued = await request_schedule_preview_core(
                db,
                tournament_id=tournament_id,
                actor=actor,
                count_overrides=overrides,
            )
        except TournamentNotFoundError as exc:
            raise ToolError(f"No tournament found with id {tournament_id}.") from exc
        except NotTournamentOwnerError as exc:
            raise ToolError(
                "You can only preview schedules for tournaments you created."
            ) from exc
        except TournamentNotPreLiveError as exc:
            # Carries its own status-aware sentence (draft/published only).
            raise ToolError(str(exc)) from exc
        except ScheduleQueueUnavailableError as exc:
            raise ToolError(
                "The preview queue is unavailable, so nothing was queued. "
                "Try again in a moment."
            ) from exc
        except DrawError as error:
            # A non-round-robin (or otherwise un-drawable) event refuses the whole
            # preview loud — never a partial grid. The enqueue already rolled back
            # (nothing was written or queued).
            raise _map_preview_draw_error(error) from error

    # Wait for the ephemeral job to finish and return the result in this one call
    # (ADR "MCP waits internally with a bounded timeout"). The wait is a blocking
    # poll loop, so it runs off the event loop in a worker thread — a synchronous
    # MCP call is fine here (no browser-facing nginx hop), but it must not stall the
    # async server.
    state = await to_thread.run_sync(
        partial(wait_for_preview, enqueued.token, timeout_s=_PREVIEW_WAIT_TIMEOUT_S)
    )
    if state.status is PreviewJobStatus.done and state.result is not None:
        return state.result
    if state.status is PreviewJobStatus.failed:
        raise ToolError(state.error or "The preview solve failed.")
    # Still queued/running past the bounded wait — in flight, not failed. Retryable,
    # not a hang: the caller runs the tool again.
    raise ToolError(
        "The preview is still solving. Try again in a moment to read the result."
    )


@mcp.tool
async def search_players(
    query: str,
    limit: SearchLimit = SEARCH_DEFAULT_LIMIT,
) -> list[PlayerRead]:
    """Search registered players by username as the authenticated API-token
    caller — the opponent picker's typeahead.

    Mirrors ``GET /v1/players/search``: it reuses the shared
    ``search_players_by_username`` query so the MCP and HTTP surfaces can never
    drift. ``query`` is matched as a case-insensitive substring; the caller is
    always excluded, as are tombstoned (merged-away) users, and results are
    ordered alphabetically and capped at ``limit`` (default 10). A blank
    ``query`` matches nothing and returns an empty list. Each hit carries the
    player's rating in the default league (``null`` for an unrated player). Use a
    hit's ``id`` as ``create_match``'s ``opponent_user_id``.
    """
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        return await search_players_by_username(
            db, query=query, current_user_id=user_id, limit=limit
        )


@mcp.tool
async def list_my_matches(
    page: MatchPage = 1,
    page_size: MatchPageSize = MY_MATCHES_DEFAULT_PAGE_SIZE,
) -> PlayerMatchListResponse:
    """List the authenticated API-token caller's OWN match history, newest first.

    Reuses the same ``paginated_player_matches`` read the HTTP
    ``GET /v1/players/{id}/matches`` endpoint serves — scoped to the caller — so
    the MCP and HTTP surfaces can never drift. Unlike the global
    ``GET /v1/matches`` feed (every platform match, by design), this returns only
    matches the CALLER is a side of. The history is all-inclusive (ADR-0008):
    any status, rated or not, solo "No opponent" matches included. Each row is
    projected onto the caller's side — ``games`` read ``mine``/``theirs``,
    ``result`` is ``W``/``L`` only once a match is decided (``null`` while it is
    pending / in play / awaiting acceptance / voided), and ``rating_change`` is
    the delta the match moved for the caller (``null`` unless decided and rated).
    ``page`` (1-based) and ``page_size`` (default 25) page through the history;
    ``total`` is the all-inclusive count.
    """
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        return await paginated_player_matches(db, user_id, page, page_size)


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
        await notify_result_posted(notifications, match, poster_id)
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
