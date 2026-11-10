# fortymm

## Never run project tooling on the host

Do not run `node`, `npm`, `npx`, package installs, builds or dev servers on the host. Do all work through the mise tasks below. They run in the development Compose stack (`compose.dev.yaml`), with dependencies in Docker volumes. The host needs only Docker.

Run mise as `./bin/mise`, not a `mise` on the PATH. On first use the script downloads a pinned, checksum-verified mise into `.mise/` (gitignored) in this checkout.

## Tasks

Run with `./bin/mise run <task>`. Pass arguments after `--`.

Stack-wide tasks act on every app in the stack:

- `up`: start every app, then print their URLs.
- `down`: stop the stack. Keeps built images and dependency volumes.
- `teardown`: remove everything the stack uses: containers, networks, volumes and built images.
- `ports`: print every published port as a URL. Host ports are random and change when an app restarts.
- `logs`: follow the logs of every app.

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

## Naming rule

- A task that acts on the whole stack has a plain name (`up`, `down`, `teardown`, `ports`, `logs`).
- A task for one app is prefixed with the app's name and a colon: `<app>:<task>`. The app's name is its directory and its Compose service name.
- To add an app, copy the `web-client` pattern:
  - the app in `<app>/`;
  - a dev image in `dev/<app>/`;
  - a `<app>` service in `compose.dev.yaml`;
  - a `# ---- <app>` block of `<app>:*` tasks in `mise.toml`, with the same task names where they apply.
- Don't rename the stack-wide tasks or another app's tasks.

Each checkout (including each git worktree) gets its own Compose project, so stacks in different checkouts don't collide. If you add or change a task in `mise.toml`, update the lists above.
