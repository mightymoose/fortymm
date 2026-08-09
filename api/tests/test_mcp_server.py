"""Transport-auth + tool-behavior tests for the mounted FastMCP server.

These drive the **mounted** app over HTTP (httpx ``ASGITransport`` against the
FastAPI app, wrapped in a FastMCP ``Client`` speaking Streamable HTTP) so the
Auth0 OAuth Resource-Server verifier (``FortymmAuth0TokenVerifier`` behind a
``RemoteAuthProvider``) actually runs at the transport — an in-memory
``Client(mcp)`` would bypass it. The point is that only a valid Auth0 JWT for an
explicitly linked user holding ``mcp.access`` is admitted; every other case
(missing / bad-signature / wrong-``aud`` / wrong-``iss`` / unlinked-``sub`` /
un-permitted / tombstoned) is rejected **before** any tool body, at the transport.

**Auth harness.** The module-level ``mcp`` is built with ``AUTH0_*`` empty (its
fail-closed reject-all verifier), so the autouse ``_mcp_auth0_verifier`` fixture
swaps in a real ``FortymmAuth0TokenVerifier`` keyed to a locally-generated RS256
**static public key** with the test issuer/audience — no Auth0 network or JWKS
mock needed, the signature verifies against the seeded key directly. Test tokens
are signed with the matching private key (:func:`_sign_token`); a user is made
admissible by linking a ``sub`` and granting ``mcp.access`` (:func:`_mint`).

The MCP app carries its own lifespan (the Streamable-HTTP session manager);
``ASGITransport`` does not fire it, so each test enters ``mcp_app.lifespan``
explicitly. The verifier resolves the token's ``sub`` against the process-wide
engine (``DATABASE_URL`` is pointed at the test Postgres by the autouse
``_solver_job_database`` fixture), so links/grants are committed via ``db_session``
first — the verifier's own connection only sees committed rows.
"""

import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

import fakeredis
import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport
from fastmcp.exceptions import ToolError
from pyrate_limiter import Duration, Rate
from rq import Queue
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from app import mcp_server
from app import queue as queue_module
from app.admin_schedule_solves import SCHEDULING_VIEW_PERMISSION
from app.auth0_provisioning import AUTH0_EMAIL_CLAIM, AUTH0_EMAIL_VERIFIED_CLAIM
from app.draws import DrawError
from app.main import app as fastapi_app
from app.main import mcp, mcp_app
from app.mcp_server import (
    MCP_ACCESS_PERMISSION,
    FortymmAuth0TokenVerifier,
    _build_mcp_auth,
    _RejectAllTokenVerifier,
)
from app.models import (
    League,
    Match,
    MatchSettings,
    MatchStatus,
    Permission,
    Role,
    RolePermission,
    ScheduleSolve,
    ScheduleSolveStatus,
    ScheduleSolveTrigger,
    SolverVerdict,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentEventPool,
    TournamentFixture,
    TournamentStatus,
    User,
    UserRole,
)
from app.models.tournament import DrawType, EventFormat
from app.rate_limiting import RedisRateLimiter
from app.tournament_draws import cut_draw
from app.tournaments import TOURNAMENT_CREATE, TOURNAMENT_ENTER, TOURNAMENT_VIEW
from tests._helpers import (
    enqueued_notification_jobs,
    event_pools,
    grant_permissions,
    make_user,
    start_session,
    table_ids_of,
    venue_tables,
    with_table_aliases,
)

MCP_URL = "http://testserver/mcp/"

# The test Auth0 tenant the verifier is pointed at. The issuer carries Auth0's
# trailing slash (``https://{domain}/``), and the audience is the API identifier
# the agent's access token must carry — both matched by the autouse verifier.
DOMAIN = "fortymm-test.us.auth0.com"
ISSUER = f"https://{DOMAIN}/"
AUDIENCE = "https://api.fortymm.test/mcp"
KID = "test-signing-key-1"


def _generate_keypair() -> tuple[str, str]:
    """A private-key PEM to sign access tokens with, and the matching public-key
    PEM the verifier trusts as a static key (no JWKS endpoint needed)."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    public_pem = (
        key.public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode("ascii")
    )
    return private_pem, public_pem


# The tenant's signing keypair (module-level so keygen runs once) and a second,
# unrelated keypair whose private key signs the "bad signature" forgery.
_PRIVATE_PEM, _PUBLIC_PEM = _generate_keypair()
_WRONG_PRIVATE_PEM, _ = _generate_keypair()


@pytest.fixture(autouse=True)
def _mcp_auth0_verifier(monkeypatch: pytest.MonkeyPatch) -> None:
    """Point the mounted MCP transport's verifier at the test signing key.

    The module-level ``mcp`` is built with ``AUTH0_*`` empty (its fail-closed
    reject-all verifier), so every test swaps in a real
    ``FortymmAuth0TokenVerifier`` keyed to the locally-generated RS256 static
    public key, with the test issuer/audience. Mutating the provider's
    ``token_verifier`` — the object the auth middleware baked into ``mcp_app``
    already holds — is what reaches the running mounted app."""
    verifier = FortymmAuth0TokenVerifier(
        public_key=_PUBLIC_PEM,
        issuer=ISSUER,
        audience=AUDIENCE,
        algorithm="RS256",
    )
    monkeypatch.setattr(mcp.auth, "token_verifier", verifier)


def _sign_token(
    *,
    sub: str,
    aud: str = AUDIENCE,
    iss: str = ISSUER,
    private_pem: str | None = None,
    expires_in: int = 300,
    extra_claims: dict[str, object] | None = None,
) -> str:
    """Sign an RS256 access token for ``sub`` — the credential an agent presents
    to the MCP transport. Defaults to the tenant key + right issuer/audience; the
    knobs reach the wrong-``aud`` / wrong-``iss`` / bad-signature rejection cases.
    ``extra_claims`` merges in the namespaced email claims the Auth0 Action ships,
    exercising the resolve-or-provision (match-by-verified-email) path."""
    now = int(time.time())
    claims: dict[str, object] = {
        "sub": sub,
        "aud": aud,
        "iss": iss,
        "iat": now,
        "exp": now + expires_in,
    }
    if extra_claims is not None:
        claims.update(extra_claims)
    return jwt.encode(
        claims,
        private_pem or _PRIVATE_PEM,
        algorithm="RS256",
        headers={"kid": KID},
    )


async def _link(db_session: AsyncSession, user: User, sub: str | None = None) -> str:
    """Bind an Auth0 ``sub`` to ``user`` (committed), the same one-to-one link the
    account-link flow writes. Returns the ``sub`` for signing a token for it."""
    sub = sub or "auth0|" + uuid.uuid4().hex
    user.auth0_sub = sub
    await db_session.commit()
    return sub


async def _grant_mcp_access(db_session: AsyncSession, user: User) -> None:
    """Grant ``user`` the ``mcp.access`` permission through real RBAC rows (its own
    role, so it never collides with a ``grant_permissions`` role for the same user).
    The seed grants this via the Beta tester role; tests grant it directly."""
    permission = (
        await db_session.execute(
            select(Permission).where(Permission.name == MCP_ACCESS_PERMISSION)
        )
    ).scalar_one_or_none()
    if permission is None:
        permission = Permission(
            name=MCP_ACCESS_PERMISSION, description=MCP_ACCESS_PERMISSION
        )
        db_session.add(permission)
        await db_session.flush()
    role = Role(name=f"mcp-access-{user.id}", description="Per-user test mcp.access.")
    db_session.add(role)
    await db_session.flush()
    db_session.add(RolePermission(role_id=role.id, permission_id=permission.id))
    db_session.add(UserRole(user_id=user.id, role_id=role.id))
    await db_session.commit()


async def _mint(db_session: AsyncSession, user: User) -> str:
    """Make ``user`` admissible to the MCP transport and return a bearer token for
    it: link an Auth0 ``sub``, grant ``mcp.access``, and sign an RS256 access token
    for that subject. Replaces the old opaque ``context="api"`` bearer token — every
    tool-behavior test authenticates as a linked + permitted user through this."""
    sub = await _link(db_session, user)
    await _grant_mcp_access(db_session, user)
    return _sign_token(sub=sub)


@asynccontextmanager
async def _mcp_client(token: str | None) -> AsyncIterator[Client]:
    """A FastMCP ``Client`` bound to the mounted app over ``ASGITransport``.

    Enters ``mcp_app.lifespan`` so the Streamable-HTTP session manager is
    running (``ASGITransport`` skips the app lifespan). ``token`` becomes the
    ``Authorization: Bearer`` header, or is omitted entirely when ``None``.
    """
    transport = httpx.ASGITransport(app=fastapi_app)

    def _factory(
        headers: dict[str, str] | None = None,
        timeout: httpx.Timeout | None = None,
        auth: httpx.Auth | None = None,
        **kwargs: object,
    ) -> httpx.AsyncClient:
        # fastmcp's factory call passes extra kwargs (e.g. follow_redirects)
        # beyond the McpHttpClientFactory protocol's three; forward them, but
        # keep our ASGITransport + base_url so the client hits the mounted app.
        kwargs.pop("transport", None)
        kwargs.pop("base_url", None)
        return httpx.AsyncClient(
            transport=transport,
            headers=headers,
            timeout=timeout if timeout is not None else httpx.Timeout(30.0),
            auth=auth,
            base_url="http://testserver",
            **kwargs,  # type: ignore[arg-type]  # httpx kwargs are heterogeneous
        )

    headers = {"Authorization": f"Bearer {token}"} if token is not None else None
    client = Client(
        StreamableHttpTransport(MCP_URL, headers=headers, httpx_client_factory=_factory)
    )
    async with mcp_app.lifespan(fastapi_app):
        yield client


async def _assert_rejected(client: Client) -> None:
    """Connecting/listing tools fails at the transport with a 401.

    The ``pytest.raises`` is held here — inside the ``mcp_app.lifespan`` block —
    so the 401 is caught before it would otherwise unwind through the session
    manager's task group and be re-wrapped in an ``ExceptionGroup``.
    """
    with pytest.raises(httpx.HTTPStatusError) as exc_info:
        async with client:
            await client.list_tools()
    assert exc_info.value.response.status_code == 401


async def test_valid_auth0_jwt_can_list_tools(db_session: AsyncSession) -> None:
    """A valid Auth0 JWT for a linked user holding ``mcp.access`` authenticates at
    the transport and can complete the initialize + ``list_tools`` handshake. The
    curated match-flow verbs are exposed — ``get_match`` is registered."""
    user = await make_user(db_session, "mcp-jwt-owner")
    token = await _mint(db_session, user)

    async with _mcp_client(token) as client, client:
        tools = await client.list_tools()

    assert "get_match" in {tool.name for tool in tools}


async def test_missing_token_is_rejected(db_session: AsyncSession) -> None:
    """No ``Authorization`` header → rejected at the transport (401), before any
    tool body."""
    async with _mcp_client(None) as client:
        await _assert_rejected(client)


async def test_bad_signature_is_rejected(db_session: AsyncSession) -> None:
    """A JWT signed by a key other than the tenant's — right ``iss`` / ``aud`` /
    ``sub``, valid linked+permitted user — fails RS256 signature verification →
    401, before any tool body."""
    user = await make_user(db_session, "mcp-badsig-owner")
    sub = await _link(db_session, user)
    await _grant_mcp_access(db_session, user)
    forged = _sign_token(sub=sub, private_pem=_WRONG_PRIVATE_PEM)

    async with _mcp_client(forged) as client:
        await _assert_rejected(client)


async def test_wrong_audience_is_rejected(db_session: AsyncSession) -> None:
    """A validly-signed token whose ``aud`` is not our API identifier is refused —
    the token was minted for a different resource server."""
    user = await make_user(db_session, "mcp-aud-owner")
    sub = await _link(db_session, user)
    await _grant_mcp_access(db_session, user)
    token = _sign_token(sub=sub, aud="https://not-our-api.example.com/")

    async with _mcp_client(token) as client:
        await _assert_rejected(client)


async def test_wrong_issuer_is_rejected(db_session: AsyncSession) -> None:
    """A validly-signed token from a different issuer is refused — only our Auth0
    tenant is trusted."""
    user = await make_user(db_session, "mcp-iss-owner")
    sub = await _link(db_session, user)
    await _grant_mcp_access(db_session, user)
    token = _sign_token(sub=sub, iss="https://evil.example.com/")

    async with _mcp_client(token) as client:
        await _assert_rejected(client)


async def test_unlinked_sub_is_rejected(db_session: AsyncSession) -> None:
    """A validly-signed token whose ``sub`` is linked to no user is rejected: Auth0
    authenticated it, but fortymm has no linked account for that subject."""
    token = _sign_token(sub="auth0|" + uuid.uuid4().hex)

    async with _mcp_client(token) as client:
        await _assert_rejected(client)


async def test_linked_user_without_mcp_access_is_rejected(
    db_session: AsyncSession,
) -> None:
    """A linked user who does NOT hold ``mcp.access`` is rejected at the transport —
    authentication is Auth0, but authorization is fortymm RBAC, and revoking the
    grant cuts the agent off even while its token is still valid."""
    user = await make_user(db_session, "mcp-noaccess-owner")
    sub = await _link(db_session, user)  # linked, but never granted mcp.access
    token = _sign_token(sub=sub)

    async with _mcp_client(token) as client:
        await _assert_rejected(client)


async def test_tombstoned_linked_users_token_is_rejected(
    db_session: AsyncSession,
) -> None:
    """A linked + permitted user who was merged away (``merged_into_user_id`` set)
    no longer resolves — the folded-in ghost never authenticates through MCP."""
    owner = await make_user(db_session, "mcp-merge-owner")
    guest = await make_user(db_session, "mcp-merged-guest")
    token = await _mint(db_session, guest)

    guest.merged_into_user_id = owner.id
    guest.merged_at = datetime.now(UTC)
    await db_session.commit()

    async with _mcp_client(token) as client:
        await _assert_rejected(client)


def _email_verifier() -> FortymmAuth0TokenVerifier:
    """A ``FortymmAuth0TokenVerifier`` keyed to the test static key, for calling
    ``verify_token`` directly — so a test can assert on the minted ``AccessToken``
    (its ``user_id`` claim) rather than only that the transport handshake 200s."""
    return FortymmAuth0TokenVerifier(
        public_key=_PUBLIC_PEM,
        issuer=ISSUER,
        audience=AUDIENCE,
        algorithm="RS256",
    )


async def test_verified_email_matches_unlinked_mcp_account_and_authorizes(
    db_session: AsyncSession,
) -> None:
    """A verified token whose ``sub`` is UNLINKED but whose verified email matches an
    existing account holding ``mcp.access`` resolves through
    ``resolve_or_provision_user``: the verifier binds the ``sub`` and mints an
    ``AccessToken`` carrying that account's id under the ``user_id`` claim — the
    match path authorizes end-to-end without a manual link step."""
    user = await make_user(db_session, "mcp-email-match-owner")
    user.email = "match-me@example.com"
    await db_session.commit()
    await _grant_mcp_access(db_session, user)
    # A brand-new Auth0 subject, linked to nobody — it can only resolve via the
    # verified-email match below.
    sub = "auth0|" + uuid.uuid4().hex
    token = _sign_token(
        sub=sub,
        extra_claims={
            AUTH0_EMAIL_CLAIM: "match-me@example.com",
            AUTH0_EMAIL_VERIFIED_CLAIM: True,
        },
    )

    access = await _email_verifier().verify_token(token)

    assert access is not None
    assert access.claims["user_id"] == str(user.id)


async def test_unverified_or_absent_email_is_rejected(
    db_session: AsyncSession,
) -> None:
    """The same unlinked ``sub`` + matchable ``mcp.access`` account, but with the
    email UNVERIFIED (``email_verified: false``) — and, separately, with the email
    claim ABSENT — resolves to ``None`` (→ 401): the JWT signature is valid, yet we
    never match or provision off an address the caller hasn't proven they control."""
    user = await make_user(db_session, "mcp-email-unverified-owner")
    user.email = "unverified@example.com"
    await db_session.commit()
    await _grant_mcp_access(db_session, user)
    sub = "auth0|" + uuid.uuid4().hex

    unverified = _sign_token(
        sub=sub,
        extra_claims={
            AUTH0_EMAIL_CLAIM: "unverified@example.com",
            AUTH0_EMAIL_VERIFIED_CLAIM: False,
        },
    )
    no_email = _sign_token(sub=sub)

    verifier = _email_verifier()
    assert await verifier.verify_token(unverified) is None
    assert await verifier.verify_token(no_email) is None


async def test_linked_sub_still_authorizes_via_verify_token(
    db_session: AsyncSession,
) -> None:
    """The pre-existing LINKED-``sub`` path is unchanged by resolve-or-provision: a
    linked + permitted user's token still mints an ``AccessToken`` carrying that
    user's id under ``user_id`` — resolved by the linked ``sub`` alone, with no email
    claim present."""
    user = await make_user(db_session, "mcp-linked-still-owner")
    token = await _mint(db_session, user)

    access = await _email_verifier().verify_token(token)

    assert access is not None
    assert access.claims["user_id"] == str(user.id)


def _pin_client_ip(monkeypatch: pytest.MonkeyPatch, host: str) -> None:
    """Make ``mcp_server.get_http_request()`` (which the verifier reads the client
    IP off) return a request whose ``client.host`` is ``host``.

    ``get_http_request()`` IS populated during ``verify_token`` under the real
    transport (probed), but a direct ``verify_token`` call has no live request, so
    the write path would otherwise key every call to the ``"unknown"`` fallback
    bucket. Pinning it lets a test drive the per-IP limiter deterministically."""
    request = Request({"type": "http", "client": (host, 12345), "headers": []})
    monkeypatch.setattr(mcp_server, "get_http_request", lambda: request)


