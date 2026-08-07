"""The FortyMM MCP server: a FastMCP app mounted at ``/mcp`` on the FastAPI app.

Router-free (no FastAPI imports); it owns a configured :data:`mcp` ``FastMCP``
instance whose transport authentication is an Auth0 OAuth Resource-Server
verifier (:class:`FortymmAuth0TokenVerifier` behind a ``RemoteAuthProvider``).
The curated match-flow verbs are registered here as tools (starting with the
:func:`get_match` read); each reuses the shared match service + serializer so the
MCP and HTTP surfaces can never drift.

Auth is the MCP 2025 OAuth flow with Auth0 as the Authorization Server and this
server as a stateless Resource Server (see
``docs/adr/20260722-the-mcp-server-is-an-oauth-resource-server-trusting-auth0.md``).
The verifier does RS256/JWKS/iss/aud/exp checks on the Auth0-issued access token,
then resolves its ``sub`` to the explicitly **linked**, non-tombstoned ``User``
(:func:`app.auth0_identity.resolve_linked_user`) and admits it only if that user
holds the ``mcp.access`` permission — so an unauthenticated or unauthorized MCP
call fails **at the transport** (401), not inside a tool. Auth0 OAuth is the only
way to authenticate to the MCP surface — the legacy opaque personal-API-token
flow it briefly shared has since been removed platform-wide. Every tool
authenticates before it runs.

**Fails closed when unconfigured.** With ``AUTH0_*`` empty (local / qa / e2e /
dev-compose all boot the api without Auth0), the api still imports and MCP still
mounts, but the verifier rejects every request — construction never touches Auth0
and a reject-all verifier 401s every call.

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
from fastmcp.server.auth import (
    AccessToken,
    JWTVerifier,
    RemoteAuthProvider,
    TokenVerifier,
)
from fastmcp.server.dependencies import get_access_token, get_http_request
from pydantic import AnyHttpUrl, BaseModel, Field
from pyrate_limiter import Duration, Rate
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth0_identity import resolve_linked_user
from app.auth0_provisioning import (
    AUTH0_EMAIL_CLAIM,
    AUTH0_EMAIL_VERIFIED_CLAIM,
    resolve_or_provision_user,
)
from app.config import get_settings
from app.db import get_sessionmaker
from app.draws import (
    DegenerateDraw,
    DrawError,
    NonSinglesDraw,
    UnsupportedDrawType,
)
from app.geocoding import AddressNotGeocodableError
from app.geocoding.dependencies import get_geocoder
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
from app.models import Match, Tournament, TournamentEvent, TournamentStatus, User
from app.notifications.dependencies import get_push_sender
from app.notifications.service import NotificationService
from app.player_matches import paginated_player_matches
from app.player_search import SEARCH_DEFAULT_LIMIT, search_players_by_username
from app.rate_limiting import RedisRateLimiter
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
from app.schedule_solve_queries import (
    LIST_DEFAULT_PAGE_SIZE,
    LIST_MAX_PAGE_SIZE,
)
from app.schedule_solve_queries import (
    list_schedule_solves as list_schedule_solves_core,
)
from app.schedule_solves import latest_solve
from app.schemas.admin import AdminScheduleSolveRead
from app.schemas.match import MatchDetails, MatchResultsGameWrite
from app.schemas.player import PlayerMatchListResponse, PlayerRead
from app.schemas.schedule_preview import (
    PreviewJobStatus,
    PreviewResult,
)
from app.schemas.tournament import (
    ScheduleSolveRead,
    TournamentCreate,
    TournamentDetailRead,
    TournamentEntrantRead,
    TournamentEventCreate,
    TournamentEventRead,
    TournamentEventUpdate,
    TournamentFixturePlacementUpdate,
    TournamentFixtureRead,
    TournamentRead,
    TournamentUpdate,
)
from app.services.match_service import MatchService
from app.tournament_draw_service import cut_event_draw as cut_event_draw_core
from app.tournament_draw_service import uncut_event_draw as uncut_event_draw_core
from app.tournament_edit import edit_tournament as edit_tournament_core
from app.tournament_entries import enter_event as enter_event_core
from app.tournament_entries import withdraw_from_event as withdraw_from_event_core
from app.tournament_errors import (
    DrawTypeFrozenError,
    DrawUnderWayError,
    EntryNotFoundError,
    EntryRefusedError,
    EventNotFoundError,
    FixtureNotFoundError,
    FixturePlacementFrozenError,
    IllegalTournamentTransitionError,
    LeagueNotEditableError,
    LeagueNotFoundError,
    NoDefaultLeagueError,
    NoDrawnEventsError,
    NonSinglesEntryError,
    NotAllowedToEnterError,
    NotAllowedToWithdrawError,
    NotTournamentOwnerError,
    PlacementTableNotFoundError,
    PlayerNotFoundError,
    PoolNotInEventError,
    PoolSetFrozenError,
    ScheduleQueueUnavailableError,
    TableInUseError,
    TableNotInCatalogueError,
    TournamentAlreadyInStatusError,
    TournamentNotFoundError,
    TournamentNotPreLiveError,
    TournamentNotReadyToGoLiveError,
    WithdrawalRegistrationClosedError,
)
from app.tournament_events import create_event as create_event_core
from app.tournament_events import delete_event as delete_event_core
from app.tournament_events import update_event as update_event_core
from app.tournament_geocoding import ADDRESS_NOT_GEOCODABLE_CODE
from app.tournament_lifecycle import create_tournament as create_tournament_core
from app.tournament_lifecycle import delete_tournament as delete_tournament_core
from app.tournament_lifecycle import (
    transition_tournament as transition_tournament_core,
)
from app.tournament_list import list_tournament_details, tournament_detail
from app.tournament_placement import place_fixture as place_fixture_core
from app.tournament_queries import (
    fixtures_by_event,
    visible_to,
)
from app.tournament_serialization import (
    serialize,
    shape_created_event_read,
    shape_event_read,
)
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

# The permission tournament creation gates on — the same seeded RBAC name the HTTP
# router's ``require_create`` dependency enforces
# (``app.tournaments.TOURNAMENT_CREATE``,
# ``scripts/seed_rbac.py``). Held as a literal rather than imported from the router so
# the MCP adapter stays router-free; ``create_tournament`` asks it through the one
# shared ``user_has_permission`` (``app.rbac``), so a mounted tool grants an agent
# nothing its user lacks over HTTP — the adapter enforces the SAME auth as HTTP.
TOURNAMENT_CREATE_PERMISSION = "tournament.create"

# The ADMIN permission the solve-ledger read gates on — the same seeded RBAC name the
# HTTP router's ``require_permission(...)`` dependency enforces
# (``app.admin_schedule_solves.SCHEDULING_VIEW_PERMISSION``, ``scripts/seed_rbac.py``).
# Held as a literal rather than imported from the router so the MCP adapter stays
# router-free; ``list_schedule_solves`` asks it through the one shared
# ``user_has_permission`` (``app.rbac``), so the operator-only ledger is gated on the
# SAME grant over MCP as over HTTP — a mounted tool grants an agent nothing its user
# lacks.
SCHEDULING_VIEW_PERMISSION = "scheduling.view"

# The MCP ``list_schedule_solves`` argument bounds, mirroring the HTTP query-param caps
# (``schedule_solve_queries``: default 25 to a page, capped at 100) so the two surfaces
# can't drift on what a valid page/size is. An out-of-range value is a schema-level
# validation error at the transport, not a tool-body ``ToolError``.
ScheduleSolvePage = Annotated[int, Field(ge=1)]
ScheduleSolvePageSize = Annotated[int, Field(ge=1, le=LIST_MAX_PAGE_SIZE)]


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


# The fortymm permission an Auth0-linked user must hold for the MCP transport to
# admit them — the new seeded RBAC grant on the Beta tester role
# (``scripts/seed_rbac.py``). Auth0 proves *who* the caller is (the token's
# ``sub``); this grant decides *whether* they may reach the MCP surface at all, so
# revoking it cuts an agent off immediately even while its Auth0 token is still
# valid (see the Auth0 Resource-Server ADR).
MCP_ACCESS_PERMISSION = "mcp.access"

# A fail-closed placeholder origin used only when Auth0 is unconfigured (``AUTH0_*``
# empty). ``RemoteAuthProvider`` validates its URLs as ``AnyHttpUrl``, so an empty
# ``base_url`` / ``authorization_servers`` entry would raise at import; this
# stand-in lets construction succeed while the reject-all verifier 401s every
# request. The ``.invalid`` TLD (RFC 6761) can never resolve, so it can never be
# mistaken for a live metadata origin.
_UNCONFIGURED_ORIGIN = "https://mcp-unconfigured.fortymm.invalid"


# Per-IP ceiling on the verifier's WRITE path only — the match-bind / provision
# that a verified-but-*unlinked* token triggers *before* the ``mcp.access`` check,
# i.e. an as-yet-unauthorized caller writing to ``users``. The steady-state linked
# path (every later request) skips it entirely. 20/hour/IP is generous for
# legitimate first-time agent onboarding (a client provisions once, then resolves
# by ``sub`` forever after) while capping an attacker who mints fresh
# verified-email identities from one IP to spray accounts. No ``identifier``: the
# verifier has no FastAPI ``Request``, so it keys ``check()`` by client IP itself.
_provision_ip_rate_limit = RedisRateLimiter(
    rates=[Rate(20, Duration.HOUR)],
    bucket_key="mcp-provision-ip",
)


def _provision_client_ip() -> str:
    """Client IP for the provision/match rate-limit key, from the active MCP HTTP
    request. ``request.client.host`` is the true client IP given
    ``FORWARDED_ALLOW_IPS`` at the uvicorn edge (ADR-0008). Falls back to a fixed
    ``"unknown"`` key when there's no live request context (``verify_token`` called
    off a request, e.g. a unit test) so the limiter degrades to one shared bucket
    rather than raising."""
    try:
        request = get_http_request()
    except RuntimeError:
        return "unknown"
    client = request.client
    return client.host if client else "unknown"


class _RejectAllTokenVerifier(TokenVerifier):
    """The fail-closed verifier the MCP transport uses when Auth0 is unconfigured.

    With ``AUTH0_*`` empty there is no issuer/audience/JWKS to trust, so every
    token is rejected outright — the api still boots and MCP still mounts, but
    every MCP request 401s (ADR "fails closed when unconfigured"). Constructing
    this touches no Auth0 config, so ``from app.main import app`` succeeds with an
    empty environment."""

    async def verify_token(self, token: str) -> AccessToken | None:
        return None


class FortymmAuth0TokenVerifier(JWTVerifier):
    """Authenticates every MCP request against an Auth0-issued RS256 JWT, then
    authorizes it against fortymm RBAC.

    The :class:`JWTVerifier` base does the authentication (JWKS fetch with a
    built-in cache, and RS256 / issuer / audience / expiry checks); we override
    :meth:`verify_token` to add fortymm's authorization on top. On a token that
    fails verification we return ``None`` (→ 401). On a verified token we read its
    ``sub`` (and namespaced email claims) and resolve it to a non-tombstoned
    ``User`` (:func:`app.auth0_provisioning.resolve_or_provision_user`); a ``sub``
    that resolves to no live user, or a user lacking ``mcp.access``, is also
    ``None`` (→ 401).

    Resolution goes through :func:`app.auth0_provisioning.resolve_or_provision_user`,
    which first tries the explicitly linked user and, failing that, *matches* the
    token's verified email to an existing account (binding the ``sub``) or
    *provisions* a fresh registered account on it — so a first-time agent whose
    verified Auth0 email matches (or has no) fortymm account gets in without a
    manual link step. An unverified / absent email never matches or provisions.

    On success we return an ``AccessToken`` that preserves the existing tool
    contract: the resolved user id rides as ``subject`` / ``client_id`` and under
    a ``user_id`` claim, so :func:`_authenticated_user_id` and every ``@mcp.tool``
    are untouched by the switch from the opaque token to Auth0."""

    async def verify_token(self, token: str) -> AccessToken | None:
        access = await super().verify_token(token)
        if access is None:
            return None
        sub = access.claims.get("sub")
        if not isinstance(sub, str) or not sub:
            return None
        async with mcp_session() as db:
            # Hot path: an already-linked ``sub`` resolves with no write. This is
            # every steady-state request, so it is NOT rate limited.
            user = await resolve_linked_user(db, sub)
            if user is None:
                # Write path: the ``sub`` isn't linked yet, so resolving it means
                # a match-bind or a fresh provision — an as-yet-unauthorized
                # caller writing to ``users``. Bound per client IP so a stream of
                # freshly-minted verified-email identities from one source can't
                # spray accounts; over the ceiling we refuse (→401) without
                # touching the write path.
                # ``bucket_key`` already namespaces the ZSET, so the key is just
                # the client IP (not re-prefixed).
                if not await _provision_ip_rate_limit.check(_provision_client_ip()):
                    return None
                # The namespaced email claims the Auth0 Action ships (see
                # ``app.auth0_provisioning``). Only a non-empty ``str`` email
                # counts, and ``email_verified`` must be the literal boolean
                # ``True`` — anything else is treated as unverified, so an
                # absent/false claim never matches or provisions.
                raw_email = access.claims.get(AUTH0_EMAIL_CLAIM)
                email = raw_email if isinstance(raw_email, str) and raw_email else None
                email_verified = access.claims.get(AUTH0_EMAIL_VERIFIED_CLAIM) is True
                user = await resolve_or_provision_user(db, sub, email, email_verified)
                if user is None:
                    return None
            if not await user_has_permission(db, user.id, MCP_ACCESS_PERMISSION):
                return None
            user_id = str(user.id)
        return AccessToken(
            token=token,
            client_id=user_id,
            subject=user_id,
            scopes=access.scopes,
            expires_at=access.expires_at,
            claims={**access.claims, "user_id": user_id},
        )


def _build_mcp_auth() -> RemoteAuthProvider:
    """Wire the MCP transport auth from :class:`~app.config.Settings`.

    Auth0 is treated as configured **all-or-nothing**: only when ALL of
    ``auth0_domain``, ``auth0_audience``, ``mcp_public_base_url`` and
    ``mcp_public_resource_url`` are set does the provider wrap a real
    :class:`FortymmAuth0TokenVerifier` (pointed at the tenant's JWKS/issuer) and
    advertise the tenant as its authorization server. A PARTIAL config — e.g. a
    deployment that sets the tenant but forgets the public URLs — falls back to
    the reject-all verifier just like the empty (local / qa / e2e / dev-compose)
    default, so the api boots and MCP mounts but every request 401s (fail-closed).
    This never ships a live verifier advertising the ``.invalid`` placeholder
    origin (broken RFC 9728 discovery). The public ``base_url`` /
    ``resource_base_url`` come straight from config (never derived from the
    internal mount) so the metadata reflects the origin behind nginx."""
    settings = get_settings()
    if (
        settings.auth0_domain
        and settings.auth0_audience
        and settings.mcp_public_base_url
        and settings.mcp_public_resource_url
    ):
        token_verifier: TokenVerifier = FortymmAuth0TokenVerifier(
            jwks_uri=settings.auth0_jwks_uri,
            issuer=settings.auth0_issuer,
            audience=settings.auth0_audience,
            algorithm="RS256",
        )
        authorization_server = settings.auth0_issuer
    else:
        token_verifier = _RejectAllTokenVerifier()
        authorization_server = _UNCONFIGURED_ORIGIN
    return RemoteAuthProvider(
        token_verifier=token_verifier,
        authorization_servers=[AnyHttpUrl(authorization_server)],
        base_url=settings.mcp_public_base_url or _UNCONFIGURED_ORIGIN,
        resource_base_url=settings.mcp_public_resource_url or None,
        resource_name="FortyMM",
    )


# The mounted MCP server. ``auth`` wires the Auth0 Resource-Server provider so
# authentication happens at the transport for every request; each tool below reads
# the resolved caller from the FastMCP auth context rather than re-parsing the token.
mcp: FastMCP[None] = FastMCP("FortyMM", auth=_build_mcp_auth())


def _authenticated_user_id() -> uuid.UUID:
    """The resolved caller's ``users.id`` from the FastMCP auth context.

    The transport already authenticated the request
    (``FortymmAuth0TokenVerifier``); that minted an :class:`AccessToken` carrying
    the resolved user id under a ``user_id`` claim (and as ``subject``). We read
    it back here rather than
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


async def _require_tournament_create(db: AsyncSession, user_id: uuid.UUID) -> None:
    """The tournament-create gate: refuse unless the caller holds ``tournament.create``.

    The transport-neutral twin of the HTTP ``require_create`` dependency, asked through
    the one shared ``user_has_permission`` — so the MCP and HTTP surfaces gate creation
    on the same grant and a mounted tool grants an agent nothing its user lacks over
    HTTP (ADR: the MCP adapter must enforce the SAME auth as HTTP). Held at the ADAPTER,
    not in the shared verb, exactly as ``_require_tournament_view`` keeps the read gate
    at the adapter. Checked first, before the verb runs, the order ``require_create``
    (403) keeps ahead of the HTTP handler."""
    if not await user_has_permission(db, user_id, TOURNAMENT_CREATE_PERMISSION):
        raise ToolError("You do not have permission to create tournaments.")


async def _require_schedule_solve_admin(db: AsyncSession, user_id: uuid.UUID) -> None:
    """The admin solve-ledger gate: refuse unless the caller holds ``scheduling.view``.

    The transport-neutral twin of the HTTP admin router's
    ``require_permission("scheduling.view")`` dependency, asked through the one shared
    ``user_has_permission`` — so the MCP and HTTP surfaces gate the operator-only ledger
    on the same grant, and a mounted tool grants an agent nothing its user lacks over
    HTTP (ADR: the MCP adapter must enforce the SAME auth as HTTP). This is the
    security crux of the read: an unauthorized caller is refused HERE, before any
    row is loaded, so a ``ToolError`` is all it ever sees — never the ledger.
    Checked first, the order the HTTP route keeps (the ``require_permission`` (403)
    dependency runs before the handler)."""
    if not await user_has_permission(db, user_id, SCHEDULING_VIEW_PERMISSION):
        raise ToolError("You don't have permission to view the schedule-solve ledger.")


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
    """Read a single match as the authenticated MCP caller.

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
    """Start a match as the authenticated MCP caller and return it.

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
    """Save the first score for a game as the authenticated MCP caller and
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
async def list_schedule_solves(
    tournament_id: uuid.UUID | None = None,
    page: ScheduleSolvePage = 1,
    page_size: ScheduleSolvePageSize = LIST_DEFAULT_PAGE_SIZE,
) -> list[AdminScheduleSolveRead]:
    """Read the Administration area's cross-tournament SOLVE LEDGER as the
    authenticated MCP caller — one page, newest request first.

    Mirrors the admin ``GET /v1/admin/schedule-solves``: it composes the exact same
    shared reader the HTTP route composes (``schedule_solve_queries``), so the two
    surfaces can never drift on what a ledger row is. Each row is one run of the
    placement solver exactly as ``schedule_solves`` recorded it (ADR "the schedule is
    solved; the call is pinned"), plus the operator-only facts the tournament-facing
    read omits: the drift guard's ``input_fingerprint``, the coalescer's
    ``rerun_requested``, and the owning tournament's id and name. ``tournament_id``
    narrows the ledger to one tournament's runs; ``page`` / ``page_size`` paginate (25
    to a page by default, capped at 100). Returns the page as a list of
    ``AdminScheduleSolveRead`` — an empty ledger (or a page past the end) is ``[]``.

    This is an OPERATOR read, gated on the same ``scheduling.view`` permission the HTTP
    admin route requires — not tournament ownership: it spans every tournament's runs.
    An agent whose user lacks that grant is refused before any row is read.

    Raises a ``ToolError`` when you lack ``scheduling.view``.
    """
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        # Permission first, through the same shared gate the HTTP admin router's
        # ``require_permission("scheduling.view")`` dependency asks — before any ledger
        # row is read, so an unauthorized caller only ever sees a ``ToolError`` (the
        # order the HTTP route keeps: the 403 dependency runs before the handler).
        await _require_schedule_solve_admin(db, user_id)
        return await list_schedule_solves_core(
            db,
            tournament_id=tournament_id,
            page=page,
            page_size=page_size,
        )


@mcp.tool
async def get_tournament(tournament_id: uuid.UUID) -> TournamentDetailRead:
    """Read a single tournament as the authenticated MCP caller.

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
        # The identical seven-statement batched composition + ``serialize_detail`` the
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
    """Read a tournament's SCHEDULE as the authenticated MCP caller — a
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
    """List the tournaments the authenticated MCP caller OWNS, newest first.

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


# The shared tournament-write refusals the owner-gated tournament tools raise
# identically — an absent tournament, an absent event, a non-owner — mapped once by
# ``_map_tournament_write_tool_error`` so a further tool cannot grow a divergent
# not-found message or owner-denial. Mirrors ``_DRAW_WRITE_ERRORS`` +
# ``_map_draw_write_tool_error`` here, and the HTTP side's ``_TOURNAMENT_WRITE_ERRORS``
# + ``_map_tournament_write_error``. The genuinely verb-specific arms — the strict
# league 404, the two draw freezes, the entry refusal, the placement freeze — stay
# inline in their tool, because each is one tool's alone.
_TOURNAMENT_WRITE_TOOL_ERRORS = (
    TournamentNotFoundError,
    EventNotFoundError,
    NotTournamentOwnerError,
)


def _map_tournament_write_tool_error(
    exc: Exception,
    *,
    tournament_id: uuid.UUID,
    event_id: uuid.UUID | None = None,
    owner_denial: str | None = None,
) -> ToolError:
    """Adapt a shared tournament-write refusal to the exact ``ToolError`` each
    owner-gated tool produced inline.

    The not-found arms are fully shared — ``TournamentNotFoundError`` names the
    ``tournament_id`` and ``EventNotFoundError`` names the ``event_id`` — mirroring
    ``_map_draw_write_tool_error`` but keyed by the id a tournament-addressed tool
    holds, rather than collapsing both into one event not-found (a draw tool is
    addressed by event id alone; these are not). The owner arm is the single per-verb
    difference: ``owner_denial`` is that verb's phrase ("edit", "add events to", …), so
    the message stays ``"You can only <phrase> tournaments you created."`` verbatim.

    ``event_id`` and ``owner_denial`` are optional in the same way and for the same
    reason: only the tools that can raise the arm needing them pass them. A
    tournament-only tool (``delete_tournament``, ``place_fixture``) has no ``event_id``;
    ``withdraw_from_event`` has no owner arm at all — its owner-ish refusal is the
    separate ``NotAllowedToWithdrawError``, mapped in the tool — so it passes neither,
    routing only its two not-found arms through here."""
    if isinstance(exc, TournamentNotFoundError):
        return ToolError(f"No tournament found with id {tournament_id}.")
    if isinstance(exc, EventNotFoundError):
        return ToolError(f"No event found with id {event_id}.")
    if isinstance(exc, NotTournamentOwnerError) and owner_denial is not None:
        return ToolError(f"You can only {owner_denial} tournaments you created.")
    return ToolError(str(exc))


def _map_address_not_geocodable_tool_error(
    exc: AddressNotGeocodableError,
) -> ToolError:
    """Adapt an unresolvable venue address (ADR-0968's coded-refusal convention) to a
    ``ToolError`` that NAMES the machine-readable code the HTTP surface answers with,
    then hands the agent the address it could not resolve.

    The HTTP create/edit adapters answer this with the coded 409
    ``{"detail": {"code": ADDRESS_NOT_GEOCODABLE_CODE, ...}}``; an agent reads prose, so
    the code rides in the prose (``[address_not_geocodable]``, exactly as the coded
    entry refusals do) and the verb's own message — which address failed — follows, so
    the agent is told both *which* rule refused it and *why* in its own words."""
    return ToolError(f"Address not geocodable [{ADDRESS_NOT_GEOCODABLE_CODE}]: {exc}")


@mcp.tool
async def edit_tournament(
    tournament_id: uuid.UUID,
    updates: TournamentUpdate,
) -> TournamentRead:
    """Edit a tournament you OWN as the authenticated MCP caller, and return
    the updated tournament.

    Mirrors ``PATCH /v1/tournaments/{tournament_id}``: it reuses the shared
    ``edit_tournament`` verb (the ``FOR UPDATE`` load-lock, the owner gate, the
    league-editable-only-while-draft state rule, the STRICT league lookup, the
    partial apply, and the table-catalogue-change → re-solve trigger) and the same
    ``TournamentUpdate`` schema the HTTP route validates, so the MCP and HTTP
    surfaces can never drift on what a valid edit is.

    ``updates`` is a PARTIAL patch: an OMITTED field is left unchanged; a supplied
    field replaces the current value. ``name`` and ``league_id`` back NOT NULL columns
    and ``table_catalogue`` backs a whole child table, so an explicit ``null`` for any
    of them is rejected (send them only to set a real value); ``description`` /
    ``start_date`` / ``end_date`` are nullable and may be cleared with ``null``.

    ``address`` (the venue) has THREE cases, so read this before sending one: OMIT it
    to leave the current venue and its coordinates untouched; send a real address to
    move the venue (it is re-geocoded only if its text actually changed); send ``null``
    — or an object whose six components are all blank — to REMOVE the venue entirely.
    A tournament with no venue is a legitimate state (announced before the venue is
    booked, or a private tournament withholding its address), so do not invent a
    placeholder address to fill the field.

    ``table_catalogue``, when present, is the venue catalogue IN FULL and IN ORDER, and
    it is applied as an ID-KEYED DIFF. So SEND BACK THE CATALOGUE YOU READ, EDITED — a
    fresh list is not an edit of the old one, it is a request to remove every table the
    tournament has and add new ones. Each entry either carries the ``id`` of a table
    this tournament already has (keeping that table, with the ``label``, ``court``
    and place this list gives it) or omits the ``id`` to ADD a table, whose id the
    server mints. A stored table no entry names is REMOVED. An ``id`` this tournament
    does not have is rejected — it is never taken as a request for a new table.

    REMOVING A TABLE THAT MATCHES ARE PLACED AT IS REFUSED, and nothing is written. The
    refusal names the table and how many matches are on it. To go through with it, send
    the SAME edit again with ``unplace_fixtures_on_removed_tables`` set to true: the
    table goes and those matches are unplaced — table, predicted start and call all
    cleared. Do not set it pre-emptively "just in case"; it exists so that losing a
    director's schedule is something they said yes to. Removing a table that only a POOL
    reserves is not refused and needs no opt-in — the pool simply reserves one fewer.

    ``league_id`` is editable ONLY while the tournament is a ``draft`` — once it is
    published the ladder is settled. ``status`` is not editable here (it moves only
    across the guarded lifecycle transitions). Returns the updated
    ``TournamentRead`` from the owner's perspective (``can_edit`` is always true).

    Raises a ``ToolError`` when no tournament with that id exists, when you are not
    the tournament's owner (only the creator may edit it), when you try to change
    the league of a tournament that has left ``draft``, when ``league_id`` names
    no league, when a ``table_catalogue`` entry names a table id this tournament does
    not have, when it would remove a table matches are placed at without the opt-in, or
    when a changed venue ``address`` cannot be geocoded (the
    ``[address_not_geocodable]`` refusal — coordinates are geocoded server-side, and
    an address that has them cannot be stored without them). Removing the venue
    geocodes nothing and so can never raise that one.
    """
    user_id = _authenticated_user_id()
    # The geocoder is built from ``Settings`` (the ``GEOCODER`` setting names it —
    # ``google`` or the deterministic ``fake``; a keyless ``google`` is refused at
    # ``Settings`` construction rather than falling back) — the MCP surface has no
    # ``Depends``, so it constructs the same seam the HTTP route resolves with
    # ``Depends(get_geocoder)``.
    geocoder = get_geocoder(get_settings())
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
                geocoder=geocoder,
            )
        except _TOURNAMENT_WRITE_TOOL_ERRORS as exc:
            raise _map_tournament_write_tool_error(
                exc, tournament_id=tournament_id, owner_denial="edit"
            ) from exc
        except LeagueNotEditableError as exc:
            raise ToolError(str(exc)) from exc
        except LeagueNotFoundError as exc:
            raise ToolError("No league found with that id.") from exc
        except TableInUseError as exc:
            # The catalogue's named 409, as prose: the sentence already names the tables
            # and the way out (``unplace_fixtures_on_removed_tables``), which is exactly
            # what an agent needs to decide whether to ask its director and retry.
            raise ToolError(str(exc)) from exc
        except TableNotInCatalogueError as exc:
            # The HTTP surface answers this on the field; an agent reads prose, so the
            # offending id rides in the sentence rather than in a ``loc``.
            raise ToolError(
                f"{exc} (table_catalogue entry {exc.index} names “{exc.table_id}”)."
            ) from exc
        except AddressNotGeocodableError as exc:
            raise _map_address_not_geocodable_tool_error(exc) from exc
        # The core raised ``NotTournamentOwnerError`` unless the caller is the owner,
        # so here the actor is the creator — the owner's perspective the HTTP PATCH
        # serializes from (``created_by_username`` known, ``can_edit`` true).
        return serialize(
            tournament,
            created_by_username=actor.username,
            current_user_id=actor.id,
        )


