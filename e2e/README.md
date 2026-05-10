# FortyMM e2e

Minimal Playwright smoke tests that boot the entire stack (Redis, RQ worker,
FastAPI, web client) and verify the pieces wire together.

## What is covered

- `tests/health.spec.ts` — calls `GET /v1/health`, which enqueues a CP-SAT job
  on Redis, the RQ worker pulls it and runs `solve_hello_world`, and the API
  returns `{ solver: { healthy: true } }`. A pass means the API ↔ Redis ↔
  worker ↔ ortools chain is wired correctly.
- `tests/landing.spec.ts` — loads the Vite-served landing page and checks the
  hero copy renders.

## Prerequisites

- Redis on `redis://127.0.0.1:6379/0` (override with `REDIS_URL`).
- The `api/` venv created and `.[dev]` installed (`python -m venv api/.venv &&
  api/.venv/bin/pip install -e 'api[dev]'`). If `api/.venv` is missing the
  helper falls back to `uvicorn`/`rq` on `PATH`.
- `web-client/` deps installed (`npm ci` from `web-client/`).

## Run

From this directory:

```bash
npm ci
npx playwright install --with-deps chromium
npm test
```

Playwright spins up the API + RQ worker (via `scripts/run-api-stack.sh`) and
the Vite dev server, then runs the tests. Override endpoints with
`API_URL` / `WEB_URL` if you want to point at already-running services.
