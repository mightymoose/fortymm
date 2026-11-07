# A session tears down the dev stacks it started

Before a session closes, it tears down every dev stack it started in a
worktree, with everything that stack created: containers, volumes, the
network, and the containers that `docker compose run` tasks leave behind.
A session that launches a worker and tells it not to tear down its stack
tears that stack down for the worker.

Compose names a worktree's project after its folder, such as
`fortymm-insights-settings`. From the repo root of any checkout, pass the
part after `fortymm-`:

```sh
bin/teardown-stack insights-settings
```

It runs `docker compose -p fortymm-<slug> down --volumes --remove-orphans`,
then removes whatever is still labelled with that project (leftover
`docker compose run` containers, volumes, networks), and fails if anything
remains. It's the only teardown `.claude/settings.json` allows without a
prompt. Don't run raw `docker rm` or `docker compose down` on fortymm
projects.

## Why

- Each worktree's stack keeps about 1.2 GB in volumes, for the tools,
  node_modules, the virtualenv and Postgres. Many worker sessions a week
  fill the disk.
- `docker compose down` can leave a `docker compose run` container behind,
  such as the one `web-client:dev` starts, and the volumes it holds. The
  script's label checks find them.

## How to tell

- A session started a stack if it ran `./bin/mise run up` or any other task
  that starts a container.
- Leave every other stack alone, the main checkout's (project `fortymm`)
  included. Its volumes keep that checkout's database and tool caches
  between sessions. `bin/teardown-stack` can't name it.
