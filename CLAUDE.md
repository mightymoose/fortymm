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

`up` starts the API (`api:dev`), its Postgres database and the web-client dev
server, which proxies `/api/*` to the API. To add a service, add its task to
`depends` on `[tasks.up]` in `mise.toml` (mise runs those in parallel).

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
The `api` service's healthcheck is a request to `/v1/health`. The API
migrates its database before it answers, so `--wait` also blocks until the
migrations ran and the API reaches the database. The `api` service
starts after the `postgres` service is healthy (`pg_isready`). To add a project's checks, call its
`<project>:ci` task from `[tasks.ci]`.

`api:ci` runs `uv sync --locked`, ruff (lint and format), mypy, pytest and
`alembic check` in the running `api` container. `alembic check` fails when
the models and the migrations disagree. `api:smoke` then builds the API's production
image (`api:build`), runs it with `PORT` set on the `postgres` service's
network, and checks that `/v1/health` reaches the database.

`web-client:ci` runs `npm ci`, lint, build and tests in the running `dev`
container, so it needs the stack up (run it via `ci`).

`web-client:routes-check` then runs a Vite build in the `dev` container, which
regenerates `web-client/src/routeTree.gen.ts` (see Routing). It fails if git
shows the file changed, so a route change without the regenerated tree breaks
CI. A new route file that the committed tree doesn't list can fail earlier,
with a type error from `tsc -b` in `web-client:ci`.

`openapi:check` then regenerates `api/openapi.json` and the web-client's
types from it in the running containers, and fails if git shows them changed,
so a route or model change without `api:openapi` breaks CI.

`openapi:breaking` then runs `oasdiff breaking --fail-on ERR` in the `dev`
container. It compares the `api/openapi.json` of the main the change builds on
with the current one, and fails on a change that breaks `/v1` (see OpenAPI
schema and clients). On a branch, that base is the merge base with
`origin/main`. On a push to `main`, CI sets `OPENAPI_BASE` to
`github.event.before`, the commit `main` pointed at before the push. If the
base has no `api/openapi.json`, the task skips the check and says why. git runs
on the host, because a worktree's `.git` points outside the bind mount. So CI
checks out the full history (`fetch-depth: 0`). mise installs oasdiff from its
GitHub release (`github:oasdiff/oasdiff` in `mise.container.toml`). CI passes
`GITHUB_TOKEN` to the `dev` service, so the install doesn't hit GitHub's
anonymous rate limit.

`web-client:e2e` then starts the Vite dev server in the `dev` container
(`docker compose exec -d`), waits for it, and runs Playwright in the
`playwright` container. It also needs the stack up and `npm ci` done, so it
runs after `web-client:ci`.

`.github/workflows/ci.yml` runs `./bin/mise run ci` on every push, deploys the
API and then the web-client (production from `main`, a Preview from any other
branch; see Deploy below), runs the post-deploy suite against that
deployment, then uploads the Playwright traces and HTML report
as the `playwright-traces` artifact and posts (or updates) a comment linking
it on the commit's open PR. It runs one at a time per branch, so deploys land
in push order.

The deploys are recorded as GitHub deployments (`actions/github-script`, no
job-level `environment:`), so they show in the repo's and the PR's
Deployments panel: `main` in the `production` environment linking to
`https://fortymm.com`, any other branch in a transient `Preview (<branch>)`
environment linking to its Cloudflare Preview URL. A deployment whose deploy
or post-deploy check fails is marked failed, and its description carries the
API's URL.

## References

`references/` holds reference material that isn't built or deployed (see
`references/README.md`). `references/design-system/` is the FortyMM design
system (v2.1), and the app matches it. Read its `README.md` and
`colors_and_type.css` before designing or styling UI.

## api

