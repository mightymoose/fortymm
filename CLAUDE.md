# CLAUDE.md

This file holds what every change needs: the commands, where things live,
and the rules a reader can't get from the code. Each project has its own
`CLAUDE.md` with its conventions (`api/`, `web-client/`, `ios-client/`),
and `docs/` says how each area works.

Don't describe a feature's behaviour here. Put it in the area's doc in
`docs/`, or in a comment or test next to the code. When a change makes a
line false, delete the line rather than adding a correction.

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

`up` starts the API (`api:dev`), its Postgres database, the mock OpenID
Connect provider (`oidc`) and the web-client dev server, which proxies
`/api/*` to the API. To add a service, add its task to
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

`ci` brings the whole Compose stack up, runs each project's CI task inside
it, then removes the containers. To add a project's checks, call its
`<project>:ci` task from `[tasks.ci]`. It fails when:

- ruff, mypy, pytest or oxlint fail, or the web-client doesn't build.
- `alembic check` finds the models and the migrations disagree. Draft a
  revision with `./bin/mise run api:revision "<what changed>"`.
- `api/signed-results/vectors.json` is stale. Run
  `./bin/mise run api:signed-result-vectors`.
- `web-client/src/routeTree.gen.ts` is stale. Any Vite build rewrites it.
- `api/openapi.json` or `web-client/src/api/schema.d.ts` is stale. Run
  `./bin/mise run api:openapi`.
- A change breaks `/v1` (oasdiff). See OpenAPI in `api/CLAUDE.md`.

On every push, `.github/workflows/ci.yml` runs `ci`, deploys (production
from `main`, a Preview from any other branch) and runs the post-deploy
suite against the deployment. `docs/ci.md` describes each step, and
`docs/deploy.md` the deploys.

## Where things live

- `api/`: the FastAPI app. Routes in `src/fortymm_api/v1/`, rules in
  `src/fortymm_api/services/`, migrations in `migrations/`.
- `web-client/`: the Vite + React app. Routes in `src/routes/`, pages in
  `src/pages/`, test page objects in `src/test/pages/`, Playwright in
  `e2e/`. `worker/` is the Cloudflare Worker that serves it.
- `ios-client/`: the SwiftUI app. It builds on the macOS host with Xcode,
  not in the dev container.
- `oidc/`: the dev and test sign-in page of the mock OpenID Connect
  provider.
- `references/`: material the app is built against, not built or deployed.
  `references/design-system/` is the design system (v2.1), and the app
  matches it. `references/matches.md` explains how a match is recorded.
- `docs/`: how each area works. `docs/README.md` lists the files.

## Rules

- Every dev tool except the iOS build runs in the Docker Compose stack.
  Install packages through the container, never on the host (see each
  project's `CLAUDE.md`).
- Business logic lives in services, and the HTTP layer only translates
  ([.claude/rules/business-logic-in-services.md](.claude/rules/business-logic-in-services.md)).
- A component that loads data owns its loading and error states
  ([.claude/rules/loading-and-errors.md](.claude/rules/loading-and-errors.md)).
- A published API version (`/v1`) never changes in a breaking way.
  Released apps call the API that `main` deploys for months.
- The web app must work offline in a hall with no signal. Scoring and
  approving a result never wait on the network.
