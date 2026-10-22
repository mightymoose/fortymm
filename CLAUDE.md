# CLAUDE.md

Dev tools run inside a Docker Compose container managed by mise. Use the repo's
bootstrap wrapper `./bin/mise` (it downloads the pinned mise on first use); a
global `mise` install isn't required.

- `mise.toml`: host-side tasks, which drive the Docker Compose stack.
- `mise.container.toml`: tool versions (Node, Python, uv) installed inside the
  dev container.
- `compose.yaml` / `Dockerfile`: the `dev` service that every task runs in,
  and the `api` service, built from the same image.

## Dev stack

```sh
./bin/mise run up           # start everything needed for local development
./bin/mise run list-ports   # print the host ports of everything running
```

`up` starts the API (`api:dev`) and the web-client dev server, which proxies
`/api/*` to it. To add a service, add its task to `depends` on `[tasks.up]` in
`mise.toml` (mise runs those in parallel).

Publish ports without a host side (e.g. `ports: ["5173"]` in `compose.yaml`)
so Docker picks a free one and several checkouts can run at once.
`list-ports` prints one line per published port of every container running
from this checkout, e.g.

```
web-client-dev       5173/tcp   localhost:32773
```

The first column is the container's `fortymm.task` label if it has one (set by
tasks that use `docker compose run`, like `web-client:dev`), otherwise its
Compose service name. Containers are matched to this checkout by Compose's
working-directory label.

## CI

```sh
./bin/mise run ci
```

`ci` brings the whole Compose stack up in the background (`docker compose up
-d --wait`), runs each project's CI task inside it with `docker compose exec`,
then removes the stack's containers. The `dev` service stays up by running
`sleep infinity`, and its healthcheck passes once the entrypoint has installed
the container's tools, so `--wait` returns only when commands can be exec'd.
The `api` service's healthcheck is a request to `/v1/ping`, so `--wait` also
blocks until the API answers. To add a project's checks, call its
`<project>:ci` task from `[tasks.ci]`.

`api:ci` runs `uv sync --locked`, ruff (lint and format), mypy and pytest in
the running `api` container.

`web-client:ci` runs `npm ci`, checks the generated API types are up to date,
then lint, build and tests in the running `dev`
container, so it needs the stack up (run it via `ci`).

`web-client:e2e` then starts the Vite dev server in the `dev` container
(`docker compose exec -d`), waits for it, and runs Playwright in the
`playwright` container. It also needs the stack up and `npm ci` done, so it
runs after `web-client:ci`.

`.github/workflows/ci.yml` runs `./bin/mise run ci` on every push, deploys
the web-client on pushes to `main` (see Deploy below), then uploads the Playwright traces and HTML report as the `playwright-traces`
artifact and posts (or updates) a comment linking it on the commit's open PR.

## References

`references/` holds reference material that isn't built or deployed (see
`references/README.md`). `references/fortymm-design-system/` is the FortyMM
design system: read its `README.md` and `colors_and_type.css` before designing
or styling UI.

## api

