# The match flow is a shared service layer behind HTTP and MCP adapters

Date: 2026-07-18 (date-numbered — sequential numbers collide across concurrent
worktrees; see ADR-0788's note and the duplicate 0915s in this directory)

## Status

Accepted — decided before implementation, from a described goal ("add an MCP
server to the API that uses the normal auth method and exposes match creation,
score entry, and the approval/correction flow"). No issue number yet. Builds
directly on **PR #1130/#1131** ("Opaque API tokens (`context="api"`) for
programmatic bearer auth"), which is the auth mechanism this ADR reuses.

## Context

The match-flow write logic — create a match, enter/update/delete a per-game
score, propose a result, accept a standing result (and counter it) — lives
**inline in the `matches.py` route handlers**. `create_match`
(`matches.py:545`) resolves the opponent, enforces the rated-needs-opponent
rule, builds the sides, commits, and serialises, all in the handler body.
`post_match_result` (`matches.py:1687`) is ~130 lines of row-locking, board
compaction, the first-post-vs-counter negotiation gates, `finalize_match`, and
fire-and-forget notifications — inline. Only `accept_match_result` already
delegates its core to `accept_standing_result` in `result_acceptance.py`, and
that seam is the one that works: the handler maps two **domain exceptions**
(`StandingResultConflictError`, `PostedGamesNotDecisiveError`) to 409s.

We want a second caller of this logic — an **MCP server** so an agent can drive
the same flow — without duplicating the negotiation rules or letting the two
callers drift. An MCP tool cannot catch an `HTTPException`, and `api/CLAUDE.md`
forbids FastAPI imports in the service layer. So the logic must speak a
transport-neutral contract that both an HTTP handler and an MCP tool can adapt.

The auth mechanism already exists: `POST /v1/api-tokens` mints an opaque,
sha256-hashed `context="api"` bearer token, and `get_current_user` resolves
`Authorization: Bearer <token>` via `_find_api_token_user` (`sessions.py:375`),
excluding tombstoned users. We reuse it rather than inventing MCP-specific auth.

## Decision

### Match-flow write logic moves into a shared service layer

Following `api/CLAUDE.md`'s three-layer rule (handler → provider → plain
service class), the create/score/propose/accept logic is extracted into service
object(s) with plain `__init__`s and no FastAPI imports, constructible in a REPL
or test with a raw session. Player search — the web opponent typeahead's
existing endpoint logic — is factored the same way so MCP and HTTP share it.

### Services return the domain `Match` and raise domain exceptions; adapters map

The service trades in the domain `Match` and a family of **domain exceptions**,
extending the pair that already exists in `result_acceptance.py`. New members
cover every case currently raised inline as an `HTTPException` in these
handlers: e.g. `SelfMatchError`, `OpponentNotFoundError`,
`RatedNeedsRegisteredOpponentError`, `MatchClosedError`,
`NegotiationConflictError` (carries the loaded `Match` so an adapter can rebuild
the viewer-relative snapshot), `ScoreConflictError` (carries the committed
score). `MatchLockUnavailable` already exists.

- The **HTTP adapter** maps each domain exception to the **exact status code and
  body it produces today** — the wire contract does not move a byte — and
  serialises via the shared serializer.
- The **MCP adapter** maps the same exceptions to FastMCP `ToolError`s with
  **actionable messages** (see below) and returns `MatchDetails` as structured
  content on success.

Rejected: services returning the already-serialised `MatchDetails` DTO. That
drags viewer-relative response-shaping into the service and couples the MCP
payload to the web BFF view — the coupling the split exists to avoid.

### The `MatchDetails` serializer moves to a shared module both adapters import

`_serialize_details` (today private to `matches.py`) moves to a module both the
HTTP handlers and the MCP tools import, so both surfaces produce the same view
object without one router depending on another's internals.

### The MCP server is FastMCP, mounted on the same app at `/mcp`

FastMCP 3.x (`fastmcp>=3.4,<4`, 3.4.4 at implementation — the current PyPI major;
the earlier "2.x" note was superseded), hand-written tools (not OpenAPI-generated
— we curate agent-shaped verbs), Streamable HTTP transport, mounted
`app.mount("/mcp", mcp.http_app(path="/"))` (the `path="/"` form yields the
intended `/mcp` endpoint rather than a nested `/mcp/mcp`).
The FastMCP ASGI app has **its own lifespan** (the Streamable-HTTP session
manager) which **must be combined** into the FastAPI lifespan, or every MCP call
500s. Always mounted; **no env flag**. It is one new dependency (`fastmcp`).

The CSRF middleware (`main.py:149`) **only engages when a session cookie is
present**, so cookieless bearer MCP requests bypass it by construction — no
exemption needed. A mounted Starlette sub-app does **not** contribute to the
parent `openapi.json`, so the MCP endpoint does not appear in `schema.d.ts` /
`Types.swift`; the regen step is run as a drift safety-check and is expected to
be a no-op.

### Auth is one shared token→user resolver wrapped in a FastMCP `TokenVerifier`

The bare lookup — `hash_token(raw)` → live `context="api"` `User`, tombstoned
excluded — is extracted into one function that **both** `_find_api_token_user`
(the HTTP bearer path) and a FastMCP `TokenVerifier` call, so MCP auth and
API-token auth can never drift. The verifier authenticates *every* tool at the
transport; unauthenticated calls fail there, not inside a tool. Each tool owns
its own DB session via a shared helper (`api/CLAUDE.md`: "outside a request you
own the session lifecycle yourself").

### The tool surface is nine curated verbs

Reads: `get_match`, `list_my_matches`, `search_players`. Writes: `create_match`,
`enter_game_score`, `update_game_score`, `delete_game_score`, `propose_result`
(one tool for both the first proposal and a counter/correction, via
`supersedes_result_id`), `accept_result`. The reads exist because an agent
cannot drive the negotiation blind — it re-reads state with `get_match` to learn
whose turn it is and the `result_id` to accept or supersede.

### Errors surface as actionable `ToolError`s; the agent recovers via `get_match`

Reconcilable conflicts (`NegotiationConflictError`, `ScoreConflictError`) map to
a `ToolError` whose message names the recovery (*"this proposal was superseded;
call `get_match` for the current standing result, then counter or accept"*).
Tool return schemas stay clean — happy path is always `MatchDetails`, errors are
errors — because the reconciliation state is always one `get_match` away.
Rejected for v1: bespoke structured conflict payloads (a discriminated
`{ok, conflict, match}` union on every tool) — a nicety to add later if agents
thrash, not warranted now.

### Access is inherited from who-can-mint; no MCP-specific RBAC

An MCP call is authorized exactly like the equivalent HTTP endpoint — a valid
`context="api"` token identifies the user; authorization is the same in-domain
participant check the services enforce. Minting stays gated on `api_token.manage`
(operator-only, per #1130), so the MCP server is **operator-only for now**. This
is a **known, accepted limitation**, not fixed here — broadening self-serve token
minting is #1130's surface, orthogonal to adding the server.

### Testing is three-tiered

The **service layer** carries the branch matrix (create/score/propose/accept/
counter/conflicts/search) via direct construction with a real `db_session`. The
existing **HTTP endpoint tests stay green and unchanged** as a regression net
proving the wire contract held. **MCP tests are thin**: a valid bearer token
drives one happy-path round-trip (create → score → propose → accept), an
invalid/missing/tombstoned token is rejected at the transport, and one
representative conflict surfaces as a `ToolError`.

## Consequences

- **One source of truth for the match flow.** The negotiation rules live once,
  in services; the HTTP handler and the MCP tools are thin adapters. A future
  third caller (a worker, a script) reuses the same services.
- **The HTTP wire contract is unchanged.** Every current status code and body is
  reproduced by the HTTP adapter; the endpoint tests are the proof. If one has
  to change, that is a red flag the refactor altered behavior.
- **`fastmcp` is a new dependency** in `api/pyproject.toml`, and the FastAPI
  lifespan gains the FastMCP session-manager lifespan.
- **The MCP server is operator-only** until token minting is broadened — an
  inherited limitation, documented, not a bug.
- **`api/`-only, no schema change** (reuses `UserToken`; no new column or
  migration). No web/iOS change; regen is a drift check expected to no-op.
