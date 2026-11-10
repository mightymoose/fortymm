# fortymm

## Never run project tooling on the host

Do not run `node`, `npm`, `npx`, `python`, `pip`, `uv`, `psql`, package installs, builds, tests or dev servers on the host. Do all work through the mise tasks below. They run in the development Compose stack (`compose.dev.yaml`), with dependencies in Docker volumes. The host needs only Docker.

Run mise as `./bin/mise`, not a `mise` on the PATH. On first use the script downloads a pinned, checksum-verified mise into `.mise/` (gitignored) in this checkout.

## Tasks

Run with `./bin/mise run <task>`. Pass arguments after `--`.

Stack-wide tasks act on every app in the stack:

- `up`: start every app and its services (`web-client`, `api`, `api-db`), then print their URLs.
- `down`: stop the stack. Keeps built images and dependency volumes.
- `teardown`: remove everything the stack uses, e2e services included: containers, networks, volumes (the database's data too) and built images.
- `ports`: print every published port as a URL (`postgresql://` for the database, `http://` otherwise). Host ports are random and change when an app restarts.
- `logs`: follow the logs of every app.
- `validate`: validate every app (runs each `<app>:validate`).
- `e2e`: run every end-to-end suite that isn't already part of an app's validate (runs `api:e2e`; `web-client:e2e` runs inside `web-client:validate`).

`web-client` tasks act on the Vite + React app in `web-client/` only:

- `web-client:up`: start only `web-client` (Vite dev server, hot reload), then print its URL.
- `web-client:down`: stop only `web-client`.
- `web-client:logs`: follow `web-client`'s logs.
- `web-client:shell`: open a shell in a `web-client` container.
- `web-client:exec`: run any command in a `web-client` container, e.g. `./bin/mise run web-client:exec -- npx vite --version`.
- `web-client:install`: install dependencies. With arguments, add packages: `./bin/mise run web-client:install -- zod`, `./bin/mise run web-client:install -- -D vitest`.
- `web-client:routes-check`: fail if the generated route tree `web-client/src/routeTree.gen.ts` is stale against `web-client/src/routes/`. It regenerates the file, so commit the result.
- `web-client:lint`: lint (oxlint).
- `web-client:typecheck`: typecheck (`tsc -b`).
- `web-client:test`: component tests (Vitest, Testing Library, jsdom).
- `web-client:build`: production build into `web-client/dist`.
- `web-client:validate`: route tree check, lint, typecheck, component tests, then `web-client:e2e` (production build and the Playwright suite), one after another. CI's stage 1 calls this.
- `web-client:e2e`: build, serve `web-client/dist` from the `web-client-preview` service (nginx), run the Playwright suite in `web-client/e2e/` against it, then stop the server.

How `web-client` code and tests are laid out (details in `web-client/README.md`):

- Screens are TanStack Router file routes: one file per route in `web-client/src/routes/` (`__root.tsx` is the shared layout and the not-found page, `index.tsx` is `/`). To add a screen, add a route file; the Vite plugin regenerates `web-client/src/routeTree.gen.ts` (committed, never hand-edited). Generator options go in `web-client/tsr.config.json`.
- A screen's component test goes next to its route, `web-client/src/routes/<route>.test.tsx`. It mounts the screen with `renderRoute(path)` from `web-client/src/test/render-route.tsx` and drives it through a page object in `web-client/src/routes/<route>.page.ts`.
- Type-level tests go in `*.test-d.tsx`, checked by `tsc -b`.
- `web-client/e2e/` holds only what needs the production build as served (nginx in `web-client-preview`), with page objects in `web-client/e2e/pages/`. Playwright is one of web-client's own dev dependencies, pinned to the version of the `dev/web-client-e2e` image.

`api` tasks act on the FastAPI app in `api/` and its PostgreSQL, the `api-db` service. Tasks that need the database start `api-db` and remove it afterwards unless it was already running:

- `api:up`: start only `api` (uvicorn with reload) and `api-db`, then print their URLs.
- `api:down`: stop only `api` and `api-db`. Keeps the venv and the data.
- `api:logs`: follow the logs of `api` and `api-db`.
- `api:shell`: open a shell in an `api` container.
- `api:exec`: run any command in an `api` container, e.g. `./bin/mise run api:exec -- python --version`.
- `api:install`: install dependencies, updating `api/uv.lock` to match `api/pyproject.toml`. With arguments, add packages: `./bin/mise run api:install -- httpx`, `./bin/mise run api:install -- --dev pytest-xdist`.
- `api:lint`: lint (`ruff check`).
- `api:format`: format the code in place (`ruff format`).
- `api:format-check`: check the formatting without changing files.
- `api:typecheck`: typecheck (`mypy`, strict).
- `api:lock-check`: check that `api/uv.lock` matches `api/pyproject.toml`.
- `api:openapi`: write the OpenAPI document to `api/openapi.json`. Run it after changing a route or a response model, and commit the file.
- `api:openapi-check`: fail if `api/openapi.json` is not the document the app serves.
- `api:openapi-breaking`: fail if `api/openapi.json` would break clients of the copy on a git ref (oasdiff, in the `api-oasdiff` service; it fails on level ERR, such as a removed path or field or a new required parameter). Additive changes pass. If the ref has no copy, it passes and says so. Defaults to `origin/main` (run `git fetch origin main` first); CI passes the base commit: `./bin/mise run api:openapi-breaking -- HEAD^`.
- `api:test`: run the in-process tests in `api/tests/` (pytest) against a real PostgreSQL, the `api_test` database. Arguments go to pytest: `./bin/mise run api:test -- -k health`.
- `api:validate`: lock check, lint, format check, typecheck, OpenAPI check and tests, one after another. CI's stage 1 calls this.
- `api:e2e`: build the production image (`api/Dockerfile`), run it as `api-release` against `api-db`, run the pytest suite in `e2e/api/` against it, then stop what it started.

How `api` code and tests are laid out (details in `api/README.md`):

- Every route is under `/v1`: a route module joins the router in `api/src/api/routes/v1.py` and writes its paths without the prefix. `/openapi.json` and `/docs` are unversioned.
- Logic lives in a service class in `api/src/api/services/`. It returns plain results and knows nothing about HTTP or the response format. A route in `api/src/api/routes/` gets the service from `api/src/api/dependencies.py` and only converts each result into a status code and a response document.
- Responses are shaped after JSON:API, using only the members we need, and are served as `application/json`. Success is `{"data": {"type", "id", "attributes"}}`. Failure is `{"errors": [{"status", "code", "title"}]}`, with nothing occurrence-specific in it. Each error is an `ErrorObject` subclass with constant members, declared with `documented(...)` and sent with `error_response(...)` (both in `api/src/api/routes/errors.py`), so the OpenAPI document types it exactly. FastAPI's own 404, 405 and 500 use the same shape. Operation IDs are the route function names (`get_health`). `api/README.md` has the details.
- A pure function's tests go in `api/tests/unit/`.
- Every case of a service's logic is tested in `api/tests/services/`, through its public methods, with the real database and the stand-ins in `api/tests/support/database_faults.py`.
- A route's tests go in `api/tests/http/`: one real case per outcome, nothing faked, plus a check of each response against the OpenAPI document. They prove wiring and translation, not logic.
- `e2e/api/tests/` has one end-to-end test per journey, on its happy path only.

## CI

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`. Each job is a checkout plus one `./bin/mise run` command, so the same command reproduces any failure locally:

1. `validate (<app>)`: `./bin/mise run <app>:validate`, one matrix job per app. For `web-client` this includes its Playwright suite; on failure the job uploads its report as the `validate-report-web-client` artifact. Alongside it, `openapi-breaking (<app>)` runs `./bin/mise run <app>:openapi-breaking -- HEAD^`, one matrix job per app with an OpenAPI document. It checks out two commits: on a pull request `HEAD^` is the base branch, and on a push to `main` it is `main` before the push.
2. `e2e (<app>)`: `./bin/mise run <app>:e2e`, one matrix job per app with an end-to-end suite outside its validate (today `api`), after every app validates. Each job starts its own copy of the stack. On failure the job uploads the suite's report as the `e2e-report-<app>` artifact.
3. `ci-passed`: fails unless every job above succeeded. This is the check to require on `main`.

## Naming rule

- A task that acts on the whole stack has a plain name (`up`, `down`, `teardown`, `ports`, `logs`, `validate`, `e2e`).
- A task for one app is prefixed with the app's name and a colon: `<app>:<task>`. The app's name is its directory and its Compose service name.
- To add an app, copy the `web-client` pattern:
  - the app in `<app>/`;
  - a dev image in `dev/<app>/`;
  - a `<app>` service in `compose.dev.yaml`, and a service named `<app>-<role>` for anything else it needs to run (e.g. `api-db`), with its image in `dev/<app>-<role>/`;
  - a `# ---- <app>` block of `<app>:*` tasks in `mise.toml`, with the same task names where they apply;
  - an `<app>:validate` task that runs every check for the app, added to the stack-wide `validate` task's `depends` and to the `app` matrix of the `validate` job in `.github/workflows/ci.yml`.
- An app's end-to-end suite (a client's, or a server's driven over HTTP) follows the same pattern under the `e2e` Compose profile, so `up` never starts it:
  - the suite in `e2e/<app>/` (as for `api`), or in the app itself when it tests only that app with the app's own tooling (`web-client/e2e/`);
  - its runner image in `dev/<app>-e2e/` and an `<app>-e2e` service in `compose.dev.yaml`;
  - any other service it needs, named `<app>-<role>` (e.g. `web-client-preview`, `api-release`), with its image in `dev/<app>-<role>/` (a server's production image stays in `<app>/Dockerfile`);
  - an `<app>:e2e` task that runs the suite and stops what it started, added to the stack-wide `e2e` task's `depends` and to the `app` matrix of the `e2e` job in `.github/workflows/ci.yml`. A suite that lives in the app and tests only the app (`web-client/e2e/`) runs at the end of `<app>:validate` instead, and is not added to either.
- Don't rename the stack-wide tasks or another app's tasks.

Each checkout (including each git worktree) gets its own Compose project, so stacks in different checkouts don't collide. If you add or change a task in `mise.toml`, update the lists above.