@mcp.tool
async def create_tournament(payload: TournamentCreate) -> TournamentRead:
    """Create a tournament as the authenticated MCP caller, and return it.

    Mirrors ``POST /v1/tournaments``: it reuses the shared ``create_tournament`` verb
    and the same ``TournamentCreate`` schema the HTTP route validates, so the MCP and
    HTTP surfaces can never drift on what a valid new tournament is. The caller becomes
    the tournament's creator (and therefore its owner — the one user who may later
    edit, transition, or delete it).

    The tournament is born a ``draft`` (its ``status`` is not settable here — it moves
    only across the guarded lifecycle transitions). ``league_id`` is OPTIONAL: omit it
    to bind the DEFAULT league (the ladder eligibility is judged on), or name one to
    run on that ladder — but a named id that matches no league is refused rather than
    silently falling back to the default (ADR-0783). ``table_catalogue`` defaults to
    empty. Returns the created ``TournamentRead`` from the creator's perspective
    (``can_edit`` is always true).

    The venue ``address`` is OPTIONAL too: omit it (or send one whose six components
    are all blank) to create a tournament with NO venue — the ordinary state of a
    tournament announced before its venue is booked, or of a private tournament whose
    address is deliberately withheld. Do not invent a placeholder address to fill the
    field; an omitted address is geocoded not at all and stored as null, and the venue
    can be set later with ``edit_tournament``. A tournament with no venue simply never
    matches a proximity ("near me") search.

    Gated on the same ``tournament.create`` permission the HTTP ``POST /v1/tournaments``
    requires.

    Raises a ``ToolError`` when you lack ``tournament.create``, when ``league_id`` names
    no league, when a supplied venue ``address`` cannot be geocoded (the
    ``[address_not_geocodable]`` refusal — coordinates are geocoded server-side, and an
    address cannot be stored without them), or (a broken deployment) when no
    ``league_id`` is given and there is no default league. Creating with no address
    geocodes nothing and so can never raise that one.
    """
    user_id = _authenticated_user_id()
    # The geocoder is built from ``Settings`` (the ``GEOCODER`` setting names it —
    # ``google`` or the deterministic ``fake``; a keyless ``google`` is refused at
    # ``Settings`` construction rather than falling back) — the MCP surface has no
    # ``Depends``, so it constructs the same seam the HTTP route resolves with
    # ``Depends(get_geocoder)``.
    geocoder = get_geocoder(get_settings())
    async with mcp_session() as db:
        # Permission first, through the same shared gate the HTTP ``require_create``
        # dependency asks — before the caller is loaded or anything is written, the
        # order the HTTP route keeps (``require_create`` (403) before the handler).
        await _require_tournament_create(db, user_id)
        actor = await _load_user(db, user_id)
        if actor is None:
            raise ToolError("Not authenticated.")
        try:
            tournament = await create_tournament_core(
                db, actor=actor, payload=payload, geocoder=geocoder
            )
        except LeagueNotFoundError as exc:
            raise ToolError("No league found with that id.") from exc
        except AddressNotGeocodableError as exc:
            raise _map_address_not_geocodable_tool_error(exc) from exc
        except NoDefaultLeagueError as exc:
            raise ToolError(
                "This deployment has no default league configured, so a tournament "
                "created without a league_id can't be placed on a ladder. Name a "
                "league_id explicitly."
            ) from exc
        # The caller is the creator, so the owner's perspective the HTTP POST
        # serializes from (``created_by_username`` known, ``can_edit`` true).
        return serialize(
            tournament,
            created_by_username=actor.username,
            current_user_id=actor.id,
        )