async def test_write_path_is_rate_limited_per_ip(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Unlinked-but-verified tokens from one IP that MATCH ``mcp.access`` accounts
    authorize (the write/match path binds each ``sub``) — until the per-IP provision
    ceiling is hit, after which the next such token is refused (``verify_token`` →
    ``None``) with no ``sub`` bound. The verifier calls the module-level limiter, so
    monkeypatching it to a small rate exercises the real wiring fast."""
    _pin_client_ip(monkeypatch, "203.0.113.7")
    limit = 3
    monkeypatch.setattr(
        mcp_server,
        "_provision_ip_rate_limit",
        RedisRateLimiter(
            rates=[Rate(limit, Duration.HOUR)],
            bucket_key="mcp-provision-ip-test-limited",
        ),
    )

    # ``limit + 1`` distinct matchable accounts (each verified email → its own
    # unlinked ``sub``), all reachable only via the write/match path.
    accounts = []
    for i in range(limit + 1):
        user = await make_user(db_session, f"mcp-ratelimit-{i}")
        user.email = f"ratelimit-{i}@example.com"
        await db_session.commit()
        await _grant_mcp_access(db_session, user)
        sub = "auth0|" + uuid.uuid4().hex
        token = _sign_token(
            sub=sub,
            extra_claims={
                AUTH0_EMAIL_CLAIM: user.email,
                AUTH0_EMAIL_VERIFIED_CLAIM: True,
            },
        )
        accounts.append((user, sub, token))

    verifier = _email_verifier()
    # The first ``limit`` write-path tokens match + bind + authorize.
    for user, _sub, token in accounts[:limit]:
        access = await verifier.verify_token(token)
        assert access is not None
        assert access.claims["user_id"] == str(user.id)

    # The next is rate limited BEFORE the write: rejected, and its ``sub`` unbound.
    over_user, over_sub, over_token = accounts[limit]
    assert await verifier.verify_token(over_token) is None
    await db_session.refresh(over_user)
    assert over_user.auth0_sub is None


async def test_linked_hot_path_is_not_rate_limited(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The already-linked hot path skips the limiter entirely: with the provision
    ceiling pinned to an impossibly tight 1/hour, a single linked + permitted user's
    token authorizes many times over from one IP — proving the steady-state read
    path is never charged against the write-path budget."""
    _pin_client_ip(monkeypatch, "203.0.113.9")
    monkeypatch.setattr(
        mcp_server,
        "_provision_ip_rate_limit",
        RedisRateLimiter(
            rates=[Rate(1, Duration.HOUR)],
            bucket_key="mcp-provision-ip-test-hot",
        ),
    )

    user = await make_user(db_session, "mcp-hotpath-owner")
    token = await _mint(db_session, user)

    verifier = _email_verifier()
    for _ in range(5):
        access = await verifier.verify_token(token)
        assert access is not None
        assert access.claims["user_id"] == str(user.id)


def test_partial_auth0_config_yields_reject_all_verifier(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A PARTIAL Auth0 config — tenant ``domain`` + ``audience`` set, but the public
    ``mcp_public_base_url`` left empty — is treated as unconfigured all-or-nothing:
    ``_build_mcp_auth`` wraps the fail-closed reject-all verifier, NOT a real
    ``FortymmAuth0TokenVerifier``. Without this the api would ship a live verifier
    advertising the ``.invalid`` placeholder resource origin (broken RFC 9728
    discovery) far from the missing-config line. Construction still succeeds (the
    api boots), but every MCP request 401s at the reject-all verifier."""
    monkeypatch.setenv("AUTH0_DOMAIN", DOMAIN)
    monkeypatch.setenv("AUTH0_AUDIENCE", AUDIENCE)
    # A resource URL is present; only the base URL is missing — proving that ANY
    # missing piece flips the whole config to fail-closed.
    monkeypatch.setenv("MCP_PUBLIC_RESOURCE_URL", "https://uat.fortymm.com/api")
    monkeypatch.delenv("MCP_PUBLIC_BASE_URL", raising=False)

    provider = _build_mcp_auth()

    assert isinstance(provider.token_verifier, _RejectAllTokenVerifier)
    assert not isinstance(provider.token_verifier, FortymmAuth0TokenVerifier)


def test_full_auth0_config_yields_real_verifier(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The counterpart proving the partial-config fallback above is not vacuous:
    with ALL four Auth0/MCP settings present, ``_build_mcp_auth`` wraps the real
    ``FortymmAuth0TokenVerifier``."""
    monkeypatch.setenv("AUTH0_DOMAIN", DOMAIN)
    monkeypatch.setenv("AUTH0_AUDIENCE", AUDIENCE)
    monkeypatch.setenv("MCP_PUBLIC_BASE_URL", "https://uat.fortymm.com/api")
    monkeypatch.setenv("MCP_PUBLIC_RESOURCE_URL", "https://uat.fortymm.com/api")

    provider = _build_mcp_auth()

    assert isinstance(provider.token_verifier, FortymmAuth0TokenVerifier)


# ----- get_match tool ------------------------------------------------------


async def _create_match(
    api_client: httpx.AsyncClient, opponent: User, *, best_of: int = 5
) -> str:
    """Create a rated match against ``opponent`` as the client's session user via
    the HTTP endpoint (committed), returning the new match id."""
    response = await api_client.post(
        "/v1/matches",
        json={
            "opponent_user_id": str(opponent.id),
            "best_of": best_of,
            "rated": True,
        },
    )
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


async def test_get_match_returns_same_details_as_http_get(
    api_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """The ``get_match`` tool returns the identical ``MatchDetails`` view the HTTP
    ``GET /v1/matches/{id}`` returns for the same authenticated user — same id,
    sides, negotiation, and viewer-relative perspective flags."""
    me = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "mcp-get-rival")
    raw = await _mint(db_session, me)
    match_id = await _create_match(api_client, opponent)

    http_body = (await api_client.get(f"/v1/matches/{match_id}")).json()

    async with _mcp_client(raw) as client, client:
        result = await client.call_tool_mcp("get_match", {"match_id": match_id})

    assert result.isError is False
    assert result.structuredContent == http_body
    # Spot-check the load-bearing fields the tool is meant to preserve.
    assert result.structuredContent is not None
    assert result.structuredContent["id"] == match_id
    my_side, opp_side = result.structuredContent["sides"]
    assert my_side["is_current_user_side"] is True
    assert my_side["players"][0]["user_id"] == str(me.id)
    assert opp_side["is_current_user_side"] is False
    assert result.structuredContent["negotiation"]["viewer_state"] == "live"
    assert result.structuredContent["can_score"] is True


async def test_get_match_unknown_id_raises_tool_error(
    api_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """An id that matches no match surfaces as a ``ToolError`` at the caller."""
    me = await start_session(api_client, db_session)
    raw = await _mint(db_session, me)
    unknown = str(uuid.uuid4())

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match=unknown):
            await client.call_tool("get_match", {"match_id": unknown})


async def test_get_match_non_participant_sees_scorecard_without_extras(
    api_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """Mirroring the public HTTP GET (#515): a caller who is not on the match
    still reads the scorecard, but with no current-user side and the
    history/rivalry extras empty — not a ``ToolError``."""
    await start_session(api_client, db_session)
    opponent = await make_user(db_session, "mcp-nonpart-rival")
    match_id = await _create_match(api_client, opponent)

    outsider = await make_user(db_session, "mcp-outsider")
    outsider_token = await _mint(db_session, outsider)

    async with _mcp_client(outsider_token) as client, client:
        result = await client.call_tool_mcp("get_match", {"match_id": match_id})

    assert result.isError is False
    body = result.structuredContent
    assert body is not None
    assert body["id"] == match_id
    # No side is the outsider's, and the participant-only extras are empty (#515).
    assert all(side["is_current_user_side"] is False for side in body["sides"])
    assert all(
        player["is_current_user"] is False
        for side in body["sides"]
        for player in side["players"]
    )
    assert body["recent_form"] == []
    assert body["head_to_head"] is None


# ----- create_match tool ---------------------------------------------------


async def test_create_match_is_registered(db_session: AsyncSession) -> None:
    """The write verb is exposed alongside the read verb over the transport."""
    user = await make_user(db_session, "mcp-create-listed")
    raw = await _mint(db_session, user)

    async with _mcp_client(raw) as client, client:
        tools = await client.list_tools()

    assert "create_match" in {tool.name for tool in tools}


async def test_create_solo_match_is_retrievable_via_get_match(
    db_session: AsyncSession,
) -> None:
    """A solo ``create_match`` (no opponent, ``rated=False``) returns a
    ``MatchDetails`` with two sides — side 2 the player-less sentinel — and the
    created match is then readable back through ``get_match``."""
    me = await make_user(db_session, "mcp-solo-creator")
    raw = await _mint(db_session, me)

    async with _mcp_client(raw) as client, client:
        created = await client.call_tool_mcp(
            "create_match", {"best_of": 3, "rated": False}
        )
        assert created.isError is False
        body = created.structuredContent
        assert body is not None
        match_id = body["id"]

        read_back = await client.call_tool_mcp("get_match", {"match_id": match_id})

    # Creator's perspective: side 1 is mine, side 2 is the player-less sentinel.
    my_side, opp_side = body["sides"]
    assert my_side["is_current_user_side"] is True
    assert my_side["players"][0]["user_id"] == str(me.id)
    assert opp_side["is_current_user_side"] is False
    assert opp_side["players"] == []
    assert body["best_of"] == 3
    assert body["affects_rating"] is False
    # get_match reads the same match back.
    assert read_back.isError is False
    assert read_back.structuredContent is not None
    assert read_back.structuredContent["id"] == match_id


async def test_create_rated_without_opponent_raises_tool_error(
    db_session: AsyncSession,
) -> None:
    """A rated match with no opponent surfaces the domain rule as a ``ToolError``
    with an actionable message."""
    me = await make_user(db_session, "mcp-rated-noopp")
    raw = await _mint(db_session, me)

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="registered opponent"):
            await client.call_tool("create_match", {"best_of": 3, "rated": True})


async def test_create_self_match_raises_tool_error(
    db_session: AsyncSession,
) -> None:
    """Passing your own id as the opponent surfaces ``SelfMatchError`` as a
    ``ToolError``."""
    me = await make_user(db_session, "mcp-self-match")
    raw = await _mint(db_session, me)

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="against yourself"):
            await client.call_tool(
                "create_match",
                {"best_of": 3, "rated": False, "opponent_user_id": str(me.id)},
            )


async def test_create_match_unknown_opponent_raises_tool_error(
    db_session: AsyncSession,
) -> None:
    """A rated match against an id that matches no live player surfaces
    ``OpponentNotFoundError`` as a ``ToolError``."""
    me = await make_user(db_session, "mcp-unknown-opp")
    raw = await _mint(db_session, me)
    ghost = str(uuid.uuid4())

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match=ghost):
            await client.call_tool(
                "create_match",
                {"best_of": 5, "rated": True, "opponent_user_id": ghost},
            )


async def test_create_rated_match_against_registered_opponent(
    db_session: AsyncSession,
) -> None:
    """A rated match against a real registered opponent is created and rated."""
    me = await make_user(db_session, "mcp-rated-creator")
    opponent = await make_user(db_session, "mcp-rated-rival")
    raw = await _mint(db_session, me)

    async with _mcp_client(raw) as client, client:
        created = await client.call_tool_mcp(
            "create_match",
            {"best_of": 5, "rated": True, "opponent_user_id": str(opponent.id)},
        )

    assert created.isError is False
    body = created.structuredContent
    assert body is not None
    assert body["affects_rating"] is True
    my_side, opp_side = body["sides"]
    assert my_side["players"][0]["user_id"] == str(me.id)
    assert opp_side["players"][0]["user_id"] == str(opponent.id)


# ----- score-write tools (enter / update / delete) -------------------------


def _game_score(body: dict[str, object] | None, game_number: int) -> dict[str, int]:
    """The committed score dict for ``game_number`` in a ``MatchDetails`` body,
    asserting one exists."""
    assert body is not None
    games = body["games"]
    assert isinstance(games, list)
    game = next(g for g in games if g["game_number"] == game_number)
    score = game["score"]
    assert score is not None
    return score


async def test_score_write_tools_are_registered(db_session: AsyncSession) -> None:
    """The three per-game score verbs are exposed over the transport."""
    user = await make_user(db_session, "mcp-score-listed")
    raw = await _mint(db_session, user)

    async with _mcp_client(raw) as client, client:
        names = {tool.name for tool in await client.list_tools()}

    assert {"enter_game_score", "update_game_score", "delete_game_score"} <= names


async def test_enter_update_delete_game_score_round_trip(
    api_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """enter → get_match reflects it; update with the current version replaces
    it; a STALE version conflicts (naming get_match); delete clears it."""
    me = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "mcp-score-rival")
    raw = await _mint(db_session, me)
    match_id = await _create_match(api_client, opponent, best_of=5)

    async with _mcp_client(raw) as client, client:
        entered = await client.call_tool_mcp(
            "enter_game_score",
            {
                "match_id": match_id,
                "game_number": 1,
                "side_1_points": 11,
                "side_2_points": 5,
            },
        )
        assert entered.isError is False
        score = _game_score(entered.structuredContent, 1)
        assert (score["side_1_points"], score["side_2_points"], score["version"]) == (
            11,
            5,
            1,
        )

        # get_match reads the committed score back.
        read_back = await client.call_tool_mcp("get_match", {"match_id": match_id})
        assert _game_score(read_back.structuredContent, 1)["side_1_points"] == 11

        # Update with the current version succeeds and bumps the version.
        updated = await client.call_tool_mcp(
            "update_game_score",
            {
                "match_id": match_id,
                "game_number": 1,
                "side_1_points": 11,
                "side_2_points": 7,
                "expected_version": 1,
            },
        )
        assert updated.isError is False
        score = _game_score(updated.structuredContent, 1)
        assert (score["side_1_points"], score["side_2_points"], score["version"]) == (
            11,
            7,
            2,
        )

        # A stale expected_version loses the optimistic-concurrency check; the
        # ToolError must name get_match as the recovery path.
        with pytest.raises(ToolError, match="get_match"):
            await client.call_tool(
                "update_game_score",
                {
                    "match_id": match_id,
                    "game_number": 1,
                    "side_1_points": 11,
                    "side_2_points": 9,
                    "expected_version": 1,
                },
            )

        # Delete clears the committed score (the game row stays, score is null).
        deleted = await client.call_tool_mcp(
            "delete_game_score",
            {"match_id": match_id, "game_number": 1},
        )
        assert deleted.isError is False
        assert deleted.structuredContent is not None
        game = next(
            g for g in deleted.structuredContent["games"] if g["game_number"] == 1
        )
        assert game["score"] is None


async def test_enter_game_score_out_of_range_is_schema_error(
    api_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """A ``game_number`` outside 1..7 is rejected as a validation error before the
    tool body — the bounded ``Field(ge=1, le=7)`` on the argument."""
    me = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "mcp-score-range-rival")
    raw = await _mint(db_session, me)
    match_id = await _create_match(api_client, opponent, best_of=5)

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError):
            await client.call_tool(
                "enter_game_score",
                {
                    "match_id": match_id,
                    "game_number": 8,
                    "side_1_points": 11,
                    "side_2_points": 5,
                },
            )


async def test_enter_game_score_non_participant_raises_tool_error(
    api_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """A caller who isn't on the match can't score it — the load collapses
    non-participation into the same opaque not-found ToolError (naming
    participation), so existence can't be probed."""
    await start_session(api_client, db_session)
    opponent = await make_user(db_session, "mcp-score-outsider-rival")
    match_id = await _create_match(api_client, opponent, best_of=5)

    outsider = await make_user(db_session, "mcp-score-outsider")
    outsider_token = await _mint(db_session, outsider)

    async with _mcp_client(outsider_token) as client, client:
        with pytest.raises(ToolError, match="participant"):
            await client.call_tool(
                "enter_game_score",
                {
                    "match_id": match_id,
                    "game_number": 1,
                    "side_1_points": 11,
                    "side_2_points": 5,
                },
            )


async def test_enter_game_score_on_frozen_match_raises_scorable_reason(
    api_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """A match with a posted (standing) result has a frozen scratchpad; scoring
    it surfaces the carried scorability reason as the ToolError."""
    me = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "mcp-score-frozen-rival")
    raw = await _mint(db_session, me)
    match_id = await _create_match(api_client, opponent, best_of=1)

    # Post a complete, decided result via HTTP — a rated two-human match leaves
    # it standing and freezes the score endpoints (#715).
    posted = await api_client.post(
        f"/v1/matches/{match_id}/results",
        json={"games": [{"game_number": 1, "side_1_points": 11, "side_2_points": 5}]},
    )
    assert posted.status_code == 201, posted.text

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="posted result"):
            await client.call_tool(
                "enter_game_score",
                {
                    "match_id": match_id,
                    "game_number": 1,
                    "side_1_points": 11,
                    "side_2_points": 7,
                },
            )


# ----- propose_result / accept_result tools --------------------------------

# A decided best-of-3 board — side 1 clinches 2–0 — for the first proposal, and a
# different-but-still-decided board (also 2–0 to side 1, different points) for the
# counter that supersedes it.
_DECISIVE_BOARD = [
    {"game_number": 1, "side_1_points": 11, "side_2_points": 7},
    {"game_number": 2, "side_1_points": 11, "side_2_points": 8},
]
_COUNTER_BOARD = [
    {"game_number": 1, "side_1_points": 11, "side_2_points": 9},
    {"game_number": 2, "side_1_points": 11, "side_2_points": 6},
]


async def test_propose_and_accept_result_tools_are_registered(
    db_session: AsyncSession,
) -> None:
    """Both negotiation verbs are exposed over the transport."""
    user = await make_user(db_session, "mcp-negotiation-listed")
    raw = await _mint(db_session, user)

    async with _mcp_client(raw) as client, client:
        names = {tool.name for tool in await client.list_tools()}

    assert {"propose_result", "accept_result"} <= names


