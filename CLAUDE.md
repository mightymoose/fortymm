# fortymm

## Never run project tooling on the host

Do not run `node`, `npm`, `npx`, `python`, `pip`, `uv`, `psql`, package installs, builds, tests or dev servers on the host. Do all work through the mise tasks below. They run in the development Compose stack (`compose.dev.yaml`), with dependencies in Docker volumes. The host needs only Docker.

Run mise as `./bin/mise`, not a `mise` on the PATH. On first use the script downloads a pinned, checksum-verified mise into `.mise/` (gitignored) in this checkout.

## Tasks

Run with `./bin/mise run <task>`. Pass arguments after `--`.

Stack-wide tasks act on every app in the stack:

- `up`: start every app and its services (`web-client`, `api`, `api-db`), then print their URLs. It runs `core:wasm` first, since `web-client` loads the core.
- `down`: stop the stack. Keeps built images and dependency volumes.
- `teardown`: remove everything the stack uses, e2e services included: containers, networks, volumes (the database's data too) and built images.
- `ports`: print every published port as a URL (`postgresql://` for the database, `http://` otherwise). Host ports are random and change when an app restarts.
- `logs`: follow the logs of every app.
- `validate`: validate every app (runs each `<app>:validate`: `web-client`, `api` and `core`) and the workflows (`workflows`).
- `workflows`: check the GitHub workflows in `.github/`, in the `workflows` tool service (image `dev/workflows/`: bash, jq, yq and actionlint's binary; `.github` mounted read-only). It runs actionlint over `.github/workflows/*.yml`, then the permission rules in `.github/scripts/check-workflows.sh`: only `ci.yml`'s `preview-comment` job has `pull-requests: write`; it has no secret, no `id-token` and no checkout of the pull request's code; it runs only under the previews' condition and after both; no job needs it. Then that check's own tests (`.github/scripts/tests/check-workflows.sh`, which break each rule in a copy of the workflows and expect the check to fail), and the comment script's tests (`.github/scripts/tests/preview-comment.sh`, against a stand-in for `gh` in `.github/scripts/tests/stand-in/`). Scripts that the workflows run themselves, not tied to one app, go in `.github/scripts/`, their tests in `.github/scripts/tests/`.
- `e2e`: run the cross-app suite in `e2e/`: what can fail only because of how the apps are served or connected. It typechecks the suite, builds `web-client`, serves the build from `web-client-worker` (the web client's production hosting, the Worker in `web-client/worker/`, in the local Workers runtime) and from `web-client-hosting`, brings up `api-release` (the api's production image) and `api-db` behind the latter, runs the Playwright suite (in the `e2e` service), then stops what it started. The suite has two Playwright projects. `worker` (`e2e/tests/hosting*.spec.ts`, after the setup `e2e/tests/hosting-serves-build.setup.ts` checks the address serves this checkout's build) proves the hosting's rules against the Worker: what a person sees (a deep path gets the app, the bundle runs, the app opens offline after one visit), and the HTTP rules no person sees until they go wrong (caching headers, the 404s that must never be the app's page, `nosniff`). `api-wiring` (`e2e/tests/health.spec.ts`) proves the web client reaching the api; it goes through `web-client-hosting`, an nginx stand-in that forwards `/api/*` to the api with `/api` stripped, because the Worker has no proxy to the api yet. Status codes and content types of the api itself are the api's own tests' job. Chromium treats the stack's plain-http origins as secure, so the service worker runs as it does on the https production hosting.

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
- `web-client:build`: production build into `web-client/dist`. It includes the service worker, `dist/sw.js`, which lists every file of the build, and the core's WebAssembly module (`dist/assets/fortymm-core-<hash>.wasm`).
- `web-client:up`, `:typecheck`, `:test` and `:build` first run `core:wasm`, and so does everything that runs them (`web-client:validate`, `web-client:e2e`, the worker tasks, `web-client:deploy` and `:preview`, `up`, `e2e`): the web client reads the core's browser build (the module, its wrapper `fortymm-core.mjs` and its types `fortymm-core.d.mts`) from the `core-cache` volume, mounted read-only at `/opt/core` in the `web-client` service, and imports it as `fortymm-core/...` (an alias in `web-client/vite.config.ts`, a path in `web-client/tsconfig.app.json`).
- `web-client:e2e`: the web client's own browser suite in `web-client/e2e/` (Playwright). It makes the production build, prepares the builds the suite deploys (`web-client/scripts/e2e-deployments.ts`: the build, and a later "next" deployment of it), serves them with `vite preview` (`web-client-preview`), typechecks and runs the suite from `web-client-e2e`, then stops what it started. It needs no other app.
- `web-client:icons`: render the install icons `web-client/public/icons/*.png` from the app's icon, `web-client/public/favicon.svg`, with Chromium (`web-client-icons`, the browser suite's image). Run it after changing the icon, look at the PNGs, and commit them.
- `web-client:validate`: route tree check, api types check, lint, typecheck, component tests, `web-client:e2e` (the production build and the browser suite), then `web-client:deploy-check`, one after another. CI's stage 1 calls this.

The web client's hosting is a Cloudflare Worker, `web-client/worker/` (its own package, with Wrangler pinned). These tasks run Wrangler in the `web-client-worker` service (image `dev/web-client-worker/`):

- `web-client:worker-up`: build `web-client`, serve it from the Worker in the local Workers runtime (`wrangler dev`, the same configuration Cloudflare runs), then print its URL. `web-client:worker-down` stops it.
- `web-client:worker-install`: install the Worker's dependencies. With arguments, add packages: `./bin/mise run web-client:worker-install -- -D wrangler@<version>`.
- `web-client:wrangler`: run any Wrangler command, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` passed through when set: `./bin/mise run web-client:wrangler -- deployments list`.
- `web-client:deploy-check`: what can be proven about deploying without credentials: the Worker typechecks (`wrangler types`, then `tsc`), dry runs of the deployment of `web-client/dist` to the production Worker and to a named trial Worker succeed and target those names, the deploy refuses to start without credentials, the preview delete refuses every name but `fortymm-pr-<number>` (the production one included), and `web-client:preview` refuses the production Worker. Reads `web-client/dist`, so it runs after the build.
- `web-client:deploy`: build and deploy to Cloudflare, and nothing more: no checks against the address (nothing is tested against production). It writes the address to `web-client/worker/.wrangler/address`. Needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment and fails, saying which is missing, without them. With an argument, deploy to a Worker of that name instead of the production one. CI's `deploy` job runs it on main.
- `web-client:preview`: deploy to a Worker that isn't the production one, then run `web-client:hosting-check` against its address: `./bin/mise run web-client:preview -- fortymm-trial`. It refuses the production name. CI's `preview` job runs it for each pull request, to `fortymm-pr-<number>`. Same credentials as `web-client:deploy`.
- `web-client:preview-delete`: delete a pull request's preview Worker: `./bin/mise run web-client:preview-delete -- fortymm-pr-9`. It refuses any name but `fortymm-pr-<number>` before reaching Cloudflare (`web-client/worker/scripts/delete-preview.sh`), and a preview that doesn't exist is not an error. CI's `Preview cleanup` workflow runs it when a pull request closes.
- `web-client:hosting-check`: run the cross-app suite's `worker` project (the hosting's rules) against any address that serves this checkout's build, `web-client/dist`: `./bin/mise run web-client:hosting-check -- https://fortymm-trial.<subdomain>.workers.dev`. It first waits, up to two minutes, until the address serves that build (`e2e/tests/hosting-serves-build.setup.ts`), since a deployment reaches Cloudflare's edge some seconds after `wrangler deploy` returns.

How `web-client` code and tests are laid out (details in `web-client/README.md`):

- Screens are TanStack Router file routes: one file per route in `web-client/src/routes/` (`__root.tsx` is the shared layout and the not-found page, `index.tsx` is `/`). To add a screen, add a route file; the Vite plugin regenerates `web-client/src/routeTree.gen.ts` (committed, never hand-edited). Generator options go in `web-client/tsr.config.json`.
- A screen's component test goes next to its route, `web-client/src/routes/<route>.test.tsx`. It uses a page object in `web-client/src/routes/<route>.page.ts` whose `render()` mounts the whole app at that screen's URL (through `renderRoute(path)` in `web-client/src/test/render-route.tsx`), and whose other methods only find elements, by role and accessible name. The test performs every interaction itself with user-event: `const user = userEvent.setup()`, then `await user.click(await page.counter())`. Page objects have no action methods.
- The web client calls the api only through the typed client in `web-client/src/api/client.ts` (openapi-fetch, which types the request from the generated `schema.gen.ts`); a call that turns an answer into what the app needs goes next to it (`web-client/src/api/health.ts`), and parses the body with zod. The rules for that boundary are in `web-client/CLAUDE.md`. The browser reaches the api at `/api` on the app's own origin, and whatever serves the app forwards `/api/*` to the api's paths (`/api/v1/health` to `/v1/health`): Vite's proxy in dev, `web-client-hosting` in the cross-app suite. The production hosting, the Worker, doesn't yet: it answers `/api` and `/api/*` with a 404, and its proxy to the api goes where `web-client/worker/src/index.ts` says. No route of the app may start with `/api`.
- The hosting is the Worker in `web-client/worker/`: `wrangler.jsonc` (assets from `../dist`; the Worker runs first for every request) and `src/index.ts`, which holds every rule: the app's page for any path that isn't a file, the 404s (`/api/*`, a missing file under `/assets/`), and every header. Its rules are tested in `e2e/` (project `worker`), against the local Workers runtime or a deployment. Details in `web-client/README.md`, "Hosting".
- In component tests, MSW stands in for the api (`web-client/src/test/api/server.ts`, started by `web-client/src/test/setup.ts`). A test says how the api answers with `server.use(...)` and a handler from `web-client/src/test/api/<resource>.ts`, typed from the same document. A request no handler answers fails the test.
- Web client code calls the shared core with `const core = await loadCore()` (`web-client/src/core/load.ts`), which fetches and instantiates the module once per page; the wrapper's methods are then synchronous. In component tests, `web-client/src/test/setup.ts` replaces `load.ts` with one that reads the same real module from disk (jsdom can't fetch it); a test makes loading fail with `vi.mocked(loadCore).mockRejectedValue(...)`. `/health` shows whether the core loaded, with the username it gives a fixed player id (a golden vector).
- Type-level tests go in `*.test-d.ts` or `*.test-d.tsx`, checked by `tsc -b` (`web-client/src/api/client.test-d.ts` proves the client's requests, the zod schemas' input and the mocks are typed from the document).
- The app keeps itself on the device so it opens with no connection: a service worker (`web-client/offline/service-worker.ts`, written into the build as `sw.js` by `web-client/offline/plugin.ts`, registered in production only by `web-client/src/keep-on-device.ts`). Requests under `/api/` are never answered from the kept copy. It is installable: `web-client/public/manifest.webmanifest`, and the iPhone icon link in `web-client/index.html`. Details in `web-client/README.md`.
- Anything the router or a screen decides, such as which page a URL shows, is a component test. The web client's browser suite, `web-client/e2e/`, holds only what needs a real browser and the production build by itself: opening with no connection, updating to a new deployment, installability. It drives `vite preview` at `localhost` (a secure context, where service workers run), with one test per claim. What depends on how the build is hosted (a deep path gets the app; the bundle loads and mounts as served; the app opens offline as served; the hosting's headers and 404s) or on the api (the hosted page reaches it; an api answer is never kept) is in the cross-app suite, `e2e/`.

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
- `api:validate`: lock check, lint, format check, typecheck, OpenAPI check, tests, `api:e2e` (the shipped image), then `api:deploy-check`, one after another. CI's stage 1 calls this.
- `api:e2e`: build the production image (`api/Dockerfile`), run it as `api-release` against `api-db`, run the pytest suite in `api/e2e/` against it (from `api-e2e`, with the api's dev image and venv), then stop what it started.

The api's pull request previews run on Google Cloud, in the project `fortymm`, region `northamerica-northeast2`: one Cloud Run service per pull request, each with its own database on one shared Cloud SQL instance for previews only (`api/README.md`, "Hosting"). These tasks run gcloud in the `api-hosting` service (image `dev/api-hosting/`), with the login kept in the `api-hosting-gcloud` volume, never in the checkout (`teardown` removes it):

- `api:gcloud`: run any gcloud command with the kept login. Log in first, in a terminal: `./bin/mise run api:gcloud -- auth login --no-launch-browser`.
- `api:hosting-setup`: prepare the project for the previews (`api/hosting/setup.sh`): APIs, the deployer and runtime service accounts and their roles, the image repository, the instance, the shared database role and its password in Secret Manager, and Workload Identity Federation for GitHub Actions in `mightymoose/fortymm`. It creates what is missing and changes nothing already in place; a second run says so. Something that exists but differs is reported, never changed. Needs an owner's login.
- `api:hosting-check`: change nothing; report each item the setup makes as in place, missing or different, then ask Google Cloud, as the deployer (impersonated), what it may and may not do. Fails if anything is missing or wrong.
- `api:preview`: deploy a preview of the api, as the deployer: `./bin/mise run api:preview -- fortymm-api-pr-9`. It builds the production image for linux/amd64, pushes it to the preview's own image package, creates the preview's database if missing (a redeploy keeps it), deploys the Cloud Run service pinned to the pushed digest (`api/hosting/preview.sh`), then runs `api:preview-check` against its address and writes the address to `api/hosting/.preview/address`. It takes `fortymm-api-pr-<number>` (CI's preview job) or `fortymm-api-trial` (a branch tried by hand), and refuses any other name before building (`api/hosting/preview-name.sh`, which also derives the database and package from the name: `pr_9`, `pr-9`). In CI it signs in through Workload Identity Federation (the credential file `google-github-actions/auth` writes, mounted by `api/hosting/run.sh`); on a laptop it impersonates the deployer with the kept login.
- `api:preview-check`: run the api's end-to-end suite (`api/e2e/`) against a deployed address: `./bin/mise run api:preview-check -- https://fortymm-api-pr-9-89514061125.northamerica-northeast2.run.app`.
- `api:preview-delete`: delete a pull request's preview: `./bin/mise run api:preview-delete -- fortymm-api-pr-9`. The service, then its database, then its image package (`api/hosting/delete-preview.sh`). It refuses any name but `fortymm-api-pr-<number>` on the host, before anything reaches Google Cloud, and something already gone is not an error. CI's `Preview cleanup` workflow runs it when a pull request closes.
- `api:deploy-check`: what can be proven about the api's hosting without credentials (`api/hosting/deploy-check.sh`): `api:hosting-setup`, `api:hosting-check`, the preview and the preview delete stop first, saying the credentials are missing, before reading or changing anything; each preview name gives its own database; and the preview delete refuses every name but `fortymm-api-pr-<number>` (the trial, the instance's own name, `postgres`, a production-looking name, two names...); and the preview and its delete take a resource as gone only when gcloud says "not found", any other failure stopping them (`api/hosting/tests/describe-answers.sh`, with stand-ins for gcloud and docker). The last step of `api:validate`.

The names the hosting scripts and the workflows share (project, region, provider, service accounts, instance), none of them secret, are in `api/hosting/hosting.env`; nothing has to be set in GitHub.

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
- `core:lint`: lint (`cargo clippy`, warnings are errors).
- `core:format`: format the code in place (`cargo fmt`).
- `core:format-check`: check the formatting without changing files.
- `core:test`: run the tests (`cargo test`). Arguments go to cargo: `./bin/mise run core:test -- --test sizes -- --nocapture` prints the measured parcel sizes.
- `core:build`: release build of the library for the container's own platform.
- `core:wasm`: build the WebAssembly module for browsers (`fortymm-core.wasm`, with the cryptography compiled in), shrink it with `wasm-opt`, print its size, then run the golden vectors through it from Node with WebCrypto hidden. Once they pass, it publishes the module, the wrapper `fortymm-core.mjs` and its types `fortymm-core.d.mts` together in `/opt/core/wasm` (each renamed into place, so a reader never sees half a file): the browser build the web client loads.
- `core:python`: build the Python module for the server (stable ABI, Python 3.12 and later), then run the golden vectors through it with the same Python as `api`. The module and its type stub `fortymm_core.pyi` go to `/opt/core/python`.
- `core:validate`: format check, lint, tests, release build, `core:wasm`, then `core:python`, one after another. CI's stage 1 calls this.

How `core` code and tests are laid out (details in `core/README.md`; every byte-level choice in `core/FORMAT.md`):

- The library is pure: no input or output, no clock, no random generator, and it never signs. Hashing and signature verification are compiled into every build, the browser's included (`Software`, behind the `Crypto` trait); a browser uses WebCrypto only to sign.
- Every number in the byte format (kind numbers, field keys, labels, the alphabet, the checksum) is in `core/src/layout.rs`, and each is described in `core/FORMAT.md`. Change both together.
- Unit tests sit beside the code. Tests in `core/tests/` go through the public interface only; signing there uses software keys in `core/tests/common/`.
- `core/vectors/vectors.json` holds the golden vectors. `core:test` fails if the code no longer produces them, and `core:wasm` and `core:python` check every build against the same file. Before the first public release, regenerate with `./bin/mise run core:test -- --test vectors -- --ignored regenerate`; after it, only add vectors.
- The bindings are in `core/bindings/`: `wasm/` (a raw WebAssembly interface and the hand-written wrapper `fortymm-core.mjs`) and `python/` (PyO3). `cargo test` and `cargo build` without `-p` act on the library alone.

## CI

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`. Each job is a checkout plus one `./bin/mise run` command, so the same command reproduces any failure locally:

1. `validate (<app>)`: `./bin/mise run <app>:validate`, one matrix job per app: everything the app can prove by itself, its own end-to-end suite included where it has one (api's shipped-image suite, web-client's browser suite). On failure the job uploads that suite's report as the `validate-report-<app>` artifact. Alongside it, `openapi-breaking (<app>)` runs `./bin/mise run <app>:openapi-breaking -- HEAD^`, one matrix job per app with an OpenAPI document. It checks out two commits: on a pull request `HEAD^` is the base branch, and on a push to `main` it is `main` before the push. Alongside them, `workflows` runs `./bin/mise run workflows`.
2. `e2e`: `./bin/mise run e2e`, one job for the cross-app suite in `e2e/`, after every app validates. It holds only what can fail because of how the apps are served or connected (today: the web client's hosting, its Worker in the local Workers runtime; and, through the nginx stand-in until the Worker has a proxy, the web client reaching the api and the api never answered from the web client's kept copy). On failure the job uploads the suite's report as the `e2e-report` artifact.
3. `preview (web-client)`: on a pull request from a branch of this repository (not a fork, not Dependabot, which get no secrets; there it is skipped): `./bin/mise run web-client:preview -- fortymm-pr-<number>`, the pull request's build on its own Cloudflare Worker, then the hosting checks against it. Its address is in the job's summary and in the pull request's comment (`preview comment`, below). One preview deploy at a time per pull request. On failure it uploads the `preview-report` artifact.
   `preview (api)`: on the same pull requests: `./bin/mise run api:preview -- fortymm-api-pr-<number>`, the pull request's api on its own Cloud Run service with its own database `pr_<number>`, then the api's end-to-end suite against it. It signs in to Google Cloud through Workload Identity Federation (`google-github-actions/auth`, with `id-token: write` on this job only), as `api-preview-deployer`, which only this repository's workflows can become: no key or secret is stored. Its address is in the job's summary and in the pull request's comment. One api preview deploy at a time per pull request. On failure it uploads the `preview-api-report` artifact.
   `preview comment`: on the same pull requests, after both previews, even when one failed. It keeps one comment on the pull request: the commit, the web client's address and the api's (the previews pass them as the job output `address`), or "no preview was deployed" for one that deployed nothing. It finds its earlier comment by a hidden marker and updates it on every push (`.github/scripts/preview-comment.sh`, with the runner's `gh` and `jq`). It checks out only the base commit's `.github/scripts`, so the script that runs with the write token is one already merged; where the base has none yet, it leaves a notice and succeeds. It is not a merge gate: `ci-passed` doesn't need it. The comment stays after the pull request closes.
4. `ci-passed`: fails unless every job above but `preview comment` succeeded; the two previews may instead be skipped where they don't run. This is the check to require on `main`.
5. `deploy (web-client)`: on a push to `main` only, after `ci-passed` succeeds: `./bin/mise run web-client:deploy`, which deploys the web client to its production Worker on Cloudflare. No checks run against production; the pull request's preview was checked. `ci-passed` doesn't wait for it.
6. `.github/workflows/preview-cleanup.yml`, `delete preview (web-client)`: when a pull request closes, merged or not, `./bin/mise run web-client:preview-delete -- fortymm-pr-<number>`. Beside it, `delete preview (api)`: `./bin/mise run api:preview-delete -- fortymm-api-pr-<number>`, signed in like `preview (api)`, sharing its concurrency group.

The web client's preview, the deploy and its cleanup are the only jobs that get the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets, and each fails if they are missing. The api's preview and its cleanup are the only jobs with `id-token: write`, the only ones that can sign in to Google Cloud, and each fails, saying so, if it can't. Pull requests run on `pull_request`, never `pull_request_target`, so a fork's code never runs with either. `preview comment` is the only job with `pull-requests: write`, and it has neither: no secret, no `id-token`, no checkout of the pull request's code. So no job can both deploy and write on a pull request, and a pull request's code never runs with the write token. `./bin/mise run workflows` (CI's `workflows` job) fails if any of that changes.

## Naming rule

- A task that acts on the whole stack has a plain name (`up`, `down`, `teardown`, `ports`, `logs`, `validate`, `e2e`). So does `workflows`, which acts on the repository's workflows.
- A task for one app is prefixed with the app's name and a colon: `<app>:<task>`. The app's name is its directory and its Compose service name.
- To add an app, copy the `web-client` pattern:
  - the app in `<app>/`;
  - a dev image in `dev/<app>/`;
  - a `<app>` service in `compose.dev.yaml`, and a service named `<app>-<role>` for anything else it needs to run (e.g. `api-db`), with its image in `dev/<app>-<role>/`;
  - a `# ---- <app>` block of `<app>:*` tasks in `mise.toml`, with the same task names where they apply;
  - an `<app>:validate` task that runs every check for the app, added to the stack-wide `validate` task's `depends` and to the `app` matrix of the `validate` job in `.github/workflows/ci.yml`.
- Everything an app can prove by itself goes in its `<app>:validate`. That includes an app's own end-to-end suite when it has one: a server's shipped image over HTTP, with what the app owns, such as its database (`api`), or a web app's production build in a real browser (`web-client`). It follows the same pattern under the `e2e` Compose profile, so `up` never starts it:
  - the suite in `<app>/e2e/`, using the app's own test tooling and dependencies;
  - an `<app>-e2e` service in `compose.dev.yaml` that runs it, with its runner image in `dev/<app>-e2e/` when the app's dev image can't run it (`api` reuses `dev/api`; `web-client` reuses `dev/e2e`, the same pinned Playwright as the cross-app suite);
  - any other service it needs, named `<app>-<role>` (e.g. `api-release`, `web-client-preview`), with its image in `dev/<app>-<role>/` (a server's production image stays in `<app>/Dockerfile`);
  - an `<app>:e2e` task that runs the suite and stops what it started, as one of the last steps of `<app>:validate`.
- The cross-app suite is the only one at the repository level: `e2e/`, run by the `e2e` service (image in `dev/e2e/`) and the stack-wide `e2e` task, which is CI's stage 2. It holds what can fail only because of how the apps are served or connected: the hosting in front of an app, and the wiring between apps. A service it needs is still named after the app it serves, `<app>-<role>` (e.g. `web-client-worker`, `web-client-hosting`).
- Don't rename the stack-wide tasks or another app's tasks.

Each checkout (including each git worktree) gets its own Compose project, so stacks in different checkouts don't collide. If you add or change a task in `mise.toml`, update the lists above.