class TournamentDeletionConfirmation(BaseModel):
    """The result of deleting a tournament — a small, agent-shaped confirmation rather
    than the HTTP route's bodiless ``204``.

    An MCP tool should answer with a meaningful value, so this names *what* was deleted
    (the ``tournament_id`` that no longer resolves). Deleting a tournament cascades to
    its events, entries and draws, so a subsequent read of this id is a not-found.

    This schema is **MCP-only** and is attached to no FastAPI route, so it does not
    reach ``openapi.json`` (a mounted MCP sub-app does not contribute to the parent
    schema — see the tournament-verbs ADR), mirroring ``DrawUncutConfirmation``.
    """

    tournament_id: uuid.UUID


@mcp.tool
async def delete_tournament(tournament_id: uuid.UUID) -> TournamentDeletionConfirmation:
    """Delete a tournament you OWN as the authenticated MCP caller. Returns a
    confirmation carrying the deleted tournament's id.

    Mirrors ``DELETE /v1/tournaments/{tournament_id}`` (which answers a bodiless
    ``204``): it reuses the shared ``delete_tournament`` verb (the ``FOR UPDATE``
    tournament row lock, then the owner gate) so the MCP and HTTP surfaces can never
    drift. Deleting is owner-gated — only the tournament's creator may — and it is
    DESTRUCTIVE: the tournament and everything under it (its events, entries and
    draws) go with it. There is no undo.

    Raises a ``ToolError`` when no tournament with that id exists, or when you are not
    the tournament's owner (only the creator may delete it).
    """
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        actor = await _load_user(db, user_id)
        if actor is None:
            raise ToolError("Not authenticated.")
        try:
            await delete_tournament_core(db, tournament_id=tournament_id, actor=actor)
        except _TOURNAMENT_WRITE_TOOL_ERRORS as exc:
            raise _map_tournament_write_tool_error(
                exc, tournament_id=tournament_id, owner_denial="delete"
            ) from exc
        return TournamentDeletionConfirmation(tournament_id=tournament_id)


