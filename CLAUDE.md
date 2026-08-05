# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working style

<progress_updates>
Before your first tool call, say in one sentence what you're about to do. While working, give a
brief update only when you find something important or change direction. When you finish, lead
with the outcome: your first sentence should answer "what happened" or "what did you find," with
supporting detail after it for readers who want it.
</progress_updates>

<conciseness>
Keep responses focused, brief, and concise. Keep disclaimers and caveats short, and spend most of
the response on the main answer. When asked to explain something, give a high-level summary unless
an in-depth explanation is specifically requested.
</conciseness>

<written_deliverables>
Match the length of written documents to what the task needs: cover the substance, but do not pad
with filler sections, redundant summaries, or boilerplate.
</written_deliverables>

<task_scope>
Deliver what was asked, at the scope intended. Make routine judgment calls yourself, and check in
only when different readings of the request would lead to materially different work. If the
request seems mistaken or a better approach exists, say so in a sentence and continue with the
task as asked rather than quietly narrowing, widening, or transforming it. Finish the whole task,
and stop short of actions that are clearly beyond what was asked.
</task_scope>

<subagent_delegation>
Delegate to a subagent only for large tasks that are genuinely independent and parallelizable,
such as a wide multi-file investigation. Do not delegate work you can finish yourself in a handful
of tool calls, and do not use subagents to verify or double-check your own work. If one subagent
can complete the task, use one rather than several, and keep spawn counts low.
</subagent_delegation>

<self_correction>
Only correct an earlier statement when the error would change the user's code, conclusions, or
decisions. State corrections plainly and briefly, then continue the task. For slips that change
nothing for the user, make the fix and move on without noting it.
</self_correction>

## Repo layout

Monorepo with three deployable/test units — `api/` (FastAPI), `web-client/`
(Vite/React SPA), `e2e/`. Each unit's stack and dependencies are in its own
manifest. The one thing worth stating up front: **`e2e/` is the composed-stack
Playwright suite and `web-client/e2e/` is the web-client-only one — both exist
intentionally.**

Toolchain pinned in `mise.toml`. Run `mise install` once.

## Domain-expert subagents — delegate layer-scoped work

Each unit has a domain-expert subagent in `.claude/agents/`. When a task's
implementation lives entirely inside one unit, **hand it off to that expert** (via
the Agent tool) rather than editing inline — the expert runs in its own context,
reads its unit's `CLAUDE.md`, and self-verifies with that layer's tests. Reserve
this for work you wouldn't finish yourself in a handful of tool calls; fix a
trivial one-line or single-function change directly instead:

| Expert | Owns | Anchor doc |
| --- | --- | --- |
| `api` | `api/` — FastAPI, SQLAlchemy/Alembic, RQ/ortools worker | `api/CLAUDE.md` |
| `web-client` | `web-client/` — React/TanStack/Zod/Tailwind/MSW, **incl. `web-client/e2e/`** | `web-client/CLAUDE.md` |
| `ios` | `ios/` — native Swift/SwiftUI app | `ios/CLAUDE.md` |
| `infra` | `deploy/` + root `docker-compose.*.yml` + `.github/` + `mise.toml` + nginx | `deploy/CLAUDE.md` |
| `e2e` | root `e2e/` — composed-stack Playwright (NOT `web-client/e2e/`) | `e2e/CLAUDE.md` |

The experts **implement but do not ship**: they have no PR/merge authority and
return a summary. **The main session owns everything cross-layer** — integration
across units, the OpenAPI/type-regen dance (`mise run regen-api-types` +
`mise run regen-ios-api-types`), and opening/merging the PR. When a change spans
units (e.g. an API route + its web client), the main session coordinates the
experts and does the regen itself. Destructive shared-cluster/stack ops stay with
the operator — the `infra` expert flags them, it does not run them.

**Sharding a plan across the experts:** `/to-chores` breaks an agreed plan into a
gitignored `.claude/work-order.md` — a checkbox list of small, agent-tagged
**chores** grouped under demoable **tracer-bullet** slices, with `[main]` steps at
the cross-layer seams. `/do-chores` then drives it: dispatches each chore to its
expert in dependency order, verifies, ticks it off, and commits per slice. Arc:
`/grill-with-docs` → `/to-chores` → `/do-chores` → `/land-the-plane`. `/epic` is
the gated conductor for that whole arc from one entry point — it sequences the
four phases but stops at every human gate and never merges (run the individual
skills when you only want one phase). A `check-main-freshness.sh` SessionStart
hook warns when the local default branch is behind origin, since a stale checkout
silently runs an old set of skills/agents (they register at launch).

## Common commands

API (`cd api`, after `python -m venv .venv && source .venv/bin/activate && pip
install -e '.[dev]'`). The usual `uvicorn` / `alembic` / `pytest` / `mypy`
invocations apply. The two that aren't guessable:

```bash
rq worker solver --url "$REDIS_URL"            # required for /v1/health to pass
TEST_DATABASE_URL=postgresql+asyncpg://... pytest   # skip testcontainers, use existing Postgres
```

Docker is required for the default `pytest` run — testcontainers spins an
ephemeral Postgres. `TEST_DATABASE_URL` is how you opt out.

Web client (`cd web-client`) — the scripts are in `package.json`. Two things
they don't tell you: `npm run dev` serves :5173 with **MSW intercepts active in
DEV only** (see `src/main.tsx`), and `npm run test:e2e` spins its **own** dev
server on :5174.

Root e2e (`cd e2e`):

