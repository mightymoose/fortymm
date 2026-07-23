# The MCP server is an OAuth Resource Server trusting Auth0

Date: 2026-07-22 (date-numbered — sequential numbers collide across concurrent
worktrees; see the note in `20260718-the-match-flow-is-shared-services-behind-http-and-mcp-adapters.md`)

## Status

Accepted — decided before implementation, from a described goal ("use Auth0 for
some kind of tokens so we can easily connect agents to our MCP server"). No
issue number yet.

**Supersedes** the auth stance of
`20260718-the-match-flow-is-shared-services-behind-http-and-mcp-adapters.md`
and `20260719-tournament-verbs-are-shared-functions-behind-http-and-mcp-adapters.md`
— specifically their "MCP auth reuses the opaque `context="api"` bearer token,
access is inherited from who-can-mint (operator-only), no MCP-specific RBAC"
decision. Those ADRs' *shared-service-layer* decision (one service behind HTTP
and MCP adapters) is unchanged; only how the **MCP transport authenticates** and
**who is authorized** changes here.

> **Amended by #1159 (2026-07-23).** Two decisions below have since been
> superseded and one rested on a false premise — see the inline amendment notes
> on decisions **4** (the in-session link flow) and **6** (the opaque bearer
> path). Auto-provision/match by verified Auth0 email
> (`20260722-mcp-accounts-auto-provision-and-match-by-verified-auth0-email.md`)
> is now the **only** MCP onboarding path; both the in-session Auth0-link flow
> and the opaque `context="api"` API-token flow have been removed platform-wide.

## Context

Today the MCP server (`app/mcp_server.py`, FastMCP 3.4.x, streamable-HTTP at
`/mcp/`, public at `uat.fortymm.com/api/mcp/`) authenticates with an **opaque
personal bearer token** — a `UserToken` with `context="api"`, minted only via
`POST /v1/api-tokens` behind the operator-only `api_token.manage` permission.
The prior MCP ADRs flagged this as **operator-only until token minting is
broadened (#1130)**: a human operator mints a long-lived secret and pastes it
into an agent host. That is friction, it hands a bearer secret around, and it
scopes MCP to operators only.

We want agents (Claude, Cursor, …) to connect through the **standard MCP 2025
OAuth flow**: the agent host pops a browser, the human logs in, the host
receives a token automatically and refreshes it on its own. That requires an
OAuth Authorization Server. Rather than build one, we trust **Auth0** as the
Authorization Server and make the MCP server an **OAuth Resource Server**.

A tension shapes the mechanism: the MCP server runs `stateless_http=True` across
two UAT replicas with no session affinity (the reason called out in `main.py`).
Any auth that needs per-process state (a client store, self-minted refresh
tokens) is incompatible with that deployment.

## Decision

**The MCP server is a stateless OAuth 2.1 Resource Server that trusts Auth0 for
authentication only; all authorization stays in fortymm RBAC.**

Concretely:

1. **Mechanism: `RemoteAuthProvider` wrapping a `JWTVerifier`, not
   `Auth0Provider`.** FastMCP's `Auth0Provider` is a stateful OAuth *proxy* (it
   mints its own FastMCP JWTs, needs a `client_secret` and an `AsyncKeyValue`
   client store) — incompatible with our stateless, multi-replica deployment.
   `RemoteAuthProvider` is the pure, stateless Resource-Server primitive: it
   wraps a `TokenVerifier` and serves the RFC 9728 protected-resource metadata +
   `401 WWW-Authenticate` challenge that MCP clients need for discovery and
   Dynamic Client Registration against Auth0 directly. `JWTVerifier` does the
   verification: JWKS fetch (built-in 1-hour cache), and `RS256` / `iss` / `aud`
   / `exp` checks. Because verification is pure signature checking, it survives
   round-robin across replicas with no shared state.

2. **The public-origin identity.** The server is mounted internally at `/mcp/`
   but is public at `uat.fortymm.com/api/mcp/` behind nginx that strips `/api`.
   The resource identifier and every URL in the protected-resource metadata must
   reflect the **public** origin, or client discovery breaks. So `base_url` /
   `resource_base_url` are passed as explicit public values from config, never
   derived from the internal mount.

3. **Auth0 is authentication-only; authorization is fortymm RBAC.** The token
   proves *who* the caller is (its `sub`); it does not decide *what* they may do.
   We do **not** require Auth0 scopes/permissions. Access requires, in fortymm:
   an explicitly **linked** account (§4) that holds the new **`mcp.access`**
   permission. One source of truth for grant/revoke (the existing RBAC admin
   UI), and revoking `mcp.access` cuts an agent off immediately even while its
   Auth0 token is still valid.