@mcp.tool
async def transition_tournament(
    tournament_id: uuid.UUID,
    to: TournamentStatus,
) -> TournamentRead:
    """Move a tournament you OWN along its lifecycle as the authenticated MCP
    caller, and return the moved tournament.

    Mirrors ``POST /v1/tournaments/{tournament_id}/transitions``: it reuses the shared
    ``transition_tournament`` verb (the ``FOR UPDATE`` tournament row lock, the owner
    gate, the forward-only edge table, the go-live precondition, and the go-live side
    effects) so the MCP and HTTP surfaces can never drift. One generic tool covers the
    whole lifecycle, the ``to`` target self-documenting in the tool schema — not three
    semantic tools.

    The lifecycle runs FORWARD ONLY, and exactly three moves exist: ``draft`` →
    ``published`` (publish), ``published`` → ``live`` (go live), and ``live`` →
    ``archived`` (archive). Anything else is refused — walking backwards, skipping a
    stage, moving out of the terminal ``archived``, and re-asserting the status the
    tournament already holds (a stale request, not a no-op).

    **Going live has a precondition** (ADR-0786): the tournament must have at least one
    event, and every event must have a **draw** whose fixtures seat exactly its current
    entrants. A tournament with no events, an event with no draw, or an event whose
    draw is **stale** (cut before somebody entered or withdrew) is refused with a
    message naming the events at fault — ``build_cut`` (or re-cut) their draws, then go
    live. Registration is open right up to that moment, which is why a draw can go stale
    under it. Going live also MATERIALIZES every ready fixture into a real match and
    queues the day's first schedule solve.

    Owner-gated: only the tournament's creator may transition it. Returns the moved
    ``TournamentRead`` from the owner's perspective (``can_edit`` is always true).

    Raises a ``ToolError`` when no tournament with that id exists, when you are not the
    tournament's owner, when the requested move is not a legal lifecycle edge (including
    re-asserting the current status), or when going live is refused because an event has
    no current draw.
    """
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        actor = await _load_user(db, user_id)
        if actor is None:
            raise ToolError("Not authenticated.")
        try:
            tournament = await transition_tournament_core(
                db, tournament_id=tournament_id, actor=actor, to=to
            )
        except _TOURNAMENT_WRITE_TOOL_ERRORS as exc:
            raise _map_tournament_write_tool_error(
                exc, tournament_id=tournament_id, owner_denial="transition"
            ) from exc
        except (
            TournamentAlreadyInStatusError,
            IllegalTournamentTransitionError,
            TournamentNotReadyToGoLiveError,
        ) as exc:
            # Each carries its exact, domain-authored sentence — the self-transition's
            # single-ended wording, the illegal edge's two-ended wording, and the
            # go-live precondition's event-naming body — surfaced verbatim to the agent.
            raise ToolError(str(exc)) from exc
        # The verb's owner gate just confirmed the caller is the creator, so the owner's
        # perspective the HTTP route serializes from (``created_by_username`` known,
        # ``can_edit`` true).
        return serialize(
            tournament,
            created_by_username=actor.username,
            current_user_id=actor.id,
        )


