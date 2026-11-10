# fortymm

## Never run project tooling on the host

Do not run `node`, `npm`, `npx`, package installs, builds or dev servers on the host. Do all work through the mise tasks below. They run in the development Compose stack (`compose.dev.yaml`), with dependencies in a Docker volume. The host needs only `mise` and `docker`.

## Tasks

Run with `mise run <task>`. Pass arguments after `--`.

- `up`: start the stack (Vite dev server for `web-client`, hot reload), then print its URL.
- `ports`: print every published port of the stack as a URL. The host port is random.
- `logs`: follow the stack's logs.
- `stop`: stop the stack. Keeps the built image and installed `node_modules`.
- `teardown`: remove everything the stack uses: containers, networks, volumes and built images.
- `shell`: open a shell in a `web-client` container.
- `exec`: run any command in a `web-client` container, e.g. `mise run exec -- npx vite --version`.
- `install`: install dependencies. With arguments, add packages: `mise run install -- zod`, `mise run install -- -D vitest`.
- `lint`: lint `web-client` (oxlint).
- `typecheck`: typecheck `web-client` (`tsc -b`).
- `build`: production build into `web-client/dist`.

Each checkout (including each git worktree) gets its own Compose project, so stacks in different checkouts don't collide. If you add or change a task in `mise.toml`, update this list.
