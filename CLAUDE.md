# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout

Monorepo with three deployable/test units:

- `api/` — FastAPI service (Python 3.13). Async SQLAlchemy + Alembic against Postgres, RQ worker on Redis runs CP-SAT (`ortools`) solver jobs.
- `web-client/` — Vite + React 19 + TypeScript SPA. TanStack Router (file-based, generated route tree) + TanStack Query, Tailwind 4, shadcn (`radix-nova` style, lucide icons), MSW for dev/test mocks.
- `e2e/` — Root Playwright suite that exercises the composed stack (separate from `web-client/e2e/`, which is the web-client-only Playwright suite). Both exist intentionally.

Toolchain pinned in `mise.toml` (Node 26.1.0, Python 3.13). Run `mise install` once.

## Common commands

API (`cd api`, after `python -m venv .venv && source .venv/bin/activate && pip install -e '.[dev]'`):

```bash
uvicorn app.main:app --reload                  # dev server on :8000
rq worker solver --url "$REDIS_URL"            # required for /v1/health to pass
alembic upgrade head                           # apply migrations
alembic revision --autogenerate -m "..."       # new migration (autogen reads app.models)
pytest                                         # all tests; testcontainers spins ephemeral Postgres
pytest tests/test_session.py::test_x           # single test
TEST_DATABASE_URL=postgresql+asyncpg://... pytest   # skip testcontainers, use existing Postgres
mypy                                           # type-check app/ (config in [tool.mypy], pyproject.toml)
```

Web client (`cd web-client`):

```bash
npm run dev           # Vite on :5173 with MSW intercepts (DEV-only, see main.tsx)
npm run build         # tsc -b && vite build
npm run lint
npm run test:run      # vitest, jsdom + MSW server
npm run test -- src/components/user-menu.test.tsx   # single vitest file
npm run test:e2e      # web-client Playwright (config spins its own dev server on :5174)
```

Root e2e (`cd e2e`):

```bash
npm run test          # Playwright against http://127.0.0.1:5173 (spawns web-client dev server unless E2E_BASE_URL set)
E2E_BASE_URL=http://localhost:8080 npm run test     # against compose stack
```

Full stack via Docker: `docker compose -f docker-compose.dev.yml up`. Nginx on **:8080** proxies `/api/*` → api, `/` → web-client. Use this URL when you want the web app to talk to the real API instead of MSW.

**UAT runs on Kubernetes (Helm + k3d).** UAT is the one prod-like stack that does *not* use docker-compose. `scripts/redeploy-uat.sh` (a.k.a. `mise run redeploy-uat`) provisions a single-node **k3d** cluster `fortymm-uat`, builds the api/web images (same `api/Dockerfile.dev` + `web-client/Dockerfile.uat`), `k3d image import`s them, syncs Secrets from the gitignored `.env` + `secrets/*.p8`, and `helm upgrade --install`s the chart at **`deploy/uat/`**. The chart reproduces the old compose topology (postgres, redis, api, worker, web-client, routing nginx); migrations + seeds run as a `post-install,post-upgrade` Helm hook **Job** (not in the api boot command). Routing nginx is a **NodePort** (30084); k3d maps host **:8084** → that NodePort, so host Caddy (still pointing at `127.0.0.1:8084`) fronts uat.fortymm.com unchanged. Needs `helm` + `k3d` (`brew install helm k3d`). Inspect with `KUBECONFIG=$(k3d kubeconfig write fortymm-uat) kubectl get pods -n fortymm-uat`.

**UAT is also on the tailnet.** The chart runs a `tailscale/tailscale` proxy (`deploy/uat/templates/tailscale.yaml`, `tailscale.enabled` in values, on by default) that fronts the routing nginx via `tailscale serve`, so UAT is reachable privately at **`https://fortymm-uat.<tailnet>.ts.net`** with auto-HTTPS — independent of the DDNS/router/Caddy chain (which still serves `uat.fortymm.com` unchanged; Tailscale is purely additive). It reads `TS_AUTHKEY` (a reusable, non-ephemeral key from the Tailscale admin console) straight from the `.env`-backed secret, so just add a `TS_AUTHKEY=tskey-...` line to `.env`; `redeploy-uat.sh` errors early if it's missing. The proxy persists its node identity in the `tailscale-state` Secret (survives restarts; no re-auth). Requires HTTPS certs + MagicDNS enabled in the tailnet. Set `tailscale.enabled=false` to skip it.