@mcp.tool
async def create_event(
    tournament_id: uuid.UUID,
    payload: TournamentEventCreate,
) -> TournamentEventRead:
    """Add an event to a tournament you OWN as the authenticated MCP caller, and
    return the created event.

    Mirrors ``POST /v1/tournaments/{tournament_id}/events``: it reuses the shared
    ``create_event`` verb (the ``FOR UPDATE`` owner-load, then the write) and the same
    ``TournamentEventCreate`` schema the HTTP route validates, so the MCP and HTTP
    surfaces can never drift on what a valid new event is.

    Creating an event is OWNER-GATED — only the tournament's creator may (there is no
    ``tournament.create``-style permission on this route; managing a tournament you
    created is a property of ownership). The event's wall-clock ``slot`` windows are
    anchored by its ``timezone`` (a real IANA zone). A brand-new event has no entrants
    and no draw yet — ``build_cut`` deals its fixtures later. Returns the created
    ``TournamentEventRead`` from the caller's perspective (its ``entry_state`` is the
    caller's own, judged on the tournament's ladder).

    Raises a ``ToolError`` when no tournament with that id exists, or when you are not
    the tournament's owner.
    """
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        actor = await _load_user(db, user_id)
        if actor is None:
            raise ToolError("Not authenticated.")
        try:
            event, league_id = await create_event_core(
                db, tournament_id=tournament_id, actor=actor, payload=payload
            )
        except _TOURNAMENT_WRITE_TOOL_ERRORS as exc:
            raise _map_tournament_write_tool_error(
                exc, tournament_id=tournament_id, owner_denial="add events to"
            ) from exc
        # The verb returns the tournament's ``league_id`` (the ladder the caller's
        # ``entry_state`` is judged on, ADR-0783) already loaded under the owner lock,
        # so the shared shaping helper needs no re-query — the same helper the HTTP
        # ``create_event`` handler uses, so the two surfaces can't drift on how a new
        # event reads back. A one-statement-old event has empty entrants/fixtures/
        # results without a query.
        return await shape_created_event_read(
            db, event=event, league_id=league_id, viewer_id=actor.id
        )