async def test_propose_awaits_acceptance_notifies_and_accept_completes(
    api_client: httpx.AsyncClient,
    db_session: AsyncSession,
    fake_notifications_queue: Queue,
) -> None:
    """The headline flow: A proposes a decided board on a rated two-human match →
    a standing result awaiting B, and B is sent one accept/counter notification.
    B reads the standing result id via get_match, then accept_result completes the
    match."""
    a = await start_session(api_client, db_session)
    b = await make_user(db_session, "mcp-accept-rival")
    token_a = await _mint(db_session, a)
    token_b = await _mint(db_session, b)
    match_id = await _create_match(api_client, b, best_of=3)

    async with _mcp_client(token_a) as client_a, client_a:
        proposed = await client_a.call_tool_mcp(
            "propose_result", {"match_id": match_id, "games": _DECISIVE_BOARD}
        )

    assert proposed.isError is False
    body = proposed.structuredContent
    assert body is not None
    # A's own view after proposing: the standing result is theirs and awaits B.
    assert body["status"] == "in_progress"
    negotiation = body["negotiation"]
    assert negotiation["viewer_state"] == "awaiting"
    standing = negotiation["standing_result"]
    assert standing is not None
    assert standing["submitted_by"] == str(a.id)
    standing_id = standing["id"]

    # B (the opposing side) got exactly one accept/counter notification.
    jobs = enqueued_notification_jobs(fake_notifications_queue)
    assert [job.user_id for job in jobs] == [b.id]
    assert jobs[0].link == f"/matches/{match_id}"

    async with _mcp_client(token_b) as client_b, client_b:
        # B sees the same standing result id through get_match, then accepts it.
        seen = await client_b.call_tool_mcp("get_match", {"match_id": match_id})
        assert seen.structuredContent is not None
        assert seen.structuredContent["negotiation"]["standing_result"]["id"] == (
            standing_id
        )

        accepted = await client_b.call_tool_mcp(
            "accept_result", {"match_id": match_id, "result_id": standing_id}
        )

    assert accepted.isError is False
    assert accepted.structuredContent is not None
    assert accepted.structuredContent["status"] == "completed"
    assert accepted.structuredContent["negotiation"]["viewer_state"] == "final"


