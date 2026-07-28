"""``GET /v1/settings/agent-access`` — the Claude-access settings page's one read.

The endpoint's whole job is a **decision**: collapse "has an email", "holds
``mcp.access``" and "has an Auth0 identity bound" into one of four panels. So the
precedence between them is what is tested here, both as a pure function and
through the wire, with the pair that used to be ambiguous — no email AND no
permission — pinned explicitly.
"""

from dataclasses import dataclass
from datetime import UTC, datetime

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_access import resolve_agent_access_state
from app.mcp_server import MCP_ACCESS_PERMISSION
from app.models import User
from app.schemas.agent_access import AgentAccessState
from tests._helpers import grant_permissions, start_session

CONNECTOR_URL = "https://uat.fortymm.com/api/mcp/"
CONNECTOR_CLIENT_ID = "client-abc"

LINKED_AT = datetime(2026, 7, 20, 15, 30, tzinfo=UTC)


def _configure_connector(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MCP_PUBLIC_RESOURCE_URL", CONNECTOR_URL)
    monkeypatch.setenv("MCP_OAUTH_CLIENT_ID", CONNECTOR_CLIENT_ID)


def _unconfigure_connector(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MCP_PUBLIC_RESOURCE_URL", raising=False)
    monkeypatch.delenv("MCP_OAUTH_CLIENT_ID", raising=False)


async def _sign_in_as(
    api_client: AsyncClient,
    db_session: AsyncSession,
    *,
    email: str | None = None,
    grant_mcp_access: bool = False,
    auth0_sub: str | None = None,
    linked_at: datetime | None = None,
) -> User:
    """Mint a session and put its user in the requested state.

    The ``mcp.access`` grant goes in through real RBAC rows rather than a
    dependency override, so the test exercises the same
    ``user_has_permission(MCP_ACCESS_PERMISSION)`` question the MCP transport
    asks — a page that disagreed with the transport is the bug worth catching.
    """
    user = await start_session(api_client, db_session)
    user.email = email
    user.auth0_sub = auth0_sub
    user.agent_access_linked_at = linked_at
    await db_session.commit()
    if grant_mcp_access:
        await grant_permissions(db_session, user, [MCP_ACCESS_PERMISSION])
    return user


@dataclass(frozen=True)
class _StateSetup:
    """How to get an account into one particular state."""

    email: str | None = None
    grant_mcp_access: bool = False
    auth0_sub: str | None = None
    linked_at: datetime | None = None


#: The four states, and the account that lands in each. Reused by the connector
#: tests below, which must hold in *every* state.
STATE_SETUPS: dict[AgentAccessState, _StateSetup] = {
    AgentAccessState.GUEST: _StateSetup(),
    AgentAccessState.GATED: _StateSetup(email="gated@example.com"),
    AgentAccessState.READY: _StateSetup(
        email="ready@example.com", grant_mcp_access=True
    ),
    AgentAccessState.CONNECTED: _StateSetup(
        email="connected@example.com",
        grant_mcp_access=True,
        auth0_sub="auth0|connected",
        linked_at=LINKED_AT,
    ),
}


async def _sign_in_for(
    api_client: AsyncClient, db_session: AsyncSession, setup: _StateSetup
) -> User:
    return await _sign_in_as(
        api_client,
        db_session,
        email=setup.email,
        grant_mcp_access=setup.grant_mcp_access,
        auth0_sub=setup.auth0_sub,
        linked_at=setup.linked_at,
    )


# --------------------------------------------------------------------------
# The precedence, as a pure function
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "email, has_mcp_access, linked_sub, expected",
    [
        (None, True, None, AgentAccessState.GUEST),
        ("player@example.com", False, None, AgentAccessState.GATED),
        ("player@example.com", True, None, AgentAccessState.READY),
        ("player@example.com", True, "auth0|abc", AgentAccessState.CONNECTED),
    ],
    ids=["no-email", "no-permission", "permitted-unbound", "permitted-bound"],
)
def test_state_resolves_from_the_three_facts(
    email: str | None,
    has_mcp_access: bool,
    linked_sub: str | None,
    expected: AgentAccessState,
) -> None:
    assert (
        resolve_agent_access_state(
            email=email, has_mcp_access=has_mcp_access, linked_sub=linked_sub
        )
        is expected
    )


@pytest.mark.parametrize(
    "linked_sub", [None, "auth0|abc"], ids=["unbound", "already-bound"]
)
def test_no_email_beats_no_permission(linked_sub: str | None) -> None:
    """The one ordering that is a real decision rather than a fallthrough.

    An account with neither an email nor the grant is missing two things, and
    only one of them can be shown. ``guest`` wins: Claude signs the player in by
    email, so an emailless account cannot connect however the grant lands —
    sending them to ask an operator for agent access would have them solve the
    wrong problem and arrive back here still unable to connect. Being already
    *bound* doesn't change it either, for the same reason.
    """
    assert (
        resolve_agent_access_state(
            email=None, has_mcp_access=False, linked_sub=linked_sub
        )
        is AgentAccessState.GUEST
    )


@pytest.mark.parametrize("email", ["", None], ids=["empty-string", "null"])
def test_an_empty_email_is_no_email(email: str | None) -> None:
    """``users.email`` is nullable, but an empty string is the same nothing —
    it must not resolve as an address Claude could sign in with."""
    assert (
        resolve_agent_access_state(email=email, has_mcp_access=True, linked_sub=None)
        is AgentAccessState.GUEST
    )


# --------------------------------------------------------------------------
# Through the wire
# --------------------------------------------------------------------------


async def test_an_account_with_no_email_reports_guest(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    user = await _sign_in_as(api_client, db_session)

    response = await api_client.get("/v1/settings/agent-access")

    assert response.status_code == 200
    body = response.json()
    assert body["state"] == "guest"
    assert body["email"] is None
    assert body["username"] == user.username
    assert body["connected_on"] is None


async def test_an_account_with_no_email_and_no_permission_reports_guest(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The precedence, end to end — a fresh guest holds no ``mcp.access``
    either, and must still be told to claim an email rather than to go and ask
    for a grant that would not help them."""
    await _sign_in_as(api_client, db_session)

    response = await api_client.get("/v1/settings/agent-access")

    assert response.json()["state"] == "guest"


async def test_an_account_without_the_grant_reports_gated(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    await _sign_in_as(api_client, db_session, email="gated@example.com")

    response = await api_client.get("/v1/settings/agent-access")

    body = response.json()
    assert body["state"] == "gated"
    assert body["email"] == "gated@example.com"
    assert body["connected_on"] is None


async def test_a_permitted_account_with_no_bound_identity_reports_ready(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    await _sign_in_as(
        api_client, db_session, email="ready@example.com", grant_mcp_access=True
    )

    response = await api_client.get("/v1/settings/agent-access")

    body = response.json()
    assert body["state"] == "ready"
    assert body["email"] == "ready@example.com"
    assert body["connected_on"] is None


async def test_a_permitted_account_with_a_bound_identity_reports_connected(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    await _sign_in_as(
        api_client,
        db_session,
        email="connected@example.com",
        grant_mcp_access=True,
        auth0_sub="auth0|connected",
        linked_at=LINKED_AT,
    )

    response = await api_client.get("/v1/settings/agent-access")

    body = response.json()
    assert body["state"] == "connected"
    assert datetime.fromisoformat(body["connected_on"]) == LINKED_AT


async def test_connected_survives_a_link_predating_the_linked_at_column(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``agent_access_linked_at`` is stamped at the bind sites, so an account
    bound before it existed is connected with an unknown date — ``auth0_sub``,
    not the timestamp, is what says "connected"."""
    await _sign_in_as(
        api_client,
        db_session,
        email="old@example.com",
        grant_mcp_access=True,
        auth0_sub="auth0|old",
        linked_at=None,
    )

    body = (await api_client.get("/v1/settings/agent-access")).json()

    assert body["state"] == "connected"
    assert body["connected_on"] is None


async def test_a_bound_identity_without_the_grant_still_reports_gated(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An operator revoking ``mcp.access`` cuts the agent off at the transport,
    so the page must stop claiming a working connection — even though the
    ``auth0_sub`` binding is still there."""
    await _sign_in_as(
        api_client,
        db_session,
        email="revoked@example.com",
        auth0_sub="auth0|revoked",
        linked_at=LINKED_AT,
    )

    body = (await api_client.get("/v1/settings/agent-access")).json()

    assert body["state"] == "gated"
    assert body["connected_on"] is None


async def test_it_requires_a_session(api_client: AsyncClient) -> None:
    response = await api_client.get("/v1/settings/agent-access")

    assert response.status_code == 401


# --------------------------------------------------------------------------
# The connector is server config, not user state
# --------------------------------------------------------------------------


@pytest.mark.parametrize("state", list(STATE_SETUPS), ids=lambda s: s.value)
async def test_the_connector_is_reported_in_every_state(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    state: AgentAccessState,
) -> None:
    """It reflects what the *server* is configured with, not what the player has
    done — a guest is shown the same pair a connected player is."""
    _configure_connector(monkeypatch)
    await _sign_in_for(api_client, db_session, STATE_SETUPS[state])

    body = (await api_client.get("/v1/settings/agent-access")).json()

    assert body["state"] == state.value
    assert body["connector"] == {
        "url": CONNECTOR_URL,
        "client_id": CONNECTOR_CLIENT_ID,
    }


@pytest.mark.parametrize("state", list(STATE_SETUPS), ids=lambda s: s.value)
async def test_the_connector_is_absent_when_unconfigured_in_every_state(
    api_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    state: AgentAccessState,
) -> None:
    """A deployment with no MCP OAuth configuration reports no connector even to
    a connected player — half a connector is worse than none
    (``Settings.mcp_connector``)."""
    _unconfigure_connector(monkeypatch)
    await _sign_in_for(api_client, db_session, STATE_SETUPS[state])

    body = (await api_client.get("/v1/settings/agent-access")).json()

    assert body["state"] == state.value
    assert body["connector"] is None


async def test_a_whitespace_only_client_id_reports_no_connector(
    api_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The carry-over ``Settings.mcp_connector`` fix, seen from the page: a
    client id of spaces is an unset one, and must not reach a player as a
    pasteable value."""
    monkeypatch.setenv("MCP_PUBLIC_RESOURCE_URL", CONNECTOR_URL)
    monkeypatch.setenv("MCP_OAUTH_CLIENT_ID", "  ")
    await _sign_in_as(
        api_client, db_session, email="ready@example.com", grant_mcp_access=True
    )

    body = (await api_client.get("/v1/settings/agent-access")).json()

    assert body["state"] == "ready"
    assert body["connector"] is None
