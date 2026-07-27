# e2e/CLAUDE.md

Root end-to-end Playwright suite. Exercises the **composed full stack** — real
`api` + `web-client` behind nginx, no mocks — driven through a real browser.

## Two Playwright suites — know which one you're in

There are **two** Playwright suites in this repo and both exist intentionally:

- **`e2e/` (this one)** — the *composed-stack* suite. By default it builds and runs
  the whole app (postgres, redis, api, worker, web-client, nginx) via docker
  compose and drives it end-to-end. No MSW, no stubs — the real API answers.
- **`web-client/e2e/`** — the *web-client-only* suite. Runs against the Vite dev
  server with **MSW off**, stubbing the network with inline Playwright
  `page.route` interceptors. It belongs to the `web-client` unit, **not here.**

This file, and the `e2e` agent, own **only the root `e2e/` suite.** Don't document
or edit `web-client/e2e/` from here.

## Common commands

From `e2e/` (after `npm install`; first run also needs `npx playwright install chromium`):

```bash
npm run test                 # default: build + run the full compose stack, test it, tear it down
npm run test:ui              # same, in Playwright's interactive UI mode
npm run test -- landing      # single spec by path/substring (tests/landing.spec.ts)
npm run test -- -g "session" # filter by test title
npm run test -- --headed     # headed browser
npm run test -- --debug      # Playwright Inspector, step through

# Run against an ALREADY-RUNNING stack instead of self-managing one:
E2E_BASE_URL=http://localhost:8080 npm run test   # dev compose stack
E2E_BASE_URL=http://127.0.0.1:8085 npm run test   # a QA stack
```

Only `test` and `test:ui` exist as scripts. Everything after `--` is passed
through to `playwright test` — don't invent scripts for flags.

## How it wires up

**Base URL resolution** (`playwright.config.ts`): `E2E_BASE_URL` if set, else
`http://127.0.0.1:${E2E_NGINX_PORT}` with `E2E_NGINX_PORT` defaulting to **18080**.
There is no web-client dev server here — the default target is nginx in front of
the built stack.

**`global-setup.ts` — the default run OWNS a compose stack.**
- If `E2E_BASE_URL` is set, setup **early-returns** — you point at a stack you
  manage, and this file touches nothing.
- Otherwise it runs `docker compose -f docker-compose.dev.yml -f
  docker-compose.e2e.yml up -d --wait --build`. The `docker-compose.e2e.yml`
  override unpublishes every service's dev ports and republishes **only nginx** on
  `${E2E_NGINX_PORT:-18080}:80`.
- **Docker is required** for the default run (it shells out to `docker compose`),
  mirroring the api testcontainers convention.
- It then polls **two deliberate readiness gates** past what `--wait` covers
  (`--wait` only checks each container's own healthcheck). **Preserve both if you
  edit setup — removing them reintroduces flakes:**
  1. `GET /` until non-5xx — web-client has no healthcheck, so the container is
     "up" before Vite's first compile finishes.
  2. `GET /api/v1/health` until `solver.healthy === true` — gates on the API being
     reachable *through nginx* (the `/api` upstream 502s for a beat after startup)
     **and** on the RQ `solver` worker having subscribed (the health probe enqueues
     a CP-SAT job; with no worker it returns `solver.healthy: false`, and
     `admin-system-health.spec.ts` would lock to that stale state).

**`global-teardown.ts`** runs `docker compose … down -v` (wipes volumes) — unless
`E2E_BASE_URL` is set (you own the stack) or `E2E_KEEP_STACK` is set (leave it up
for poking after a run). Both early-return.

**Config knobs:** `fullyParallel: true`; single `chromium` project (Desktop
Chrome); `trace: 'on-first-retry'`. In CI: `retries: 2`, `forbidOnly: true`,
`github` + `html` reporters; locally `retries: 0`, `list` reporter.

## Test organization

Specs live in `tests/*.spec.ts`; page objects in `page-objects/`
(`*.page.ts`, nested per-page helpers under `page-objects/<page>-page/`, e.g.
`page-objects/dashboard-page/user-menu.page.ts`); non-page-object test infra
(e.g. API-seed helpers that provision state over the real API, no `Page`) in
`support/*.ts` (e.g. `support/match-api.ts`). Keep to the patterns already here:

- **Page Object Model.** One class per surface exposing named `Locator`s (see
  `landing.page.ts`; `dashboard.page.ts` shows the child-composition variant,
  where the Locators live on the composed `UserMenuPage`). Navigation is a static
  `navigateTo(page)` factory that `goto`s and returns the instance. Compose child
  page objects (e.g. `DashboardPage.userMenu` → `UserMenuPage`) rather than growing
  one flat class. Keep raw selectors *inside* the page object; specs read
  intent-named locators.
- **Resilient, user-facing locators.** Prefer `getByRole`/`getByText`/
  `getByTestId` over CSS/XPath. Existing objects use `getByRole('heading', {...})`
  and `getByTestId('user-menu')` — match that.
- **Web-first assertions, no hard waits.** Always `await expect(locator).toBe…()`
  — they auto-retry. Never `waitForTimeout`/sleep or assert on a resolved boolean.
- **Test isolation.** Each Playwright test gets a fresh browser context (own
  cookies/storage) and self-provisions its state. The stack is **not reset between
  tests**, so don't assume an empty DB globally; the guest-session tests lean on a
  *fresh browser context* minting a new guest, not on a clean database. Prefer
  facts true of a brand-new visitor, or provision unique data (`@faker-js/faker` is
  available).
- **Parallelization.** `fullyParallel` runs specs and the tests within them
  concurrently against the one shared stack — keep tests independent so they can't
  contaminate each other. Multi-tab/concurrency scenarios use
  `context.newPage()` (see `dashboard-session.spec.ts`).

## Gotchas

- **Default run needs Docker and builds images** (`--build`). First run is slow.
  If BuildKit serves a stale cached image, the suite tests an old bundle — do a
  clean rebuild if a change you expect isn't reflected.
- **Port 18080 is chosen to dodge the dev nginx on :8080.** Override with
  `E2E_NGINX_PORT` if 18080 is taken. The "Playwright 5174 collides with the dev
  compose web-client" memory is about **`web-client/e2e/`** (its own dev server on
  5174) — it does **not** apply to this suite, which fronts nginx on 18080.
- **`E2E_BASE_URL` disables all stack management** — setup and teardown both
  early-return. You are responsible for standing up and tearing down whatever it
  points at.
- **`down -v` wipes the stack's volumes** on teardown. Set `E2E_KEEP_STACK=1` to
  keep the stack (and its data) up for manual inspection after a run.
- **Tear a kept stack down before the next default run.** `up --build` mints a
  fresh image id every time (BuildKit writes new provenance/attestation
  manifests even when every layer is cached), so a second run *recreates* api,
  worker and web-client while leaving the already-healthy **nginx** untouched —
  and nginx resolved the api's container IP at startup. Setup then fails its
  second gate with a **persistent** `status 502` that no amount of waiting cures.
  `docker compose … restart nginx` unwedges an existing stack; starting from no
  stack at all avoids it, which is why the normal `down -v` teardown means you
  never see this.
- **Don't edit these gates away.** The two `waitForReady` probes in `global-setup`
  exist for specific documented races (nginx 502 window, `solver` worker
  subscription). Deleting them makes the suite flake on cold starts.