async def test_counter_supersedes_standing_proposal(
    api_client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """After A proposes, B counters with a different decided board targeting the
    standing id — the counter becomes the new standing result, superseding A's."""
    a = await start_session(api_client, db_session)
    b = await make_user(db_session, "mcp-counter-rival")
    token_a = await _mint(db_session, a)
    token_b = await _mint(db_session, b)
    match_id = await _create_match(api_client, b, best_of=3)

    async with _mcp_client(token_a) as client_a, client_a:
        proposed = await client_a.call_tool_mcp(
            "propose_result", {"match_id": match_id, "games": _DECISIVE_BOARD}
        )
    assert proposed.structuredContent is not None
    first_id = proposed.structuredContent["negotiation"]["standing_result"]["id"]

    async with _mcp_client(token_b) as client_b, client_b:
        countered = await client_b.call_tool_mcp(
            "propose_result",
            {
                "match_id": match_id,
                "games": _COUNTER_BOARD,
                "supersedes_result_id": first_id,
            },
        )

    assert countered.isError is False
    body = countered.structuredContent
    assert body is not None
    standing = body["negotiation"]["standing_result"]
    assert standing is not None
    # A new standing result, submitted by B, that supersedes A's first proposal.
    assert standing["id"] != first_id
    assert standing["submitted_by"] == str(b.id)


async def test_accept_own_proposal_raises_tool_error(
    api_client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The proposing side already consented by proposing; A accepting their own
    standing proposal is a ``ToolError``."""
    a = await start_session(api_client, db_session)
    b = await make_user(db_session, "mcp-own-rival")
    token_a = await _mint(db_session, a)
    match_id = await _create_match(api_client, b, best_of=3)

    async with _mcp_client(token_a) as client_a, client_a:
        proposed = await client_a.call_tool_mcp(
            "propose_result", {"match_id": match_id, "games": _DECISIVE_BOARD}
        )
        assert proposed.structuredContent is not None
        standing_id = proposed.structuredContent["negotiation"]["standing_result"]["id"]

        with pytest.raises(ToolError, match="your own proposal"):
            await client_a.call_tool(
                "accept_result", {"match_id": match_id, "result_id": standing_id}
            )


async def test_accept_stale_result_id_raises_tool_error_naming_get_match(
    api_client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Accepting a superseded result id (A's first proposal, after B countered)
    surfaces the moved-on conflict as a ``ToolError`` naming get_match."""
    a = await start_session(api_client, db_session)
    b = await make_user(db_session, "mcp-stale-rival")
    token_a = await _mint(db_session, a)
    token_b = await _mint(db_session, b)
    match_id = await _create_match(api_client, b, best_of=3)

    async with _mcp_client(token_a) as client_a, client_a:
        proposed = await client_a.call_tool_mcp(
            "propose_result", {"match_id": match_id, "games": _DECISIVE_BOARD}
        )
    assert proposed.structuredContent is not None
    first_id = proposed.structuredContent["negotiation"]["standing_result"]["id"]

    async with _mcp_client(token_b) as client_b, client_b:
        # B counters, superseding A's first proposal ...
        await client_b.call_tool_mcp(
            "propose_result",
            {
                "match_id": match_id,
                "games": _COUNTER_BOARD,
                "supersedes_result_id": first_id,
            },
        )
        # ... so accepting the now-stale first id loses the negotiation race.
        with pytest.raises(ToolError, match="get_match"):
            await client_b.call_tool(
                "accept_result", {"match_id": match_id, "result_id": first_id}
            )


async def test_countering_stale_result_id_raises_tool_error_naming_get_match(
    api_client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A counter that supersedes an id no longer standing (B already countered
    A's first proposal) surfaces the conflict as a ``ToolError`` naming
    get_match."""
    a = await start_session(api_client, db_session)
    b = await make_user(db_session, "mcp-counter-stale-rival")
    token_a = await _mint(db_session, a)
    token_b = await _mint(db_session, b)
    match_id = await _create_match(api_client, b, best_of=3)

    async with _mcp_client(token_a) as client_a, client_a:
        proposed = await client_a.call_tool_mcp(
            "propose_result", {"match_id": match_id, "games": _DECISIVE_BOARD}
        )
        assert proposed.structuredContent is not None
        first_id = proposed.structuredContent["negotiation"]["standing_result"]["id"]

    async with _mcp_client(token_b) as client_b, client_b:
        await client_b.call_tool_mcp(
            "propose_result",
            {
                "match_id": match_id,
                "games": _COUNTER_BOARD,
                "supersedes_result_id": first_id,
            },
        )

    # A now tries to counter targeting the stale first id.
    async with _mcp_client(token_a) as client_a, client_a:
        with pytest.raises(ToolError, match="get_match"):
            await client_a.call_tool(
                "propose_result",
                {
                    "match_id": match_id,
                    "games": _DECISIVE_BOARD,
                    "supersedes_result_id": first_id,
                },
            )


async def test_propose_undecided_board_raises_tool_error(
    api_client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A board that doesn't decide the match (one game on a best-of-3) can't be a
    result — surfaced as a ``ToolError``."""
    a = await start_session(api_client, db_session)
    b = await make_user(db_session, "mcp-undecided-rival")
    token_a = await _mint(db_session, a)
    match_id = await _create_match(api_client, b, best_of=3)

    async with _mcp_client(token_a) as client_a, client_a:
        with pytest.raises(ToolError):
            await client_a.call_tool(
                "propose_result",
                {
                    "match_id": match_id,
                    "games": [
                        {"game_number": 1, "side_1_points": 11, "side_2_points": 7}
                    ],
                },
            )


# ----- search_players / list_my_matches read tools -------------------------


async def test_search_and_list_my_matches_tools_are_registered(
    db_session: AsyncSession,
) -> None:
    """Both read verbs are exposed over the transport."""
    user = await make_user(db_session, "mcp-reads-listed")
    raw = await _mint(db_session, user)

    async with _mcp_client(raw) as client, client:
        names = {tool.name for tool in await client.list_tools()}

    assert {"search_players", "list_my_matches"} <= names


async def test_search_players_finds_opponent_and_excludes_caller(
    db_session: AsyncSession,
) -> None:
    """A username-fragment search returns matching players and never the caller
    themselves, mirroring ``GET /v1/players/search``."""
    me = await make_user(db_session, "mcp-search-zephyr-self")
    rival = await make_user(db_session, "mcp-search-zephyr-rival")
    raw = await _mint(db_session, me)

    async with _mcp_client(raw) as client, client:
        found = await client.call_tool_mcp("search_players", {"query": "zephyr-rival"})

    assert found.isError is False
    assert found.structuredContent is not None
    players = found.structuredContent["result"]
    ids = {p["id"] for p in players}
    assert str(rival.id) in ids
    assert str(me.id) not in ids


async def test_search_players_blank_query_returns_empty(
    db_session: AsyncSession,
) -> None:
    """A blank query matches nothing — the same as the underlying service."""
    me = await make_user(db_session, "mcp-search-blank")
    await make_user(db_session, "mcp-search-blank-other")
    raw = await _mint(db_session, me)

    async with _mcp_client(raw) as client, client:
        found = await client.call_tool_mcp("search_players", {"query": "   "})

    assert found.isError is False
    assert found.structuredContent is not None
    assert found.structuredContent["result"] == []


async def test_search_create_score_negotiate_then_list_my_matches(
    db_session: AsyncSession,
) -> None:
    """The whole match flow over MCP ONLY: A searches for B, creates a rated
    best-of-3, scores a decisive board, proposes it; B accepts → completed;
    finally A's ``list_my_matches`` shows the completed match, won, against B."""
    a = await make_user(db_session, "mcp-flow-alice")
    b = await make_user(db_session, "mcp-flow-bob-quartz")
    token_a = await _mint(db_session, a)
    token_b = await _mint(db_session, b)

    async with _mcp_client(token_a) as client_a, client_a:
        # A finds B by a username fragment; A is excluded from her own search.
        found = await client_a.call_tool_mcp("search_players", {"query": "bob-quartz"})
        assert found.isError is False
        assert found.structuredContent is not None
        hit_ids = {p["id"] for p in found.structuredContent["result"]}
        assert str(b.id) in hit_ids
        assert str(a.id) not in hit_ids

        # A creates a rated best-of-3 against B via the tool.
        created = await client_a.call_tool_mcp(
            "create_match",
            {"best_of": 3, "rated": True, "opponent_user_id": str(b.id)},
        )
        assert created.isError is False
        assert created.structuredContent is not None
        match_id = created.structuredContent["id"]

        # A scores a decisive 2-0 board, then proposes it.
        for game in _DECISIVE_BOARD:
            entered = await client_a.call_tool_mcp(
                "enter_game_score",
                {
                    "match_id": match_id,
                    "game_number": game["game_number"],
                    "side_1_points": game["side_1_points"],
                    "side_2_points": game["side_2_points"],
                },
            )
            assert entered.isError is False
        proposed = await client_a.call_tool_mcp(
            "propose_result", {"match_id": match_id, "games": _DECISIVE_BOARD}
        )
        assert proposed.structuredContent is not None
        standing_id = proposed.structuredContent["negotiation"]["standing_result"]["id"]

    # B accepts the standing proposal → the match completes.
    async with _mcp_client(token_b) as client_b, client_b:
        accepted = await client_b.call_tool_mcp(
            "accept_result", {"match_id": match_id, "result_id": standing_id}
        )
        assert accepted.isError is False
        assert accepted.structuredContent is not None
        assert accepted.structuredContent["status"] == "completed"

    # A's own match list now shows the completed match, projected onto her side.
    async with _mcp_client(token_a) as client_a, client_a:
        listed = await client_a.call_tool_mcp("list_my_matches", {})

    assert listed.isError is False
    assert listed.structuredContent is not None
    rows = {row["id"]: row for row in listed.structuredContent["items"]}
    assert match_id in rows
    assert rows[match_id]["status"] == "completed"
    assert rows[match_id]["result"] == "W"
    assert rows[match_id]["opponent"]["id"] == str(b.id)


async def test_list_my_matches_returns_only_the_callers_matches(
    api_client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """``list_my_matches`` is scoped to the caller — a match the caller is NOT a
    side of (unlike the global ``GET /v1/matches`` feed) never appears."""
    me = await make_user(db_session, "mcp-mine-owner")
    raw = await _mint(db_session, me)

    # A match the caller owns (created via the tool), and a wholly-separate match
    # between two other players seeded over HTTP that the caller is absent from.
    other = await start_session(api_client, db_session)
    other_opponent = await make_user(db_session, "mcp-mine-other-rival")
    foreign_match_id = await _create_match(api_client, other_opponent)

    async with _mcp_client(raw) as client, client:
        created = await client.call_tool_mcp(
            "create_match",
            {"best_of": 3, "rated": True, "opponent_user_id": str(other.id)},
        )
        assert created.structuredContent is not None
        mine_match_id = created.structuredContent["id"]

        listed = await client.call_tool_mcp("list_my_matches", {})

    assert listed.isError is False
    assert listed.structuredContent is not None
    listed_ids = {row["id"] for row in listed.structuredContent["items"]}
    assert mine_match_id in listed_ids
    assert foreign_match_id not in listed_ids


# ----- get_tournament tool -------------------------------------------------


def _tournament_payload() -> dict[str, object]:
    """A minimal valid create-tournament body (same shape as test_tournaments)."""
    return {
        "name": "MCP Cup 2026",
        "description": "An MCP-visible open.",
        "start_date": "2026-08-01",
        "end_date": "2026-08-02",
        "address": {
            "venue": "Berkeley TT Club",
            "street": "2727 Milvia St",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94703",
            "country": "USA",
        },
        "table_catalogue": [{"label": "Table 1", "court": "A"}],
    }


def _event_payload() -> dict[str, object]:
    """A minimal valid create-event body for a tournament (same shape as
    test_tournaments), so the detail read exercises the events list too."""
    return {
        "name": "Open Singles",
        "format": "singles",
        "draw_type": "single-elim",
        "max_players": 64,
        "entry_fee": 45,
        "timezone": "America/Chicago",
        "slot": {"date": "2026-08-01", "start": "09:00", "end": "18:00"},
        "match_settings": {"rated": True, "length_games": 5},
        "predicates": [{"id": "pr-1", "field": "rating", "op": "<", "value": 1500}],
        "pools": [
            {
                "name": "Pool A",
                "slot": {"date": "2026-08-01", "start": "09:00", "end": "12:30"},
                "table_ids": ["t1"],
            }
        ],
    }


async def _create_tournament(api_client: httpx.AsyncClient) -> str:
    """Create a tournament (with one event) as the client's session user via HTTP
    (committed), returning the new tournament id."""
    response = await api_client.post("/v1/tournaments", json=_tournament_payload())
    assert response.status_code == 201, response.text
    tournament_id = str(response.json()["id"])
    event = await api_client.post(
        f"/v1/tournaments/{tournament_id}/events", json=_event_payload()
    )
    assert event.status_code == 201, event.text
    return tournament_id


async def test_get_tournament_returns_same_detail_as_http_get(
    api_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """The ``get_tournament`` tool returns the identical ``TournamentDetailRead``
    view the HTTP ``GET /v1/tournaments/{id}`` returns for the same authenticated
    user — same fields, events, and viewer-relative ``can_edit``."""
    me = await start_session(api_client, db_session)
    await grant_permissions(db_session, me, [TOURNAMENT_VIEW, TOURNAMENT_CREATE])
    raw = await _mint(db_session, me)
    tournament_id = await _create_tournament(api_client)

    http_body = (await api_client.get(f"/v1/tournaments/{tournament_id}")).json()

    async with _mcp_client(raw) as client, client:
        result = await client.call_tool_mcp(
            "get_tournament", {"tournament_id": tournament_id}
        )

    assert result.isError is False
    assert result.structuredContent == http_body
    # Spot-check the load-bearing fields the tool is meant to preserve.
    assert result.structuredContent is not None
    assert result.structuredContent["id"] == tournament_id
    assert result.structuredContent["can_edit"] is True
    assert result.structuredContent["created_by_user_id"] == str(me.id)
    assert len(result.structuredContent["events"]) == 1


async def test_get_tournament_unknown_id_raises_tool_error(
    api_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """An id that matches no tournament surfaces as a ``ToolError`` at the caller."""
    me = await start_session(api_client, db_session)
    await grant_permissions(db_session, me, [TOURNAMENT_VIEW])
    raw = await _mint(db_session, me)
    unknown = str(uuid.uuid4())

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match=unknown):
            await client.call_tool("get_tournament", {"tournament_id": unknown})


async def test_get_tournament_without_view_permission_raises_tool_error(
    db_session: AsyncSession,
) -> None:
    """A caller who does not hold ``tournament.view`` is refused before any row is
    loaded — the same gate the HTTP ``require_view`` dependency enforces."""
    me = await make_user(db_session, "mcp-tourn-noperm")
    raw = await _mint(db_session, me)

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="permission"):
            await client.call_tool(
                "get_tournament", {"tournament_id": str(uuid.uuid4())}
            )


async def test_get_tournament_hidden_draft_raises_tool_error_for_non_owner(
    api_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """A draft the caller does not own is not theirs to see: even holding
    ``tournament.view``, an outsider gets the same not-found ``ToolError`` an
    absent id would — existence is never confirmed for an unannounced draft,
    exactly as the HTTP route hides it behind a 404 (see visible_to)."""
    owner = await start_session(api_client, db_session)
    await grant_permissions(db_session, owner, [TOURNAMENT_VIEW, TOURNAMENT_CREATE])
    tournament_id = await _create_tournament(api_client)  # born ``draft``

    outsider = await make_user(db_session, "mcp-tourn-outsider")
    await grant_permissions(db_session, outsider, [TOURNAMENT_VIEW])
    outsider_token = await _mint(db_session, outsider)

    async with _mcp_client(outsider_token) as client, client:
        with pytest.raises(ToolError, match=tournament_id):
            await client.call_tool("get_tournament", {"tournament_id": tournament_id})


# ----- list_my_tournaments tool --------------------------------------------


async def _seed_owned_tournament(
    db_session: AsyncSession,
    owner: User,
    league: League,
    name: str,
    status: TournamentStatus,
) -> Tournament:
    """Insert a tournament owned by ``owner`` directly (committed), so a test can
    give a *different* user a tournament the caller doesn't own — at any status,
    including a published one the caller can otherwise see."""
    tournament = Tournament(
        name=name,
        address={
            "venue": "Elsewhere TT",
            "street": "1 Broadway",
            "city": "Oakland",
            "region": "CA",
            "postal": "94607",
            "country": "USA",
            "latitude": 37.8703,
            "longitude": -122.2731,
        },
        league_id=league.id,
        created_by_user_id=owner.id,
        status=status,
    )
    db_session.add(tournament)
    await db_session.commit()
    await db_session.refresh(tournament)
    return tournament


async def test_list_my_tournaments_returns_only_the_callers_own_newest_first(
    api_client: httpx.AsyncClient,
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """``list_my_tournaments`` is OWNER-scoped, not visibility-scoped: it returns
    exactly the tournaments the caller created (newest first) and EXCLUDES another
    user's — even a PUBLISHED one the caller can otherwise see via the HTTP list.

    Two different api-token users each own tournaments; the caller (A) also holds
    ``tournament.view`` and so *can* see B's published tournament through
    ``GET /v1/tournaments`` — proving the tool's exclusion is about ownership, not
    visibility."""
    me = await start_session(api_client, db_session)
    await grant_permissions(db_session, me, [TOURNAMENT_VIEW, TOURNAMENT_CREATE])
    token_a = await _mint(db_session, me)
    # Two tournaments owned by A, created oldest → newest so the ordering is pinned.
    mine_first = await _create_tournament(api_client)
    mine_second = await _create_tournament(api_client)

    # A second user B owns a PUBLISHED (announced) tournament — A can *see* it via
    # the visibility-scoped HTTP list, but does not own it.
    other = await make_user(db_session, "mcp-list-tourn-other-owner")
    await grant_permissions(db_session, other, [TOURNAMENT_VIEW])
    token_b = await _mint(db_session, other)
    theirs = await _seed_owned_tournament(
        db_session, other, default_league, "Their Open", TournamentStatus.published
    )

    # Sanity: A genuinely *can* see B's published tournament through the
    # visibility-scoped HTTP list — so excluding it below is about ownership.
    visible = (await api_client.get("/v1/tournaments")).json()
    visible_ids = {t["id"] for t in visible}
    assert {mine_first, mine_second, str(theirs.id)} <= visible_ids

    async with _mcp_client(token_a) as client, client:
        listed = await client.call_tool_mcp("list_my_tournaments", {})
    assert listed.isError is False
    assert listed.structuredContent is not None
    ids = [t["id"] for t in listed.structuredContent["result"]]
    # Exactly A's own, newest first, and B's published tournament is excluded.
    assert ids == [mine_second, mine_first]
    assert str(theirs.id) not in ids

    # And B's own listing is symmetric: only B's tournament, none of A's.
    async with _mcp_client(token_b) as client_b, client_b:
        listed_b = await client_b.call_tool_mcp("list_my_tournaments", {})
    assert listed_b.isError is False
    assert listed_b.structuredContent is not None
    ids_b = [t["id"] for t in listed_b.structuredContent["result"]]
    assert ids_b == [str(theirs.id)]
    assert mine_first not in ids_b
    assert mine_second not in ids_b


async def test_list_my_tournaments_without_view_permission_raises_tool_error(
    db_session: AsyncSession,
) -> None:
    """A caller who does not hold ``tournament.view`` is refused, mirroring the
    ``tournament.view`` gate the HTTP list enforces via ``require_view``."""
    me = await make_user(db_session, "mcp-list-tourn-noperm")
    raw = await _mint(db_session, me)

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="permission"):
            await client.call_tool("list_my_tournaments", {})


# ----- list_schedule_solves tool (admin ledger read) -----------------------


async def _add_ledger_solve(
    db_session: AsyncSession,
    tournament_id: uuid.UUID,
    *,
    requested_at: datetime,
    input_fingerprint: str | None = None,
) -> ScheduleSolve:
    """Insert one committed ledger row for ``tournament_id`` directly, so a read
    test can pin the ordering with explicit ``requested_at`` values."""
    row = ScheduleSolve(
        tournament_id=tournament_id,
        trigger=ScheduleSolveTrigger.manual,
        status=ScheduleSolveStatus.succeeded,
        verdict=SolverVerdict.optimal,
        requested_at=requested_at,
        input_fingerprint=input_fingerprint,
    )
    db_session.add(row)
    await db_session.commit()
    await db_session.refresh(row)
    return row


async def test_list_schedule_solves_returns_ledger_for_admin(
    api_client: httpx.AsyncClient,
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A caller holding ``scheduling.view`` gets the cross-tournament ledger,
    newest first, each row joined to its tournament name — the same rows the HTTP
    admin ``GET /v1/admin/schedule-solves`` serves, composed from the same reader."""
    me = await start_session(api_client, db_session)
    await grant_permissions(db_session, me, [SCHEDULING_VIEW_PERMISSION])
    raw = await _mint(db_session, me)
    spring = await _seed_owned_tournament(
        db_session, me, default_league, "Spring Open", TournamentStatus.published
    )
    autumn = await _seed_owned_tournament(
        db_session, me, default_league, "Autumn Cup", TournamentStatus.published
    )
    older = await _add_ledger_solve(
        db_session, spring.id, requested_at=datetime(2030, 1, 1, 9, 0, tzinfo=UTC)
    )
    newer = await _add_ledger_solve(
        db_session, autumn.id, requested_at=datetime(2030, 1, 1, 10, 0, tzinfo=UTC)
    )

    async with _mcp_client(raw) as client, client:
        result = await client.call_tool_mcp("list_schedule_solves", {})

    assert result.isError is False
    assert result.structuredContent is not None
    rows = result.structuredContent["result"]
    assert [r["id"] for r in rows] == [str(newer.id), str(older.id)]
    by_id = {r["id"]: r for r in rows}
    assert by_id[str(newer.id)]["tournament_name"] == "Autumn Cup"
    assert by_id[str(older.id)]["tournament_name"] == "Spring Open"

    # The tournament_id filter narrows to one tournament's runs.
    async with _mcp_client(raw) as client, client:
        filtered = await client.call_tool_mcp(
            "list_schedule_solves", {"tournament_id": str(spring.id)}
        )
    assert filtered.isError is False
    assert filtered.structuredContent is not None
    filtered_rows = filtered.structuredContent["result"]
    assert [r["id"] for r in filtered_rows] == [str(older.id)]


async def test_list_schedule_solves_without_permission_is_tool_error_and_leaks_no_data(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The security crux: a caller who does NOT hold ``scheduling.view`` is refused
    with a ``ToolError`` before any row is read, and the operator-only ledger never
    leaks — neither a row id nor its ``input_fingerprint`` appears in the error, and
    no structured data is returned. This is the same gate the HTTP admin route's
    ``require_permission("scheduling.view")`` dependency enforces (a 403 there)."""
    # A real, committed ledger row that WOULD surface if the gate leaked.
    owner = await make_user(db_session, "sched-ledger-owner")
    tournament = await _seed_owned_tournament(
        db_session, owner, default_league, "Ledger Open", TournamentStatus.published
    )
    solve = await _add_ledger_solve(
        db_session,
        tournament.id,
        requested_at=datetime(2030, 1, 1, 9, 0, tzinfo=UTC),
        input_fingerprint="LEAKY-FINGERPRINT-9f3c",
    )

    # A caller holding no scheduling permission at all.
    caller = await make_user(db_session, "sched-ledger-noperm")
    raw = await _mint(db_session, caller)

    async with _mcp_client(raw) as client, client:
        result = await client.call_tool_mcp("list_schedule_solves", {})

    # Refused, with NO structured payload…
    assert result.isError is True
    assert result.structuredContent is None
    # …the error names the permission, and no ledger data leaked through the text.
    blob = " ".join(getattr(block, "text", "") for block in result.content)
    assert "permission" in blob.lower()
    assert str(solve.id) not in blob
    assert "LEAKY-FINGERPRINT-9f3c" not in blob

    # And the raising form is a ToolError too (the plain call_tool path).
    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="permission"):
            await client.call_tool("list_schedule_solves", {})


# ----- get_schedule tool ---------------------------------------------------


async def _first_event_id(db_session: AsyncSession, tournament_id: str) -> uuid.UUID:
    """The id of the one event ``_create_tournament`` created for this tournament."""
    return (
        await db_session.execute(
            select(TournamentEvent.id).where(
                TournamentEvent.tournament_id == uuid.UUID(tournament_id)
            )
        )
    ).scalar_one()


async def _only_pool_id(db_session: AsyncSession, event_id: uuid.UUID) -> uuid.UUID:
    """The id of the event's one pool — server-minted (ADR 20260801), so a seed that
    puts a fixture in it has to look it up rather than spell it."""
    return (
        await db_session.execute(
            select(TournamentEventPool.id).where(
                TournamentEventPool.event_id == event_id
            )
        )
    ).scalar_one()


async def _seed_placed_fixture(
    db_session: AsyncSession,
    event_id: uuid.UUID,
    *,
    table_id: str,
    scheduled_start: datetime,
) -> TournamentFixture:
    """Cut a single PLACED fixture directly: two active entrants seated on it, in a
    pool, with a table + predicted start (a naive wall-clock time, ADR-0790). The
    enter/cut/place routes would take several acts to reach this state; the read
    path just needs the state itself."""
    entry_a = TournamentEntry(
        event_id=event_id,
        user_id=(await make_user(db_session, "sched-a-" + uuid.uuid4().hex)).id,
        status=TournamentEntryStatus.entered,
    )
    entry_b = TournamentEntry(
        event_id=event_id,
        user_id=(await make_user(db_session, "sched-b-" + uuid.uuid4().hex)).id,
        status=TournamentEntryStatus.entered,
    )
    db_session.add_all([entry_a, entry_b])
    await db_session.commit()
    fixture = TournamentFixture(
        event_id=event_id,
        pool_id=await _only_pool_id(db_session, event_id),
        round=1,
        position=1,
        entry_a_id=entry_a.id,
        entry_b_id=entry_b.id,
        table_id=table_id,
        scheduled_start=scheduled_start,
    )
    db_session.add(fixture)
    await db_session.commit()
    await db_session.refresh(fixture)
    return fixture


async def test_get_schedule_returns_placed_fixtures_and_latest_solve_verdict(
    api_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """A tournament with a cut, PLACED draw and a solve on its ledger: ``get_schedule``
    groups each event's fixtures with their table + predicted start, and reports the
    latest solve's status/verdict — the same placement + solve facts the detail BFF
    reads, in the narrow schedule projection."""
    me = await start_session(api_client, db_session)
    await grant_permissions(db_session, me, [TOURNAMENT_VIEW, TOURNAMENT_CREATE])
    raw = await _mint(db_session, me)
    tournament_id = await _create_tournament(api_client)
    event_id = await _first_event_id(db_session, tournament_id)

    # Aware, so asyncpg stores a deterministic instant regardless of the test
    # runner's local timezone (a naive value is read in the session tz — 14:00Z on
    # a US-Central dev box, 09:00Z in a UTC CI runner). 9:00 AM America/Chicago
    # (CDT on this August date) = 14:00Z, which the BFF renders back as "9:00 AM CDT".
    scheduled_start = datetime(2026, 8, 1, 9, 0, tzinfo=ZoneInfo("America/Chicago"))
    (the_table, *_) = await table_ids_of(db_session, uuid.UUID(tournament_id))
    fixture = await _seed_placed_fixture(
        db_session, event_id, table_id=the_table, scheduled_start=scheduled_start
    )
    # A finished solve on the ledger, so the projection carries a verdict.
    db_session.add(
        ScheduleSolve(
            tournament_id=uuid.UUID(tournament_id),
            trigger=ScheduleSolveTrigger.manual,
            status=ScheduleSolveStatus.succeeded,
            verdict=SolverVerdict.optimal,
            fixtures_placed=1,
            fixtures_pinned=0,
        )
    )
    await db_session.commit()

    async with _mcp_client(raw) as client, client:
        result = await client.call_tool_mcp(
            "get_schedule", {"tournament_id": tournament_id}
        )

    assert result.isError is False
    body = result.structuredContent
    assert body is not None
    assert body["tournament_id"] == tournament_id
    assert len(body["events"]) == 1
    group = body["events"][0]
    assert group["event_id"] == str(event_id)
    assert group["name"] == "Open Singles"
    assert len(group["fixtures"]) == 1
    placed = group["fixtures"][0]
    assert placed["id"] == str(fixture.id)
    assert placed["table_id"] == the_table
    # ``scheduled_start`` is now a venue-local ``FixtureTimeRead`` (ADR "tournament
    # times are timezone-aware instants"): the 09:00 seed is anchored in the event's
    # America/Chicago zone (= 14:00Z), rendered with its local label + tz abbrev.
    assert placed["scheduled_start"] == {
        "instant": "2026-08-01T14:00:00Z",
        "local_label": "9:00 AM",
        "tz_abbrev": "CDT",
    }
    assert placed["pool_id"] == str(fixture.pool_id)
    assert placed["round"] == 1
    assert placed["position"] == 1
    assert body["latest_schedule_solve"]["status"] == "succeeded"
    assert body["latest_schedule_solve"]["verdict"] == "optimal"


async def test_get_schedule_with_no_draw_and_no_solve_is_empty(
    api_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """A tournament whose event has no cut draw and which has never been solved:
    the event group carries ``[]`` fixtures (the designed un-cut state, ADR-0786)
    and ``latest_schedule_solve`` is ``null``."""
    me = await start_session(api_client, db_session)
    await grant_permissions(db_session, me, [TOURNAMENT_VIEW, TOURNAMENT_CREATE])
    raw = await _mint(db_session, me)
    tournament_id = await _create_tournament(api_client)
    event_id = await _first_event_id(db_session, tournament_id)

    async with _mcp_client(raw) as client, client:
        result = await client.call_tool_mcp(
            "get_schedule", {"tournament_id": tournament_id}
        )

    assert result.isError is False
    body = result.structuredContent
    assert body is not None
    assert body["tournament_id"] == tournament_id
    assert len(body["events"]) == 1
    assert body["events"][0]["event_id"] == str(event_id)
    assert body["events"][0]["fixtures"] == []
    assert body["latest_schedule_solve"] is None


async def test_get_schedule_unknown_id_raises_tool_error(
    api_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """An id that matches no tournament surfaces as a ``ToolError`` at the caller."""
    me = await start_session(api_client, db_session)
    await grant_permissions(db_session, me, [TOURNAMENT_VIEW])
    raw = await _mint(db_session, me)
    unknown = str(uuid.uuid4())

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match=unknown):
            await client.call_tool("get_schedule", {"tournament_id": unknown})


async def test_get_schedule_hidden_draft_raises_tool_error_for_non_owner(
    api_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """A draft the caller does not own is not theirs to see: even holding
    ``tournament.view``, an outsider gets the same not-found ``ToolError`` an absent
    id would — the same visibility gate ``get_tournament`` and the HTTP detail read
    keep."""
    owner = await start_session(api_client, db_session)
    await grant_permissions(db_session, owner, [TOURNAMENT_VIEW, TOURNAMENT_CREATE])
    tournament_id = await _create_tournament(api_client)  # born ``draft``

    outsider = await make_user(db_session, "mcp-sched-outsider")
    await grant_permissions(db_session, outsider, [TOURNAMENT_VIEW])
    outsider_token = await _mint(db_session, outsider)

    async with _mcp_client(outsider_token) as client, client:
        with pytest.raises(ToolError, match=tournament_id):
            await client.call_tool("get_schedule", {"tournament_id": tournament_id})


async def test_get_schedule_without_view_permission_raises_tool_error(
    db_session: AsyncSession,
) -> None:
    """A caller who does not hold ``tournament.view`` is refused before any row is
    loaded — the same gate the HTTP detail read's ``require_view`` dependency
    enforces."""
    me = await make_user(db_session, "mcp-sched-noperm")
    raw = await _mint(db_session, me)

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="permission"):
            await client.call_tool("get_schedule", {"tournament_id": str(uuid.uuid4())})


# ----- edit_tournament tool ------------------------------------------------


async def test_edit_tournament_is_registered(db_session: AsyncSession) -> None:
    """The write verb is exposed as a tool to an authenticated caller."""
    user = await make_user(db_session, "mcp-edit-listed")
    raw = await _mint(db_session, user)

    async with _mcp_client(raw) as client, client:
        tools = await client.list_tools()
    assert "edit_tournament" in {tool.name for tool in tools}


async def test_edit_tournament_owner_renames_and_it_persists(
    api_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """A bearer-authed OWNER renames a tournament via the tool: the returned view
    carries the new name (and leaves the other fields untouched — partial
    semantics), and the change is committed, readable back through the tool."""
    me = await start_session(api_client, db_session)
    await grant_permissions(db_session, me, [TOURNAMENT_VIEW, TOURNAMENT_CREATE])
    raw = await _mint(db_session, me)
    tournament_id = await _create_tournament(api_client)

    async with _mcp_client(raw) as client, client:
        result = await client.call_tool_mcp(
            "edit_tournament",
            {"tournament_id": tournament_id, "updates": {"name": "Renamed Cup"}},
        )
        assert result.isError is False
        body = result.structuredContent
        assert body is not None
        assert body["id"] == tournament_id
        assert body["name"] == "Renamed Cup"
        assert body["can_edit"] is True
        assert body["created_by_user_id"] == str(me.id)
        # Partial semantics: an omitted field is left unchanged.
        assert body["description"] == _tournament_payload()["description"]

        # The write committed — read it back through the tool.
        read_back = await client.call_tool_mcp(
            "get_tournament", {"tournament_id": tournament_id}
        )
    assert read_back.structuredContent is not None
    assert read_back.structuredContent["name"] == "Renamed Cup"

    # And it is durable in the database.
    db_session.expire_all()
    persisted = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == uuid.UUID(tournament_id))
        )
    ).scalar_one()
    assert persisted.name == "Renamed Cup"


async def test_edit_tournament_non_owner_raises_tool_error_and_writes_nothing(
    api_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """A caller who is not the tournament's creator gets a ``ToolError`` (owner-gated
    by construction in the shared verb), and nothing is written."""
    owner = await start_session(api_client, db_session)
    await grant_permissions(db_session, owner, [TOURNAMENT_VIEW, TOURNAMENT_CREATE])
    tournament_id = await _create_tournament(api_client)
    original_name = _tournament_payload()["name"]

    outsider = await make_user(db_session, "mcp-edit-outsider")
    outsider_token = await _mint(db_session, outsider)

    async with _mcp_client(outsider_token) as client, client:
        with pytest.raises(ToolError, match="only edit tournaments you created"):
            await client.call_tool(
                "edit_tournament",
                {"tournament_id": tournament_id, "updates": {"name": "Hijacked"}},
            )

    # Nothing was written: the name is still the owner's original.
    db_session.expire_all()
    persisted = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == uuid.UUID(tournament_id))
        )
    ).scalar_one()
    assert persisted.name == original_name


async def test_edit_tournament_unknown_id_raises_tool_error(
    db_session: AsyncSession,
) -> None:
    """An id that matches no tournament surfaces as a ``ToolError`` at the caller."""
    me = await make_user(db_session, "mcp-edit-unknown")
    raw = await _mint(db_session, me)
    unknown = str(uuid.uuid4())

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match=unknown):
            await client.call_tool(
                "edit_tournament",
                {"tournament_id": unknown, "updates": {"name": "Nope"}},
            )


async def test_edit_tournament_league_change_after_publish_raises_tool_error(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Changing the league of a tournament that has left ``draft`` is refused
    (ADR-0783): the owner gets a ``ToolError`` carrying the state rule, and the
    refusal is judged before the league is even looked up (so an arbitrary id is
    enough to trip it)."""
    owner = await make_user(db_session, "mcp-edit-published-owner")
    raw = await _mint(db_session, owner)
    published = await _seed_owned_tournament(
        db_session, owner, default_league, "Published Cup", TournamentStatus.published
    )

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="can only be changed while it is a draft"):
            await client.call_tool(
                "edit_tournament",
                {
                    "tournament_id": str(published.id),
                    "updates": {"league_id": str(uuid.uuid4())},
                },
            )


# ----- build_cut / uncut draw tools ----------------------------------------
#
# Two pools, so the round-robin snake deals a clean draw a fixture's ``pool_id``
# refs against — the same shape ``test_tournament_draw_service.py`` cuts across.
_DRAW_POOL_A: dict[str, object] = {
    "name": "Pool A",
    "slot": {"date": "2026-08-01", "start": "09:00", "end": "12:30"},
    "table_ids": ["t1"],
}
_DRAW_POOL_B: dict[str, object] = {
    "name": "Pool B",
    "slot": {"date": "2026-08-01", "start": "09:00", "end": "12:30"},
    "table_ids": ["t2"],
}


async def _seed_drawable_tournament(
    db_session: AsyncSession,
    owner: User,
    league: League,
    *,
    format: EventFormat = EventFormat.singles,
    draw_type: DrawType = DrawType.round_robin,
    entrants: int = 4,
) -> tuple[Tournament, TournamentEvent]:
    """A tournament + one event owned by ``owner`` (committed), seeded directly so a
    draw tool can be driven against its ``event_id`` alone. A round-robin singles event
    with two pools and ``entrants`` seeded entries is cuttable; ``format`` /
    ``draw_type`` / ``entrants`` are knobbed to reach the un-cuttable cases (a doubles
    event, an unsupported draw type)."""
    tournament = Tournament(
        name="MCP Draw Cup",
        address={
            "venue": "Berkeley TT Club",
            "street": "2727 Milvia St",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94703",
            "country": "USA",
            "latitude": 37.8703,
            "longitude": -122.2731,
        },
        tables=venue_tables(("Table 1", "A"), ("Table 2", "A")),
        league_id=league.id,
        created_by_user_id=owner.id,
        status=TournamentStatus.draft,
    )
    db_session.add(tournament)
    await db_session.commit()
    await db_session.refresh(tournament)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=format,
        draw_settings=TournamentEventDrawSettings.for_draw_type(draw_type),
        max_players=64,
        entry_fee=Decimal("45"),
        timezone="America/Chicago",
        slot={"date": "2026-08-01", "start": "09:00", "end": "18:00"},
        match_settings={"rated": True, "length_games": 5},
        predicates=[],
        pools=with_table_aliases(tournament, [_DRAW_POOL_A, _DRAW_POOL_B]),
    )
    db_session.add(event)
    await db_session.commit()
    await db_session.refresh(event)
    db_session.add_all(
        [
            TournamentEntry(
                event_id=event.id,
                user_id=(await make_user(db_session, "draw-e-" + uuid.uuid4().hex)).id,
                status=TournamentEntryStatus.entered,
                seed=n,
            )
            for n in range(1, entrants + 1)
        ]
    )
    await db_session.commit()
    return tournament, event


async def test_build_cut_and_uncut_tools_are_registered(
    db_session: AsyncSession,
) -> None:
    """Both draw-write verbs are exposed as tools to an authenticated caller."""
    user = await make_user(db_session, "mcp-draw-listed")
    raw = await _mint(db_session, user)

    async with _mcp_client(raw) as client, client:
        names = {tool.name for tool in await client.list_tools()}
    assert {"build_cut", "uncut"} <= names


async def test_build_cut_returns_fixtures_visible_via_schedule_then_uncut_removes_them(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """An owner cuts a singles event's draw via ``build_cut``: the fixtures come back
    (4 entrants over 2 pools → one round-robin fixture per pool), they are visible via
    ``get_schedule``, and ``uncut`` then tears them down (``fixtures_remaining`` = 0 and
    the schedule shows ``[]``)."""
    owner = await make_user(db_session, "mcp-draw-owner")
    await grant_permissions(db_session, owner, [TOURNAMENT_VIEW])
    raw = await _mint(db_session, owner)
    tournament, event = await _seed_drawable_tournament(
        db_session, owner, default_league
    )
    event_id, tournament_id = str(event.id), str(tournament.id)

    async with _mcp_client(raw) as client, client:
        cut = await client.call_tool_mcp("build_cut", {"event_id": event_id})
        assert cut.isError is False
        assert cut.structuredContent is not None
        fixtures = cut.structuredContent["result"]
        assert len(fixtures) == 2
        pool_ids = {
            str(pool_id)
            for pool_id in (
                await db_session.execute(
                    select(TournamentEventPool.id).where(
                        TournamentEventPool.event_id == event.id
                    )
                )
            )
            .scalars()
            .all()
        }
        assert all(f["pool_id"] in pool_ids for f in fixtures)

        # The cut draw is visible through the schedule projection.
        schedule = await client.call_tool_mcp(
            "get_schedule", {"tournament_id": tournament_id}
        )
        assert schedule.structuredContent is not None
        group = schedule.structuredContent["events"][0]
        assert {f["id"] for f in group["fixtures"]} == {f["id"] for f in fixtures}

        # Un-cut tears the whole draw down.
        removed = await client.call_tool_mcp("uncut", {"event_id": event_id})
        assert removed.isError is False
        assert removed.structuredContent is not None
        assert removed.structuredContent["fixtures_remaining"] == 0
        assert removed.structuredContent["event_id"] == event_id
        assert removed.structuredContent["tournament_id"] == tournament_id

        # And the schedule now carries no fixtures for the event.
        after = await client.call_tool_mcp(
            "get_schedule", {"tournament_id": tournament_id}
        )
    assert after.structuredContent is not None
    assert after.structuredContent["events"][0]["fixtures"] == []


async def test_uncut_of_a_never_cut_draw_is_an_idempotent_ok(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Un-cutting an event that was never cut deletes nothing and still succeeds —
    ``fixtures_remaining`` is 0, not a ``ToolError`` (ADR-0786's idempotent DELETE)."""
    owner = await make_user(db_session, "mcp-uncut-noop-owner")
    raw = await _mint(db_session, owner)
    _, event = await _seed_drawable_tournament(db_session, owner, default_league)

    async with _mcp_client(raw) as client, client:
        removed = await client.call_tool_mcp("uncut", {"event_id": str(event.id)})
    assert removed.isError is False
    assert removed.structuredContent is not None
    assert removed.structuredContent["fixtures_remaining"] == 0


async def test_build_cut_non_owner_raises_tool_error(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A caller who is not the tournament's creator gets a ``ToolError`` — owner-gated
    by construction in the shared verb — and no draw is cut."""
    owner = await make_user(db_session, "mcp-draw-real-owner")
    _, event = await _seed_drawable_tournament(db_session, owner, default_league)

    outsider = await make_user(db_session, "mcp-draw-outsider")
    outsider_token = await _mint(db_session, outsider)

    async with _mcp_client(outsider_token) as client, client:
        with pytest.raises(ToolError, match="tournaments you created"):
            await client.call_tool("build_cut", {"event_id": str(event.id)})

    # Nothing was written.
    remaining = (
        (
            await db_session.execute(
                select(TournamentFixture).where(TournamentFixture.event_id == event.id)
            )
        )
        .scalars()
        .all()
    )
    assert remaining == []


async def test_build_cut_unknown_event_raises_tool_error(
    db_session: AsyncSession,
) -> None:
    """An event id that resolves to no event surfaces as a not-found ``ToolError``."""
    owner = await make_user(db_session, "mcp-draw-unknown")
    raw = await _mint(db_session, owner)
    unknown = str(uuid.uuid4())

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match=unknown):
            await client.call_tool("build_cut", {"event_id": unknown})


async def test_build_cut_played_draw_raises_tool_error(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Once the draw shows evidence of play (a fixture with a recorded winner), a
    re-cut is refused with a ``ToolError`` naming that the draw is under way, and the
    standing draw is left intact."""
    owner = await make_user(db_session, "mcp-draw-played-owner")
    raw = await _mint(db_session, owner)
    _, event = await _seed_drawable_tournament(db_session, owner, default_league)
    # Capture the id once, while the ORM object is fresh: the ``commit`` below expires
    # it, and touching ``event.id`` afterwards would fire a sync lazy-load
    # (MissingGreenlet) in async land.
    event_id = event.id

    # Cut a real draw first (own client block, closed before the DB write below — a
    # test ``db_session`` write interleaved inside an open MCP client block trips the
    # ASGI transport's greenlet context).
    async with _mcp_client(raw) as client, client:
        cut = await client.call_tool_mcp("build_cut", {"event_id": str(event_id)})
    assert cut.isError is False

    # Record a winner on one fixture — evidence of play. Read the ids off the fresh rows
    # BEFORE the commit for the same reason.
    fixtures = list(
        (
            await db_session.execute(
                select(TournamentFixture).where(TournamentFixture.event_id == event_id)
            )
        )
        .scalars()
        .all()
    )
    before = {f.id for f in fixtures}
    fixtures[0].winner_entry_id = fixtures[0].entry_a_id
    await db_session.commit()

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="under way"):
            await client.call_tool("build_cut", {"event_id": str(event_id)})

    # The standing draw is untouched — the refusal is asked before any delete.
    db_session.expire_all()
    still = (
        (
            await db_session.execute(
                select(TournamentFixture.id).where(
                    TournamentFixture.event_id == event_id
                )
            )
        )
        .scalars()
        .all()
    )
    assert set(still) == before


async def test_build_cut_non_singles_event_raises_readable_tool_error(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A doubles event can never be given a draw (ADR-0788): ``build_cut`` surfaces the
    ``NonSinglesDraw`` refusal as a readable ``ToolError`` naming the format, and writes
    nothing."""
    owner = await make_user(db_session, "mcp-draw-doubles-owner")
    raw = await _mint(db_session, owner)
    _, event = await _seed_drawable_tournament(
        db_session, owner, default_league, format=EventFormat.doubles
    )

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="singles events can"):
            await client.call_tool("build_cut", {"event_id": str(event.id)})

    remaining = (
        (
            await db_session.execute(
                select(TournamentFixture).where(TournamentFixture.event_id == event.id)
            )
        )
        .scalars()
        .all()
    )
    assert remaining == []


# ``test_build_cut_unsupported_draw_type_raises_readable_tool_error`` lived here. Its
# only subject was an ``rr-then-ko`` event — a draw type that is no longer a
# ``DrawType`` member (ADR "a draw type is a seeded row, and the enum holds only what
# runs"), and ``strategy_for`` is now total, so no event ``build_cut`` can be handed
# raises ``UnsupportedDrawType``. There is no live subject to re-point it at: the
# refusal that replaced it is asserted in ``test_tournaments`` (create-event 422) and
# ``test_draws`` (``strategy_for`` is total). The ``UnsupportedDrawType`` arm of
# ``_map_draw_refusal_tool_error`` has since been deleted as dead code — the test below
# is what covers the generic fallback a future raiser would now reach instead. The
# preview's own ``UnsupportedDrawType`` path is genuinely reachable — a tournament
# whose every event is a bracket or a swiss draw has nothing to preview — and keeps
# both its arm (``_map_preview_draw_error``) and its coverage in
# ``test_schedule_preview_snapshot``.


async def test_build_cut_a_draw_error_nobody_wrote_copy_for_refuses_without_leaking_it(
    db_session: AsyncSession,
    default_league: League,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A ``DrawError`` subclass this adapter has never heard of is still a designed
    ``ToolError`` — with a **generic** sentence, never the exception's own.

    The MCP twin of ``test_tournaments``'
    ``test_a_draw_error_nobody_wrote_copy_for_refuses_without_leaking_its_message``.
    ``_map_draw_refusal_tool_error`` matches on the errors that exist today and composes
    an agent-readable sentence for each; its fallback arm is what a *new* one hits, and
    the rule there is that a message written for a developer must not become the
    sentence an MCP client is handed.

    **The no-leak half is the point.** A ``DrawError`` raised deep in a strategy can
    carry a table name, a pool ref, a column — internals that are a bug report when they
    stay in the log and a defect the moment they reach a client. So the invented error's
    message is deliberately full of them and the assertion is that *none* of it survives
    into the ``ToolError``.

    The only honest way to raise the base error is to invent the subclass the domain
    does not have yet — which is precisely the future this arm exists for. Patched at
    the same seam the HTTP test uses (``app.tournament_draw_service.cut_draw``, the
    domain core both surfaces share), so what is under test is the MCP *adapter*, not a
    second copy of the domain.
    """
    owner = await make_user(db_session, "mcp-draw-unknown-error-owner")
    raw = await _mint(db_session, owner)
    _, event = await _seed_drawable_tournament(db_session, owner, default_league)

    # Every fragment of this is something a client must never be shown.
    leaked = (
        "tournament_fixtures.pool_id='p-a' has a NULL seat at (round=2, position=1)"
    )

    class SwissRoundNotSettled(DrawError):
        """The DrawError of some slice that has not been written."""

    async def _raise_an_unknown_draw_error(
        db: AsyncSession, event: TournamentEvent
    ) -> None:
        raise SwissRoundNotSettled(leaked)

    monkeypatch.setattr(
        "app.tournament_draw_service.cut_draw", _raise_an_unknown_draw_error
    )

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError) as caught:
            await client.call_tool("build_cut", {"event_id": str(event.id)})

    message = str(caught.value)
    assert "This event's draw can't be cut as the event stands." in message
    # Asserted fragment by fragment, not just as the whole sentence: a partial leak
    # (the table name alone) is the same defect as the whole message.
    assert leaked not in message
    for internals in ("tournament_fixtures", "pool_id", "NULL seat", "round=2"):
        assert internals not in message, (
            f"the refusal leaked {internals!r} from a DrawError nobody wrote copy "
            f"for: {message!r}"
        )

    # The refusal wrote nothing: the verb rolled back, as the other draw-refusal
    # tools' tests assert too.
    remaining = (
        (
            await db_session.execute(
                select(TournamentFixture).where(TournamentFixture.event_id == event.id)
            )
        )
        .scalars()
        .all()
    )
    assert remaining == []


async def test_uncut_non_owner_raises_tool_error(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """``uncut`` is owner-gated by construction too: a non-owner gets a ``ToolError``
    and no draw is removed."""
    owner = await make_user(db_session, "mcp-uncut-owner")
    owner_token = await _mint(db_session, owner)
    _, event = await _seed_drawable_tournament(db_session, owner, default_league)

    # Owner cuts, so there is a real draw a non-owner might try to remove.
    async with _mcp_client(owner_token) as client, client:
        assert (
            await client.call_tool_mcp("build_cut", {"event_id": str(event.id)})
        ).isError is False

    outsider = await make_user(db_session, "mcp-uncut-outsider")
    outsider_token = await _mint(db_session, outsider)
    async with _mcp_client(outsider_token) as client, client:
        with pytest.raises(ToolError, match="tournaments you created"):
            await client.call_tool("uncut", {"event_id": str(event.id)})


# ----- request_schedule_solve tool -----------------------------------------


async def test_request_schedule_solve_is_registered(
    db_session: AsyncSession,
) -> None:
    """The solve write verb is exposed as a tool to an authenticated caller."""
    user = await make_user(db_session, "mcp-solve-listed")
    raw = await _mint(db_session, user)

    async with _mcp_client(raw) as client, client:
        names = {tool.name for tool in await client.list_tools()}
    assert "request_schedule_solve" in names


async def test_request_schedule_solve_owner_queues_a_run(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """An owner runs the scheduler for a tournament with a cut draw: the tool returns
    a ledger row for the run (``queued``/``running``, its ``verdict`` not yet known —
    the solve is async, its verdict read back later via ``get_schedule``), and that
    row is durable on the tournament's solve ledger."""
    owner = await make_user(db_session, "mcp-solve-owner")
    await grant_permissions(db_session, owner, [TOURNAMENT_VIEW])
    raw = await _mint(db_session, owner)
    tournament, event = await _seed_drawable_tournament(
        db_session, owner, default_league
    )
    tournament_id = str(tournament.id)

    async with _mcp_client(raw) as client, client:
        # Cut a draw first, so the tournament has fixtures the scheduler can place.
        assert (
            await client.call_tool_mcp("build_cut", {"event_id": str(event.id)})
        ).isError is False
        result = await client.call_tool_mcp(
            "request_schedule_solve", {"tournament_id": tournament_id}
        )

    assert result.isError is False
    body = result.structuredContent
    assert body is not None
    # An async run: the returned row is the queued/running ledger row, its verdict
    # (and placement counts) not yet known — read back later via get_schedule.
    assert body["status"] in {"queued", "running"}
    assert body["verdict"] is None

    # The run is a real, durable row on the tournament's solve ledger.
    db_session.expire_all()
    persisted = (
        await db_session.execute(
            select(ScheduleSolve).where(
                ScheduleSolve.id == uuid.UUID(body["id"]),
                ScheduleSolve.tournament_id == uuid.UUID(tournament_id),
            )
        )
    ).scalar_one()
    assert persisted.status in {
        ScheduleSolveStatus.queued,
        ScheduleSolveStatus.running,
    }


async def test_request_schedule_solve_without_a_drawn_event_raises_tool_error(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A tournament whose events have no cut draw has nothing to schedule: the owner
    gets a ``ToolError`` telling them to ``build_cut`` a draw first, and no solve is
    queued (``NoDrawnEventsError``)."""
    owner = await make_user(db_session, "mcp-solve-undrawn-owner")
    raw = await _mint(db_session, owner)
    tournament, _ = await _seed_drawable_tournament(db_session, owner, default_league)
    tournament_id = tournament.id

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="build_cut"):
            await client.call_tool(
                "request_schedule_solve", {"tournament_id": str(tournament_id)}
            )

    # Nothing was queued — the ledger stays empty.
    db_session.expire_all()
    solves = (
        (
            await db_session.execute(
                select(ScheduleSolve).where(
                    ScheduleSolve.tournament_id == tournament_id
                )
            )
        )
        .scalars()
        .all()
    )
    assert solves == []


async def test_request_schedule_solve_non_owner_raises_tool_error(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Running the scheduler is owner-gated by construction in the shared verb: a
    caller who is not the tournament's creator gets a ``ToolError`` (judged before the
    draw state is even looked at), and no solve is queued."""
    owner = await make_user(db_session, "mcp-solve-real-owner")
    tournament, _ = await _seed_drawable_tournament(db_session, owner, default_league)
    tournament_id = tournament.id

    outsider = await make_user(db_session, "mcp-solve-outsider")
    outsider_token = await _mint(db_session, outsider)
    async with _mcp_client(outsider_token) as client, client:
        with pytest.raises(ToolError, match="tournaments you created"):
            await client.call_tool(
                "request_schedule_solve", {"tournament_id": str(tournament_id)}
            )

    db_session.expire_all()
    solves = (
        (
            await db_session.execute(
                select(ScheduleSolve).where(
                    ScheduleSolve.tournament_id == tournament_id
                )
            )
        )
        .scalars()
        .all()
    )
    assert solves == []


# ----- preview_schedule tool (preview_mcp) ---------------------------------
#
# The synchronous MCP preview adapter (chore 1d): enqueue the ephemeral preview,
# wait internally, and return the whole ``PreviewResult`` in ONE call. The tests
# are named ``*preview_mcp*`` so ``pytest -k preview_mcp`` selects exactly them.


@pytest.fixture
def sync_preview_queue(monkeypatch: pytest.MonkeyPatch) -> Queue:
    """A SYNCHRONOUS (``is_async=False``) RQ queue on fakeredis standing in for the
    real ``preview`` queue: the DB-blind preview job runs INLINE at enqueue time and
    its ``PreviewResult`` lands in the job's Redis result, exactly as a deployed
    worker would leave it — so the tool's internal ``wait_for_preview`` reads back a
    finished job on its first poll and returns the result in one call. Both the
    enqueue verb and the wait go through this same monkeypatched
    ``get_preview_queue``, so they share the one fakeredis connection."""
    connection = fakeredis.FakeStrictRedis()
    q = Queue(queue_module.PREVIEW_QUEUE, connection=connection, is_async=False)
    monkeypatch.setattr(queue_module, "get_preview_queue", lambda: q)
    return q


async def _seed_previewable_tournament(
    db_session: AsyncSession,
    owner: User,
    league: League,
    *,
    status: TournamentStatus = TournamentStatus.draft,
    draw_type: DrawType = DrawType.round_robin,
) -> tuple[Tournament, TournamentEvent]:
    """A tournament owned by ``owner`` with one SMALL round-robin singles event
    (capped at four, one pool over both tables), seeded directly. No
    ``TournamentEntry`` rows — a preview draws a SYNTHETIC field, so the inline solve
    is a tiny four-player round-robin. ``draw_type`` is knobbed to reach the
    un-schedulable refusal (a non-round-robin event)."""
    tournament = Tournament(
        name="MCP Preview Cup",
        address={
            "venue": "Berkeley TT Club",
            "street": "2727 Milvia St",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94703",
            "country": "USA",
            "latitude": 37.8703,
            "longitude": -122.2731,
        },
        tables=venue_tables(("Table 1", "A"), ("Table 2", "A")),
        league_id=league.id,
        created_by_user_id=owner.id,
        status=status,
    )
    db_session.add(tournament)
    await db_session.commit()
    await db_session.refresh(tournament)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(draw_type),
        max_players=4,
        entry_fee=Decimal("0"),
        slot={"date": "2030-01-01", "start": "09:00", "end": "17:00"},
        match_settings={"rated": False, "length_games": 3},
        predicates=[],
        timezone="America/Los_Angeles",
        pools=with_table_aliases(
            tournament,
            [
                {
                    "name": "Pool A",
                    "slot": {
                        "date": "2030-01-01",
                        "start": "09:00",
                        "end": "17:00",
                    },
                    "table_ids": ["t1", "t2"],
                }
            ],
        ),
    )
    db_session.add(event)
    await db_session.commit()
    await db_session.refresh(event)
    return tournament, event


async def test_preview_mcp_tool_is_registered(db_session: AsyncSession) -> None:
    """The synchronous preview verb is exposed as a tool to an authenticated
    caller."""
    user = await make_user(db_session, "preview-mcp-listed")
    raw = await _mint(db_session, user)

    async with _mcp_client(raw) as client, client:
        names = {tool.name for tool in await client.list_tools()}
    assert "preview_schedule" in names


async def test_preview_mcp_owner_gets_result_synchronously(
    db_session: AsyncSession,
    default_league: League,
    sync_preview_queue: Queue,
) -> None:
    """An owner driving ``preview_schedule`` on a ``draft`` tournament gets the whole
    ``PreviewResult`` back in ONE call — a fitting verdict, the estimated duration,
    the counts (four synthetic entrants over one pool → six round-robin matches), a
    per-event breakdown, and the always-present honest-notes strip. No poll."""
    owner = await make_user(db_session, "preview-mcp-owner")
    raw = await _mint(db_session, owner)
    tournament, _ = await _seed_previewable_tournament(
        db_session, owner, default_league
    )

    async with _mcp_client(raw) as client, client:
        result = await client.call_tool_mcp(
            "preview_schedule", {"tournament_id": str(tournament.id)}
        )

    assert result.isError is False
    body = result.structuredContent
    assert body is not None
    # Verdict-first: the tiny four-player day fits, computed by the real engine.
    assert body["verdict"] in ("optimal", "feasible")
    assert body["fits"] is True
    # Estimated duration is a real makespan (a plan was placed), and the counts come
    # straight off the instant draw.
    assert body["estimated_duration_min"] is not None
    assert body["total_matches"] == 6
    # A per-event breakdown for the one event, and the honest-notes strip.
    assert len(body["events"]) == 1
    assert body["events"][0]["matches"] == 6
    assert body["notes"]


async def test_preview_mcp_overrides_size_the_synthetic_field(
    db_session: AsyncSession,
    default_league: League,
    sync_preview_queue: Queue,
) -> None:
    """The optional per-event ``overrides`` argument sizes the synthetic field: six
    entrants draws fifteen round-robin matches, not the capped four's six — and the
    result still comes back synchronously in one call."""
    owner = await make_user(db_session, "preview-mcp-override-owner")
    raw = await _mint(db_session, owner)
    tournament, event = await _seed_previewable_tournament(
        db_session, owner, default_league
    )

    async with _mcp_client(raw) as client, client:
        result = await client.call_tool_mcp(
            "preview_schedule",
            {
                "tournament_id": str(tournament.id),
                "overrides": {str(event.id): 6},
            },
        )

    assert result.isError is False
    body = result.structuredContent
    assert body is not None
    assert body["total_matches"] == 15
    assert body["events"][0]["matches"] == 15


async def test_preview_mcp_unsupported_draw_type_raises_tool_error(
    db_session: AsyncSession,
    default_league: League,
    sync_preview_queue: Queue,
) -> None:
    """A tournament whose only event is one the preview lays out nothing of (here
    single-elim) is refused with an actionable ``ToolError`` — never an empty result
    an agent would read as "it fits".

    The sentence still names round-robin, because that is the actionable half: such an
    event beside a round-robin one is skipped now, not refused, and the preview covers
    the rest of the day. What it must NOT say any more is that the scheduler cannot
    place a bracket — a live solve does (ADR "a pool restricts scheduling, it does not
    enable it"). The refusal happens at snapshot build, before anything is queued."""
    owner = await make_user(db_session, "preview-mcp-ko-owner")
    raw = await _mint(db_session, owner)
    tournament, _ = await _seed_previewable_tournament(
        db_session, owner, default_league, draw_type=DrawType.single_elim
    )

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="round-robin") as caught:
            await client.call_tool(
                "preview_schedule", {"tournament_id": str(tournament.id)}
            )

    message = str(caught.value)
    # The draw type is named off the error's structural ``draw_type``, and the blame
    # lands on the preview rather than on a scheduler that would now place it.
    assert DrawType.single_elim.value in message, message
    assert "can be previewed" in message, message
    # Pin a phrase only the CURRENT copy carries. The three assertions above are all
    # satisfied by the sentence this arc deleted ("…has no schedule generator — only
    # round-robin draws can be previewed…"), which carried "round-robin",
    # "single-elim" and "can be previewed" too — so on their own they would stay green
    # through a revert to copy that blames a scheduler now placing brackets. The HTTP
    # twin discriminates on "cannot be previewed"; this is the MCP arm's equivalent.
    assert "No event of this tournament" in message, message
    assert "no schedule generator" not in message, message

    # Nothing was queued — the refusal is raised before the enqueue.
    assert sync_preview_queue.jobs == []


async def test_preview_mcp_non_owner_raises_tool_error(
    db_session: AsyncSession,
    default_league: League,
    sync_preview_queue: Queue,
) -> None:
    """A preview is owner-gated: a caller who is not the tournament's creator gets a
    ``ToolError``, and nothing is queued."""
    owner = await make_user(db_session, "preview-mcp-real-owner")
    tournament, _ = await _seed_previewable_tournament(
        db_session, owner, default_league
    )

    outsider = await make_user(db_session, "preview-mcp-outsider")
    outsider_token = await _mint(db_session, outsider)
    async with _mcp_client(outsider_token) as client, client:
        with pytest.raises(ToolError, match="tournaments you created"):
            await client.call_tool(
                "preview_schedule", {"tournament_id": str(tournament.id)}
            )

    assert sync_preview_queue.jobs == []


async def test_preview_mcp_post_live_tournament_raises_tool_error(
    db_session: AsyncSession,
    default_league: League,
    sync_preview_queue: Queue,
) -> None:
    """A preview answers a pre-registration question, so a ``live`` tournament is
    refused with a status-aware ``ToolError`` (draft/published only), and nothing is
    queued."""
    owner = await make_user(db_session, "preview-mcp-live-owner")
    raw = await _mint(db_session, owner)
    tournament, _ = await _seed_previewable_tournament(
        db_session, owner, default_league, status=TournamentStatus.live
    )

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="draft or published"):
            await client.call_tool(
                "preview_schedule", {"tournament_id": str(tournament.id)}
            )

    assert sync_preview_queue.jobs == []


async def test_preview_mcp_unknown_tournament_raises_tool_error(
    db_session: AsyncSession,
    sync_preview_queue: Queue,
) -> None:
    """An id that matches no tournament surfaces as a not-found ``ToolError`` at the
    caller."""
    owner = await make_user(db_session, "preview-mcp-unknown-owner")
    raw = await _mint(db_session, owner)
    unknown = str(uuid.uuid4())

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match=unknown):
            await client.call_tool("preview_schedule", {"tournament_id": unknown})


# ----- create_tournament tool ----------------------------------------------


async def test_create_tournament_is_registered(db_session: AsyncSession) -> None:
    """The create verb is exposed as a tool to an authenticated caller."""
    user = await make_user(db_session, "mcp-create-listed")
    raw = await _mint(db_session, user)

    async with _mcp_client(raw) as client, client:
        tools = await client.list_tools()
    assert "create_tournament" in {tool.name for tool in tools}


async def test_create_tournament_makes_the_caller_the_creator(
    db_session: AsyncSession,
) -> None:
    """A bearer-authed caller creates a tournament via the tool: the returned view
    names the caller as creator (and owner — ``can_edit`` true), it is born a
    ``draft``, and the row is committed and readable back."""
    me = await make_user(db_session, "mcp-create-owner")
    me_id = me.id
    await grant_permissions(db_session, me, [TOURNAMENT_CREATE])
    raw = await _mint(db_session, me)

    async with _mcp_client(raw) as client, client:
        result = await client.call_tool_mcp(
            "create_tournament", {"payload": _tournament_payload()}
        )
        assert result.isError is False
        body = result.structuredContent
        assert body is not None
        assert body["created_by_user_id"] == str(me_id)
        assert body["can_edit"] is True
        assert body["name"] == _tournament_payload()["name"]
        assert body["status"] == "draft"
        tournament_id = body["id"]

    # Durable in the database, owned by the caller.
    db_session.expire_all()
    persisted = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == uuid.UUID(tournament_id))
        )
    ).scalar_one()
    assert persisted.created_by_user_id == me_id


