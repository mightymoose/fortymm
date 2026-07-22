# The remaining tournament verbs get HTTP + MCP adapters — including the destructive and admin ones

Date: 2026-07-22 (date-numbered — sequential numbers collide across concurrent
worktrees; see ADR-0788's note and the duplicate 0915s in this directory)

## Status

Accepted — decided before implementation, from a described goal ("convert the
rest of the tournament endpoints into MCP calls using the same patterns … pull
the business logic out into a service, and both the controller and the MCP entry
point are thin wrappers"). No issue number yet. This is a straight continuation
of
**`20260719-tournament-verbs-are-shared-functions-behind-http-and-mcp-adapters.md`**
(ADR-0719) — the same pattern applied to the tournament endpoints that ADR-0719
did **not** cover — and inherits the match-flow MCP ADR
(`20260718-the-match-flow-is-shared-services-behind-http-and-mcp-adapters.md`)
and the opaque `context="api"` bearer auth (PR #1130/#1131).

## Context

ADR-0719 converted six tournament verbs (get, list, edit, cut, uncut, request a
solve; the preview work added a seventh). The following HTTP endpoints still
carry their business logic **inline** in `tournaments.py` (or, for the admin
read, in `admin_schedule_solves.py`) with **no MCP tool**:

| HTTP route | handler | note |
|---|---|---|
| `POST /v1/tournaments` | `create_tournament` | authoring |
| `DELETE /v1/tournaments/{id}` | `delete_tournament` | **destructive** |
| `POST …/transitions` | `create_tournament_transition` | lifecycle (publish / go-live / archive), go-live materializes matches + triggers a solve |
| `POST …/events` | `create_event` | authoring |
| `PATCH …/events/{event_id}` | `update_event` | pool/draw-type freeze + timezone reanchor |
| `DELETE …/events/{event_id}` | `delete_event` | **destructive** |
| `POST …/events/{event_id}/entries` | `enter_event` | dual-actor (self-register / director-adds, ADR-0784); eligibility + capacity lock |
| `DELETE …/events/{event_id}/entries/{entry_id}` | `withdraw_from_event` | soft-delete, owner-or-self (ADR-0784) |
| `PATCH …/fixtures/{fixture_id}/placement` | `place_fixture` | delegates to `match_calls.apply_manual_placement` |
| `GET /v1/admin/schedule-solves` | `list_schedule_solves` | **RBAC-gated admin read**, separate router |

## Decision

**1. Extract each to a transport-neutral shared verb, exactly as ADR-0719
prescribes** — a module-level `async def verb(db, *, <ids>, actor: User) -> <domain/DTO>`
that owns no transport concern, raises domain exceptions from
`tournament_errors.py` (never `HTTPException`, never `ToolError`), and preserves
the endpoint's existing row-locking, refusal **ordering** (404 → 403 → 409/422,
ADR-0017/ADR-1001), and side effects (go-live's `materialize_live_draw` +
`request_solve`; the entry capacity lock; the soft-delete). **Not** a
`TournamentService` class — ADR-0719's reasoning stands, and `api/CLAUDE.md`'s
"stateless service → just a module-level function taking `db`" rule of thumb
governs (there is no collaborator worth injecting). The HTTP handler thins to a
`try: await verb(...) except <DomainError>: raise HTTPException(...)`; the MCP
tool maps the same domain exceptions to `ToolError` prose.

New verb modules, grouped by resource so no file grows a second 900-line router:
`tournament_lifecycle.py` (create / delete / transition the tournament),
`tournament_events.py` (create / update / delete an event),
`tournament_entries.py` (enter / withdraw), `tournament_placement.py`
(place a fixture). The admin read gets a reader function its own router and the
MCP tool both call.

**2. Every one of the ten gets an MCP tool — including the two deletes and the
admin read.** The MCP adapter resolves the caller through the *same*
`context="api"` bearer path as HTTP and the shared verb runs the *same* auth
gate: the deletes are owner-gated, the admin read runs the identical
`require_permission` check. So exposing them over MCP grants an authenticated
agent **no capability its user does not already have over HTTP** — withholding a
tool would buy no safety, only an asymmetric surface where the same token can do
a thing through one transport but not the other. Destructiveness is a property of
the verb, mitigated by the owner gate, not by which transports can reach it.

**3. Lifecycle is one generic `transition_tournament(tournament_id, to)` MCP
tool**, mirroring the single generic `POST …/transitions` HTTP endpoint and its
one `transition_tournament` verb — not three semantic `publish` / `go_live` /
`archive` tools. It keeps HTTP and MCP symmetric and the tool surface minimal;
the `to` enum is self-documenting in the tool schema. Named semantic wrappers
stay a cheap, non-breaking addition if agent ergonomics later warrant them.

**4. `enter_event` keeps its dual-actor model over MCP** (ADR-0784): the tool
takes an optional `user_id`, absent = self-registration, present = a director
entering that player, judged by the identical ownership gate and the identical
four refusal codes as HTTP.

## Consequences

- The wire contract of all ten HTTP endpoints is unchanged; their existing
  endpoint tests are the contract proof and stay green untouched. New tests are
  branch-matrix tests against each verb (constructed directly with a real
  `db_session`) plus a thin MCP round-trip per tool.
- MCP-only response schemas (for the 204/no-body verbs — deletes, withdraw) live
  in `mcp_server.py` and never reach `openapi.json`, as ADR-0719 established.
- `mcp_server.py` grows by ten tools; the tournament router **shrinks** as the
  inline logic (and its helpers) moves into the verb modules.
- Regenerate `schema.d.ts` + `Types.swift` if any route docstring/signature
  shifts during thinning (it should not, but the CI drift guard is the check).