@mcp.tool
async def update_event(
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    updates: TournamentEventUpdate,
) -> TournamentEventRead:
    """Edit an event of a tournament you OWN as the authenticated MCP caller, and
    return the updated event.

    Mirrors ``PATCH /v1/tournaments/{tournament_id}/events/{event_id}``: it reuses the
    shared ``update_event`` verb (the ``FOR UPDATE`` owner-load, the event load, the two
    draw freezes, the partial apply, the timezone reanchor, and the scheduling-facts →
    re-solve trigger) and the same ``TournamentEventUpdate`` schema the HTTP route
    validates, so the MCP and HTTP surfaces can never drift on what a valid edit is.

    ``updates`` is a PARTIAL patch: an OMITTED field is left unchanged; ``predicates``
    replaces wholesale when sent. ``pools`` is an ID-KEYED DIFF sent in full and in
    order: an entry carrying an ``id`` keeps that pool (re-worded, re-timed, re-tabled,
    re-positioned), an entry omitting one adds a pool the server mints an id for, and a
    pool no entry names is removed — so send back the pools you read, edited. An ``id``
    this event does not have is refused. Editing an event is OWNER-GATED — only
    the tournament's creator may (there is no permission on this route). **Once the
    event's draw is cut, two things freeze** (ADR-0786): a ``pools`` payload that
    changes *which pools* the event has is refused, and so is a ``draw_type`` change —
    remove the draw, edit, and cut again. Everything else (name, fee, rules,
    ``max_players``, a
    pool's ``table_ids`` / ``slot`` / ``name``) stays editable with a draw standing. A
    ``timezone`` edit preserves the wall-clock of already-placed fixtures. Returns the
    updated ``TournamentEventRead`` from the caller's perspective (its entrants, draw
    and results survive the edit; its ``entry_state`` is the caller's own, recomputed
    from the event as it now stands).

    Raises a ``ToolError`` when no tournament with that id exists, when you are not the
    tournament's owner, when no event with that id exists under the tournament, or when
    the edit would change the frozen pool set or draw type of a cut-draw event.
    """
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        actor = await _load_user(db, user_id)
        if actor is None:
            raise ToolError("Not authenticated.")
        try:
            event, league_id = await update_event_core(
                db,
                tournament_id=tournament_id,
                event_id=event_id,
                actor=actor,
                updates=updates,
            )
        except _TOURNAMENT_WRITE_TOOL_ERRORS as exc:
            raise _map_tournament_write_tool_error(
                exc,
                tournament_id=tournament_id,
                event_id=event_id,
                owner_denial="edit events of",
            ) from exc
        except (PoolSetFrozenError, DrawTypeFrozenError) as exc:
            # Both freezes carry the exact, domain-authored 409 sentence — surfaced as
            # the ``ToolError`` prose verbatim, so the agent is told how to get unstuck
            # (remove the draw, edit, cut again).
            raise ToolError(str(exc)) from exc
        except PoolNotInEventError as exc:
            # The HTTP surface answers this on the field; an agent reads prose, so the
            # offending id rides in the sentence rather than in a ``loc`` — the same
            # treatment the catalogue's ``TableNotInCatalogueError`` gets above.
            raise ToolError(
                f"{exc} (pools entry {exc.index} names “{exc.pool_id}”)."
            ) from exc
        # The verb returns the tournament's ``league_id`` (the ladder the caller's
        # ``entry_state`` is judged on, ADR-0783) already loaded under the owner lock,
        # so the shared shaping helper needs no re-query — the same helper the HTTP
        # ``update_event`` handler uses, so the two surfaces can't drift. A PATCH is not
        # a re-cut (ADR-0786): the edited event keeps its entrants, draw and results,
        # which the helper reloads and reprojects.
        return await shape_event_read(
            db, event=event, league_id=league_id, viewer_id=actor.id
        )


class EventDeletionConfirmation(BaseModel):
    """The result of deleting an event — a small, agent-shaped confirmation rather than
    the HTTP route's bodiless ``204``.

    An MCP tool should answer with a meaningful value, so this names *what* was deleted
    (the ``tournament_id`` it hung off and the ``event_id`` that no longer resolves).

    This schema is **MCP-only** and is attached to no FastAPI route, so it does not
    reach ``openapi.json`` (a mounted MCP sub-app does not contribute to the parent
    schema — see the tournament-verbs ADR), mirroring
    ``TournamentDeletionConfirmation``.
    """

    tournament_id: uuid.UUID
    event_id: uuid.UUID


@mcp.tool
async def delete_event(
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
) -> EventDeletionConfirmation:
    """Delete an event from a tournament you OWN as the authenticated MCP caller.
    Returns a confirmation carrying the deleted event's id.

    Mirrors ``DELETE /v1/tournaments/{tournament_id}/events/{event_id}`` (which answers
    a bodiless ``204``): it reuses the shared ``delete_event`` verb (the ``FOR UPDATE``
    owner-load, then the event load, then the delete) so the MCP and HTTP surfaces can
    never drift. Deleting is owner-gated — only the tournament's creator may — and it is
    DESTRUCTIVE: the event and everything under it go with it. There is no undo.

    Raises a ``ToolError`` when no tournament with that id exists, when you are not the
    tournament's owner, or when no event with that id exists under the tournament.
    """
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        actor = await _load_user(db, user_id)
        if actor is None:
            raise ToolError("Not authenticated.")
        try:
            await delete_event_core(
                db, tournament_id=tournament_id, event_id=event_id, actor=actor
            )
        except _TOURNAMENT_WRITE_TOOL_ERRORS as exc:
            raise _map_tournament_write_tool_error(
                exc,
                tournament_id=tournament_id,
                event_id=event_id,
                owner_denial="delete events from",
            ) from exc
        return EventDeletionConfirmation(tournament_id=tournament_id, event_id=event_id)


# ----- enter_event tool ----------------------------------------------------


def _map_entry_refused_tool_error(exc: EntryRefusedError) -> ToolError:
    """Adapt a coded entry refusal (ADR-0968) to a ``ToolError`` that NAMES which of the
    four refusals fired, then hands the agent the domain-authored fallback sentence.

    The HTTP surface answers these with a machine-readable ``code`` a client switches
    on;
    an agent reads prose, so the code rides in the prose (``[event_full]`` …) and the
    verb's own message — a full event, a shut window, a rating cap, an existing entry —
    follows, so the agent is told both *which* rule refused and *why* in its own
    words."""
    return ToolError(f"Entry refused [{exc.refusal.value}]: {exc}")


