"""The Claude-access settings page — its one read and its two write actions.

One endpoint for one page (root ``CLAUDE.md``): the situations a player can be
in are collapsed to a single ``state`` here, on the server, rather than left for
the client to re-derive by ``&&``-ing four nullable fields into a panel choice.
Two clients (web and iOS) guessing from raw nullables is two chances to disagree
about whether somebody is connected.

The two actions are the round trip ADR
``20260728-disconnecting-an-agent-is-a-user-held-revocation-checked-at-the-mcp-transport``
describes: connect (implicit, by an agent signing in) → **disconnect**
(explicit) → **re-allow** (explicit) → connect again. Both return the very same
``AgentAccessResponse`` the read does, so the page re-renders from the action's
own result rather than firing a second request and briefly showing a state it
already knows is stale.

The surface is deliberately **agent-neutral**. The binding is one Auth0 identity,
so disconnecting stops every agent signed in with that email — the Claude
branding belongs in the web UI, not in these paths.

Everything this module needs already exists elsewhere and is *asked*, never
restated: the grant is ``mcp_server.MCP_ACCESS_PERMISSION`` read through
``rbac.user_has_permission`` (the same question the MCP transport asks before
admitting an agent, so the page cannot promise access the transport would
refuse), and the connector pair is ``Settings.mcp_connector``.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import McpConnectorConfig, get_settings
from app.db import get_session
from app.mcp_server import MCP_ACCESS_PERMISSION
from app.models import User
from app.rbac import user_has_permission
from app.schemas.agent_access import (
    AgentAccessConnector,
    AgentAccessResponse,
    AgentAccessState,
)
from app.sessions import get_current_user

router = APIRouter(prefix="/v1")


def resolve_agent_access_state(
    *,
    email: str | None,
    has_mcp_access: bool,
    revoked_at: datetime | None,
    linked_sub: str | None,
) -> AgentAccessState:
    """Which of the situations the caller is in — the decision this page exists
    to make, as a pure function of four facts.

    THE ORDER IS THE DECISION, so it is stated once here and tested directly:

    1. ``guest`` — no email. Claude signs the player in *by email* and the API
       matches an agent's token to an account on the verified address
       (``app.auth0_provisioning``), so an account with no email cannot connect
       *whatever else is true of it*. It outranks the missing grant in
       particular: telling a guest "ask an operator for agent access" sends them
       to solve the wrong problem, and they would land back here still unable to
       connect. Claim an email first.
    2. ``gated`` — no ``mcp.access``. Setup steps for an account the MCP
       transport would 401 are a dead end.
    3. ``revoked`` — the player switched agent access off themselves. This beats
       both states below it because it is the truth about whether an agent can
       act: the transport refuses a revoked user *after* resolving the token
       (``FortymmAuth0TokenVerifier``), so a still-bound ``auth0_sub`` no longer
       means a working connection, and the bare setup panel would walk a revoked
       player into a silent 401. Revocation is sticky by design, so this state
       is the only thing that can offer the way back.
    4. ``connected`` — an Auth0 identity is bound.
    5. ``ready`` — permitted, nothing bound yet.
    """
    if not email:
        return AgentAccessState.GUEST
    if not has_mcp_access:
        return AgentAccessState.GATED
    if revoked_at is not None:
        return AgentAccessState.REVOKED
    if linked_sub:
        return AgentAccessState.CONNECTED
    return AgentAccessState.READY


def _connected_on(
    state: AgentAccessState, linked_at: datetime | None
) -> datetime | None:
    """The "Connected <date>" timestamp, which only the ``connected`` state has.

    An exhaustive ``match`` with no catch-all rather than
    ``if state is CONNECTED``: a new member added to ``AgentAccessState`` is
    then a type error here until somebody decides what date, if any, it shows.

    ``revoked`` answers ``None`` — the same as every other non-connected state.
    A "Connected 20 July" line under a panel that says agent access is switched
    off would be reporting a connection that no longer exists: disconnect clears
    ``auth0_sub``, and even if it hadn't, the transport refuses the caller. The
    date of a connection that has been withdrawn is not something this page has
    anywhere honest to put.
    """
    match state:
        case AgentAccessState.CONNECTED:
            return linked_at
        case (
            AgentAccessState.GUEST
            | AgentAccessState.GATED
            | AgentAccessState.REVOKED
            | AgentAccessState.READY
        ):
            return None


def _serialize_connector(
    connector: McpConnectorConfig | None,
) -> AgentAccessConnector | None:
    if connector is None:
        return None
    return AgentAccessConnector(url=connector.url, client_id=connector.client_id)


async def _describe(db: AsyncSession, user: User) -> AgentAccessResponse:
    """The page's payload for ``user`` as they stand right now.

    Shared by the read and both write actions so an action's answer cannot drift
    from what the next read would say.
    """
    state = resolve_agent_access_state(
        email=user.email,
        has_mcp_access=await user_has_permission(db, user.id, MCP_ACCESS_PERMISSION),
        revoked_at=user.agent_access_revoked_at,
        linked_sub=user.auth0_sub,
    )
    return AgentAccessResponse(
        state=state,
        email=user.email,
        username=user.username,
        connected_on=_connected_on(state, user.agent_access_linked_at),
        connector=_serialize_connector(get_settings().mcp_connector),
    )


@router.get("/settings/agent-access", response_model=AgentAccessResponse)
async def get_agent_access(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> AgentAccessResponse:
    """Everything the Claude-access settings page renders: which panel to show,
    the email an agent must be signed in with, when an agent was first linked,
    and the connector pair to paste into Claude.

    The connector reports server configuration, so it is present or absent
    independently of the caller's state — a deployment with no MCP OAuth
    configuration returns it as null even for a connected player.
    """
    return await _describe(db, current_user)


@router.post("/settings/agent-access/disconnect", response_model=AgentAccessResponse)
async def disconnect_agent_access(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> AgentAccessResponse:
    """Switch agent access off for the calling player, and report the page's new
    state.

    This stops **every** agent signed in with this account's email — Claude,
    Claude Code, anything else — because the binding is one Auth0 identity, not
    one per connector.

    It takes effect against tokens that have already been issued and are still
    valid: the MCP transport re-reads this flag on every request after resolving
    the token to a user, so there is no window in which an agent keeps working.

    Disconnecting an account that is already disconnected is not an error; it
    changes nothing.
    """
    if current_user.agent_access_revoked_at is None:
        # Only stamp the *first* disconnect: the column means "when the player
        # switched agent access off", and a repeated click should not rewrite
        # that moment. Re-stamping would also make the idempotency claim weaker
        # than it is — a second call is a genuine no-op.
        current_user.agent_access_revoked_at = datetime.now(UTC)
    # Cosmetic, per the ADR: the stamp above is what actually holds. Clearing the
    # binding is what makes this page's reported state honest, and is only safe
    # to do because the revocation blocks ``resolve_or_provision_user`` from
    # matching this account by email and silently re-binding the same ``sub``.
    current_user.auth0_sub = None
    await db.commit()
    return await _describe(db, current_user)


@router.post("/settings/agent-access/allow", response_model=AgentAccessResponse)
async def allow_agent_access(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> AgentAccessResponse:
    """Let agents connect to this account again, and report the page's new state.

    This clears the player's own revocation and nothing else — it does not
    reconnect anything. The next agent that signs in with this account's email
    binds itself, as it did the first time.

    It exists because revocation is deliberately sticky: with no explicit way
    back, a disconnected player who followed the connector setup steps again
    would be refused by the transport with a silent 401, forever.

    Allowing an account that was never revoked is not an error; it changes
    nothing.
    """
    current_user.agent_access_revoked_at = None
    await db.commit()
    return await _describe(db, current_user)
