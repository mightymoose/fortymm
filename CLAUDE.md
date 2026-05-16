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

## Architecture notes that span files

**OpenAPI is the source of truth for client/server types.** The API generates `openapi.json` at runtime; `web-client/src/api/schema.d.ts` is generated from it via `npm run gen:api` (openapi-typescript) and consumed by `openapi-fetch` in `web-client/src/api/client.ts`. The `openapi-schema` CI workflow boots the API, regenerates the schema, and fails if the committed file drifts. Regenerate locally with `mise run regen-api-types` — it starts the API if it isn't already running. Whenever you change FastAPI routes or pydantic schemas, regenerate and commit `schema.d.ts` in the same PR.

**Solver health is a real round-trip.** `GET /v1/health` enqueues a job on the `solver` RQ queue and waits up to 10s for a worker to solve a tiny CP-SAT problem (`app/solver.py:solve_hello_world`). With no worker running, health fails. Tests sidestep this by replacing the queue with `fakeredis` + synchronous RQ in `tests/conftest.py` (`fake_solver_queue` autouse fixture).

**Ephemeral, cookie-based sessions.** `GET /v1/session` creates a `User` + `UserToken` (sha256-hashed) on first hit and sets an HTTP-only `session` cookie; subsequent hits resolve the user from that cookie. Tokens are namespaced by `context` so a single user table can back multiple credential types later. `SESSION_COOKIE_SECURE` defaults true; set to `false` for local non-HTTPS dev (compose already does this).

**Alembic discovers models via `app.models` import.** `api/migrations/env.py` and `tests/conftest.py` both import `app.models` for the side effect of registering on `Base.metadata`. New model files must be re-exported from `app/models/__init__.py` or autogenerate will miss them.

**Routing is file-based and generated.** `web-client/src/routes/*.tsx` files are compiled into `routeTree.gen.ts` by the `@tanstack/router-plugin/vite` plugin. Don't edit `routeTree.gen.ts` by hand.

**BFF endpoints — one per page.** Each page-level UI surface has a single backend endpoint that returns all the data it needs, pre-shaped for that page. The frontend does no joining, aggregation, or status-label mapping — those happen on the server, current-user-aware. Examples: `GET /v1/matches` backs `/matches`; `GET /v1/matches/{id}` backs both `/matches/$matchId` and the scoring routes; `GET /v1/dashboard` backs the dynamic widgets on `/dashboard`. Exception: independently-interactive widgets (typeaheads, autocompletes, infinite-scroll panels) keep their own endpoints — e.g. `GET /v1/players/search` backs the new-match opponent picker. Rule of thumb: if the widget fetches in response to user input rather than on page load, it's its own endpoint.

**MSW only intercepts in `import.meta.env.DEV`.** See `web-client/src/main.tsx`. The vitest setup (`src/test/setup.ts`) uses the Node MSW server with `onUnhandledRequest: 'error'` — every fetch in a test must have a matching handler in `src/mocks/handlers.ts` (or one added via `server.use(...)`). Production builds never load MSW.

**`VITE_API_URL`** (web-client) overrides the API base URL; otherwise the client uses `window.location.origin`. In dev that means MSW handles everything; in the compose stack the web origin (`:8080`) is also where nginx proxies the API.

## Conventions

- Web-client path alias: `@/*` → `src/*` (see `vite.config.ts`, `components.json`).
- shadcn components go under `src/components/ui` (configured in `components.json`).
- API tests use async pytest (`asyncio_mode = "auto"`, session-scoped loop) and the `db_session` fixture, which truncates all tables after each test.
- Docker is required for the default API test run (testcontainers). Set `TEST_DATABASE_URL` to opt out.