`api/` is a FastAPI app managed with uv. mise installs its Python (pinned in
`mise.container.toml`; there's no `.python-version`) and the Dockerfile tells
uv to use only that interpreter. uv manages the dependencies (`pyproject.toml`
and `uv.lock`). Code is in `src/fortymm_api/`, tests in `tests/` (pytest,
through FastAPI's `TestClient`).

- `main.py`: `create_app()`, the app factory. Operation IDs are the route
  functions' names, so generated clients get names like `health`. If
  `WORKER_SECRET` is set, the app answers 403 to every request without a
  matching `X-FortyMM-Worker-Secret` header (see Deploy). Local dev, the
  tests and `api:smoke` don't set it, so they need no secret. The app
  answers 415 to a `POST`, `PUT`, `PATCH` or `DELETE` whose `Content-Type`
  isn't `application/json`. The check ignores case and parameters such as
  `charset`. A cross-site HTML form can't send that type, so another site
  can't make `POST /v1/session` replace a visitor's session. The 403 check
  runs first. Both answer in the `errors` shape, such as `{"errors":
  [{"status": "415", "title": "..."}]}`.
- `v1/`: the `/v1` routes, one module per resource, each with its own
  `APIRouter` and Pydantic request/response models; `v1/__init__.py` mounts
  them. Annotate route return types with the response model. A route does
  only the HTTP work. It reads the request, calls a service and writes the
  response.
- `services/`: the business logic, one module per area, such as
  `services/sessions.py`. A service takes an ORM `Session` and plain values,
  and returns domain types. It never sees a request, a response or a cookie.
  `tests/services/` tests each rule by calling the service directly, on a
  `migrated_database`. A route's tests check only its HTTP work, such as
  the status, the headers, the cookie and the body's shape.
  [.claude/rules/business-logic-in-services.md](.claude/rules/business-logic-in-services.md)
  says why.
- `database.py`: the Postgres connections, through SQLAlchemy 2.0 and the
  psycopg 3 driver. If `DATABASE_URL` is set, `create_app()` makes an
  `Engine` (at most 4 connections) and a `sessionmaker`. The app's lifespan
  migrates the database first (see Migrations). A route takes an ORM
  `Session` with a `DatabaseSession` parameter. Each request runs in one
  transaction. It commits before the response goes out, so a failed commit
  answers 500. An exception rolls it back. `DATABASE_URL` is optional off
  Cloud Run, so the OpenAPI export runs with no database. On Cloud Run,
  `create_app()` raises without it.
- `models.py`: the ORM's declarative `Base`. Its metadata has a naming
  convention, so constraints get stable names in migrations. Mapped classes
  subclass it and take the singular entity name, such as `Account` and
  `Player`. The model for the `sessions` table is `AuthSession`, so
  `Session` stays SQLAlchemy's. Use `relationship()` from `models.py`. It
  defaults to `lazy="raise"`, so a lazy load fails and every load shows in
  its query. Code uses the mapped classes directly. The ids and emails use
  the NewTypes `AccountId`, `PlayerId` and `Email` from `accounts.py`.
  SQLAlchemy can't see through a NewType, so `Base.type_annotation_map`
  gives each one its column type. The tables are `accounts`, `players`,
  `player_managers` and `sessions` (see Accounts and sessions).
- `/v1/health` runs `SELECT 1` and returns `{"data": {"database": "ok"}}`.
  The healthchecks, `api:smoke`, the 403 check and the post-deploy suite use
  it.
- Response bodies follow JSON:API's top-level shape: the payload goes under
  `data` (e.g. `/v1/health` returns `{"data": {"database": "ok"}}`), so each
  response model has a `data` field rather than naming the payload itself.

It runs in the `api` Compose service (uvicorn with `--reload` on port 8000)
with no published port: the web-client dev server proxies `/api/*` to it with
the prefix stripped, so `/v1/health` is at
`http://localhost:<web-client port>/api/v1/health` and the interactive docs at
`/api/docs`. Its virtualenv lives in the `api-venv` volume.

The database is the `postgres` Compose service (`postgres:18`, the same major
version as Cloud SQL), with user, password and database all `fortymm`. Its
data lives in the `postgres-data` volume. The `api` service gets
`DATABASE_URL` pointing at it. Port 5432 is published on a free host port,
which `list-ports` prints. `api:test` starts `postgres` first, and the tests
use the real database. A test that makes tables uses the
`throwaway_database_url` fixture, a new database that the test drops after.
Tables a test makes in `fortymm` would fail `alembic check`. The
`migrated_database` fixture is an `Engine` for a throwaway database that the
migrations ran on.

### Accounts and sessions

Every visitor gets a guest account the first time the app loads. A guest
account has no `email`. A verified account has one, always lowercase.

- `accounts.py`: `CurrentAccount = GuestAccount | VerifiedAccount`, the
  account of a valid session. An adopted account (`adopted_into` set) is
  neither kind, so its sessions are invalid. `current_account()` in
  `services/sessions.py` decides the kind in one place. It checks `adopted_into` first, then `email`.
- Players are permanent. The `players_are_permanent` trigger refuses every
  `DELETE` on `players`. An account manages players through
  `player_managers`. Each row has `relationship` `self` or `managed`. An
  account has at most one `self` player, and a player at most one `self`
  account.
- `ownership.py`: `OWNERSHIP_RULES` says what adoption and player merge do
  to each foreign key to `accounts` or `players`. `tests/test_ownership.py`
  reads every such foreign key from `information_schema`. It fails if one
  has no entry. So a new foreign key to either table needs an entry in the
  same change.
- `POST /v1/session` (`v1/session.py`) starts or resumes the visitor's
  session through `services.sessions.start_session()`. With a valid session, it updates `accounts.last_seen_at`, moves
  `sessions.expires_at` to 400 days from now and sets the same cookie
  again. With no cookie, or an unknown, expired or adopted one, it makes a
  guest account and a session. It deletes the session row that the old
  cookie matched, and keeps that row's account. Every response sets `Cache-Control: no-store`. The body is
  `{"data": {"account": {"id": "...", "kind": "guest"}}}`, or `"verified"`.
- The cookie is `__Host-fortymm_session`: 32 random bytes in base64url, with
  `Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000` (400 days).
  `sessions.expires_at` also ends 400 days after the last `POST
  /v1/session`. The API stores only the token's sha256, in
  `sessions.token_hash`.
- `services/sessions.py`: a session is valid if its `token_hash` matches,
  `expires_at` is in the future and its account has no `adopted_into`.
  `authenticate()` returns the account of a valid session, or `None`.
- `auth.py`: the cookie and the `RequestAccount` dependency. A route that
  needs the account takes a `RequestAccount` parameter. Without a valid
  session, that dependency answers 401 in the `errors` shape. Only `POST
  /v1/session` makes a guest account.
- A service that writes as an account loads the account row with
  `with_for_update(read=True)`, which is `SELECT ... FOR SHARE`. After the
  lock, it checks `adopted_into` again. If it is set, the route answers 401. So a
  write can't land on a guest account after an adoption moved its data.
  `RequestAccount` takes no lock. `POST /v1/session` locks the account `FOR
  UPDATE`, because it writes `last_seen_at`.
- `alembic check` doesn't compare a partial index's `WHERE` clause. So
  `tests/test_schema.py` checks each constraint, each index and the trigger
  on a `migrated_database`.

### Migrations

Alembic migrates the database. `api/migrations/` holds `env.py`, the
revision template and the revisions in `versions/`. `api/alembic.ini` points
the CLI (run from `api/`) and the app at it. The app reads `alembic.ini`
from its working directory: `api/` in dev and the tests, `/app` in the
production image.

- The app runs `alembic upgrade head` in its lifespan, before it serves. So
  dev, the tests, `api:smoke` and Cloud Run all get the schema the same way.
  If the database can't be reached or a migration fails, the API doesn't
  start.
- `env.py` takes a Postgres advisory lock before it migrates. A second
  instance waits for the lock, then finds nothing left to apply.
- Migrations are forward-only. The template has no `downgrade()`.
  Autogenerate can't see triggers, functions or views, so write those as
  `op.execute(...)`.
- `api:revision` drafts a revision with autogenerate from the models'
  changes. A person reviews every draft before commit. ruff fixes and
  formats the draft, so it passes the ruff checks in `api:ci`.
- `api:ci` runs `alembic check`, which fails when a model changes without a
  revision.

```sh
./bin/mise run api:dev       # start the API and stream its logs
./bin/mise run api:test      # run the API's tests
./bin/mise run api:openapi   # regenerate the OpenAPI schema and client types
./bin/mise run api:revision "add accounts"  # draft a migration from the models' changes
./bin/mise run api:build     # build the production image as fortymm-api-production
```

`api/Dockerfile` is its production image, separate from the dev image: a
multi-stage uv build (`uv sync --locked --no-dev`) that runs uvicorn as a
non-root user on `$PORT` with `--root-path /api` and the proxy headers
trusted, without `--reload`. It copies `alembic.ini` and `migrations/` to
its working directory, `/app`, for the startup migration. `api:build` passes it the Python and uv versions
from `mise.container.toml`, so it runs the same ones as the dev container.

### OpenAPI schema and clients

`api/openapi.json` is the committed OpenAPI schema, written from the app by
`python -m fortymm_api.openapi`. Clients generate their types from it; the
web-client's are in `web-client/src/api/schema.d.ts` (`npm run
generate:api`, openapi-typescript). After changing a route or model, run
`api:openapi` and commit both files; CI's `openapi:check` fails if either is
stale.

A published API version (today `/v1`) never changes in a breaking way. Released
iOS and Android apps stay installed for months, and they call the API that
`main` deploys. So the apps' code in the same commit doesn't protect them. A
deliberate break goes in a new version, and the old version keeps working.
`openapi:breaking` catches the breaks nobody meant to make. Examples are a
renamed Pydantic field, a response field that becomes optional or nullable, a
new required request field, stricter validation and a removed enum value.

Until the first app store release, the only client is the web-client, which
deploys with the API. Until then, `api/openapi-breaking-ignore.txt` can let a
deliberate break to `/v1` through. Add the error's line as oasdiff prints it,
`METHOD PATH description`, e.g. ``GET /v1/health removed the required property
`data/database` from the response with the `200` status``. The task applies only
the lines that the change adds to the file, compared with its base. So an entry
covers only the change that adds it, and it can't hide a later break once it's
on `main`. Lines that start with `#` are comments.

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

Routes use TanStack Router's file-based routing. Each file in
`web-client/src/routes/` defines one route, and its path in that directory
gives the URL (see TanStack Router's file naming conventions). The
`@tanstack/router-plugin` Vite plugin (in `vite.config.ts`, before the React
plugin) reads the directory and writes the route tree to
`web-client/src/routeTree.gen.ts`. `createAppRouter()` in `src/router.tsx`
builds the router from that tree.

The plugin writes the tree when Vite starts: the dev server (which also
watches the directory), `vite build` and Vitest. Commit
`routeTree.gen.ts` with the route change. `tsc -b` reads it before Vite runs
in `npm run build`. If it is stale, CI fails (see `web-client:routes-check`).
oxlint skips it. The web-client has no formatter.

`autoCodeSplitting` puts each route's component in its own JS chunk. The
router loads a route's chunk before it shows the route. A route file holds
only the route definition. The components it shows live outside
`src/routes/`, because the plugin treats every file there as a route:
`src/pages/` holds the page and layout components and their tests. Import the
component in the route file and don't export it from there, or it stays in
the entry chunk.

To add a page, add its component to `src/pages/` and a route file that shows
it to `src/routes/`.

- `__root.tsx`: the root route, with component `Root` (`src/pages/Root.tsx`),
  and the router context type (`api` and `queryClient`).
- `_authenticated.tsx`: a pathless layout route with no path segment, with
  component `AuthenticatedLayout` (`src/pages/AuthenticatedLayout.tsx`).
  Pages that will need a signed-in user (such as `/`, which is
  `_authenticated/index.tsx`) go in `_authenticated/`. The layout checks the
  API's health and shows the loading screen (see API client).
- `design-system.tsx`: a public page. Public pages go directly in
  `src/routes/`. They make no request and never show the loading screen.

### API client

`src/api/client.ts` exports `api`, an openapi-fetch client typed by the
generated schema, with base URL `/api`: `const { data, error } = await
api.GET('/v1/health')`. `createApiClient()` builds one with other options (e.g.
an absolute base URL in tests). In production the Cloudflare Worker forwards `/api/*`
the same way (see Deploy). The dev server's proxy target defaults to
`http://api:8000` and can be overridden with `API_PROXY_TARGET`.

Components fetch through TanStack Query. `src/api/queries.ts` holds the query
options, one function per request, each taking the typed client, e.g.
`useSuspenseQuery(healthQuery(api))`. Each `queryFn` calls the client and
throws when the response has no data. `createAppRouter()` puts the client in
the router context as `api`, with the `QueryClient` as `queryClient`, and
wraps the router in a `QueryClientProvider`. On a full page load, the
`_authenticated` route's loader starts the health check without waiting for
it. The loader stays in the entry chunk, so the request runs while the page's
chunk downloads. `AuthenticatedLayout` (`src/pages/AuthenticatedLayout.tsx`)
suspends until `/v1/health` answers.
`LoadingScreen` covers it if that takes more than `SHOW_AFTER_MS` (300ms), so
a fast load shows the page with no loading screen. Once shown, the loading
screen stays up for at least `MIN_SHOWN_MS` (900ms, one bounce). Then the page
renders under it, and it fades out (`.loading-screen-leaving`) and removes
itself when the fade ends. jsdom runs no CSS animations, so the `HomePage`
page object ends the fade itself. `healthQuery` never goes stale, so health
is checked once per page load, and coming back to an authenticated page
doesn't show the loading screen again. If health fails after the default
retries, the router's default error component shows.

### Tests

Vitest is configured in the `test` block of `web-client/vite.config.ts` (jsdom
environment). `web-client/src/setupTests.ts` loads the jest-dom matchers,
starts the mock API, and cleans up rendered components after each test. Tests
live next to the code as `*.test.tsx`.

Tests go through page objects in `web-client/src/test/pages/`. A static async
`render()` renders the app's router at the page's path (via
`src/test/renderRoute.tsx`, using a memory history) and returns the object,
whose getters query `screen` on each access (e.g.
`(await HomePage.render()).title`). Page objects expose elements located by
accessible role; assertions stay in the tests.

Unit tests mock the API with MSW. `src/test/server.ts` holds the mock server
and its default handlers, and `setupTests.ts` starts it. An unhandled request
fails the test. A test overrides a handler with `server.use()`, and the
override resets after the test. Type each mock body with the schema's type,
e.g. `components['schemas']['HealthResponse']`.

`renderRoute` gives each render its own `QueryClient` with retries off and an
API client with base URL `API_BASE_URL` (`http://localhost/api`), because
Node's `Request` rejects a relative URL. It waits for the health check, so the
page is on screen when `render()` resolves. To test the loading screen, hold
the health response with `holdHealth()` from `src/test/server.ts` (see
`src/pages/AuthenticatedLayout.test.tsx`). `DesignSystemPage.render()` never
waits for health, because the page doesn't check it. `renderRoute` calls
`router.load()`, which also loads the route's chunk, so no page object waits
for a chunk.

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

The design system page is a copy of the reference's component gallery
(`references/design-system/ui_kits/components/index.html`). It has one
component per gallery section, in `src/pages/designSystem/`
(`ButtonsSection`, `FieldsSection` and so on). Each section and example
carries the gallery's `data-testid` (`section-actions`, `ex-variants`).

The app also has the gallery's screenshot test mode (`src/testMode.ts`, see
the gallery's `TESTING.md`). `?test` turns off transitions, animations and
the text caret. `?test&only=<testid>` shows one element alone, flush top-left
with 24px padding. `<html data-fm-ready="true">` marks the page ready. The
mode's rules are in `kit.css`. Components read `isTestMode()` for the
mode's behaviour, such as toasts that stay until dismissed.

So one set of page objects serves both pages. `GalleryPage` holds the page
chrome, `goto(only?)`, and one object per section in
`e2e/pages/designSystem/`, found by test id. `DesignSystemPage` opens the
app's page, and `ReferenceKitPage` opens the gallery from disk.

Screenshot tests use `toHaveScreenshot`; their baselines live next to the spec
in `e2e/<spec>-snapshots/` and only match when taken in the `playwright`
container, so regenerate them there (`docker compose exec playwright npx
playwright test --update-snapshots`, with the stack and dev server up as in
`web-client:e2e`). `design-system.spec.ts` compares the app's page with the
gallery. Each section has one journey test. The journey opens each section
and example with `goto('<testid>')` and takes its screenshots on the app,
then the same screenshots on the gallery, each in its own `test.step`. The
two pages share each png, so they must render identically. The checks are
soft, so one mismatch doesn't hide the rest. The journey reaches hover,
focus and open states through the real UI on both pages. The header has its
own pair of tests, with the app's title swapped into the gallery's.

An update run writes the png from whichever page it checks last, and it
never fails. After `--update-snapshots`, run the suite again without the
flag. Only that run proves that the app matches the gallery.

`e2e/reference-styles.spec.ts` fails if `src/styles/` stops matching the
reference (see Styles).

Every run records a trace: `web-client/test-results/<test>/trace.zip` (open
with `npx playwright show-trace` or https://trace.playwright.dev) and an HTML
report in `web-client/playwright-report/`.

#### Post-deploy suite

`web-client/e2e/deployed/` is a separate suite, run against a deployment
rather than the dev server, that checks the Worker, the assets and the API
are wired together: `/api/v1/health` reaches the database through the API,
`/api/openapi.json` and `/api/docs` come from the API, an unknown `/api/*` path
gets the API's JSON 404 rather than the SPA's `index.html` (so
`run_worker_first` works), and `/` and `/design-system` load the app (so the
assets and the SPA fallback work). The
main config ignores it; `web-client/playwright.deployed.config.ts` runs it,
with `baseURL` from `PLAYWRIGHT_BASE_URL` (it fails fast without one) and no
screenshot tests. Its `ready` project retries `/api/v1/health` for up to a
minute (Cloud Run cold starts, Preview propagation) before the other specs
run. Against production (`fortymm.com`, `www.fortymm.com` or
`fortymm.mightymoose.workers.dev`), the config runs only the `ready` project.
The app's pages will make a guest account on load, and production keeps every
account. So a production run checks only `/api/v1/health`.

```sh
DEPLOY_URL=https://fortymm.com ./bin/mise run web-client:e2e-deployed
```

`web-client:e2e-deployed` starts just the `playwright` container (and `dev`,
whose network it shares), runs the suite there against `DEPLOY_URL`, then
removes the containers. It needs `npm ci` done (as `ci` does). Its traces and
report go to `web-client/test-results/deployed/` and
`web-client/playwright-report/deployed/`, so they don't replace the main
run's, and CI uploads them in the same `playwright-traces` artifact.

### Styles

The design system's styles apply to the whole app; `main.tsx` imports them:

- `src/styles/tokens.css`: the `:root` tokens (CSS variables) of
  `references/design-system/colors_and_type.css`, plus the self-hosted fonts
  in `src/assets/fonts/`.
- `src/styles/base.css`: the base, type roles, status markers and motion of
  the same file. Then the app's own chrome: `.page-header`
  (`src/components/PageHeader.tsx`, Home's title) and the loading screen.
- `src/styles/kit.css`: the component classes (`fm-*`) of
  `references/design-system/ui_kits/components/kit.css`.
- `src/styles/page.css`: the gallery's page chrome (`.doc-*`), with `.page`
  (the root route's wrapper, `src/pages/Root.tsx`) for its `.doc`.

The reference's parts of these files are copies. Don't edit them.
`e2e/reference-styles.spec.ts` fails when a copy differs from the reference.
If the reference changes, copy the change in.

Each font is split into woff2 files by `unicode-range`, so a page downloads
only the files its text uses. `space-grotesk.css` comes from Fontsource.
`web-client/scripts/subset-fonts.py` writes `bebas-neue.css`,
`jetbrains-mono.css` and their files from the reference's TTFs, the same
files the reference kit embeds. If the reference's fonts change, run it again
(`docker compose run --rm dev /app/bin/docker-entrypoint uv run --no-project
web-client/scripts/subset-fonts.py`).

`index.html` preloads the latin file of each font, because every first paint
uses them. Without the preloads, the browser
finds the fonts only after `main.tsx` renders, so the page and the loading
screen show fallback text first. Vite rewrites the preload `href`s to the
same hashed files the CSS uses. If you rename or add a font that the first
paint uses, update the preloads too.

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

### Dependencies

`node_modules` lives in a Docker volume, not on the host, so native packages
match the container's platform. Install or run npm commands through the
container, e.g.
`docker compose run --rm -w /app/web-client dev npm install <pkg>`.

## Deploy

Production is `https://fortymm.com` (and `www.fortymm.com`): a Cloudflare
Worker serves the web-client and forwards `/api/*` to the API on Google Cloud
Run, so the app's `/api` client is same-origin, as in dev, with no CORS.

The API's `*.run.app` URLs are public, so the Worker proves each request came
through it. It sends the Worker secret in the `X-FortyMM-Worker-Secret`
header, and the API answers 403 to any request without it. The Worker also
limits each client IP to 100 `/api/*` requests a minute and answers 429 above
that. The Worker secret section below describes where the value lives.

```sh
./bin/mise run api:deploy           # build, push and deploy the API; prints its URL last
./bin/mise run api:preview          # the same, as this branch's Preview revision
./bin/mise run api:url              # print the production API's URL
./bin/mise run web-client:deploy    # wrangler deploy of web-client/dist and the Worker
./bin/mise run web-client:preview   # a Cloudflare Preview named after the git branch
./bin/mise run api:preview-delete <branch>         # remove that branch's API Preview tag and database
./bin/mise run web-client:preview-delete <branch>  # delete that branch's Cloudflare Preview
```

CI deploys on every push after `ci` passes, the API first, so the Worker
never points at a route that isn't there yet:

- `main`: `api:deploy`, then `web-client:deploy` with `API_ORIGIN` set to the
  URL it printed.
- Any other branch: `api:preview`, then `web-client:preview` with
  `API_ORIGIN` set to that revision's URL, so each Cloudflare Preview talks to
  the API built from the same commit. Both Preview URLs are in the deploy
  steps' logs.

Before the deploys, CI pins one version of the Worker secret, and both
deploys use it. After the API deploy, CI requests `$API_ORIGIN/v1/health`
without the header and fails unless the API answers 403.

Then CI runs the post-deploy suite (`web-client:e2e-deployed`, see
End-to-end tests) against what it just deployed:

- Any other branch: against the Cloudflare Preview, whose URL the deploy step
  takes from wrangler's `Preview URL:` line (failing if it's missing). This
  checks the branch's full stack, Worker, assets and API revision, before
  it's merged.
- `main`: against `https://fortymm.com` after `web-client:deploy`. Production
  has already changed by then, so this detects a broken deploy rather than
  preventing one. It runs only the health check, so it makes no account.

Both are skipped while the API deploys are (see below), since `/api/*`
answers 503 then.

When a branch other than `main` is deleted,
`.github/workflows/preview-cleanup.yml` removes its Previews.
GitHub runs the workflow from `main`, so the deleted branch's name comes from
the `delete` event. The workflow runs `api:preview-delete` and then
`web-client:preview-delete` with that name. Each task succeeds if its Preview
isn't there. The workflow skips the API step while the API deploys are
skipped. It uses the CI concurrency group of the deleted branch. So it waits
for that branch's running CI deploy, and a CI deploy can't recreate the
Previews after the cleanup.

### web-client (Cloudflare Workers)

`web-client/wrangler.jsonc` configures it. `worker/index.ts` is the Worker
(unit-tested in `worker/index.test.ts`): requests to `/api/*` go to
`API_ORIGIN` with the `/api` prefix stripped, keeping the method, headers,
query and body and setting `X-Forwarded-Host`, `X-Forwarded-Proto` and
`X-Forwarded-For`; with no `API_ORIGIN` they get a 503. The Worker sets
`X-FortyMM-Worker-Secret` from `WORKER_SECRET`, and removes a client's own
copy when `WORKER_SECRET` is empty. Before it forwards a request, the
`API_RATE_LIMIT` binding (`ratelimits` in `wrangler.jsonc`) counts it against
the client's `CF-Connecting-IP`. Above 100 requests a minute, the Worker
answers 429 with `Retry-After: 60`. Cloudflare counts each location
separately, so the limit is approximate. Previews get only the bindings under
`previews` in `wrangler.jsonc`, so that block repeats the rate limit.
Everything else goes to the static assets in `dist/` (the `ASSETS` binding).
`assets.run_worker_first: ["/api/*"]` runs the Worker before the assets for
those paths, and `not_found_handling: "single-page-application"` serves
`index.html` for any other path with no matching file, so client-side routes
load directly.

`API_ORIGIN` isn't in `wrangler.jsonc`: `web-client:deploy` and
`web-client:preview` pass it with `--var` from the environment (CI sets it
from the API deploy), and warn if it's empty. They also pass `WORKER_SECRET`
from the environment, with `--secrets-file`. wrangler runs in the `dev`
container, so the tasks write the file there. If `WORKER_SECRET` is empty,
they warn that the API will answer the Worker with a 403.

Production is served on `fortymm.com` and `www.fortymm.com` (Custom Domains
in `routes`, whose DNS records and certificates Cloudflare manages) and on
`fortymm.mightymoose.workers.dev`.

Previews (`wrangler preview`, open beta) are served on
`<preview-name>-fortymm.mightymoose.workers.dev` because `preview_urls` is on in
`wrangler.jsonc`; changes to that setting only take effect after a production
deploy. `bin/preview-name` makes the name from the branch (`claude/foo_bar` ->
`claude-foo-bar`, at most 30 characters, starting with a letter); the API's
Preview revision uses the same name as its tag. `bin/preview-name` takes an
optional branch name and defaults to the current branch, so it can also name
a deleted branch.

The tasks deploy whatever is in `web-client/dist`, so build first (CI deploys
the build `ci` just tested). They need `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in the environment; CI reads them from the repo's
Actions secrets of the same names.

`web-client:preview-delete` runs `npm ci` and then `wrangler preview delete
--name <name> -y`. wrangler can't check whether a Preview exists first. So
the task reads wrangler's error when the delete fails. If the request to the
Preview API failed with a "not found" error, the task succeeds.

### api (Cloud Run)

The API runs on Cloud Run in GCP project `fortymm`, region `us-central1`
(`GCP_PROJECT` and `GCP_REGION` in `mise.toml`'s `[env]`; set either in the
environment to override). `api:deploy` and `api:preview` build the production
image, push it to Artifact Registry as
`us-central1-docker.pkg.dev/fortymm/fortymm/api:<commit>`, and run
`gcloud run deploy` through `api/deploy/cloud-run-deploy`, which holds the
service settings: min instances 0 (scale to zero), max 3 (1 for Previews),
1 CPU, 256 MiB, unauthenticated access, with the Worker secret as
`WORKER_SECRET` and the Cloud SQL database (see below). Production runs as
the `api-runtime` service account, and Previews as `api-preview-runtime`.
They need `gcloud` logged in as an account that can deploy, and Docker.

- `api:deploy` deploys the `api` service, and the new revision takes all its
  traffic.
- `api:preview` deploys a revision of a separate `api-preview` service tagged
  with the branch's Preview name and no traffic, served on
  `https://<preview-name>---<api-preview's host>`. Each push moves the tag to
  the new revision. Keeping Previews on their own service means a branch
  deploy can never change production's traffic or settings. The revision
  uses the branch's own database (see The database below).
- `api:preview-delete <branch>` removes the branch's tag from `api-preview`
  (`gcloud run services update-traffic --remove-tags`), then drops the
  branch's database. It first checks that the service and the tag exist, and
  skips the tag removal if either is missing. It drops the database in every
  case, because a database can outlive its tag. The revision stays, untagged
  and with no traffic. Cloud Run keeps a limited number of revisions per
  service, and an idle revision costs nothing, so nothing deletes revisions.

#### The database

The API's database is the Cloud SQL instance `fortymm` (Postgres 18,
Enterprise edition, `db-f1-micro`, 10 GB SSD) in the same region.
`cloud-run-deploy` mounts it with `--add-cloudsql-instances` and sets
`DATABASE_URL` to its Unix socket. libpq reads the password from
`PGPASSWORD`, which Cloud Run sets from a secret at `latest`:

| Target | Database | User | Password secret | Runs as |
| --- | --- | --- | --- | --- |
| `api` | `fortymm` | `api` | `api-database-password` | `api-runtime` |
| `api-preview` | `fortymm_preview_<name>` | `api_preview` | `api-preview-database-password` | `api-preview-runtime` |

Each Preview gets its own database, because the API migrates its database at
startup and two branches can have different schemas.
`api/deploy/preview-database` makes the name. It is `fortymm_preview_` and
then the Preview name with dashes changed to underscores
(`feat-db-per-preview` -> `fortymm_preview_feat_db_per_preview`). `cloud-run-deploy` creates the
database on the branch's first Preview deploy. `api:preview-delete` drops it,
and the preview-cleanup workflow runs that task when the branch is deleted.
All Previews connect as `api_preview`. Cloud SQL runs one admin operation per
instance at a time, so `preview-database` retries a create or drop that
collides with another one for about 5 minutes.

Only the matching runtime service account can read each password secret, so
branch code can't read production's password. The instance allows 25
connections. Production holds up to 12 (3 instances with 4 each), and each
warm Preview holds up to 4, so about 3 warm Previews fit at once. The
instance costs about $9-10 a month and never scales to zero.

#### The Worker secret

The Worker secret is a 64-character hex value in Secret Manager, as the
secret `api-worker-secret`. Cloud Run allows unauthenticated requests, so the
Worker secret is the only thing that keeps clients from going around the
Worker.

- `cloud-run-deploy` mounts it as `WORKER_SECRET` at a pinned version number:
  `WORKER_SECRET_VERSION` if set, otherwise the newest enabled version. It
  never uses `latest`. Instances scale to zero and read `latest` again on each
  cold start, so a new version would reach the API before the Worker.
- CI sets `WORKER_SECRET_VERSION` once per run. The Cloudflare deploy steps
  read that version with `gcloud secrets versions access`, mask it in the
  log, and pass it to `web-client:deploy` or `web-client:preview` as
  `WORKER_SECRET`. The value stays in those steps.
- Cloud Run sets `K_SERVICE`. If `K_SERVICE` is set and `WORKER_SECRET` is
  not, `create_app()` raises, so the revision fails to start instead of
  serving the API to anyone.

To rotate the Worker secret, add a version, then push `main`:

```sh
openssl rand -hex 32 | tr -d '\n' |
  gcloud secrets versions add api-worker-secret --project fortymm --data-file=-
```

Production answers 403 for about a minute, between the API deploy and the
Worker deploy. Each Preview picks up the new version on its next push. After
that, disable the old version (`gcloud secrets versions disable <n> --secret
api-worker-secret --project fortymm`) to retire it. A Preview revision still
pinned to a disabled version can't start, so push its branch again first.

CI authenticates to Google Cloud with Workload Identity Federation
(`google-github-actions/auth`; no service-account key), as the
`github-deployer` service account, from two Actions **variables**:
`GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_SERVICE_ACCOUNT`. Until both are
set, CI skips the API deploys with a warning, and the Worker answers `/api/*`
with a 503.

The Artifact Registry repository has a cleanup policy
(`api/deploy/cleanup-policy.json`, applied by `bootstrap-gcp.sh`): it deletes
images older than 30 days except the 10 newest and the one tagged
`production`, which `cloud-run-deploy` moves to each production deploy.

The one-time GCP setup (enabling the APIs, the Artifact Registry repository,
the service accounts and their roles, the Worker secret, the Cloud SQL
instance with its databases, users and password secrets, the Workload
Identity pool and provider for `mightymoose/fortymm`, the budget) is
`api/deploy/bootstrap-gcp.sh`, run once by a project owner; it prints the
variables to set. `api/deploy/README.md` describes it step by step.

The budget `FortyMM (fortymm)` covers the project's monthly spend. Google
Cloud emails the billing account's admins and users when the spend passes
$10 and $25. The Cloud SQL instance alone costs about $9-10 a month, so the
$10 alert will likely fire most months.