Prod-like compose stacks (built artifacts, no dev server, isolated volumes; only nginx published):
- `docker compose -f docker-compose.qa.yml up -d --build` — `fortymm-qa`, nginx on **:8085**, local-only at http://127.0.0.1:8085. Same app shape as UAT, separate project/port/volumes. `down -v` to wipe its data. To run **multiple QA stacks at once**, parameterize per stack: `QA_ID=<id> QA_PORT=<port> QA_MAILPIT_PORT=<port>` override the project name, nginx host port (+`APP_BASE_URL`), and Mailpit port. `scripts/qa-up.sh [id]` picks a free port trio automatically and prints the assigned URL.

**Preview-stack email.** The **QA** stack runs a `mailpit` service that captures *all* outbound email instead of relaying it through the real Postmark account in `.env`. Its api/worker `environment:` blocks override `SMTP_*` (`SMTP_HOST=mailpit`, `:1025`, no TLS, blank creds) so it can never send real mail — the worker's RQ `email` jobs (confirmation / magic-link sign-in / account-merge, see `api/app/email.py`) land in Mailpit. Read them at the Mailpit web UI: **QA → http://127.0.0.1:8087** (host-local only; not proxied by Caddy, since captured mail contains live sign-in links). QA also overrides `APP_BASE_URL` to `http://127.0.0.1:8085` so captured links are clickable. To verify a sign-in/confirmation flow on QA, trigger it in the UI then open the Mailpit UI to grab the link.

**UAT sends real email.** Unlike QA, the UAT stack does *not* run Mailpit — it relays through the live Postmark account configured by `SMTP_*` in `.env`. Mail triggered on UAT lands in real inboxes.

Workflow commands: `/land-the-plane` (ship the branch), `/qa-review` (adversarial "Quinn" QA pass in a subagent against the QA stack), `/strangle` (quartet extraction).

## Cross-cutting invariants

**OpenAPI is the source of truth for client/server types.** `web-client/src/api/schema.d.ts` is generated from the API's `openapi.json` (`npm run gen:api`, consumed by `openapi-fetch` in `web-client/src/api/client.ts`). The `openapi-schema` CI workflow fails if the committed file drifts. Whenever you change FastAPI routes or pydantic schemas (docstrings count — they become OpenAPI descriptions), run `mise run regen-api-types` and commit `schema.d.ts` in the same PR.

The iOS app mirrors this with `ios/Fortymm/Generated/Types.swift`, generated from the same `openapi.json` by `swift-openapi-generator` (types-only — the app's hand-rolled `MatchAPI.swift`-style DTOs aren't migrated onto it yet, this just gives a compiler-checked reference and a CI drift guard). Generation goes through `ios/openapi/fix_openapi_nullable.py` first: `swift-openapi-generator` silently drops any `Optional[T]` field encoded the way Pydantic/FastAPI emit OpenAPI 3.1 (`anyOf: [T, {type: null}]`) — the script rewrites that into the older `nullable: true` form the generator actually understands. The `verify-ios` job in the `openapi-schema` workflow catches drift the same way. After changing routes/schemas, also run `mise run regen-ios-api-types` and commit the regenerated `Types.swift`.

**BFF endpoints — one per page.** Each page-level UI surface has a single backend endpoint that returns all the data it needs, pre-shaped for that page; joining, aggregation, and status-label mapping happen on the server, current-user-aware. Exception: independently-interactive widgets (typeaheads, infinite-scroll panels) keep their own endpoints. Rule of thumb: if the widget fetches in response to user input rather than on page load, it's its own endpoint.

**Parse untrusted data at every boundary.** The parser is idiomatic to each surface: the API validates request/response bodies with **Pydantic** (`api/CLAUDE.md` — "type the I/O boundaries"); the iOS app decodes with **`Codable`** against generated `ios/Fortymm/Generated/Types.swift`; the **web client uses Zod** everywhere (`web-client/CLAUDE.md` — `## Boundaries` and `## Forms`).

Layer-specific architecture and conventions live in `api/CLAUDE.md` and `web-client/CLAUDE.md` (loaded automatically when working in those directories).

## Conventions

- Docker is required for the default API test run (testcontainers). Set `TEST_DATABASE_URL` to opt out.
