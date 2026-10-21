# CLAUDE.md

Dev tools run inside a Docker Compose container managed by mise. Use the repo's
bootstrap wrapper `./bin/mise` (it downloads the pinned mise on first use); a
global `mise` install isn't required.

- `mise.toml`: host-side tasks, which drive the Docker Compose stack.
- `mise.container.toml`: tool versions (e.g. Node) installed inside the dev
  container.
- `compose.yaml` / `Dockerfile`: the `dev` service that every task runs in.

## Dev stack

```sh
./bin/mise run up           # start everything needed for local development
./bin/mise run list-ports   # print the host ports of everything running
```

For now `up` only starts the web-client dev server. To add a service, add its
task to `depends` on `[tasks.up]` in `mise.toml` (mise runs those in parallel).

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
To add a project's checks, call its `<project>:ci` task from `[tasks.ci]`.

`web-client:ci` runs `npm ci`, lint, build and tests in the running `dev`
container, so it needs the stack up (run it via `ci`).

`web-client:e2e` then starts the Vite dev server in the `dev` container
(`docker compose exec -d`), waits for it, and runs Playwright in the
`playwright` container. It also needs the stack up and `npm ci` done, so it
runs after `web-client:ci`.

`.github/workflows/ci.yml` runs `./bin/mise run ci` on every push, deploys
the web-client on pushes to `main` (see Deploy below), then uploads the Playwright traces and HTML report as the `playwright-traces`
artifact and posts (or updates) a comment linking it on the commit's open PR.

## web-client

`web-client/` is a Vite + React + TypeScript app, tested with Vitest and React
Testing Library. Each task builds the dev image if needed, installs Node
(pinned in `mise.container.toml`) and the app's npm dependencies inside the
container, then runs.

```sh
./bin/mise run web-client:test   # run the unit tests once
./bin/mise run web-client:dev    # start the Vite dev server on a free host port
```

### Tests

Vitest is configured in the `test` block of `web-client/vite.config.ts` (jsdom
environment). `web-client/src/setupTests.ts` loads the jest-dom matchers and
cleans up rendered components after each test. Tests live next to the code as
`*.test.tsx`.

Tests go through page objects in `web-client/src/test/pages/`. A static
`render()` renders the page and returns the object, whose getters query
`screen` on each access (e.g. `HomePage.render().title`). Page objects expose
elements located by accessible role; assertions stay in the tests.

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

Every run records a trace: `web-client/test-results/<test>/trace.zip` (open
with `npx playwright show-trace` or https://trace.playwright.dev) and an HTML
report in `web-client/playwright-report/`.

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
Preview" step's log.

It deploys whatever is in `web-client/dist`, so build first (CI deploys the
build `ci` just tested). It needs `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in the environment; CI reads them from the repo's
Actions secrets of the same names.

### Dependencies

`node_modules` lives in a Docker volume, not on the host, so native packages
match the container's platform. Install or run npm commands through the
container, e.g.
`docker compose run --rm -w /app/web-client dev npm install <pkg>`.
