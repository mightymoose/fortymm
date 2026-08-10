"""The Claude-access settings page's one read and its two write actions.

The read's whole job is a **decision**: collapse "has an email", "holds
``mcp.access``", "has revoked their own access" and "has an Auth0 identity
bound" into one of five panels. So the precedence between them is what is tested
here, both as a pure function and through the wire, with the pairs that are real
orderings rather than fallthroughs — no email AND no permission; revoked AND
still bound — pinned explicitly.

The two actions are tested as the round trip the ADR describes (disconnect →
re-allow), for their effect on the persisted flag the MCP transport reads, and
for idempotence in both directions.
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
REVOKED_AT = datetime(2026, 7, 21, 9, 0, tzinfo=UTC)

DISCONNECT_URL = "/v1/settings/agent-access/disconnect"
ALLOW_URL = "/v1/settings/agent-access/allow"


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
    revoked_at: datetime | None = None,
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
    user.agent_access_revoked_at = revoked_at
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
    revoked_at: datetime | None = None


#: Every state, and the account that lands in each. Reused by the connector
#: tests below, which must hold in *every* state.
STATE_SETUPS: dict[AgentAccessState, _StateSetup] = {
    AgentAccessState.GUEST: _StateSetup(),
    AgentAccessState.GATED: _StateSetup(email="gated@example.com"),
    AgentAccessState.REVOKED: _StateSetup(
        email="switched-off@example.com",
        grant_mcp_access=True,
        revoked_at=REVOKED_AT,
    ),
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


def test_every_state_has_a_setup() -> None:
    """``STATE_SETUPS`` drives the parametrised connector tests, so a new member
    that nobody added a setup for would silently go uncovered there."""
    assert set(STATE_SETUPS) == set(AgentAccessState)


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
        revoked_at=setup.revoked_at,
    )


# --------------------------------------------------------------------------
# The precedence, as a pure function
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "email, has_mcp_access, revoked_at, linked_sub, expected",
    [
        (None, True, None, None, AgentAccessState.GUEST),
        ("player@example.com", False, None, None, AgentAccessState.GATED),
        ("player@example.com", True, REVOKED_AT, None, AgentAccessState.REVOKED),
        ("player@example.com", True, None, None, AgentAccessState.READY),
        ("player@example.com", True, None, "auth0|abc", AgentAccessState.CONNECTED),
    ],
    ids=[
        "no-email",
        "no-permission",
        "self-revoked",
        "permitted-unbound",
        "permitted-bound",
    ],
)
def test_state_resolves_from_the_four_facts(
    email: str | None,
    has_mcp_access: bool,
    revoked_at: datetime | None,
    linked_sub: str | None,
    expected: AgentAccessState,
) -> None:
    assert (
        resolve_agent_access_state(
            email=email,
            has_mcp_access=has_mcp_access,
            revoked_at=revoked_at,
            linked_sub=linked_sub,
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
            email=None, has_mcp_access=False, revoked_at=None, linked_sub=linked_sub
        )
        is AgentAccessState.GUEST
    )


def test_revoked_beats_connected() -> None:
    """The second real ordering. A revoked account can still carry a bound
    ``auth0_sub`` — an account revoked before this feature cleared the binding,
    or one re-bound by a path that isn't disconnect — and ``connected`` would be
    a false claim: the transport refuses a revoked user after resolving the
    token, so nothing that identity does works."""
    assert (
        resolve_agent_access_state(
            email="player@example.com",
            has_mcp_access=True,
            revoked_at=REVOKED_AT,
            linked_sub="auth0|abc",
        )
        is AgentAccessState.REVOKED
    )


def test_revoked_and_ready_do_not_collapse() -> None:
    """The point of the state. Two accounts with no binding differ only by the
    revocation stamp, and must not report the same panel: the revoked one needs
    the re-allow control, and showing it the bare setup steps walks it into a
    silent 401 with no way out."""
    never_connected = resolve_agent_access_state(
        email="player@example.com",
        has_mcp_access=True,
        revoked_at=None,
        linked_sub=None,
    )
    switched_off = resolve_agent_access_state(
        email="player@example.com",
        has_mcp_access=True,
        revoked_at=REVOKED_AT,
        linked_sub=None,
    )

    assert never_connected is AgentAccessState.READY
    assert switched_off is AgentAccessState.REVOKED


def test_no_permission_beats_revoked() -> None:
    """Operator revocation and player revocation are independent and both fail
    closed, but only one panel can be shown — ``gated`` wins, because re-allowing
    would not restore access while the grant is missing."""
    assert (
        resolve_agent_access_state(
            email="player@example.com",
            has_mcp_access=False,
            revoked_at=REVOKED_AT,
            linked_sub=None,
        )
        is AgentAccessState.GATED
    )


@pytest.mark.parametrize("email", ["", None], ids=["empty-string", "null"])
def test_an_empty_email_is_no_email(email: str | None) -> None:
    """``users.email`` is nullable, but an empty string is the same nothing —
    it must not resolve as an address Claude could sign in with."""
    assert (
        resolve_agent_access_state(
            email=email, has_mcp_access=True, revoked_at=None, linked_sub=None
        )
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


async def test_a_revoked_account_reports_revoked(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    await _sign_in_as(
        api_client,
        db_session,
        email="switched-off@example.com",
        grant_mcp_access=True,
        revoked_at=REVOKED_AT,
    )

    body = (await api_client.get("/v1/settings/agent-access")).json()

    assert body["state"] == "revoked"
    assert body["email"] == "switched-off@example.com"
    assert body["connected_on"] is None


async def test_a_revoked_account_still_bound_reports_revoked_not_connected(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The stamp is what holds, not the binding — so a row carrying both must
    not be reported as a working connection."""
    await _sign_in_as(
        api_client,
        db_session,
        email="switched-off@example.com",
        grant_mcp_access=True,
        auth0_sub="auth0|still-bound",
        linked_at=LINKED_AT,
        revoked_at=REVOKED_AT,
    )

    body = (await api_client.get("/v1/settings/agent-access")).json()

    assert body["state"] == "revoked"
    assert body["connected_on"] is None