@mcp.tool
async def enter_event(
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    user_id: uuid.UUID | None = None,
) -> TournamentEntrantRead:
    """Enter a player in a singles event as the authenticated MCP caller —
    yourself,
    or (as the tournament's owner) somebody else — and return the created entrant.

    Mirrors ``POST /v1/tournaments/{tournament_id}/events/{event_id}/entries``: it
    reuses
    the shared ``enter_event`` verb (the dual-actor fork, the self-path permission gate,
    the ``FOR UPDATE`` capacity lock, the ordered refusals and the INSERT) so the MCP
    and
    HTTP surfaces can never drift.

    ``user_id`` chooses the actor (ADR-0784): **omit it** (or pass your OWN id) to enter
    *yourself* — self-registration, gated on the ``tournament.enter`` permission,
    recording
    no adder. Pass a **different** ``user_id`` to enter that player as the **director**
    —
    which only the tournament's OWNER may do, and which records you as the adder. A
    director's entry is judged by exactly the same rules as a player's — the same
    eligibility evaluator, the same capacity lock, the same four refusal codes — there
    is
    no ``force``, so ownership is never an eligibility bypass.

    Registration is open only while the tournament is ``published`` (its status *is* its
    window, ADR-0017), for the director too. An event's eligibility rules are judged
    against the entrant's rating on the tournament's ladder (a player with NO rating
    passes every rule, ADR-0783 §3). Doubles/teams events cannot be entered directly
    (one
    row per player, nowhere to seat a partner). Returns the created
    ``TournamentEntrantRead``
    — the ENTRANT (the player, on a director entry, not you), carrying their rating on
    the
    tournament's ladder (``null`` for an unrated player).

    Raises a ``ToolError`` when you lack ``tournament.enter`` on a self-registration,
    when
    you name another player's id but do not own the tournament, when no tournament or
    event
    with those ids exists, when a named ``user_id`` matches no live player, when the
    event
    is not singles, and — naming which refusal fired — when registration is closed, the
    player fails the event's rating rules, the event is full, or the player is already
    entered.
    """
    caller_id = _authenticated_user_id()
    async with mcp_session() as db:
        actor = await _load_user(db, caller_id)
        if actor is None:
            raise ToolError("Not authenticated.")
        try:
            return await enter_event_core(
                db,
                tournament_id=tournament_id,
                event_id=event_id,
                actor=actor,
                user_id=user_id,
            )
        except _TOURNAMENT_WRITE_TOOL_ERRORS as exc:
            # The shared not-found arms, plus the director path's owner gate: naming
            # another player's id is owner-gated ("enter other players into").
            raise _map_tournament_write_tool_error(
                exc,
                tournament_id=tournament_id,
                event_id=event_id,
                owner_denial="enter other players into",
            ) from exc
        except NotAllowedToEnterError as exc:
            # The self-registration permission gate (``tournament.enter``) — asked only
            # on the self path, the same grant the HTTP route requires there.
            raise ToolError(
                "You do not have permission to enter tournament events."
            ) from exc
        except PlayerNotFoundError as exc:
            raise ToolError(f"No live player found with id {user_id}.") from exc
        except NonSinglesEntryError as exc:
            # Carries its own sentence naming the event's (non-singles) format.
            raise ToolError(str(exc)) from exc
        except EntryRefusedError as exc:
            raise _map_entry_refused_tool_error(exc) from exc


class EntryWithdrawalConfirmation(BaseModel):
    """The result of withdrawing an entry — a small, agent-shaped confirmation rather
    than the HTTP route's bodiless ``204``.

    An MCP tool should answer with a meaningful value, so this names *what* was
    withdrawn (the ``entry_id`` that is now ``withdrawn``) and asserts the outcome. The
    withdrawal is a SOFT delete (ADR-0784): the row survives with its status flipped, so
    a later read still finds the entry — as ``withdrawn``, not gone — and, because the
    uniqueness guard is a *partial* index over active entries, the player is free to
    enter the same event again. Withdrawing an already-withdrawn entry is an idempotent
    success too, confirming the same terminal state.

    This schema is **MCP-only** and is attached to no FastAPI route, so it does not
    reach ``openapi.json`` (a mounted MCP sub-app does not contribute to the parent
    schema — see the tournament-verbs ADR), mirroring
    ``TournamentDeletionConfirmation`` / ``EventDeletionConfirmation``.
    """

    tournament_id: uuid.UUID
    event_id: uuid.UUID
    entry_id: uuid.UUID


