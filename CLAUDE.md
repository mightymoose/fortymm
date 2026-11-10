# fortymm

## Never run project tooling on the host

Do not run `node`, `npm`, `npx`, package installs, builds or dev servers on the host. Do all work through the mise tasks below. They run in the development Compose stack (`compose.dev.yaml`), with dependencies in Docker volumes. The host needs only Docker.

Run mise as `./bin/mise`, not a `mise` on the PATH. On first use the script downloads a pinned, checksum-verified mise into `.mise/` (gitignored) in this checkout.

## Tasks

Run with `./bin/mise run <task>`. Pass arguments after `--`.

Stack-wide tasks act on every app in the stack:

- `up`: start every app, then print their URLs.
- `down`: stop the stack. Keeps built images and dependency volumes.
- `teardown`: remove everything the stack uses, e2e services included: containers, networks, volumes and built images.
- `ports`: print every published port as a URL. Host ports are random and change when an app restarts.
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

## CI

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`. Each job is a checkout plus one `./bin/mise run` command, so the same command reproduces any failure locally:

1. `validate (<app>)`: `./bin/mise run <app>:validate`, one matrix job per app.
2. `e2e (<app>)`: `./bin/mise run <app>:e2e`, one matrix job per client, after every app validates. Each job starts its own copy of the stack. On failure the job uploads the suite's report as the `e2e-report-<app>` artifact.
3. `ci-passed`: fails unless every job above succeeded. This is the check to require on `main`.

## Naming rule

- A task that acts on the whole stack has a plain name (`up`, `down`, `teardown`, `ports`, `logs`, `validate`, `e2e`).
- A task for one app is prefixed with the app's name and a colon: `<app>:<task>`. The app's name is its directory and its Compose service name.
- To add an app, copy the `web-client` pattern:
  - the app in `<app>/`;
  - a dev image in `dev/<app>/`;
  - a `<app>` service in `compose.dev.yaml`;
  - a `# ---- <app>` block of `<app>:*` tasks in `mise.toml`, with the same task names where they apply;
  - an `<app>:validate` task that runs every check for the app, added to the stack-wide `validate` task's `depends` and to the `app` matrix of the `validate` job in `.github/workflows/ci.yml`.
- A client app's end-to-end suite follows the same pattern under the `e2e` Compose profile, so `up` never starts it:
  - the suite in `e2e/<app>/`;
  - its runner image in `dev/<app>-e2e/` and an `<app>-e2e` service in `compose.dev.yaml`;
  - any other service it needs, named `<app>-<role>` (e.g. `web-client-preview`), with its image in `dev/<app>-<role>/`;
  - an `<app>:e2e` task that runs the suite and stops what it started, added to the stack-wide `e2e` task's `depends` and to the `app` matrix of the `e2e` job in `.github/workflows/ci.yml`.
- Don't rename the stack-wide tasks or another app's tasks.

Each checkout (including each git worktree) gets its own Compose project, so stacks in different checkouts don't collide. If you add or change a task in `mise.toml`, update the lists above.