```bash
npm run test          # self-manages a docker compose stack (dev.yml + e2e.yml, --build) and tests it via nginx on :18080
E2E_BASE_URL=http://localhost:8080 npm run test     # against an already-running stack (skips stack management)
```

Full stack via Docker: `docker compose -f docker-compose.dev.yml up`. Nginx on **:8080** proxies `/api/*` → api, `/` → web-client. Use this URL when you want the web app to talk to the real API instead of MSW.

**Preview stacks — the map. Details and failure modes: `deploy/CLAUDE.md`.**

| Stack | How | Where | Email |
| --- | --- | --- | --- |
| QA | up: `scripts/qa-up.sh [id]` · **down: `scripts/qa-down.sh [id]`** | :8085 | captured in **Mailpit** :8087 — never sends real mail |
| UAT | `mise run redeploy-uat` — Helm + **k3d**, *not* compose, chart at `deploy/fortymm/` | :8084, `uat.fortymm.com`, and `https://fortymm-uat.<tailnet>.ts.net` | **real Postmark** — lands in real inboxes |

**CI publishes both Helm charts to GHCR**, alongside the api and web images, so a deploy needs `helm` and no checkout. See `deploy/CLAUDE.md` for the registry paths, the version scheme, the pull command, and why the stack chart carries its own image digests.

**Always reap a QA stack once its branch merges** (`land-the-plane` Step 6). `docker compose down -v` is *not* enough — it leaves the stack's locally-built images and buildx cache behind. Skipping this grew `Docker.raw` to 230 GB and wedged the daemon; with ~78 worktrees each able to spawn a `fortymm-qa-<id>` stack, it compounds fast. Use `scripts/qa-down.sh` (`--all` for every QA stack, `--dry-run` to preview, opt-in `--prune-cache` for the global build cache). **Never** blanket-`prune`: `fortymm-uat_postgres-data` is unattached and would be silently destroyed along with the k3d `tailscale-state` Secrets.

## Cloud sessions

This repo runs in Claude Code cloud sessions (claude.ai/code). `.claude/settings.json` wires a
SessionStart hook, `scripts/install_tools.sh`. On a cloud session, the hook installs `mise`'s
`node` and `python` tools. It then installs project dependencies: `api/.venv`, root
`node_modules`, `web-client/node_modules`, and `e2e/node_modules`.

The cloud environment lives in your claude.ai account, not in this repo. It holds network access,
environment variables, and a setup script that installs `mise`. Configure or check it at
claude.ai/code, under the cloud icon above the message box.

A setup script for this repo already exists, based on comments in `scripts/install_tools.sh`.
Before you create a new one, open the existing environment and check its setup script.

If you create a new setup script, note one gap. Trusted network access covers npm, PyPI, and
Docker Hub, but not `mise.run`, the domain `mise`'s own installer uses. Add `mise.run` under
Custom network access, or install `mise` through a method that stays inside the Trusted list.

What runs in a cloud session, unmodified:
- `pytest` in `api/`. Docker comes pre-installed, so testcontainers can start Postgres.
- The root `e2e/` Docker Compose suite.
- `scripts/qa-up.sh`. The session's disk is disposable, so you do not need to run
  `scripts/qa-down.sh` there.

What does not run, by design:
- `ios/` work. Cloud sessions run Ubuntu. The iOS build needs Xcode.
- `mise run redeploy-uat`. It targets the shared k3d/Tailscale cluster, not a throwaway session.
  The cloud-session hook skips `helm` and `k3d` for this reason.

## Cross-cutting invariants

**OpenAPI is the source of truth for client/server types.** `web-client/src/api/schema.d.ts` is generated from the API's `openapi.json` (`npm run gen:api`, consumed by `openapi-fetch` in `web-client/src/api/client.ts`). The `openapi-schema` CI workflow fails if the committed file drifts. Whenever you change FastAPI routes or pydantic schemas (docstrings count — they become OpenAPI descriptions), run `mise run regen-api-types` and commit `schema.d.ts` in the same PR.

The iOS app mirrors this with `ios/Fortymm/Generated/Types.swift`, generated from the same `openapi.json` by `swift-openapi-generator` (types-only — the app's hand-rolled `MatchAPI.swift`-style DTOs aren't migrated onto it yet, this just gives a compiler-checked reference and a CI drift guard). Generation goes through `ios/openapi/fix_openapi_nullable.py` first: `swift-openapi-generator` silently drops any `Optional[T]` field encoded the way Pydantic/FastAPI emit OpenAPI 3.1 (`anyOf: [T, {type: null}]`) — the script rewrites that into the older `nullable: true` form the generator actually understands. The `verify-ios` job in the `openapi-schema` workflow catches drift the same way. After changing routes/schemas, also run `mise run regen-ios-api-types` and commit the regenerated `Types.swift`.

**BFF endpoints — one per page.** Each page-level UI surface has a single backend endpoint that returns all the data it needs, pre-shaped for that page; joining, aggregation, and status-label mapping happen on the server, current-user-aware. Exception: independently-interactive widgets (typeaheads, infinite-scroll panels) keep their own endpoints. Rule of thumb: if the widget fetches in response to user input rather than on page load, it's its own endpoint.

**Parse untrusted data at every boundary** — see `.claude/rules/parse-at-boundaries.md`.

**Verify the artifact under test is the one you changed** — see `.claude/rules/verify-the-artifact-under-test.md`.

**Collect the garbage you create** — `land-the-plane` Step 7 runs `scripts/reap-worktrees.sh` (see its header for why).

Layer-specific architecture and conventions live in `api/CLAUDE.md` and `web-client/CLAUDE.md` (loaded automatically when working in those directories).
