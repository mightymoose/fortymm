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

`.github/workflows/ci.yml` runs `./bin/mise run ci` on every push.

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
