"""Shared application configuration.

New configuration belongs here as a field on ``Settings`` rather than another
ad hoc ``os.environ.get(...)`` call site scattered through the codebase (see
"Module layout for new code" in ``api/CLAUDE.md``). Existing ad hoc readers
(``app/db.py``, ``app/captcha.py``, ``app/queue.py``) predate this module and
are left as-is.
"""

from dataclasses import dataclass
from enum import StrEnum
from typing import Annotated

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


@dataclass(frozen=True)
class McpConnectorConfig:
    """The complete pair a player pastes into Claude's "Add custom connector".

    The dataclass itself validates nothing — ``McpConnectorConfig("", "")`` is
    constructible. What holds is the *single construction site*:
    :attr:`Settings.mcp_connector` is the only thing that builds one, and it
    returns ``None`` rather than a half-filled instance, so every value reaching
    a caller has both fields non-empty and its URL already normalised. Keep it
    that way — a second construction site is what would make the guarantee
    false, and nothing here would catch it.
    """

    #: The connector URL, always ending in exactly one trailing slash.
    url: str

    #: The public (non-secret) OAuth client id the connector authenticates with.
    client_id: str


class GeocoderChoice(StrEnum):
    """Which geocoding implementation this process uses — a closed set.

    Selection is **explicit configuration**, never inferred from whether a key
    happens to be present (ADR "a venue's coordinates are geocoded server-side
    and not null", 2026-07-26 amendment). Inference failed silently open: an
    environment meant to geocode for real, whose key was missing or rotated
    out, quietly hashed addresses into pseudo-random coordinates and stored
    them as though they were real.
    """

    GOOGLE = "google"
    FAKE = "fake"


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

    #: Public base URL of the MCP server (e.g. ``https://uat.fortymm.com/api``).
    #: Passed explicitly rather than derived from the internal ``/mcp/`` mount so
    #: the protected-resource metadata reflects the public origin behind nginx.
    mcp_public_base_url: str = ""

    #: Public resource identifier advertised in the RFC 9728 protected-resource
    #: metadata (the MCP server's public origin). Empty = fail-closed.
    mcp_public_resource_url: str = ""

    #: Public OAuth client id an MCP client (Claude's "Add custom connector")
    #: authenticates the player with. **Not a secret** — a public client id is
    #: designed to be handed to the user, which is why it may be surfaced to the
    #: browser alongside the connector URL. Empty = no connector is advertised
    #: (see :attr:`Settings.mcp_connector`).
    mcp_oauth_client_id: str = ""

    #: How long an attached realtime stream lets hints pile up before emitting,
    #: in milliseconds. Coalescing is what stops one burst of writes (a draw
    #: advance, a wave of tournament completions) from becoming one dashboard
    #: refetch per write per viewer; it is lossless because a hint is an
    #: idempotent invalidation, so N collapse to 1 with nothing lost. Raise it
    #: to trade freshness for fewer refetches; 0 disables coalescing entirely
    #: (which the tests use so assertions don't each wait a window).
    realtime_coalesce_ms: int = 250

    #: Hard lifetime of a single ``GET /v1/stream`` connection, in seconds.
    #: A stream is deliberately finite: the client reconnects (``EventSource``
    #: does it for free), which re-runs auth, releases any proxy-held buffer,
    #: and bounds how long a process can accumulate attachments that no browser
    #: is on the other end of any more.
    realtime_max_stream_seconds: int = 900

    #: Concurrent streams one user may hold, so a tab-hoarding (or looping)
    #: client cannot pin an unbounded number of attachments in a process. Four
    #: is "a few tabs". Past this, attaching **displaces** that user's oldest
    #: stream rather than refusing the new one: the slot being competed for may
    #: belong to a client that is gone but still connected (a suspended app, a
    #: frozen tab, a sleeping laptop), which the server cannot detect, and
    #: refusing would leave the live newcomer silently deaf until the old
    #: stream's ``realtime_max_stream_seconds`` finally expired.
    realtime_max_connections_per_user: int = 4

    #: Which geocoder resolves a venue's coordinates on write (ADR "a venue's
    #: coordinates are geocoded server-side and not null"). **Defaults to
    #: ``google``** and is validated below, so a process that says nothing gets
    #: the real provider or refuses to start — the test double has to be asked
    #: for by name (``GEOCODER=fake``). The asymmetry is the point: a config
    #: mistake must not silently select a double that writes plausible-looking
    #: nonsense into ``tournaments.address``.
    geocoder: GeocoderChoice = GeocoderChoice.GOOGLE

    #: Google Geocoding API key. Required when :attr:`geocoder` is ``google``
    #: (enforced at construction by :meth:`_require_google_key`); ignored when
    #: it is ``fake``.
    google_geocoding_api_key: str | None = None

    #: Base of the SSE ``retry:`` hint sent to the client, in milliseconds —
    #: how long it waits before reconnecting after the stream ends.
    realtime_retry_base_ms: int = 3000

    #: Random spread added to ``realtime_retry_base_ms``, in milliseconds. The
    #: jitter is the point: without it every stream a restarting pod dropped
    #: reconnects in the same millisecond and the pod is stampeded awake.
    realtime_retry_spread_ms: int = 5000

    #: The ``From`` header on outbound auth mail (``app.email._deliver``), e.g.
    #: ``FortyMM <noreply@fortymm.com>``. Environment-specific and hand-copied
    #: into each deploy's ``.env`` — no repo file can safely hardcode the real
    #: value. ``GET /v1/login/sender`` reads this (via ``email.utils.parseaddr``,
    #: to strip the RFC 5322 display name) so the web client's sender-address
    #: copy can never drift from what actually sends the mail.
    email_from: str = "noreply@fortymm.local"

    #: Per-IP ceiling on tournament **self-entry** (``POST
    #: /v1/tournaments/{id}/events/{event_id}/entries`` with no body), per hour
    #: (#1092). Self-entry carries no permission any more, so this per-IP cap is
    #: the bound on a host minting guest sessions and entering once per session.
    #: Read at ask-time from the environment, never hardcoded — the lesson of
    #: #1552 (the hardcoded sign-in cap starved every QA pass, and the failure
    #: read as a product bug): the QA and e2e compose files raise this so a whole
    #: automated pass from one shared host never reaches it. One venue on one
    #: wifi network can legitimately share an IP, so the 429 tells the player to
    #: retry shortly. The director entry arm carries no rate limit.
    tournament_entry_ip_per_hour: int = 30

    #: The five authentication rate-limit ceilings (issue #1590), each an
    #: independent requests-per-hour count. Production keeps the tight abuse
    #: tiers below; docker-compose.dev.yml and docker-compose.qa.yml raise
    #: them to a finite 1,000/hour so ordinary development, root e2e, and
    #: standalone QA activity never exhaust them. ``app.sessions`` builds its
    #: limiter dependencies once from one ``Settings`` snapshot at import —
    #: these are never re-read per request (hot reconfiguration is out of
    #: scope), so changing an environment variable needs a process restart.
    #:
    #: ``gt=0`` is the boundary check: a zero, negative, fractional, or
    #: non-numeric environment value must fail ``Settings`` construction —
    #: the process refuses to boot — rather than be coerced or silently
    #: replaced with a fallback ceiling.
    email_send_session_limit_per_hour: Annotated[int, Field(gt=0)] = 5
    email_send_ip_limit_per_hour: Annotated[int, Field(gt=0)] = 20
    email_resend_session_limit_per_hour: Annotated[int, Field(gt=0)] = 3
    email_resend_ip_limit_per_hour: Annotated[int, Field(gt=0)] = 10
    login_consume_ip_limit_per_hour: Annotated[int, Field(gt=0)] = 60

    @model_validator(mode="after")
    def _require_google_key(self) -> "Settings":
        """Refuse to construct a ``google`` configuration with no API key.

        Deliberately on the **model**, not in
        ``app.geocoding.dependencies.get_geocoder``: that provider is only the
        FastAPI path, while the RQ worker, the retirement sweep and any script
        construct ``Settings`` too. One guard here covers every entrypoint —
        and because ``lifespan`` calls :func:`get_settings`, a misconfigured
        deploy dies at boot rather than at its first geocode.
        """
        if self.geocoder is GeocoderChoice.GOOGLE and not self.google_geocoding_api_key:
            raise ValueError(
                "GEOCODER is 'google' but GOOGLE_GEOCODING_API_KEY is unset. "
                "Set the key, or ask for the test double by name with "
                "GEOCODER=fake."
            )
        return self

    @property
    def auth0_issuer(self) -> str:
        """The Auth0 tenant's OIDC issuer — ``https://{domain}/`` (Auth0 mints
        tokens with the trailing slash). The single source of the ``iss`` the MCP
        JWT verifier (``app.mcp_server``) trusts when validating an agent's access
        token, so the tenant URL topology is built in exactly one place.
        Meaningful only when ``auth0_domain`` is set."""
        return f"https://{self.auth0_domain}/"

    @property
    def auth0_jwks_uri(self) -> str:
        """The Auth0 tenant's JWKS endpoint — ``https://{domain}/.well-known/jwks.json``,
        where the MCP verifier fetches the tenant's public signing keys to verify
        an agent's access token. The single source of that URL (see
        ``auth0_issuer``). Meaningful only when ``auth0_domain`` is set."""
        return f"https://{self.auth0_domain}/.well-known/jwks.json"

    @property
    def mcp_connector(self) -> McpConnectorConfig | None:
        """The connector a player can paste into Claude — or ``None``.

        Resolved **all-or-nothing**, mirroring ``_build_mcp_auth`` in
        ``app.mcp_server``: only when BOTH ``mcp_public_resource_url`` and
        ``mcp_oauth_client_id`` are non-empty is there anything to advertise. A
        partial config fails closed (``None``) instead of surfacing a broken
        value — a settings page rendering an empty client-id box makes a player
        paste nothing into Claude and hit an inscrutable failure.

        "Non-empty" is asked of the **stripped** value, and the stripped value
        is what ships: a variable set to whitespace (a blank line in a compose
        ``.env``, a heredoc'd Kubernetes secret carrying a trailing newline) is
        an unset variable that merely looks set, and passing it through would
        put an invisible character in the client id a player pastes into Claude.

        The URL is normalised to end in **exactly one** trailing slash whether
        or not the configured value carries one (``deploy/uat/values.yaml``
        currently sets it without). A missing trailing slash makes nginx answer
        discovery with a 307, which has surfaced as a 502 on every MCP call —
        so the slash is fixed here, once, rather than trusted to every deploy.
        """
        resource_url = self.mcp_public_resource_url.strip()
        client_id = self.mcp_oauth_client_id.strip()
        if not (resource_url and client_id):
            return None
        return McpConnectorConfig(
            url=f"{resource_url.rstrip('/')}/",
            client_id=client_id,
        )


def get_settings() -> Settings:
    """Read settings from the environment.

    Constructed fresh on every call rather than cached at import time, so
    tests can override an environment variable (``monkeypatch.setenv(...)``)
    per test and see it take effect — mirrors ``app.db.get_database_url()``.
    """
    return Settings()
