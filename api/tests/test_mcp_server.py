"""Transport-auth tests for the mounted FastMCP server (chore 1c).

These drive the **mounted** app over HTTP (httpx ``ASGITransport`` against the
FastAPI app, wrapped in a FastMCP ``Client`` speaking Streamable HTTP) so the
``FortymmTokenVerifier`` actually runs at the transport — an in-memory
``Client(mcp)`` would bypass it. The server exposes **zero tools** for now, so a
valid token proves only that ``list_tools`` succeeds (empty is fine); the point
is that missing / invalid / tombstoned-user tokens are rejected **before** any
tool body, at the transport.

The MCP app carries its own lifespan (the Streamable-HTTP session manager);
``ASGITransport`` does not fire it, so each test enters ``mcp_app.lifespan``
explicitly. The verifier resolves tokens against the process-wide engine
(``DATABASE_URL`` is pointed at the test Postgres by the autouse
``_solver_job_database`` fixture), so tokens are committed via ``db_session``
first — the verifier's own connection only sees committed rows.
"""

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

import httpx
import pytest
from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport
from fastmcp.exceptions import ToolError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api_token_auth import API_TOKEN_CONTEXT
from app.main import app as fastapi_app
from app.main import mcp_app
from app.models import User, UserToken
from app.token_hashing import hash_token
from tests._helpers import make_user, start_session

MCP_URL = "http://testserver/mcp/"


async def _mint(db_session: AsyncSession, user: User) -> str:
    """Store an ``api``-context token for ``user`` (only the sha256 hash lands in
    the DB, as production does) and return the raw token."""
    raw = "api-raw-" + uuid.uuid4().hex
    db_session.add(
        UserToken(user_id=user.id, context=API_TOKEN_CONTEXT, token=hash_token(raw))
    )
    await db_session.commit()
    return raw


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


async def test_valid_api_token_can_list_tools(db_session: AsyncSession) -> None:
    """A live ``context="api"`` bearer token authenticates at the transport and
    can complete the initialize + ``list_tools`` handshake. The curated
    match-flow verbs are exposed — ``get_match`` is registered."""
    user = await make_user(db_session, "mcp-token-owner")
    raw = await _mint(db_session, user)

    async with _mcp_client(raw) as client, client:
        tools = await client.list_tools()

    assert "get_match" in {tool.name for tool in tools}


async def test_missing_token_is_rejected(db_session: AsyncSession) -> None:
    """No ``Authorization`` header → rejected at the transport (401), before any
    tool body."""
    async with _mcp_client(None) as client:
        await _assert_rejected(client)


async def test_invalid_token_is_rejected(db_session: AsyncSession) -> None:
    """A well-formed but never-minted token resolves to no user → 401."""
    async with _mcp_client("api-raw-" + uuid.uuid4().hex) as client:
        await _assert_rejected(client)


async def test_tombstoned_users_token_is_rejected(db_session: AsyncSession) -> None:
    """A valid token whose user was merged away (``merged_into_user_id`` set) is
    rejected — the folded-in ghost never authenticates through MCP either."""
    owner = await make_user(db_session, "mcp-merge-owner")
    guest = await make_user(db_session, "mcp-merged-guest")
    raw = await _mint(db_session, guest)

    guest.merged_into_user_id = owner.id
    guest.merged_at = datetime.now(UTC)
    await db_session.commit()

    async with _mcp_client(raw) as client:
        await _assert_rejected(client)


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
