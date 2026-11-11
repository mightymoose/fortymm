# fortymm

## Never run project tooling on the host

Do not run `node`, `npm`, `npx`, `python`, `pip`, `uv`, `psql`, package installs, builds, tests or dev servers on the host. Do all work through the mise tasks below. They run in the development Compose stack (`compose.dev.yaml`), with dependencies in Docker volumes. The host needs only Docker.

Run mise as `./bin/mise`, not a `mise` on the PATH. On first use the script downloads a pinned, checksum-verified mise into `.mise/` (gitignored) in this checkout.

## Tasks

Run with `./bin/mise run <task>`. Pass arguments after `--`.

Stack-wide tasks act on every app in the stack:

- `up`: start every app and its services (`web-client`, `api`, `api-db`), then print their URLs. It first runs `core:python` and `core:wasm`, which `api` and `web-client` load.
- `down`: stop the stack. Keeps built images and dependency volumes.
- `teardown`: remove everything the stack uses, e2e services included: containers, networks, volumes (the database's data too) and built images.
- `ports`: print every published port as a URL (`postgresql://` for the database, `http://` otherwise). Host ports are random and change when an app restarts.
- `logs`: follow the logs of every app.
- `validate`: validate every app (runs each `<app>:validate`: `web-client`, `api` and `core`).
- `e2e`: run the cross-app suite in `e2e/`: what can fail only because of how the apps are served or connected. It typechecks the suite, builds `web-client`, serves the build from `web-client-hosting`, brings up `api-release` (the api's production image) and `api-db` behind it, runs the Playwright suite against it (in the `e2e` service), then stops what it started. `web-client-hosting` is an nginx stand-in for the production hosting (Cloudflare Workers, not in this repository yet); like the real hosting must, it forwards `/api/*` to the api with `/api` stripped. Its tests assert what a person sees, not HTTP details: status codes and content types are the api's own tests' job. The browser is full Chromium told to treat the stand-in's plain-http origin as secure (`e2e/playwright.config.ts`), because WebCrypto, which the web client signs with, exists only in a secure context.

`web-client` tasks act on the Vite + React app in `web-client/` only:

- `web-client:up`: start only `web-client` (Vite dev server, hot reload), then print its URL. Runs `core:wasm` first.
- `web-client:down`: stop only `web-client`.
- `web-client:logs`: follow `web-client`'s logs.
- `web-client:shell`: open a shell in a `web-client` container.
- `web-client:exec`: run any command in a `web-client` container, e.g. `./bin/mise run web-client:exec -- npx vite --version`.
- `web-client:install`: install dependencies. With arguments, add packages: `./bin/mise run web-client:install -- zod`, `./bin/mise run web-client:install -- -D vitest`.
- `web-client:routes-check`: fail if the generated route tree `web-client/src/routeTree.gen.ts` is stale against `web-client/src/routes/`. It regenerates the file, so commit the result.
- `web-client:api-types`: regenerate the api types `web-client/src/api/schema.gen.ts` from `api/openapi.json` (openapi-typescript, in the `web-client-openapi` tool service). Run it after `api:openapi` changes the document, and commit the file.
- `web-client:api-types-check`: fail if `web-client/src/api/schema.gen.ts` is stale against `api/openapi.json`. It regenerates the file, so commit the result. This is the one place `web-client` reads a file of another app.
- `web-client:lint`: lint (oxlint).
- `web-client:typecheck`: typecheck (`tsc -b`).
- `web-client:test`: component tests (Vitest, Testing Library, jsdom).
- `web-client:build`: production build into `web-client/dist`.
- These three, and `web-client:up`, first run `core:wasm`: the web client reads the core's browser build (the WebAssembly module with cryptography and its wrapper) from the `core-cache` volume, mounted read-only at `/opt/core`, as `fortymm-core/...` (`web-client/vite.config.ts`, `web-client/tsconfig.app.json`). The build bundles both into `dist`.
- `web-client:validate`: route tree check, api types check, lint, typecheck, component tests, then the production build, one after another. CI's stage 1 calls this.

How `web-client` code and tests are laid out (details in `web-client/README.md`):

- Screens are TanStack Router file routes: one file per route in `web-client/src/routes/` (`__root.tsx` is the shared layout and the not-found page, `index.tsx` is `/`). To add a screen, add a route file; the Vite plugin regenerates `web-client/src/routeTree.gen.ts` (committed, never hand-edited). Generator options go in `web-client/tsr.config.json`.
- A screen's component test goes next to its route, `web-client/src/routes/<route>.test.tsx`. It uses a page object in `web-client/src/routes/<route>.page.ts` whose `render()` mounts the whole app at that screen's URL (through `renderRoute(path)` in `web-client/src/test/render-route.tsx`), and whose other methods only find elements, by role and accessible name. The test performs every interaction itself with user-event: `const user = userEvent.setup()`, then `await user.click(await page.counter())`. Page objects have no action methods.
- The web client calls the api only through the typed client in `web-client/src/api/client.ts` (openapi-fetch, which types the request from the generated `schema.gen.ts`); a call that turns an answer into what the app needs goes next to it (`web-client/src/api/health.ts`), and parses the body with zod. The rules for that boundary are in `web-client/CLAUDE.md`. The browser reaches the api at `/api` on the app's own origin, and whatever serves the app forwards `/api/*` to the api's paths (`/api/v1/health` to `/v1/health`): Vite's proxy in dev, `web-client-hosting` in the cross-app suite. No route of the app may start with `/api`.
- In component tests, MSW stands in for the api (`web-client/src/test/api/server.ts`, started by `web-client/src/test/setup.ts`). A test says how the api answers with `server.use(...)` and a handler from `web-client/src/test/api/<resource>.ts`, typed from the same document. A request no handler answers fails the test.
- Type-level tests go in `*.test-d.ts` or `*.test-d.tsx`, checked by `tsc -b` (`web-client/src/api/client.test-d.ts` proves the client's requests, the zod schemas' input and the mocks are typed from the document).
- `web-client` has no browser suite of its own: anything the router or a screen decides, such as which page a URL shows, is a component test. What depends on how the build is hosted (a deep path gets the app; the bundle loads and mounts in a real browser; the hosted page reaches the api through the hosting) is in the cross-app suite, `e2e/`.

`api` tasks act on the FastAPI app in `api/` and its PostgreSQL, the `api-db` service. Tasks that need the database start `api-db` and remove it afterwards unless it was already running:

- `api:up`: start only `api` (uvicorn with reload) and `api-db`, then print their URLs. Runs `core:python` first.
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
- `api:openapi-breaking`: fail if `api/openapi.json` would break clients of the copy on a git ref (oasdiff, in the `api-oasdiff` service; it fails on level ERR, such as a removed path or field or a new required parameter). Additive changes pass. If the ref has no copy, it passes and says so. Defaults to `origin/main` (run `git fetch origin main` first); CI passes the base commit: `./bin/mise run api:openapi-breaking -- HEAD^`. An operation marked temporary (`x-stability-level: draft`, see `api/README.md`) may be removed or changed without failing it.
- `api:test`: run the in-process tests in `api/tests/` (pytest) against a real PostgreSQL, the `api_test` database. Arguments go to pytest: `./bin/mise run api:test -- -k health`.
- `api:openapi-temporary-check`: fail unless `api:openapi-breaking`'s oasdiff command passes with every temporary operation taken out of `api/openapi.json`, and fails with any one other operation taken out. It edits the document with `jq` on the host.
- `api:up`, `api:typecheck`, `api:openapi`, `api:openapi-check` and `api:test` first run `core:python`: the app imports the core's Python module, which the `api` service reads from the `core-cache` volume (`PYTHONPATH` and, for mypy, `MYPYPATH`, at `/opt/core/python`). The shipped image (`api/Dockerfile`) builds its own copy from `core/`, given to the build as a second context named `core`.
- `api:validate`: lock check, lint, format check, typecheck, OpenAPI check, the temporary-mark check, tests, then `api:e2e` (the shipped image), one after another. CI's stage 1 calls this.
- `api:e2e`: build the production image (`api/Dockerfile`), run it as `api-release` against `api-db`, run the pytest suite in `api/e2e/` against it (from `api-e2e`, with the api's dev image and venv), then stop what it started.

How `api` code and tests are laid out (details in `api/README.md`):

- Every route is under `/v1`: a route module joins the router in `api/src/api/routes/v1.py` and writes its paths without the prefix. `/openapi.json` and `/docs` are unversioned.
- Logic lives in a service class in `api/src/api/services/`. It returns plain results and knows nothing about HTTP or the response format. A route in `api/src/api/routes/` gets the service from `api/src/api/dependencies.py` and only converts each result into a status code and a response document.
- Responses are shaped after JSON:API, using only the members we need, and are served as `application/json`. Success is `{"data": {"type", "id", "attributes"}}`. Failure is `{"errors": [{"status", "code", "title"}]}`, with nothing occurrence-specific in it. Each error is an `ErrorObject` subclass with constant members, declared with `documented(...)` and sent with `error_response(...)` (both in `api/src/api/routes/errors.py`), so the OpenAPI document types it exactly. FastAPI's own 404, 405 and 500 use the same shape. Operation IDs are the route function names (`get_health`). `api/README.md` has the details.
- A pure function's tests go in `api/tests/unit/`.
- Every case of a service's logic is tested in `api/tests/services/`, through its public methods, with the real database and the stand-ins in `api/tests/support/database_faults.py`.
- A route's tests go in `api/tests/http/`: one real case per outcome, nothing faked, plus a check of each response against the OpenAPI document. They prove wiring and translation, not logic.
- `api/e2e/` drives the shipped image (`api-release`) over the network, with its real database: one test per journey, on its happy path only.

`core` tasks act on the shared core library in `core/` (Rust), in the `core` service. It is a library, so it has no `up`, `down` or `logs`, and `up` does not start it. The Rust toolchain is pinned in `dev/core/Dockerfile`. Cargo's downloads and all build output are in the `core-cache` volume, never in the checkout:

- `core:shell`: open a shell in a `core` container.
- `core:exec`: run any command in a `core` container, e.g. `./bin/mise run core:exec -- cargo tree`.
- `core:install`: update `core/Cargo.lock` to match the `Cargo.toml` files. With arguments, add packages: `./bin/mise run core:install -- sha2`, `./bin/mise run core:install -- --dev hex`.
- `core:lint`: lint (`cargo clippy`, warnings are errors), once with the built-in cryptography and once without it (the web build).
- `core:format`: format the code in place (`cargo fmt`).
- `core:format-check`: check the formatting without changing files.
- `core:test`: run the tests (`cargo test`). Arguments go to cargo: `./bin/mise run core:test -- --test sizes -- --nocapture` prints the measured parcel sizes.
- `core:build`: release build of the library for the container's own platform.
- `core:wasm`: build the WebAssembly module for browsers twice, with the cryptography compiled in and without it, shrink both with `wasm-opt`, print their sizes, then run the golden vectors through both from Node. The build without cryptography hashes and verifies with WebCrypto. The wrapper `fortymm-core.mjs` and its types `fortymm-core.d.mts` are copied beside the modules in `/opt/core/wasm`.
- `core:python`: build the Python module for the server (stable ABI, Python 3.12 and later), then run the golden vectors through it with the same Python as `api`. The module and its type stub `fortymm_core.pyi` go to `/opt/core/python`.
- `core:validate`: format check, lint, tests, release build, `core:wasm`, then `core:python`, one after another. CI's stage 1 calls this.

How `core` code and tests are laid out (details in `core/README.md`; every byte-level choice in `core/FORMAT.md`):

- The library is pure: no input or output, no clock, no random generator, and it never signs. Hashing and signature verification come from the `Crypto` trait; the default `crypto` feature compiles in a software implementation, and a build without it gets both from its host.
- Every number in the byte format (kind numbers, field keys, labels, the alphabet, the checksum) is in `core/src/layout.rs`, and each is described in `core/FORMAT.md`. Change both together.
- Unit tests sit beside the code. Tests in `core/tests/` go through the public interface only; signing there uses software keys in `core/tests/common/`.
- `core/vectors/vectors.json` holds the golden vectors. `core:test` fails if the code no longer produces them, and `core:wasm` and `core:python` check every build against the same file. Before the first public release, regenerate with `./bin/mise run core:test -- --test vectors -- --ignored regenerate`; after it, only add vectors.
- The bindings are in `core/bindings/`: `wasm/` (a raw WebAssembly interface and the hand-written wrapper `fortymm-core.mjs`) and `python/` (PyO3). `cargo test` and `cargo build` without `-p` act on the library alone.

## CI

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`. Each job is a checkout plus one `./bin/mise run` command, so the same command reproduces any failure locally:

1. `validate (<app>)`: `./bin/mise run <app>:validate`, one matrix job per app: everything the app can prove by itself, its own end-to-end suite included where it has one (api's shipped-image suite). On failure the job uploads that suite's report as the `validate-report-<app>` artifact. Alongside it, `openapi-breaking (<app>)` runs `./bin/mise run <app>:openapi-breaking -- HEAD^`, one matrix job per app with an OpenAPI document. It checks out two commits: on a pull request `HEAD^` is the base branch, and on a push to `main` it is `main` before the push.
2. `e2e`: `./bin/mise run e2e`, one job for the cross-app suite in `e2e/`, after every app validates. It holds only what can fail because of how the apps are served or connected (today: the web client's hosting, through its stand-in, and the web client reaching the api through it). On failure the job uploads the suite's report as the `e2e-report` artifact.
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
- Everything an app can prove by itself goes in its `<app>:validate`. That includes an app's own end-to-end suite when it has one: a server's shipped image over HTTP, with what the app owns, such as its database (today `api`). It follows the same pattern under the `e2e` Compose profile, so `up` never starts it:
  - the suite in `<app>/e2e/`, using the app's own test tooling and dependencies;
  - an `<app>-e2e` service in `compose.dev.yaml` that runs it, with its runner image in `dev/<app>-e2e/` when the app's dev image can't run it (`api` reuses `dev/api`);
  - any other service it needs, named `<app>-<role>` (e.g. `api-release`), with its image in `dev/<app>-<role>/` (a server's production image stays in `<app>/Dockerfile`);
  - an `<app>:e2e` task that runs the suite and stops what it started, as the last step of `<app>:validate`.
- The cross-app suite is the only one at the repository level: `e2e/`, run by the `e2e` service (image in `dev/e2e/`) and the stack-wide `e2e` task, which is CI's stage 2. It holds what can fail only because of how the apps are served or connected: the hosting in front of an app, and the wiring between apps. A service it needs is still named after the app it serves, `<app>-<role>` (e.g. `web-client-hosting`).
- Don't rename the stack-wide tasks or another app's tasks.

Each checkout (including each git worktree) gets its own Compose project, so stacks in different checkouts don't collide. If you add or change a task in `mise.toml`, update the lists above.
