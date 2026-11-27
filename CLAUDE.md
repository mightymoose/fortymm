# fortymm

## Everything runs in Docker

Nothing runs on the host except `./bin/mise` and `docker`. No `node`, `npm`, `dafny`, `python`, etc. on the host — not to scaffold, install, build, test, or run.

- Each part of the repo has a service in `docker-compose.yml` and its own `Dockerfile`.
- Toolchains (node, dafny, …) are pinned in that part's `mise.toml` and installed into the image by `bin/mise`.
- Host-side entry points are mise file tasks in `mise-tasks/` that wrap `docker compose` (subfolders become `folder:task`, e.g. `mise-tasks/web-client/dev` is `web-client:dev`). Run them with `./bin/mise run <task>`; list them with `./bin/mise tasks`.
- Need a new command? Add a mise task that runs it in the right container; don't run the tool on the host.
- After changing a part's `mise.toml` or dependency manifest, rebuild its image: `docker compose build <service>`.

## Services

- `check-requirements` — verifies the Dafny specs in `requirements/`. `./bin/mise run requirements:check`, `./bin/mise run requirements:dafny -- <args>`
- `design-system` — nginx serving the design system reference boards in `requirements/design-system/reference/`, the reference for the Playwright screenshot tests. `./bin/mise run requirements:design-system:reference:serve` serves them on a random host port (printed at startup).
- `web-client` — Vite + React + TypeScript app in `web-client/`. `./bin/mise run web-client:dev` starts the dev server on a random host port (printed at startup), so many can run at once.
- `tailscale` + `web-client-public` (profile `public`) — the dev server on the internet via Tailscale Funnel, no host ports. `./bin/mise run preview`; setup in README.

`./bin/mise run ports` lists the host ports of this checkout's running containers.