async def test_create_tournament_unknown_league_raises_tool_error(
    db_session: AsyncSession,
) -> None:
    """A ``league_id`` that names no league is refused (the STRICT resolution),
    surfacing as a ``ToolError`` rather than a silent fall back to the default."""
    me = await make_user(db_session, "mcp-create-bad-league")
    me_id = me.id
    await grant_permissions(db_session, me, [TOURNAMENT_CREATE])
    raw = await _mint(db_session, me)
    payload = {**_tournament_payload(), "league_id": str(uuid.uuid4())}

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="No league found"):
            await client.call_tool("create_tournament", {"payload": payload})

    # Nothing was created.
    db_session.expire_all()
    assert (
        await db_session.execute(
            select(Tournament).where(Tournament.created_by_user_id == me_id)
        )
    ).scalar_one_or_none() is None


async def test_create_tournament_without_permission_raises_tool_error(
    db_session: AsyncSession,
) -> None:
    """A caller who does not hold ``tournament.create`` is refused before anything is
    written — the same gate the HTTP ``require_create`` dependency enforces, so a
    mounted tool grants an agent nothing its user lacks over HTTP."""
    me = await make_user(db_session, "mcp-create-noperm")
    me_id = me.id
    raw = await _mint(db_session, me)

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="permission to create tournaments"):
            await client.call_tool(
                "create_tournament", {"payload": _tournament_payload()}
            )

    # Nothing was created.
    db_session.expire_all()
    assert (
        await db_session.execute(
            select(Tournament).where(Tournament.created_by_user_id == me_id)
        )
    ).scalar_one_or_none() is None