4. **Identity is bound by an explicit, in-session link — not email-matching or
   auto-provisioning.** A new nullable, unique `users.auth0_sub` column holds the
   binding. A logged-in fortymm user links once via a server-side confidential
   OAuth code flow (`GET /v1/auth0/link/start` → Auth0 login → `GET
   /v1/auth0/link/callback` exchanges the code, verifies the id_token, binds its
   `sub` to `current_user`). The binding is **one-to-one**: a `sub` already
   linked to a different live user is rejected (no silent takeover); a user may
   overwrite their own binding; a repeat of the same `sub` is a no-op. We store
   `sub` only — no email/PII we don't use for authz. At MCP time the verifier
   resolves the token's `sub` → the linked, non-tombstoned `User`.

   > **Superseded by #1159 (2026-07-23).** The in-session link flow
   > (`/v1/auth0/link/*`, `app/auth0_link.py`, the Settings → *Agent access*
   > UI) has been **removed**. A `sub` is now bound to a fortymm user
   > automatically at MCP-token time by matching the token's verified Auth0
   > email to an existing account (or provisioning one) — see
   > `20260722-mcp-accounts-auto-provision-and-match-by-verified-auth0-email.md`.
   > The one-to-one, no-silent-takeover binding rule described here is preserved
   > by that flow; only the explicit in-session link step is gone.

5. **The `mcp.access` permission is granted via the Beta tester role.** It is a
   new seeded permission (`scripts/seed_rbac.py`), added to the existing "Beta
   tester" bundle, so early-access testers can self-serve-connect an agent while
   the capability stays deliberately gated (not open to every user).

6. **The homegrown token is replaced on the MCP surface only.** The MCP verifier
   stops resolving `context="api"` tokens. The opaque token and its HTTP bearer
   path (`sessions._resolve_current_user`, `POST /v1/api-tokens`, the admin UI)
   are **kept** — the iOS app depends on HTTP bearer. Migrating HTTP bearer to
   Auth0 (and then deleting `api_tokens.py`) is deliberately out of scope.

   > **Corrected & superseded by #1159 (2026-07-23).** The premise "the iOS app
   > depends on HTTP bearer" was **false**: the iOS app authenticates with a
   > `Cookie: session=<token>` header (`context="session"`), never the opaque
   > `context="api"` bearer — as does the web client and the e2e suite. Since
   > #1156 the MCP surface stopped resolving opaque tokens, leaving the
   > `context="api"` bearer path with **zero live consumers**. It has therefore
   > been removed entirely: `app/api_tokens.py`, `app/api_token_auth.py`, the
   > bearer branch of `sessions._resolve_current_user`, the `api_token.manage`
   > permission, and the Administration → *API Tokens* UI are all gone.
   > Cookie-session auth (what iOS/web/e2e actually use) is unchanged.

The tool contract is unchanged: the verifier injects `claims["user_id"]` after
mapping, so every `@mcp.tool` and `_authenticated_user_id()` are untouched.

## Consequences

- **Better agent onboarding, no shared secret.** Hosts complete an OAuth login
  and manage token lifecycle themselves; no operator pastes a long-lived bearer.
- **A one-time human link step per user.** A fortymm user must log into Auth0
  once (Google/DB connection) while signed into fortymm to bind the two
  identities. Auth0 is a new, separate identity system from fortymm's magic-link
  login; the link is what ties them.
- **Two Auth0 registrations:** an API/Resource-Server (audience for the agent's
  token) and a Regular Web Application (confidential client for the link flow).
  The only secret we store is that web app's `client_secret`; verification needs
  no secret (JWKS is public).
- **Fails closed when unconfigured.** With `AUTH0_*` unset (local/qa/e2e
  compose), the api still boots and MCP still mounts, but every MCP request 401s
  — no valid issuer/audience can be satisfied. Unit tests exercise the verifier
  with a locally-generated RS256 keypair; the full browser flow is a UAT concern.
- **The opaque-token MCP connection stops working on UAT** once this ships; a
  user re-adds the server as an OAuth connector and links their account.
- **A verification risk to close during rollout:** every advertised `.well-known`
  metadata URL must be reachable through nginx with the `/api` strip, and Auth0
  must honor the resource indicator so the issued token's `aud` matches our API
  identifier. Both are checked end-to-end against UAT, not assumed.
