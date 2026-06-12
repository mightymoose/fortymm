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

Prod-like stacks (built artifacts, no dev server, isolated volumes; only nginx published):
- `docker compose -f docker-compose.uat.yml up -d --build` — `fortymm-uat`, nginx on **:8084**, fronted by host Caddy at uat.fortymm.com.
- `docker compose -f docker-compose.qa.yml up -d --build` — `fortymm-qa`, nginx on **:8085**, local-only at http://127.0.0.1:8085. Same shape as UAT, separate project/port/volumes so the two run side by side. `down -v` to wipe its data.

Workflow commands: `/land-the-plane` (ship the branch), `/qa-review` (adversarial "Quinn" QA pass in a subagent against the QA stack), `/strangle` (quartet extraction).

## Cross-cutting invariants

**OpenAPI is the source of truth for client/server types.** `web-client/src/api/schema.d.ts` is generated from the API's `openapi.json` (`npm run gen:api`, consumed by `openapi-fetch` in `web-client/src/api/client.ts`). The `openapi-schema` CI workflow fails if the committed file drifts. Whenever you change FastAPI routes or pydantic schemas (docstrings count — they become OpenAPI descriptions), run `mise run regen-api-types` and commit `schema.d.ts` in the same PR.

**BFF endpoints — one per page.** Each page-level UI surface has a single backend endpoint that returns all the data it needs, pre-shaped for that page; joining, aggregation, and status-label mapping happen on the server, current-user-aware. Exception: independently-interactive widgets (typeaheads, infinite-scroll panels) keep their own endpoints. Rule of thumb: if the widget fetches in response to user input rather than on page load, it's its own endpoint.

Layer-specific architecture and conventions live in `api/CLAUDE.md` and `web-client/CLAUDE.md` (loaded automatically when working in those directories).

## Conventions

- Docker is required for the default API test run (testcontainers). Set `TEST_DATABASE_URL` to opt out.