async def test_create_tournament_unresolvable_address_raises_tool_error(
    db_session: AsyncSession,
) -> None:
    """A venue address the geocoder cannot resolve (the ``FakeGeocoder``
    ``__unresolvable__`` sentinel) surfaces as a ``ToolError`` naming the same
    machine-readable code the HTTP surface answers with (``address_not_geocodable``),
    and nothing is created — the coordinate NOT NULL invariant holds on the MCP path
    too (ADR "an unresolvable address is a 422 at the boundary")."""
    me = await make_user(db_session, "mcp-create-bad-address")
    me_id = me.id
    await grant_permissions(db_session, me, [TOURNAMENT_CREATE])
    raw = await _mint(db_session, me)
    payload: dict[str, object] = {
        **_tournament_payload(),
        "address": {
            "venue": "__unresolvable__",
            "street": "2727 Milvia St",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94703",
            "country": "USA",
        },
    }

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="address_not_geocodable"):
            await client.call_tool("create_tournament", {"payload": payload})

    # Nothing was created — the geocode failed before the write.
    db_session.expire_all()
    assert (
        await db_session.execute(
            select(Tournament).where(Tournament.created_by_user_id == me_id)
        )
    ).scalar_one_or_none() is None


# ----- delete_tournament tool ----------------------------------------------


