"""Response shape for the Claude-access settings page (``GET
/v1/settings/agent-access``).

One page, one endpoint (the BFF rule in the root ``CLAUDE.md``): everything the
page renders — which panel to show, the email Claude must be signed in with, and
the connector pair to paste — arrives in a single payload, already decided
server-side.
"""

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel


class AgentAccessState(StrEnum):
    """Which panel the settings page renders — a closed set, decided on the
    server so the client never re-derives it from a handful of nullable fields.

    The four members are ordered by the precedence
    :func:`app.agent_access.resolve_agent_access_state` applies, which is the
    actual decision (and is tested as one). They are mutually exclusive by
    construction: exactly one is returned.
    """

    #: The account has no email address. Claude signs the player in *by email*,
    #: so there is nothing to connect with until they claim one — this outranks
    #: every other consideration, including whether they hold the grant.
    GUEST = "guest"

    #: The account has an email but not the ``mcp.access`` permission. Agent
    #: access is an operator-granted capability (the Beta tester bundle), so
    #: the page offers to request it rather than showing setup steps that would
    #: end in a 401.
    GATED = "gated"

    #: Permitted, with no Auth0 identity bound yet — show the setup steps.
    READY = "ready"

    #: Permitted, with an Auth0 identity bound (``users.auth0_sub``). An agent
    #: has signed in as this player at least once.
    CONNECTED = "connected"


class AgentAccessConnector(BaseModel):
    """The pair a player pastes into Claude's "Add custom connector".

    Present or absent as a whole — a half-filled connector (an empty client-id
    box) makes a player paste nothing and hit an inscrutable failure, so
    ``app.config.Settings.mcp_connector`` resolves it all-or-nothing.
    """

    #: Connector URL, normalised to exactly one trailing slash by the settings
    #: layer (a missing slash makes nginx answer discovery with a 307, which has
    #: surfaced as a 502 on every MCP call).
    url: str

    #: The **public** OAuth client id. Not a secret — a public client id is
    #: designed to be handed to the user.
    client_id: str


class AgentAccessResponse(BaseModel):
    """Everything the Claude-access settings page renders."""

    #: Which panel to show. The whole decision, made once, on the server.
    state: AgentAccessState

    #: The email Claude must be signed in with for its token to match this
    #: account (``app.auth0_provisioning`` matches on the verified email).
    #: ``None`` exactly when ``state`` is ``guest``.
    email: str | None

    #: The caller's username, so the page can address them without a second
    #: call to ``GET /v1/session``.
    username: str

    #: When an Auth0 identity was first bound to this account
    #: (``users.agent_access_linked_at``) — the "Connected <date>" line. Only
    #: ever set in the ``connected`` state, and may still be ``None`` there for
    #: an account linked before the column existed.
    connected_on: datetime | None

    #: The connector pair, or ``None`` when this deployment has no MCP OAuth
    #: configuration. **Independent of ``state``**: it reports what the *server*
    #: is configured with, not what the player has done, so it populates
    #: identically in all four states.
    connector: AgentAccessConnector | None
