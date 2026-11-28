# fortymm

## Everything runs in Docker

Nothing runs on the host except `./bin/mise` and `docker`. No `node`, `npm`, `dafny`, `python`, etc. on the host — not to scaffold, install, build, test, or run.

- Each part of the repo has a service in `docker-compose.yml` and its own `Dockerfile`.
- Toolchains (node, dafny, …) are pinned in that part's `mise.toml` and installed into the image by `bin/mise`.
- Host-side entry points are mise file tasks in `mise-tasks/` that wrap `docker compose` (subfolders become `folder:task`, e.g. `mise-tasks/web-client/dev` is `web-client:dev`). Run them with `./bin/mise run <task>`; list them with `./bin/mise tasks`.
- Need a new command? Add a mise task that runs it in the right container; don't run the tool on the host.
- After changing a part's `mise.toml` or dependency manifest, rebuild its image: `docker compose build <service>`.

## Services

- `check-requirements` — verifies the Dafny specs in `requirements/`. `./bin/mise run requirements:check`, `./bin/mise run requirements:dafny -- <args>`
- `design-system` — nginx serving the design system reference boards in `requirements/design-system/reference/`, the reference for the Playwright screenshot tests. `./bin/mise run requirements:design-system:reference:serve` serves them on a random host port (printed at startup).
- `web-client` — Vite + React + TypeScript app in `web-client/`. `./bin/mise run web-client:dev` starts the dev server on a random host port (printed at startup), so many can run at once. `./bin/mise run web-client:api-client` regenerates the typed api client (`src/api/generated.ts`, orval) from `api/openapi.json`. `./bin/mise run web-client:test` runs the Vitest unit tests and `./bin/mise run web-client:e2e` the Playwright tests, in the same image. `./bin/mise run web-client:screenshots` rewrites the design system screenshot baselines from the reference boards.
- `api` — FastAPI app in `api/` (Python + uv, deps in `pyproject.toml` / `uv.lock`). Routes live under `/api`; the web client's Vite dev server proxies `/api` to it, in dev and preview (`api-public`). `./bin/mise run api:dev` starts it on a random host port (docs at `/api/docs`), `./bin/mise run api:test` runs pytest, `./bin/mise run api:uv -- <args>` runs uv (e.g. `add <pkg>`), `./bin/mise run api:openapi` regenerates the committed `api/openapi.json`. Verify fails if that spec is stale, or if oasdiff finds a breaking change against `main`'s.
- `core` — the shared Rust library in `core/` (a cargo workspace: the library, plus `bindings/wasm` via wasm-bindgen and `bindings/python` via pyo3). `./bin/mise run core:test` runs the Rust tests, and `./bin/mise run core:cargo -- <args>` runs cargo. The build-only services `core-wasm` (wasm-pack, giving the npm package `fortymm-core-wasm`) and `core-python` (maturin, giving the `fortymm_core` wheel) are build contexts for the web-client and api images. Those images build the bindings from `./core`, so after a core change run `docker compose build api web-client` (dev and the test tasks already build).
- `journeys` — whole-stack Playwright tests in `journeys/tests/` (`*.journey.ts`): a browser on the compose network against `web-client-nginx` (the built web client on nginx, with its Workbox service worker, so offline journeys live here) and the api, so web client, api and core together. They drive the web client's page objects, exported from `web-client/e2e/pages.ts` (mounted read-only; keep page objects importing only types from `@playwright/test`). `./bin/mise run journeys:test` starts the dev servers if needed and always rebuilds `web-client-nginx`; `./bin/mise run journeys:npm -- <args>` runs npm.
- `tailscale` + `web-client-public` (profile `public`) — the web client's production build, served by nginx (`web-client/nginx.conf.template`, which proxies `/api` to `api-public`), on the internet via Tailscale Funnel, no host ports. `./bin/mise run preview`; setup in README.

`./bin/mise run dev` starts every dev server (api, web client and its nginx build `web-client-nginx`, design system reference) and prints their URLs; `--detach` returns once they are healthy. `./bin/mise run verify` starts them if needed, then runs lint, typecheck and tests for the web client and api, the e2e tests and journeys against the servers, and the Dafny requirements check, and stops them afterwards only if it started them.

`./bin/mise run ports` lists the host ports of this checkout's running containers.