async def test_delete_tournament_is_registered(db_session: AsyncSession) -> None:
    """The destructive delete verb is exposed as a tool to an authenticated caller."""
    user = await make_user(db_session, "mcp-delete-listed")
    raw = await _mint(db_session, user)

    async with _mcp_client(raw) as client, client:
        tools = await client.list_tools()
    assert "delete_tournament" in {tool.name for tool in tools}


async def test_delete_tournament_owner_removes_it_and_confirms(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A bearer-authed OWNER deletes a tournament via the tool: it confirms the
    deleted id, and the row is gone from the database."""
    owner = await make_user(db_session, "mcp-delete-owner")
    raw = await _mint(db_session, owner)
    tournament = await _seed_owned_tournament(
        db_session, owner, default_league, "Deletable Cup", TournamentStatus.draft
    )
    tournament_id = tournament.id

    async with _mcp_client(raw) as client, client:
        result = await client.call_tool_mcp(
            "delete_tournament", {"tournament_id": str(tournament_id)}
        )
        assert result.isError is False
        assert result.structuredContent is not None
        assert result.structuredContent["tournament_id"] == str(tournament_id)

    # The row is gone.
    db_session.expire_all()
    assert (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament_id)
        )
    ).scalar_one_or_none() is None


async def test_delete_tournament_non_owner_raises_tool_error_and_deletes_nothing(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A caller who is not the tournament's creator gets a ``ToolError`` (owner-gated
    in the shared verb), and the tournament is left untouched."""
    owner = await make_user(db_session, "mcp-delete-guard-owner")
    tournament = await _seed_owned_tournament(
        db_session, owner, default_league, "Not Yours Cup", TournamentStatus.draft
    )
    tournament_id = tournament.id

    outsider = await make_user(db_session, "mcp-delete-outsider")
    outsider_token = await _mint(db_session, outsider)

    async with _mcp_client(outsider_token) as client, client:
        with pytest.raises(ToolError, match="only delete tournaments you created"):
            await client.call_tool(
                "delete_tournament", {"tournament_id": str(tournament_id)}
            )

    # Nothing was deleted.
    db_session.expire_all()
    assert (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament_id)
        )
    ).scalar_one_or_none() is not None


async def test_delete_tournament_unknown_id_raises_tool_error(
    db_session: AsyncSession,
) -> None:
    """An id that matches no tournament surfaces as a not-found ``ToolError`` — the
    404 judged before the 403, so a non-owner never learns whether an id existed."""
    me = await make_user(db_session, "mcp-delete-unknown")
    raw = await _mint(db_session, me)
    unknown = str(uuid.uuid4())

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match=unknown):
            await client.call_tool("delete_tournament", {"tournament_id": unknown})


# ----- transition_tournament tool ------------------------------------------


async def test_transition_tournament_is_registered(db_session: AsyncSession) -> None:
    """The one generic lifecycle verb is exposed as a tool to an authenticated
    caller — not three semantic publish/go_live/archive tools."""
    user = await make_user(db_session, "mcp-tx-listed")
    raw = await _mint(db_session, user)

    async with _mcp_client(raw) as client, client:
        tools = await client.list_tools()
    assert "transition_tournament" in {tool.name for tool in tools}


async def test_transition_tournament_owner_walks_the_whole_lifecycle(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """An owner drives a tournament with a cut draw all the way through the lifecycle
    via the one generic tool: draft → published → live → archived. Going live
    materializes every fixture into a real match and queues the ``go_live`` solve."""
    owner = await make_user(db_session, "mcp-tx-owner")
    raw = await _mint(db_session, owner)
    tournament, event = await _seed_drawable_tournament(
        db_session, owner, default_league
    )
    tournament_id, event_id = tournament.id, event.id
    # Cut the draw while still a draft (drawing is not status-tied) — DB writes done
    # OUTSIDE the MCP client block (an interleaved write trips the ASGI greenlet
    # context). No entrant arrives after, so the draw stays current for go-live.
    await cut_draw(db_session, event)
    await db_session.commit()

    async with _mcp_client(raw) as client, client:
        published = await client.call_tool_mcp(
            "transition_tournament",
            {"tournament_id": str(tournament_id), "to": "published"},
        )
        assert published.isError is False
        assert published.structuredContent is not None
        assert published.structuredContent["status"] == "published"
        assert published.structuredContent["can_edit"] is True

        live = await client.call_tool_mcp(
            "transition_tournament",
            {"tournament_id": str(tournament_id), "to": "live"},
        )
        assert live.isError is False
        assert live.structuredContent is not None
        assert live.structuredContent["status"] == "live"

        archived = await client.call_tool_mcp(
            "transition_tournament",
            {"tournament_id": str(tournament_id), "to": "archived"},
        )
        assert archived.isError is False
        assert archived.structuredContent is not None
        assert archived.structuredContent["status"] == "archived"

    # Going live materialized every fixture into a real match…
    db_session.expire_all()
    fixtures = list(
        (
            await db_session.execute(
                select(TournamentFixture).where(TournamentFixture.event_id == event_id)
            )
        )
        .scalars()
        .all()
    )
    assert fixtures
    assert all(f.match_id is not None for f in fixtures)
    # …and queued exactly one solve, with the go_live trigger.
    solves = list(
        (
            await db_session.execute(
                select(ScheduleSolve).where(
                    ScheduleSolve.tournament_id == tournament_id
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(solves) == 1
    assert solves[0].trigger is ScheduleSolveTrigger.go_live
    assert solves[0].status is ScheduleSolveStatus.queued


async def test_transition_tournament_non_owner_raises_tool_error(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Transitioning is owner-gated by construction in the shared verb: a caller who is
    not the creator gets a ``ToolError`` and the status is left unchanged."""
    owner = await make_user(db_session, "mcp-tx-real-owner")
    tournament = await _seed_owned_tournament(
        db_session, owner, default_league, "Not Yours Cup", TournamentStatus.draft
    )
    tournament_id = tournament.id

    outsider = await make_user(db_session, "mcp-tx-outsider")
    outsider_token = await _mint(db_session, outsider)

    async with _mcp_client(outsider_token) as client, client:
        with pytest.raises(ToolError, match="transition tournaments you created"):
            await client.call_tool(
                "transition_tournament",
                {"tournament_id": str(tournament_id), "to": "published"},
            )

    # Untouched.
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament_id)
        )
    ).scalar_one()
    assert row.status is TournamentStatus.draft


async def test_transition_tournament_illegal_edge_raises_tool_error(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A draft → live jump skips the ``published`` stage — an illegal edge, surfaced as
    a ``ToolError`` naming both ends, and the tournament stays a draft."""
    owner = await make_user(db_session, "mcp-tx-illegal-owner")
    raw = await _mint(db_session, owner)
    tournament = await _seed_owned_tournament(
        db_session, owner, default_league, "Skip Cup", TournamentStatus.draft
    )
    tournament_id = tournament.id

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="cannot be moved to live"):
            await client.call_tool(
                "transition_tournament",
                {"tournament_id": str(tournament_id), "to": "live"},
            )

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament_id)
        )
    ).scalar_one()
    assert row.status is TournamentStatus.draft


async def test_transition_tournament_go_live_without_a_draw_raises_tool_error(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Going live with an event that has no cut draw is refused with a ``ToolError``
    naming the event (the go-live precondition), and the tournament stays published."""
    owner = await make_user(db_session, "mcp-tx-nodraw-owner")
    raw = await _mint(db_session, owner)
    tournament, _event = await _seed_drawable_tournament(
        db_session, owner, default_league
    )
    tournament_id = tournament.id
    # Move it to published directly (no draw cut), so only the go-live precondition is
    # left to trip.
    tournament.status = TournamentStatus.published
    await db_session.commit()

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="no draw yet"):
            await client.call_tool(
                "transition_tournament",
                {"tournament_id": str(tournament_id), "to": "live"},
            )

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament_id)
        )
    ).scalar_one()
    assert row.status is TournamentStatus.published


async def test_transition_tournament_unknown_id_raises_tool_error(
    db_session: AsyncSession,
) -> None:
    """An id that matches no tournament surfaces as a not-found ``ToolError`` — the 404
    judged before the 403, so a non-owner never learns whether an id existed."""
    me = await make_user(db_session, "mcp-tx-unknown")
    raw = await _mint(db_session, me)
    unknown = str(uuid.uuid4())

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match=unknown):
            await client.call_tool(
                "transition_tournament",
                {"tournament_id": unknown, "to": "published"},
            )


# ----- create_event / delete_event tools -----------------------------------


async def _seed_event(db: AsyncSession, tournament: Tournament) -> TournamentEvent:
    """Insert one event directly under ``tournament`` (committed), so a delete test has
    a target without going through the create tool first."""
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Existing Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.round_robin),
        max_players=None,
        entry_fee=Decimal("0.00"),
        timezone="America/Chicago",
        slot={"date": "2026-08-01", "start": "09:00", "end": "17:00"},
        match_settings={"rated": False, "length_games": 3},
        predicates=[],
        pools=[],
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    return event


async def test_create_event_is_registered(db_session: AsyncSession) -> None:
    """The event-authoring verb is exposed as a tool to an authenticated caller."""
    user = await make_user(db_session, "mcp-create-event-listed")
    raw = await _mint(db_session, user)

    async with _mcp_client(raw) as client, client:
        tools = await client.list_tools()
    assert "create_event" in {tool.name for tool in tools}


async def test_delete_event_is_registered(db_session: AsyncSession) -> None:
    """The destructive event-delete verb is exposed as a tool to an authenticated
    caller."""
    user = await make_user(db_session, "mcp-delete-event-listed")
    raw = await _mint(db_session, user)

    async with _mcp_client(raw) as client, client:
        tools = await client.list_tools()
    assert "delete_event" in {tool.name for tool in tools}


async def test_create_event_owner_adds_it_and_it_persists(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A bearer-authed OWNER adds an event via the tool: the returned view names the
    event under its tournament, and the row is committed and readable back. Owner-only
    — no ``tournament.create``-style grant is required (or checked)."""
    owner = await make_user(db_session, "mcp-create-event-owner")
    raw = await _mint(db_session, owner)
    tournament = await _seed_owned_tournament(
        db_session, owner, default_league, "Eventful Cup", TournamentStatus.draft
    )
    tournament_id = tournament.id

    async with _mcp_client(raw) as client, client:
        result = await client.call_tool_mcp(
            "create_event",
            {"tournament_id": str(tournament_id), "payload": _event_payload()},
        )
        assert result.isError is False
        body = result.structuredContent
        assert body is not None
        assert body["tournament_id"] == str(tournament_id)
        assert body["name"] == "Open Singles"
        event_id = body["id"]

    # Durable in the database, under the tournament.
    db_session.expire_all()
    persisted = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == uuid.UUID(event_id))
        )
    ).scalar_one()
    assert persisted.tournament_id == tournament_id
    assert persisted.match_settings == {"rated": True, "length_games": 5}


async def test_create_event_non_owner_raises_tool_error_and_writes_nothing(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Adding an event is owner-gated in the shared verb: a caller who is not the
    tournament's creator gets a ``ToolError`` and no event is written."""
    owner = await make_user(db_session, "mcp-create-event-guard-owner")
    tournament = await _seed_owned_tournament(
        db_session, owner, default_league, "Not Yours Cup", TournamentStatus.draft
    )
    tournament_id = tournament.id

    outsider = await make_user(db_session, "mcp-create-event-outsider")
    outsider_token = await _mint(db_session, outsider)

    async with _mcp_client(outsider_token) as client, client:
        with pytest.raises(ToolError, match="add events to tournaments you created"):
            await client.call_tool(
                "create_event",
                {"tournament_id": str(tournament_id), "payload": _event_payload()},
            )

    # Nothing was created.
    db_session.expire_all()
    assert (
        await db_session.execute(
            select(TournamentEvent).where(
                TournamentEvent.tournament_id == tournament_id
            )
        )
    ).scalar_one_or_none() is None


async def test_create_event_unknown_tournament_raises_tool_error(
    db_session: AsyncSession,
) -> None:
    """An id that matches no tournament surfaces as a not-found ``ToolError`` — the 404
    judged before the 403, so a non-owner never learns whether an id existed."""
    me = await make_user(db_session, "mcp-create-event-unknown")
    raw = await _mint(db_session, me)
    unknown = str(uuid.uuid4())

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match=unknown):
            await client.call_tool(
                "create_event",
                {"tournament_id": unknown, "payload": _event_payload()},
            )