`api/` is a FastAPI app managed with uv. mise installs its Python (pinned in
`mise.container.toml`; there's no `.python-version`) and the Dockerfile tells
uv to use only that interpreter. uv manages the dependencies (`pyproject.toml`
and `uv.lock`). Code is in `src/fortymm_api/`, tests in `tests/` (pytest,
through FastAPI's `TestClient`).

- `main.py`: `create_app()`, the app factory. Operation IDs are the route
  functions' names, so generated clients get names like `ping`.
- `v1/`: the `/v1` routes, one module per resource, each with its own
  `APIRouter` and Pydantic request/response models; `v1/__init__.py` mounts
  them. Annotate route return types with the response model.
- Response bodies follow JSON:API's top-level shape: the payload goes under
  `data` (e.g. `/v1/ping` returns `{"data": "pong"}`), so each response model
  has a `data` field rather than naming the payload itself.

It runs in the `api` Compose service (uvicorn with `--reload` on port 8000)
with no published port: the web-client dev server proxies `/api/*` to it with
the prefix stripped, so `/v1/ping` is at
`http://localhost:<web-client port>/api/v1/ping` and the interactive docs at
`/api/docs`. Its virtualenv lives in the `api-venv` volume.

```sh
./bin/mise run api:dev       # start the API and stream its logs
./bin/mise run api:test      # run the API's tests
./bin/mise run api:openapi   # regenerate the OpenAPI schema and client types
```

### OpenAPI schema and clients

`api/openapi.json` is the committed OpenAPI schema, written from the app by
`python -m fortymm_api.openapi`. Clients generate their types from it; the
web-client's are in `web-client/src/api/schema.d.ts` (`npm run
generate:api`, openapi-typescript). After changing a route or model, run
`api:openapi` and commit both files; CI fails if either is stale (a pytest in
the API, `generate:api -- --check` in the web-client).

## web-client

`web-client/` is a Vite + React + TypeScript app, tested with Vitest and React
Testing Library. Each task builds the dev image if needed, installs Node
(pinned in `mise.container.toml`) and the app's npm dependencies inside the
container, then runs.

```sh
./bin/mise run web-client:test   # run the unit tests once
./bin/mise run web-client:dev    # start the Vite dev server on a free host port
```

### Routing

Routes are defined in code with TanStack Router in `web-client/src/router.tsx`
(`createAppRouter()`); each page's component lives in `web-client/src/routes/`.
To add a page, add its route to the route tree there.

### API client

`src/api/client.ts` exports `api`, an openapi-fetch client typed by the
generated schema, with base URL `/api`: `const { data, error } = await
api.GET('/v1/ping')`. `createApiClient()` builds one with other options (e.g.
a stub `fetch` in tests). The dev server's proxy target defaults to
`http://api:8000` and can be overridden with `API_PROXY_TARGET`.

### Tests

Vitest is configured in the `test` block of `web-client/vite.config.ts` (jsdom
environment). `web-client/src/setupTests.ts` loads the jest-dom matchers and
cleans up rendered components after each test. Tests live next to the code as
`*.test.tsx`.

Tests go through page objects in `web-client/src/test/pages/`. A static async
`render()` renders the app's router at the page's path (via
`src/test/renderRoute.tsx`, using a memory history) and returns the object,
whose getters query `screen` on each access (e.g.
`(await HomePage.render()).title`). Page objects expose elements located by
accessible role; assertions stay in the tests.

### End-to-end tests

The Playwright suite lives in `web-client/e2e/` (`*.spec.ts`, excluded from
Vitest) and is configured in `web-client/playwright.config.ts`. It runs in the
`playwright` Compose service: the official Playwright image, which ships the
browsers, sharing the `dev` service's network so the dev server is on
`localhost:5173`. Keep the image tag in `compose.yaml` in sync with
`@playwright/test` in `package.json` (pinned exactly).

Specs import `test` and `expect` from `e2e/fixtures.ts`, which provides page
objects (`e2e/pages/`) as fixtures: `test('...', async ({ homePage }) => ...)`.
As in the unit tests, page objects expose role-based locators and actions like
`goto()`, and the specs do the asserting.

Screenshot tests use `toHaveScreenshot`; their baselines live next to the spec
in `e2e/<spec>-snapshots/` and only match when taken in the `playwright`
container, so regenerate them there (`docker compose exec playwright npx
playwright test --update-snapshots`, with the stack and dev server up as in
`web-client:e2e`). `design-system.spec.ts` checks the design system page's
header against the same screenshot as the reference kit's header
(`references/fortymm-design-system/ui_kits/shadcn/index.html`, opened from
disk with the app's copy swapped in), so the two must render identically.

Every run records a trace: `web-client/test-results/<test>/trace.zip` (open
with `npx playwright show-trace` or https://trace.playwright.dev) and an HTML
report in `web-client/playwright-report/`.

### Styles

The design system's styles apply to the whole app; `main.tsx` imports them:

- `src/styles/tokens.css`: the tokens (CSS variables) from
  `references/fortymm-design-system/colors_and_type.css`, plus the self-hosted
  fonts in `src/assets/fonts/`.
- `src/styles/base.css`: the reset, type styles (also applied to `h1`-`h4`,
  `p` and `code`) and brand utilities from the same file, then the page
  chrome from the reference shadcn/ui kit: `.page` (the root route's
  wrapper, `src/routes/Root.tsx`) and `.page-header`
  (`src/components/PageHeader.tsx`, the title and subtitle every page starts
  with).

Use these classes and CSS variables rather than raw values or page-specific
styles. `/design-system` is where the app's styles are checked against the
reference (see the screenshot tests above).

### Dev server

Vite listens on port 5173 inside the container, and Docker publishes it on a
free host port. `web-client:dev`:

- prints the URL first (`web-client dev server: http://localhost:<port>`).
  Vite's own banner below it shows the in-container port 5173, which is not
  the one to open.
- then streams the server's logs. Ctrl-C stops and removes the container.

`./bin/mise run list-ports` shows the port again later.

### Deploy

The web-client is served by Cloudflare Workers static assets, configured in
`web-client/wrangler.jsonc`. `not_found_handling: "single-page-application"`
serves `index.html` for any path with no matching file in `dist/`, so
client-side routes load directly. Production is served on `fortymm.com` and
`www.fortymm.com` (Custom Domains in `routes`, whose DNS records and
certificates Cloudflare manages) and on `fortymm.mightymoose.workers.dev`.

```sh
./bin/mise run web-client:deploy    # wrangler deploy of web-client/dist
./bin/mise run web-client:preview   # a Preview named after the git branch
```

CI deploys `main` to production and every other branch as a Preview (`wrangler
preview`, open beta), whose URL is printed in the "Deploy a Cloudflare
Preview" step's log. Previews are served on
`<preview-name>-fortymm.mightymoose.workers.dev` because `preview_urls` is on in
`wrangler.jsonc`; changes to that setting only take effect after a production
deploy.

It deploys whatever is in `web-client/dist`, so build first (CI deploys the
build `ci` just tested). It needs `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in the environment; CI reads them from the repo's
Actions secrets of the same names.

### Dependencies

`node_modules` lives in a Docker volume, not on the host, so native packages
match the container's platform. Install or run npm commands through the
container, e.g.
`docker compose run --rm -w /app/web-client dev npm install <pkg>`.
