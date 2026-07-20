# Tournament read/write verbs are shared functions behind HTTP and MCP adapters

Date: 2026-07-19 (date-numbered — sequential numbers collide across concurrent
worktrees; see ADR-0788's note and the duplicate 0915s in this directory)

## Status

Accepted — decided before implementation, from a described goal ("add MCP tools
for some tournament functionality: get a tournament, edit a tournament, build a
cut, run a simulation, get a schedule"). No issue number yet. Builds directly on
**the match-flow MCP ADR** (`20260718-the-match-flow-is-shared-services-behind-http-and-mcp-adapters.md`)
— this is that same pattern applied to the tournament domain — and reuses the
opaque `context="api"` bearer auth from **PR #1130/#1131**.

## Context

We want an agent to drive part of the tournament flow over the existing MCP
server (`api/app/mcp_server.py`, mounted at `/mcp`), the same way it already
drives the match flow. The five requested verbs, once mapped onto what the
codebase actually has, are:

1. **Get a tournament** — the BFF detail read `GET /v1/tournaments/{id}`
   (`get_tournament`, `tournaments.py:917`), returning `TournamentDetailRead`.
2. **Edit a tournament** — `PATCH /v1/tournaments/{id}` (`update_tournament`,
   `tournaments.py:999`), request `TournamentUpdate`, owner-gated.
3. **Build a cut** — `POST /v1/tournaments/{id}/events/{event_id}/draw`
   (`cut_event_draw`, `tournaments.py:2484`), which **cuts a draw**: generates an
   event's **fixtures** from its entrants (`cut_draw`, `tournament_draws.py:356`).
   Its inverse — **uncut** — is `DELETE .../draw` (`uncut_draw`).
4. **Run a simulation** — there is **no "simulation"** in this domain. The
   nearest — and the intended — capability is running the **scheduler**: request
   a **solve** via `POST /v1/tournaments/{id}/schedule/solves`
   (`request_schedule_solve`, `tournaments.py:2862` → `request_solve`,
   `schedule_solves.py:273`), the CP-SAT job that computes *when and where*
   matches play. See the **Solve** glossary entry (`CONTEXT.md`): a solve is not
   a what-if projection of outcomes.
5. **Get a schedule** — there is **deliberately no** `GET .../schedule` endpoint;
   the schedule (each event's fixtures with their **placement**, plus the latest
   **solve**) rides the detail BFF (`tournaments.py:2614-2631`).

Two structural facts make this unlike the match flow:

- **The domain cores are already extracted.** `cut_draw` / `uncut_draw`
  (`tournament_draws.py`) and `request_solve` (`schedule_solves.py`) are already
  standalone, FastAPI-free functions. What is *not* extracted is the per-handler
  **glue** around them: owner-gating (`_require_owner`), the `FOR UPDATE`
  load-lock (`_get_tournament_for_update_or_404`), and the machine-readable
  **refusal codes** (`_draw_refusal`, `_no_drawn_events_refusal`). There is no
  `TournamentService` class; `tournaments.py` is a ~2,900-line router.
- **Writes are owner-gated, not RBAC-gated.** Every tournament mutation checks
  `created_by_user_id == current_user.id`; reads require the `tournament.view`
  permission plus a `_visible_to` visibility filter.

## Decision

### The three write verbs get transport-neutral shared functions; HTTP handlers become adapters

For just these three paths (edit, cut/uncut, request-solve) — **not** the whole
router — the owner-check + load-lock + refusal-raising orchestration is extracted
into transport-neutral functions that raise **domain exceptions** (never
`HTTPException`), constructible with a raw session. The existing HTTP handlers
are refactored into thin adapters that call these functions and map each domain
exception to the **exact status code and body they produce today** — the wire
contract does not move a byte, and the existing endpoint tests are the proof. The
MCP tools call the same functions and map the same exceptions to actionable
`ToolError`s.

Rejected: **replicating the glue inside `mcp_server.py`** (calling the
already-shared `cut_draw` / `request_solve` cores directly and re-implementing
owner-check + refusal mapping there). It is faster and leaves the handlers
untouched, but it puts the owner/refusal logic in two places — the precise drift
the match-flow ADR exists to prevent. We are following that ADR, not diverging
from it for convenience.

Rejected: **extracting a full `TournamentService` class** over the whole router
now. The three verbs do not need it, and a 2,900-line refactor is out of scope.

### Reads reuse the queries and a shared serializer, gated exactly as HTTP

`get_tournament` (MCP) reuses the same `tournament_queries.*` reads +
`latest_solve` and the `_serialize_detail` serializer the HTTP handler uses; the
serializer moves to a module both surfaces import (as the match ADR moved
`_serialize_details`), so neither router depends on the other's internals. MCP
reads enforce the **same** `tournament.view` permission and `_visible_to`
visibility as the HTTP read — the MCP surface is not a way around them.

### `get_schedule` is a dedicated tool with a new projection schema

Rather than fold the schedule into `get_tournament`, MCP gets a dedicated
`get_schedule` verb returning a narrower, agent-shaped **schedule projection** —
each event's fixtures (pairing, table, predicted start, pool/round/position)
grouped for reading, plus the latest solve's status/verdict. It reuses the same
`fixtures_by_event` + `latest_solve` queries and the existing
`TournamentFixtureRead` / `ScheduleSolveRead` shapes; the only new artifact is a
small wrapper response schema. This schema is **MCP-only** — a mounted sub-app
does not contribute to the parent `openapi.json`, so it never reaches
`schema.d.ts` / `Types.swift`, and the regen step stays a drift no-op.

### The tool surface is seven curated verbs

Reads: `get_tournament`, `get_schedule`, `list_my_tournaments`. Writes
(owner-gated): `edit_tournament`
(mirrors the **full** `TournamentUpdate` partial, table catalogue included, so
the two surfaces never disagree on what is editable), `build_cut` and `uncut`
(the cut/uncut pair, per event), `request_schedule_solve` (the "run a
simulation" verb; async — returns the queued `ScheduleSolveRead`, and the caller
reads the verdict later via `get_schedule` / `get_tournament`).

`list_my_tournaments` is the discovery read that makes the surface drivable: an
agent needs a `tournament_id` before it can call anything else. It is
**owner-scoped** (`created_by_user_id == caller`), not visibility-scoped like the
HTTP `GET /v1/tournaments` list — because the write verbs are owner-gated, the
tournaments an agent can act on are the ones it created. It reuses that list's
exact batched-query machinery with the added owner filter and returns
`list[TournamentDetailRead]` (no new schema).

### Access is inherited; writes are owner-gated

As in the match ADR, an MCP call is authorized exactly like its HTTP twin: a
valid `context="api"` token identifies the caller, minting stays gated on
`api_token.manage` (operator-only for now — a known, inherited limitation), and
**write verbs additionally require the caller to be the tournament's owner** — an
MCP caller can only edit/cut/solve tournaments they created.

### Errors surface as actionable `ToolError`s

Refusals map to `ToolError`s that name the recovery: a cut refused for
evidence-of-play, a solve refused because no event is drawn
(`no_drawn_events`), a league change refused after publish, an absent
tournament/event. Reconcilable/again-later cases (a solve already in flight, a
lock held) say "retry". Machine-readable **refusal codes** (ADR-0968) are carried
in the message text for the agent.

### Testing is three-tiered

The extracted **write functions** carry the branch matrix (owner-gate,
refusals, the edit state-rules, cut/uncut, solve coalescing) via direct
construction with a real `db_session`. The existing **HTTP endpoint tests stay
green and unchanged**, proving the wire contract held. **MCP tests are thin**: a
valid bearer token drives a read + one representative write per verb, an
invalid/missing/tombstoned token is rejected at the transport, and one
representative refusal surfaces as a `ToolError`.

## Consequences

- **One source of truth per tournament verb.** The owner/lock/refusal
  orchestration for edit, cut, and solve lives once; HTTP and MCP are thin
  adapters. A future third caller reuses the same functions.
- **The HTTP wire contract is unchanged** for the three refactored routes; the
  endpoint tests are the proof, and a required change to one is a red flag.
- **`api/`-only, no schema change / migration.** Reuses existing models; the one
  new Pydantic schema is the MCP-only schedule projection. No web/iOS change;
  regen is a drift check expected to no-op.
- **The MCP tournament surface is operator-only and owner-gated** — inherited
  limitations, documented, not bugs.
- **"Simulation" is retired as vocabulary** in favour of **solve** (`CONTEXT.md`),
  so the tool is named `request_schedule_solve`, not `run_simulation`.
