"""Shared application configuration.

New configuration belongs here as a field on ``Settings`` rather than another
ad hoc ``os.environ.get(...)`` call site scattered through the codebase (see
"Module layout for new code" in ``api/CLAUDE.md``). Existing ad hoc readers
(``app/db.py``, ``app/captcha.py``, ``app/queue.py``) predate this module and
are left as-is.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    #: The CP-SAT wall-clock time cap, in seconds, for a schedule solve
    #: (``app.scheduling.solve``'s ``time_cap_s``). The ADR's default is a
    #: hard cap: mid-tournament we want a good answer now, not a proof, and
    #: FEASIBLE under the cap is accepted. Large one-off solves (e.g. a big
    #: multi-day tournament with hundreds of fixtures) may need this raised
    #: well past the default — there is deliberately no upper clamp.
    solver_time_cap_s: float = 10.0

    #: The CP-SAT wall-clock time cap, in seconds, for a **schedule preview**
    #: solve — the ephemeral, non-persistent solve over a synthetic field (ADR
    #: "a schedule preview is a non-persistent solve over a synthetic field").
    #: Deliberately far tighter than ``solver_time_cap_s``: a preview's
    #: feasibility verdict is cap-independent (SAT is SAT) and only its makespan
    #: estimate loosens slightly under a short cap — a conservative over-estimate
    #: is safe for a preview — while the browser request behind it must not sit
    #: for the full real-solve budget. The dedicated ``preview`` queue jumps it
    #: ahead of pending real solves, so a low cap keeps a preview snappy.
    preview_solver_time_cap_s: float = 5.0

    #: Auth0 tenant domain (e.g. ``fortymm.us.auth0.com``) — the issuer the MCP
    #: JWT verifier trusts and the origin its JWKS is fetched from. Empty means
    #: Auth0 is unconfigured: the api still boots and MCP still mounts, but every
    #: MCP request 401s (fail-closed — see the "fails closed when unconfigured"
    #: consequence in the Auth0 Resource-Server ADR).
    auth0_domain: str = ""

    #: Auth0 API identifier registered for the MCP Resource Server — the ``aud``
    #: an agent's access token must carry to be accepted. Empty = fail-closed.
    auth0_audience: str = ""

    #: Client id of the Auth0 Regular Web Application (confidential client) used
    #: for the one-time account-link code flow. Empty = link flow unconfigured.
    auth0_link_client_id: str = ""

    #: Client secret of that Auth0 web application — the only Auth0 secret we
    #: store (verification needs no secret; JWKS is public). Empty = fail-closed.
    auth0_link_client_secret: str = ""

    #: Public base URL of the MCP server (e.g. ``https://uat.fortymm.com/api``).
    #: Passed explicitly rather than derived from the internal ``/mcp/`` mount so
    #: the protected-resource metadata reflects the public origin behind nginx.
    mcp_public_base_url: str = ""

    #: Public resource identifier advertised in the RFC 9728 protected-resource
    #: metadata (the MCP server's public origin). Empty = fail-closed.
    mcp_public_resource_url: str = ""

    #: Redirect URI registered with the Auth0 web application for the account-link
    #: callback (``GET /v1/auth0/link/callback``). Empty = link flow unconfigured.
    auth0_link_redirect_uri: str = ""


def get_settings() -> Settings:
    """Read settings from the environment.

    Constructed fresh on every call rather than cached at import time, so
    tests can override an environment variable (``monkeypatch.setenv(...)``)
    per test and see it take effect — mirrors ``app.db.get_database_url()``.
    """
    return Settings()
