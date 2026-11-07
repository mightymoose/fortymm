# A session tears down the dev stacks it started

Before a session closes, it tears down every dev stack it started in a
worktree, with everything that stack created: containers, volumes, the
network, and the containers that `docker compose run` tasks leave behind.
A session that launches a worker and tells it not to tear down its stack
tears that stack down for the worker.

Compose names a worktree's project after its folder, such as
`fortymm-insights-settings`. Run this from any directory:

```sh
docker compose -p <project> down --volumes --remove-orphans
```

Then check that nothing is left:

```sh
docker ps -a --filter label=com.docker.compose.project=<project>
docker volume ls --filter label=com.docker.compose.project=<project>
docker network ls --filter label=com.docker.compose.project=<project>
```

Remove whatever they list by name, with `docker rm -f <name>`,
`docker volume rm <name>` and `docker network rm <name>`. Write the project
and each name out in full, not through a variable, `$(...)` or `xargs`. The
allow rules in `.claude/settings.json` match only the literal text, and only
names that start with `fortymm-`.

## Why

- Each worktree's stack keeps about 1.2 GB in volumes, for the tools,
  node_modules, the virtualenv and Postgres. Many worker sessions a week
  fill the disk.
- `docker compose down` can leave a `docker compose run` container behind,
  such as the one `web-client:dev` starts, and the volumes it holds. The
  label checks find them.

## How to tell

- A session started a stack if it ran `./bin/mise run up` or any other task
  that starts a container.
- Leave every other stack alone, the main checkout's (project `fortymm`)
  included. Its volumes keep that checkout's database and tool caches
  between sessions, and the allow rules don't match them.