@mcp.tool
async def withdraw_from_event(
    tournament_id: uuid.UUID,
    event_id: uuid.UUID,
    entry_id: uuid.UUID,
) -> EntryWithdrawalConfirmation:
    """Withdraw an entry from a singles event as the authenticated MCP caller —
    your own, or (as the tournament's owner) any entry in it. Returns a confirmation
    carrying the withdrawn entry's id.

    Mirrors ``DELETE
    /v1/tournaments/{tournament_id}/events/{event_id}/entries/{entry_id}`` (which
    answers a bodiless ``204``): it reuses the shared ``withdraw_from_event`` verb (the
    ``FOR UPDATE`` tournament row lock, the tournament/event/entry loads, the
    owner-or-self fork, the registration-window gate on the state change, and the seated
    re-solve trigger) so the MCP and HTTP surfaces can never drift.

    The withdrawal is a SOFT delete (ADR-0784): the entry's status flips to
    ``withdrawn`` and the row survives, so the event keeps its withdrawal history — and,
    because the uniqueness guard is a *partial* index over active entries, the player is
    free to enter the same event again afterwards.

    **Who may withdraw** mirrors who may enter: the entry's own player (with the
    ``tournament.enter`` permission) or the tournament's OWNER, for any entry in it —
    anybody else is refused. Withdrawal, like entry, is open only while the tournament
    is ``published`` (its status *is* its registration window, ADR-0017), for the owner
    too: withdrawing an ACTIVE entry from a ``draft``, ``live`` or ``archived``
    tournament is refused. But withdrawing an entry that is ALREADY withdrawn is an
    idempotent success in every status — a no-op, not an error.

    Raises a ``ToolError`` when no tournament or event with those ids exists, when no
    entry with that id exists under the event, when the entry is neither yours nor in a
    tournament you own, when you lack ``tournament.enter`` withdrawing your own entry,
    and when an active entry cannot be withdrawn because registration is closed.
    """
    caller_id = _authenticated_user_id()
    async with mcp_session() as db:
        actor = await _load_user(db, caller_id)
        if actor is None:
            raise ToolError("Not authenticated.")
        try:
            await withdraw_from_event_core(
                db,
                tournament_id=tournament_id,
                event_id=event_id,
                entry_id=entry_id,
                actor=actor,
            )
        except (TournamentNotFoundError, EventNotFoundError) as exc:
            # withdraw has no owner arm — its owner-ish refusal is the separate
            # ``NotAllowedToWithdrawError`` below — so only its two not-found arms route
            # through the shared mapper (``owner_denial`` omitted).
            raise _map_tournament_write_tool_error(
                exc, tournament_id=tournament_id, event_id=event_id
            ) from exc
        except EntryNotFoundError as exc:
            raise ToolError(f"No entry found with id {entry_id}.") from exc
        except NotAllowedToEnterError as exc:
            # The self path lacking ``tournament.enter`` — the same grant the enter tool
            # requires on self-registration.
            raise ToolError(
                "You do not have permission to withdraw from tournament events."
            ) from exc
        except NotAllowedToWithdrawError as exc:
            # Neither the entry's own player nor the tournament's owner.
            raise ToolError(
                "You can only withdraw your own entry, or any entry from a "
                "tournament you created."
            ) from exc
        except WithdrawalRegistrationClosedError as exc:
            # An active entry, outside the registration window — the domain-authored
            # sentence names which closed status refused it.
            raise ToolError(str(exc)) from exc
        return EntryWithdrawalConfirmation(
            tournament_id=tournament_id, event_id=event_id, entry_id=entry_id
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

    * ``NonSinglesDraw`` carries its ``event_format`` structurally — a doubles/teams
      event can never be given a draw (an entry is one row per player, with nowhere to
      seat a partner or a team, ADR-0788), so the refusal names the event and is
      permanent.
    * ``DegenerateDraw``'s message is **domain-authored copy** (the strategy alone knows
      which degeneracy it hit and the numbers the director must change — "5 entrants
      across 3 pool(s)"), passed through so the agent reads exactly what a director
      would.
    * The fallback arm is a generic sentence, never a future subclass's own message —
      refusing vaguely is a bug report, leaking internals is a defect. Covered by
      ``test_build_cut_a_draw_error_nobody_wrote_copy_for_refuses_without_leaking_it``,
      which invents a ``DrawError`` subclass carrying internals and asserts none of
      them reach the client."""
    match error:
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
    """Cut (or re-cut) an event's DRAW as the authenticated MCP caller — generate
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
    cannot produce a draw at all: it is not a singles event, it has no pools configured
    for a pooled draw type, or its field is too small for its pools (a pool of fewer
    than two has nobody to play). The message names what to change."""
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
    """Un-cut an event's DRAW as the authenticated MCP caller: delete its
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
async def place_fixture(
    tournament_id: uuid.UUID,
    fixture_id: uuid.UUID,
    placement: TournamentFixturePlacementUpdate,
) -> TournamentFixtureRead:
    """Set (or clear) a fixture's PLACEMENT — its table and predicted start — for a
    fixture of a tournament you OWN as the authenticated MCP caller, and return
    the updated fixture.

    Mirrors ``PATCH /v1/tournaments/{tournament_id}/fixtures/{fixture_id}/placement``:
    it reuses the shared ``place_fixture`` verb (the ``FOR UPDATE`` tournament row lock,
    the owner gate, the fixture load, the played-out freeze, the pin/notify transition,
    the ``settings_changed`` re-solve trigger, the commit and the post-commit fan-out)
    and the same ``TournamentFixturePlacementUpdate`` schema the HTTP route validates,
    so the MCP and HTTP surfaces can never drift. You address the fixture by its
    ``tournament_id`` + ``fixture_id`` (the fixture must belong to that tournament).

    ``placement`` is the placement in full: ``table_id`` (the id of one of the
    tournament's ``table_catalogue`` tables) and ``scheduled_start`` (a **naive**
    wall-clock time in the venue's local frame). ``null`` on either clears that half;
    ``(null, null)`` unassigns the fixture entirely.

    **A manual placement is a PIN.** A full placement (both halves set, both entrants
    known) sets ``pinned_at`` — a commitment every later schedule solve plans around —
    and, while the tournament is **live**, placing a fixture IS calling it: a first
    placement notifies both entrants, and re-placing a fixture whose players were
    already told sends them a "your match moved" correction. Pre-live placements are
    silent pins (free rearranging while planning, nobody paged); a fixture with a TBD
    side stores the placement but does not pin. Anything less than a full placement
    UNPINS (and, if the players had been called, cancels the call). Every successful
    write also queues a re-solve.

    **The table must EXIST** (ADR 20260801): a ``table_id`` naming no table in this
    tournament's ``table_catalogue`` is refused, not stored — a placement whose table
    does not exist is a dangling reference, not a state the director chose.

    **The placement is otherwise SOFT** (ADR-0790): ``scheduled_start`` is a
    prediction, and the other constraints (table-in-pool, time-in-window, no
    double-booking) are flags derived on read, NOT invariants — so an out-of-window
    time, or a table outside the fixture's pool, is STORED, not rejected. The one hard
    rule about the fixture itself: one whose linked match is ``completed`` or ``voided``
    is history, so its placement can no longer be changed. Owner-gated: only the
    tournament's creator may place its fixtures.

    Raises a ``ToolError`` when no tournament with that id exists, when you are not the
    tournament's owner, when no fixture with that id belongs to the tournament, when the
    placement's ``table_id`` names no table in the tournament's catalogue, or when
    the fixture's match is already completed/voided (its placement is frozen)."""
    user_id = _authenticated_user_id()
    async with mcp_session() as db:
        actor = await _load_user(db, user_id)
        if actor is None:
            raise ToolError("Not authenticated.")
        try:
            return await place_fixture_core(
                db,
                tournament_id=tournament_id,
                fixture_id=fixture_id,
                actor=actor,
                placement=placement,
            )
        except _TOURNAMENT_WRITE_TOOL_ERRORS as exc:
            raise _map_tournament_write_tool_error(
                exc, tournament_id=tournament_id, owner_denial="place fixtures for"
            ) from exc
        except FixtureNotFoundError as exc:
            raise ToolError(f"No fixture found with id {fixture_id}.") from exc
        except FixturePlacementFrozenError as exc:
            # Carries the exact, domain-authored 409 sentence — the played-out fixture's
            # freeze — surfaced as the ``ToolError`` prose verbatim.
            raise ToolError(str(exc)) from exc
        except PlacementTableNotFoundError as exc:
            # The HTTP route's 422 on ``body.table_id`` (ADR 20260801): a placement must
            # name a real table. Named with the offending id, because an MCP caller
            # composed it rather than clicked it.
            raise ToolError(f"{exc} (table_id: {exc.table_id})") from exc


@mcp.tool
async def request_schedule_solve(tournament_id: uuid.UUID) -> ScheduleSolveRead:
    """Run the SCHEDULER for a tournament you OWN as the authenticated MCP
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
# (``preview_solver_time_cap_s`` defaults to 5s, plus at most
# ``diagnostic_solver_time_cap_s`` again when the preview comes back infeasible and
# the conflict-core diagnostic runs) and the MCP path is not behind the
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
      draw type has no schedule generator yet (only round-robin does today; single-elim
      can be *cut* but not yet *placed*), a fact to change on the event, not a
      transient one to retry. **This arm is the reason the mirror is not exact:**
      ``_map_draw_refusal_tool_error`` has no ``UnsupportedDrawType`` arm, because on
      the CUT path the error is unreachable (``strategy_for`` is total). On the PREVIEW
      path it is genuinely raised — ``schedule_preview`` raises it for single-elim — so
      the arm here is live code with its own coverage in
      ``test_schedule_preview_snapshot``.
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
    MCP caller — solve a synthetic field over the tournament's real tables,
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

    Draw coverage is ROUND-ROBIN ONLY: an event with any other draw type (today that
    means single-elim) refuses the WHOLE preview with an actionable ``ToolError`` —
    never a partial grid — because a preview must not invent a schedule for a format
    production cannot run.

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

    # No per-caller rate limit here (unlike the HTTP enqueue's ``preview_request_
    # rate_limit``): a tool body only runs *after* the verifier authenticated the
    # token AND authorized the resolved user against ``mcp.access``, so every tool
    # call is an already-authorized account (``_authenticated_user_id`` above), not
    # an anonymous browser session that could be rotated to multiply a budget. (The
    # verifier's *write* path — the match-bind / provision that runs before that
    # ``mcp.access`` check, on an as-yet-unauthorized caller — IS separately per-IP
    # rate limited; see ``_provision_ip_rate_limit``. That protects account
    # creation; it doesn't apply once a caller is a permitted token holder here.)
    # A preview is also already self-throttling (one CFS-limited ``preview`` worker
    # slot, a few-second cap, and this call blocks on it), so a token holder cannot
    # outrun the single slot regardless. The HTTP limiter exists to cap
    # unauthenticated-ish session churn, which has no analogue on an MCP tool.
    #
    # Wait for the ephemeral job to finish and return the result in this one call
    # (ADR "MCP waits internally with a bounded timeout"). The wait is a blocking
    # poll loop, so it runs off the event loop in a worker thread — a synchronous
    # MCP call is fine here (no browser-facing nginx hop), but it must not stall the
    # async server. The tournament id binds the token to the tournament just enqueued
    # for, the same guard the HTTP poll enforces.
    state = await to_thread.run_sync(
        partial(
            wait_for_preview,
            enqueued.token,
            tournament_id,
            timeout_s=_PREVIEW_WAIT_TIMEOUT_S,
        )
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
    """Search registered players by username as the authenticated MCP
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
    """List the authenticated MCP caller's OWN match history, newest first.

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
    authenticated MCP caller and return the updated match.

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
    """Propose a result for a match as the authenticated MCP caller — the
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
    """Accept a standing proposal as the authenticated MCP caller — the
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
    """Clear a game's committed score as the authenticated MCP caller and
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
