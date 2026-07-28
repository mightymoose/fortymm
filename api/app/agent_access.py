"""The Claude-access settings page — ``GET /v1/settings/agent-access``.

One endpoint for one page (root ``CLAUDE.md``): the four situations a player can
be in are collapsed to a single ``state`` here, on the server, rather than left
for the client to re-derive by ``&&``-ing three nullable fields into a panel
choice. Two clients (web and iOS) guessing from raw nullables is two chances to
disagree about whether somebody is connected.

Everything this module needs already exists elsewhere and is *asked*, never
restated: the grant is ``mcp_server.MCP_ACCESS_PERMISSION`` read through
``rbac.user_has_permission`` (the same question the MCP transport asks before
admitting an agent, so the page cannot promise access the transport would
refuse), and the connector pair is ``Settings.mcp_connector``.
"""

from datetime import datetime

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
    *, email: str | None, has_mcp_access: bool, linked_sub: str | None
) -> AgentAccessState:
    """Which of the four situations the caller is in — the decision this
    endpoint exists to make, as a pure function of three facts.

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
    3. ``connected`` — an Auth0 identity is bound.
    4. ``ready`` — permitted, nothing bound yet.
    """
    if not email:
        return AgentAccessState.GUEST
    if not has_mcp_access:
        return AgentAccessState.GATED
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
    """
    match state:
        case AgentAccessState.CONNECTED:
            return linked_at
        case AgentAccessState.GUEST | AgentAccessState.GATED | AgentAccessState.READY:
            return None


def _serialize_connector(
    connector: McpConnectorConfig | None,
) -> AgentAccessConnector | None:
    if connector is None:
        return None
    return AgentAccessConnector(url=connector.url, client_id=connector.client_id)


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
    state = resolve_agent_access_state(
        email=current_user.email,
        has_mcp_access=await user_has_permission(
            db, current_user.id, MCP_ACCESS_PERMISSION
        ),
        linked_sub=current_user.auth0_sub,
    )
    return AgentAccessResponse(
        state=state,
        email=current_user.email,
        username=current_user.username,
        connected_on=_connected_on(state, current_user.agent_access_linked_at),
        connector=_serialize_connector(get_settings().mcp_connector),
    )