async def test_revoked_is_distinguishable_from_never_connected_over_the_wire(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    """One account, read twice, with the stamp as the only difference between
    the reads — so nothing but the revocation can account for a change in state.

    If ``revoked`` collapsed into ``ready`` the client could not tell the two
    apart, could not offer the re-allow control, and the player would dead-end.
    """
    user = await _sign_in_as(
        api_client, db_session, email="player@example.com", grant_mcp_access=True
    )
    never_connected = (await api_client.get("/v1/settings/agent-access")).json()

    user.agent_access_revoked_at = REVOKED_AT
    await db_session.commit()
    switched_off = (await api_client.get("/v1/settings/agent-access")).json()

    assert never_connected["state"] == "ready"
    assert switched_off["state"] == "revoked"


@pytest.mark.parametrize(
    "method, url",
    [
        ("get", "/v1/settings/agent-access"),
        ("post", DISCONNECT_URL),
        ("post", ALLOW_URL),
    ],
    ids=["read", "disconnect", "allow"],
)
async def test_it_requires_a_session(
    api_client: AsyncClient, method: str, url: str
) -> None:
    response = await api_client.request(method, url)

    assert response.status_code == 401


# --------------------------------------------------------------------------
# Disconnect and re-allow
# --------------------------------------------------------------------------


async def test_disconnect_revokes_and_unbinds(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The stamp is the enforcement and the clear is the honesty — both happen.

    ``agent_access_revoked_at`` is the flag the MCP transport reads, so
    asserting it is persisted is asserting the disconnect took effect against
    the transport (which chore 2a already proved honours it).
    """
    user = await _sign_in_as(
        api_client,
        db_session,
        email="connected@example.com",
        grant_mcp_access=True,
        auth0_sub="auth0|connected",
        linked_at=LINKED_AT,
    )

    response = await api_client.post(DISCONNECT_URL)

    assert response.status_code == 200
    assert response.json()["state"] == "revoked"
    await db_session.refresh(user)
    assert user.agent_access_revoked_at is not None
    # The binding is cleared, which is what lets a re-allow land back on
    # ``ready`` — the one state that renders the connector URL and client id.
    assert user.auth0_sub is None


async def test_disconnect_is_idempotent(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A second disconnect is not an error and is a genuine no-op — it keeps the
    moment the player actually switched agent access off rather than rewriting
    it to now."""
    user = await _sign_in_as(
        api_client,
        db_session,
        email="connected@example.com",
        grant_mcp_access=True,
        auth0_sub="auth0|connected",
    )

    first = await api_client.post(DISCONNECT_URL)
    await db_session.refresh(user)
    revoked_at = user.agent_access_revoked_at
    second = await api_client.post(DISCONNECT_URL)
    await db_session.refresh(user)

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json() == first.json()
    assert user.agent_access_revoked_at == revoked_at


async def test_disconnecting_a_never_connected_account_still_revokes(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    """There is nothing bound to clear, but the revocation is still the player's
    own state and must stick — otherwise the page would bounce back to
    ``ready``."""
    user = await _sign_in_as(
        api_client, db_session, email="ready@example.com", grant_mcp_access=True
    )

    response = await api_client.post(DISCONNECT_URL)

    assert response.json()["state"] == "revoked"
    await db_session.refresh(user)
    assert user.agent_access_revoked_at is not None


async def test_allow_clears_the_revocation(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    user = await _sign_in_as(
        api_client,
        db_session,
        email="switched-off@example.com",
        grant_mcp_access=True,
        revoked_at=REVOKED_AT,
    )

    response = await api_client.post(ALLOW_URL)

    assert response.status_code == 200
    assert response.json()["state"] == "ready"
    await db_session.refresh(user)
    assert user.agent_access_revoked_at is None


async def test_allow_does_not_reconnect_anything(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Re-allowing only lifts the block. The binding is re-made by the next
    agent that signs in, not by this endpoint."""
    user = await _sign_in_as(
        api_client,
        db_session,
        email="switched-off@example.com",
        grant_mcp_access=True,
        revoked_at=REVOKED_AT,
    )

    body = (await api_client.post(ALLOW_URL)).json()

    assert body["state"] == "ready"
    assert body["connected_on"] is None
    await db_session.refresh(user)
    assert user.auth0_sub is None


async def test_allow_is_idempotent(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Allowing an account that was never revoked changes nothing and is not an
    error."""
    user = await _sign_in_as(
        api_client, db_session, email="ready@example.com", grant_mcp_access=True
    )

    first = await api_client.post(ALLOW_URL)
    second = await api_client.post(ALLOW_URL)

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["state"] == "ready"
    assert second.json() == first.json()
    await db_session.refresh(user)
    assert user.agent_access_revoked_at is None


async def test_the_round_trip(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    """connect (implicit) → disconnect → re-allow → connectable again, as the
    ADR describes it, through the page's own endpoints.

    Re-allow lands on ``ready``, not ``connected``: disconnect cleared the
    binding, so the setup panel — the only surface carrying the connector URL
    and client id — is reachable again. An agent re-binds by verified email on
    its next token, so nothing here has to be redone by hand."""
    await _sign_in_as(
        api_client,
        db_session,
        email="player@example.com",
        grant_mcp_access=True,
        auth0_sub="auth0|player",
        linked_at=LINKED_AT,
    )

    async def state() -> str:
        body = (await api_client.get("/v1/settings/agent-access")).json()
        assert isinstance(body["state"], str)
        return body["state"]

    assert await state() == "connected"
    await api_client.post(DISCONNECT_URL)
    assert await state() == "revoked"
    await api_client.post(ALLOW_URL)
    assert await state() == "ready"


async def test_a_gated_account_can_still_disconnect(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The actions are not conditioned on the grant. A player whose ``mcp.access``
    was pulled while an agent was linked can still switch their own access off —
    and the page keeps reporting ``gated``, because that is the thing standing in
    their way."""
    user = await _sign_in_as(
        api_client,
        db_session,
        email="gated@example.com",
        auth0_sub="auth0|gated",
    )

    body = (await api_client.post(DISCONNECT_URL)).json()

    assert body["state"] == "gated"
    await db_session.refresh(user)
    assert user.agent_access_revoked_at is not None
    assert user.auth0_sub is None


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
