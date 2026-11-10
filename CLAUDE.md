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
- `e2e`: run every end-to-end suite (runs each `<app>:e2e`).

`web-client` tasks act on the Vite + React app in `web-client/` only:

- `web-client:up`: start only `web-client` (Vite dev server, hot reload), then print its URL.
- `web-client:down`: stop only `web-client`.
- `web-client:logs`: follow `web-client`'s logs.
- `web-client:shell`: open a shell in a `web-client` container.
- `web-client:exec`: run any command in a `web-client` container, e.g. `./bin/mise run web-client:exec -- npx vite --version`.
- `web-client:install`: install dependencies. With arguments, add packages: `./bin/mise run web-client:install -- zod`, `./bin/mise run web-client:install -- -D vitest`.
- `web-client:lint`: lint (oxlint).
- `web-client:typecheck`: typecheck (`tsc -b`).
- `web-client:build`: production build into `web-client/dist`.
- `web-client:validate`: lint, typecheck and build, one after another. CI's stage 1 calls this.
- `web-client:e2e`: build, serve `web-client/dist` from the `web-client-preview` service (nginx), run the Playwright suite in `e2e/web-client/` against it, then stop the server.

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
- `api:test`: run the in-process tests in `api/tests/` (pytest) against a real PostgreSQL, the `api_test` database. Arguments go to pytest: `./bin/mise run api:test -- -k health`.
- `api:validate`: lock check, lint, format check, typecheck, OpenAPI check and tests, one after another. CI's stage 1 calls this.
- `api:e2e`: build the production image (`api/Dockerfile`), run it as `api-release` against `api-db`, run the pytest suite in `e2e/api/` against it, then stop what it started.

Where `api` tests go (see `api/README.md`): a pure function's tests in `api/tests/unit/`; a route's tests in `api/tests/http/`, through the app's HTTP interface with the real database (`tests/support/`); one end-to-end test per journey in `e2e/api/tests/`, on its happy path only.

## CI

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`. Each job is a checkout plus one `./bin/mise run` command, so the same command reproduces any failure locally:

1. `validate (<app>)`: `./bin/mise run <app>:validate`, one matrix job per app.
2. `e2e (<app>)`: `./bin/mise run <app>:e2e`, one matrix job per app with an end-to-end suite, after every app validates. Each job starts its own copy of the stack. On failure the job uploads the suite's report as the `e2e-report-<app>` artifact.
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
  - the suite in `e2e/<app>/`;
  - its runner image in `dev/<app>-e2e/` and an `<app>-e2e` service in `compose.dev.yaml`;
  - any other service it needs, named `<app>-<role>` (e.g. `web-client-preview`, `api-release`), with its image in `dev/<app>-<role>/` (a server's production image stays in `<app>/Dockerfile`);
  - an `<app>:e2e` task that runs the suite and stops what it started, added to the stack-wide `e2e` task's `depends` and to the `app` matrix of the `e2e` job in `.github/workflows/ci.yml`.
- Don't rename the stack-wide tasks or another app's tasks.

Each checkout (including each git worktree) gets its own Compose project, so stacks in different checkouts don't collide. If you add or change a task in `mise.toml`, update the lists above.