async def test_delete_event_owner_removes_it_and_confirms(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A bearer-authed OWNER deletes an event via the tool: it confirms the deleted
    tournament + event ids, and the row is gone from the database."""
    owner = await make_user(db_session, "mcp-delete-event-owner")
    raw = await _mint(db_session, owner)
    tournament = await _seed_owned_tournament(
        db_session,
        owner,
        default_league,
        "Deletable Events Cup",
        TournamentStatus.draft,
    )
    event = await _seed_event(db_session, tournament)
    tournament_id, event_id = tournament.id, event.id

    async with _mcp_client(raw) as client, client:
        result = await client.call_tool_mcp(
            "delete_event",
            {"tournament_id": str(tournament_id), "event_id": str(event_id)},
        )
        assert result.isError is False
        assert result.structuredContent is not None
        assert result.structuredContent["tournament_id"] == str(tournament_id)
        assert result.structuredContent["event_id"] == str(event_id)

    # The row is gone.
    db_session.expire_all()
    assert (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one_or_none() is None


async def test_delete_event_non_owner_raises_tool_error_and_deletes_nothing(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A caller who is not the tournament's creator gets a ``ToolError`` (owner-gated
    in the shared verb), and the event is left untouched."""
    owner = await make_user(db_session, "mcp-delete-event-guard-owner")
    tournament = await _seed_owned_tournament(
        db_session, owner, default_league, "Guarded Events Cup", TournamentStatus.draft
    )
    event = await _seed_event(db_session, tournament)
    tournament_id, event_id = tournament.id, event.id

    outsider = await make_user(db_session, "mcp-delete-event-outsider")
    outsider_token = await _mint(db_session, outsider)

    async with _mcp_client(outsider_token) as client, client:
        with pytest.raises(
            ToolError, match="delete events from tournaments you created"
        ):
            await client.call_tool(
                "delete_event",
                {"tournament_id": str(tournament_id), "event_id": str(event_id)},
            )

    # Nothing was deleted.
    db_session.expire_all()
    assert (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one_or_none() is not None


async def test_delete_event_unknown_event_raises_tool_error(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The tournament is owned, but names no such event — a not-found ``ToolError`` on
    the event, judged after the tournament's 404/403."""
    owner = await make_user(db_session, "mcp-delete-event-unknown")
    raw = await _mint(db_session, owner)
    tournament = await _seed_owned_tournament(
        db_session, owner, default_league, "Empty Events Cup", TournamentStatus.draft
    )
    unknown_event = str(uuid.uuid4())

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match=unknown_event):
            await client.call_tool(
                "delete_event",
                {
                    "tournament_id": str(tournament.id),
                    "event_id": unknown_event,
                },
            )


# ----- update_event tool ---------------------------------------------------


async def _seed_cut_event(db: AsyncSession, tournament: Tournament) -> TournamentEvent:
    """Seed an event carrying one pool AND a fixture, so ``event_has_draw`` is True and
    the two freezes are live — the target for the frozen-change ToolError round trip."""
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Cut Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.round_robin),
        max_players=None,
        entry_fee=Decimal("0.00"),
        timezone="America/Chicago",
        slot={"date": "2026-08-01", "start": "09:00", "end": "17:00"},
        match_settings={"rated": False, "length_games": 3},
        predicates=[],
        pools=event_pools(
            [
                {
                    "name": "Pool A",
                    "slot": {"date": "2026-08-01", "start": "09:00", "end": "12:30"},
                    # No tables: this tournament is seeded without a catalogue, and a
                    # reservation is a row foreign-keyed to a real one (ADR 20260801).
                    # Nothing here is about the venue — the target is the draw-type
                    # freeze.
                    "table_ids": [],
                }
            ],
        ),
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    fixture = TournamentFixture(
        event_id=event.id,
        pool_id=event.pools[0].id,
        round=1,
        position=1,
    )
    db.add(fixture)
    await db.commit()
    return event


async def test_update_event_is_registered(db_session: AsyncSession) -> None:
    """The event-update verb is exposed as a tool to an authenticated caller."""
    user = await make_user(db_session, "mcp-update-event-listed")
    raw = await _mint(db_session, user)

    async with _mcp_client(raw) as client, client:
        tools = await client.list_tools()
    assert "update_event" in {tool.name for tool in tools}


async def test_update_event_owner_edits_it_and_it_persists(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A bearer-authed OWNER edits an event via the tool: the returned view carries the
    new name, and the row is committed and readable back."""
    owner = await make_user(db_session, "mcp-update-event-owner")
    raw = await _mint(db_session, owner)
    tournament = await _seed_owned_tournament(
        db_session, owner, default_league, "Editable Events Cup", TournamentStatus.draft
    )
    event = await _seed_event(db_session, tournament)
    tournament_id, event_id = tournament.id, event.id

    async with _mcp_client(raw) as client, client:
        result = await client.call_tool_mcp(
            "update_event",
            {
                "tournament_id": str(tournament_id),
                "event_id": str(event_id),
                "updates": {"name": "Renamed Open"},
            },
        )
        assert result.isError is False
        body = result.structuredContent
        assert body is not None
        assert body["id"] == str(event_id)
        assert body["name"] == "Renamed Open"

    # Durable in the database.
    db_session.expire_all()
    persisted = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one()
    assert persisted.name == "Renamed Open"


async def test_update_event_frozen_change_raises_tool_error(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A ``draw_type`` change on an event whose draw is cut surfaces the freeze as a
    ``ToolError`` carrying the domain-authored sentence, and writes nothing."""
    owner = await make_user(db_session, "mcp-update-event-frozen-owner")
    raw = await _mint(db_session, owner)
    tournament = await _seed_owned_tournament(
        db_session, owner, default_league, "Frozen Events Cup", TournamentStatus.draft
    )
    event = await _seed_cut_event(db_session, tournament)
    tournament_id, event_id = tournament.id, event.id

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="draw type is frozen"):
            await client.call_tool(
                "update_event",
                {
                    "tournament_id": str(tournament_id),
                    "event_id": str(event_id),
                    "updates": {"name": "Should Not Apply", "draw_type": "single-elim"},
                },
            )

    # The refusal wrote nothing — the draw type and name are both untouched.
    db_session.expire_all()
    persisted = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one()
    assert persisted.draw_settings.draw_type is DrawType.round_robin
    assert persisted.name == "Cut Singles"


async def test_update_event_non_owner_raises_tool_error_and_writes_nothing(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Editing an event is owner-gated in the shared verb: a caller who is not the
    tournament's creator gets a ``ToolError`` and the event is left untouched."""
    owner = await make_user(db_session, "mcp-update-event-guard-owner")
    tournament = await _seed_owned_tournament(
        db_session,
        owner,
        default_league,
        "Guarded Edit Cup",
        TournamentStatus.draft,
    )
    event = await _seed_event(db_session, tournament)
    tournament_id, event_id = tournament.id, event.id

    outsider = await make_user(db_session, "mcp-update-event-outsider")
    outsider_token = await _mint(db_session, outsider)

    async with _mcp_client(outsider_token) as client, client:
        with pytest.raises(ToolError, match="edit events of tournaments you created"):
            await client.call_tool(
                "update_event",
                {
                    "tournament_id": str(tournament_id),
                    "event_id": str(event_id),
                    "updates": {"name": "Hijacked"},
                },
            )

    # The name is unchanged.
    db_session.expire_all()
    persisted = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one()
    assert persisted.name == "Existing Singles"


# ----- enter_event tool ----------------------------------------------------


async def _seed_published_singles_event(
    db: AsyncSession,
    owner: User,
    league: League,
    *,
    max_players: int | None = None,
) -> tuple[Tournament, TournamentEvent]:
    """A ``published`` tournament (registration open, ADR-0017) owned by ``owner`` with
    one singles event — the target the entry tool needs. Written directly so the tool is
    tested against a known state, not through the create routes."""
    tournament = await _seed_owned_tournament(
        db, owner, league, "Entry Cup", TournamentStatus.published
    )
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.round_robin),
        max_players=max_players,
        entry_fee=Decimal("0.00"),
        timezone="America/Chicago",
        slot={"date": "2026-08-01", "start": "09:00", "end": "17:00"},
        match_settings={"rated": False, "length_games": 3},
        predicates=[],
        pools=[],
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    return tournament, event


async def test_enter_event_self_registration_round_trip(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A bearer-authed caller holding ``tournament.enter`` enters THEMSELVES via the
    tool
    (no ``user_id``): the returned entrant is the caller, the row is committed, and it
    records no adder (self-registration, ADR-0784)."""
    owner = await make_user(db_session, "mcp-enter-owner")
    me = await make_user(db_session, "mcp-enter-self")
    await grant_permissions(db_session, me, [TOURNAMENT_ENTER])
    raw = await _mint(db_session, me)
    _, event = await _seed_published_singles_event(db_session, owner, default_league)
    # Read the ids up front: ``expire_all`` below expires every ORM object, and touching
    # ``event.id`` after it to build a query would lazy-load in sync code
    # (MissingGreenlet).
    tournament_id, event_id, me_id, me_username = (
        event.tournament_id,
        event.id,
        me.id,
        me.username,
    )

    async with _mcp_client(raw) as client, client:
        result = await client.call_tool_mcp(
            "enter_event",
            {"tournament_id": str(tournament_id), "event_id": str(event_id)},
        )
    assert result.isError is False
    assert result.structuredContent is not None
    assert result.structuredContent["user_id"] == str(me_id)
    assert result.structuredContent["username"] == me_username

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentEntry).where(TournamentEntry.event_id == event_id)
        )
    ).scalar_one()
    assert row.user_id == me_id
    assert row.added_by_user_id is None


async def test_enter_event_owner_enters_another_player_via_user_id(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The owner names another player's id: the tool enters that player (owner-gated, no
    ``tournament.enter`` grant needed) and the row records the owner as the adder."""
    owner = await make_user(db_session, "mcp-enter-director")
    player = await make_user(db_session, "mcp-enter-added-player")
    raw = await _mint(db_session, owner)
    _, event = await _seed_published_singles_event(db_session, owner, default_league)
    tournament_id, event_id, owner_id, player_id = (
        event.tournament_id,
        event.id,
        owner.id,
        player.id,
    )

    async with _mcp_client(raw) as client, client:
        result = await client.call_tool_mcp(
            "enter_event",
            {
                "tournament_id": str(tournament_id),
                "event_id": str(event_id),
                "user_id": str(player_id),
            },
        )
    assert result.isError is False
    assert result.structuredContent is not None
    # The created row describes the PLAYER, not the director who wrote it.
    assert result.structuredContent["user_id"] == str(player_id)

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentEntry).where(TournamentEntry.event_id == event_id)
        )
    ).scalar_one()
    assert (row.user_id, row.added_by_user_id) == (player_id, owner_id)


async def test_enter_event_non_owner_naming_another_raises_tool_error(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A caller who names another player's id but does not own the tournament gets a
    ``ToolError`` (the director arm is owner-gated), and nothing is written."""
    owner = await make_user(db_session, "mcp-enter-guard-owner")
    stranger = await make_user(db_session, "mcp-enter-stranger")
    await grant_permissions(db_session, stranger, [TOURNAMENT_ENTER])
    other = await make_user(db_session, "mcp-enter-other")
    stranger_token = await _mint(db_session, stranger)
    _, event = await _seed_published_singles_event(db_session, owner, default_league)
    tournament_id, event_id, other_id = event.tournament_id, event.id, other.id

    async with _mcp_client(stranger_token) as client, client:
        with pytest.raises(ToolError, match="tournaments you created"):
            await client.call_tool(
                "enter_event",
                {
                    "tournament_id": str(tournament_id),
                    "event_id": str(event_id),
                    "user_id": str(other_id),
                },
            )

    db_session.expire_all()
    assert (
        await db_session.execute(
            select(TournamentEntry).where(TournamentEntry.event_id == event_id)
        )
    ).scalar_one_or_none() is None


async def test_enter_event_full_event_raises_tool_error_naming_the_refusal(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A refusal (``event_full``) surfaces as a ``ToolError`` whose prose NAMES which of
    the four refusals fired (ADR-0968)."""
    owner = await make_user(db_session, "mcp-enter-full-owner")
    first = await make_user(db_session, "mcp-enter-full-first")
    me = await make_user(db_session, "mcp-enter-full-me")
    await grant_permissions(db_session, me, [TOURNAMENT_ENTER])
    raw = await _mint(db_session, me)
    _, event = await _seed_published_singles_event(
        db_session, owner, default_league, max_players=1
    )
    tournament_id, event_id, first_id = event.tournament_id, event.id, first.id
    db_session.add(TournamentEntry(event_id=event_id, user_id=first_id))
    await db_session.commit()

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="event_full"):
            await client.call_tool(
                "enter_event",
                {"tournament_id": str(tournament_id), "event_id": str(event_id)},
            )

    # The seeded entrant is untouched; no second row was written.
    db_session.expire_all()
    rows = (
        (
            await db_session.execute(
                select(TournamentEntry).where(TournamentEntry.event_id == event_id)
            )
        )
        .scalars()
        .all()
    )
    assert [r.user_id for r in rows] == [first_id]


# ----- withdraw_from_event tool --------------------------------------------


async def _seed_active_entry(
    db: AsyncSession, event: TournamentEvent, user: User
) -> uuid.UUID:
    """An active entry for ``user`` in ``event``, written straight to the database — the
    withdraw tool's precondition. Returns the entry id."""
    entry = TournamentEntry(
        event_id=event.id,
        user_id=user.id,
        status=TournamentEntryStatus.entered,
    )
    db.add(entry)
    await db.commit()
    await db.refresh(entry)
    return entry.id


async def test_withdraw_from_event_self_round_trip(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A bearer-authed caller holding ``tournament.enter`` withdraws their OWN entry via
    the tool: the confirmation names the entry, and the row is soft-deleted (status
    ``withdrawn``, the row survives)."""
    owner = await make_user(db_session, "mcp-withdraw-owner")
    me = await make_user(db_session, "mcp-withdraw-self")
    await grant_permissions(db_session, me, [TOURNAMENT_ENTER])
    raw = await _mint(db_session, me)
    _, event = await _seed_published_singles_event(db_session, owner, default_league)
    entry_id = await _seed_active_entry(db_session, event, me)
    tournament_id, event_id = event.tournament_id, event.id

    async with _mcp_client(raw) as client, client:
        result = await client.call_tool_mcp(
            "withdraw_from_event",
            {
                "tournament_id": str(tournament_id),
                "event_id": str(event_id),
                "entry_id": str(entry_id),
            },
        )
    assert result.isError is False
    assert result.structuredContent is not None
    assert result.structuredContent["entry_id"] == str(entry_id)

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentEntry).where(TournamentEntry.id == entry_id)
        )
    ).scalar_one()
    assert row.status is TournamentEntryStatus.withdrawn


async def test_withdraw_from_event_owner_withdraws_another_players_entry(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The owner withdraws SOMEBODY ELSE's entry via the tool — owner-gated, no
    ``tournament.enter`` grant needed. The entry is soft-deleted."""
    owner = await make_user(db_session, "mcp-withdraw-director")
    player = await make_user(db_session, "mcp-withdraw-player")
    raw = await _mint(db_session, owner)
    _, event = await _seed_published_singles_event(db_session, owner, default_league)
    entry_id = await _seed_active_entry(db_session, event, player)
    tournament_id, event_id = event.tournament_id, event.id

    async with _mcp_client(raw) as client, client:
        result = await client.call_tool_mcp(
            "withdraw_from_event",
            {
                "tournament_id": str(tournament_id),
                "event_id": str(event_id),
                "entry_id": str(entry_id),
            },
        )
    assert result.isError is False
    assert result.structuredContent is not None
    assert result.structuredContent["entry_id"] == str(entry_id)

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentEntry).where(TournamentEntry.id == entry_id)
        )
    ).scalar_one()
    assert row.status is TournamentEntryStatus.withdrawn


async def test_withdraw_from_event_third_party_raises_tool_error(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A caller who is neither the entry's own player nor the tournament's owner gets a
    ``ToolError`` (even holding ``tournament.enter``), and the entry stays active."""
    owner = await make_user(db_session, "mcp-withdraw-guard-owner")
    entrant = await make_user(db_session, "mcp-withdraw-entrant")
    stranger = await make_user(db_session, "mcp-withdraw-stranger")
    await grant_permissions(db_session, stranger, [TOURNAMENT_ENTER])
    stranger_token = await _mint(db_session, stranger)
    _, event = await _seed_published_singles_event(db_session, owner, default_league)
    entry_id = await _seed_active_entry(db_session, event, entrant)
    tournament_id, event_id = event.tournament_id, event.id

    async with _mcp_client(stranger_token) as client, client:
        with pytest.raises(ToolError, match="withdraw your own entry"):
            await client.call_tool(
                "withdraw_from_event",
                {
                    "tournament_id": str(tournament_id),
                    "event_id": str(event_id),
                    "entry_id": str(entry_id),
                },
            )

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentEntry).where(TournamentEntry.id == entry_id)
        )
    ).scalar_one()
    assert row.status is TournamentEntryStatus.entered


# ----- place_fixture tool --------------------------------------------------


async def _seed_placeable_fixture(
    db: AsyncSession,
    owner: User,
    league: League,
) -> tuple[Tournament, TournamentEvent, TournamentFixture]:
    """A ``draft`` tournament owned by ``owner`` with one singles event and one fixture
    seating two active entrants — the target the place-fixture tool needs, written
    straight to the database. The ``table_catalogue`` carries ``t1``/``t2`` so a
    placement can name a real table, and the event's pool ``p-os-1`` anchors the
    fixture."""
    tournament = Tournament(
        name="MCP Placement Cup",
        address={
            "venue": "Berkeley TT Club",
            "street": "2727 Milvia St",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94703",
            "country": "USA",
            "latitude": 37.8703,
            "longitude": -122.2731,
        },
        tables=venue_tables(("Table 1", "A"), ("Table 2", "A")),
        league_id=league.id,
        created_by_user_id=owner.id,
        status=TournamentStatus.draft,
    )
    db.add(tournament)
    await db.commit()
    await db.refresh(tournament)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.round_robin),
        max_players=64,
        entry_fee=Decimal("45"),
        timezone="America/Chicago",
        slot={"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        match_settings={"rated": True, "length_games": 5},
        predicates=[],
        pools=with_table_aliases(
            tournament,
            [
                {
                    "name": "Pool A",
                    "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
                    "table_ids": ["t1"],
                }
            ],
        ),
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    entry_a = TournamentEntry(
        event_id=event.id,
        user_id=(await make_user(db, "mcp-place-a-" + uuid.uuid4().hex)).id,
        status=TournamentEntryStatus.entered,
    )
    entry_b = TournamentEntry(
        event_id=event.id,
        user_id=(await make_user(db, "mcp-place-b-" + uuid.uuid4().hex)).id,
        status=TournamentEntryStatus.entered,
    )
    db.add_all([entry_a, entry_b])
    await db.commit()
    fixture = TournamentFixture(
        event_id=event.id,
        pool_id=event.pools[0].id,
        round=1,
        position=1,
        entry_a_id=entry_a.id,
        entry_b_id=entry_b.id,
    )
    db.add(fixture)
    await db.commit()
    await db.refresh(fixture)
    return tournament, event, fixture


async def test_place_fixture_owner_round_trip(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A bearer-authed OWNER places a fixture via the tool: the returned fixture carries
    the table + predicted start, and the columns are committed (a full placement of a
    known-entrant fixture also pins it)."""
    owner = await make_user(db_session, "mcp-place-owner")
    raw = await _mint(db_session, owner)
    tournament, _event, fixture = await _seed_placeable_fixture(
        db_session, owner, default_league
    )
    tournament_id, fixture_id = tournament.id, fixture.id
    # A placement names a real table (ADR 20260801), and its id is the server's.
    table_id = str(tournament.tables[0].id)

    async with _mcp_client(raw) as client, client:
        result = await client.call_tool_mcp(
            "place_fixture",
            {
                "tournament_id": str(tournament_id),
                "fixture_id": str(fixture_id),
                "placement": {
                    "table_id": table_id,
                    "scheduled_start": "2026-06-13T10:00:00",
                },
            },
        )
    assert result.isError is False
    assert result.structuredContent is not None
    assert result.structuredContent["id"] == str(fixture_id)
    assert result.structuredContent["table_id"] == table_id
    assert result.structuredContent["scheduled_start"] is not None

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentFixture).where(TournamentFixture.id == fixture_id)
        )
    ).scalar_one()
    assert row.table_id == table_id
    assert row.scheduled_start is not None
    assert row.pinned_at is not None


async def test_place_fixture_non_owner_raises_tool_error(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A caller who does not own the tournament gets a ``ToolError`` (owner-gated by
    construction in the shared verb), and the fixture is left unplaced."""
    owner = await make_user(db_session, "mcp-place-guard-owner")
    stranger = await make_user(db_session, "mcp-place-stranger")
    stranger_token = await _mint(db_session, stranger)
    tournament, _event, fixture = await _seed_placeable_fixture(
        db_session, owner, default_league
    )
    tournament_id, fixture_id = tournament.id, fixture.id
    table_id = str(tournament.tables[0].id)

    async with _mcp_client(stranger_token) as client, client:
        with pytest.raises(ToolError, match="tournaments you created"):
            await client.call_tool(
                "place_fixture",
                {
                    "tournament_id": str(tournament_id),
                    "fixture_id": str(fixture_id),
                    "placement": {
                        "table_id": table_id,
                        "scheduled_start": "2026-06-13T10:00:00",
                    },
                },
            )

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentFixture).where(TournamentFixture.id == fixture_id)
        )
    ).scalar_one()
    assert row.table_id is None
    assert row.pinned_at is None


async def test_place_fixture_played_out_fixture_raises_tool_error(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A refusal (the played-out freeze, ADR-0790) surfaces as a ``ToolError`` whose
    prose names the frozen state, and nothing is written."""
    owner = await make_user(db_session, "mcp-place-frozen-owner")
    raw = await _mint(db_session, owner)
    tournament, _event, fixture = await _seed_placeable_fixture(
        db_session, owner, default_league
    )
    tournament_id, fixture_id = tournament.id, fixture.id
    table_id = str(tournament.tables[1].id)
    match = Match(
        match_settings=MatchSettings(team_size=1, best_of=5, affects_rating=False),
        league_id=default_league.id,
        created_by_user_id=owner.id,
    )
    match.status = MatchStatus.completed
    db_session.add(match)
    await db_session.commit()
    fixture.match_id = match.id
    await db_session.commit()

    async with _mcp_client(raw) as client, client:
        with pytest.raises(ToolError, match="can no longer be changed"):
            await client.call_tool(
                "place_fixture",
                {
                    "tournament_id": str(tournament_id),
                    "fixture_id": str(fixture_id),
                    "placement": {
                        "table_id": table_id,
                        "scheduled_start": "2026-06-13T14:00:00",
                    },
                },
            )

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(TournamentFixture).where(TournamentFixture.id == fixture_id)
        )
    ).scalar_one()
    assert row.table_id is None
    assert row.pinned_at is None
