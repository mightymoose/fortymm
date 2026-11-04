# CI

```sh
./bin/mise run ci
```

`ci` brings the whole Compose stack up in the background (`docker compose up
-d --wait`), runs each project's CI task inside it with `docker compose exec`,
then removes the stack's containers. The `dev` service stays up by running
`sleep infinity`, and its healthcheck passes once the entrypoint has installed
the container's tools, so `--wait` returns only when commands can be exec'd.
The `api` service's healthcheck is a request to `/v1/health`. The API
migrates its database before it answers, so `--wait` also blocks until the
migrations ran and the API reaches the database. The `api` service
starts after the `postgres` service is healthy (`pg_isready`). To add a project's checks, call its
`<project>:ci` task from `[tasks.ci]`.

`api:ci` runs `uv sync --locked`, ruff (lint and format), mypy, pytest and
`alembic check` in the running `api` container. `alembic check` fails when
the models and the migrations disagree. pytest also fails when
`api/signed-results/vectors.json` differs from what its generator writes
(see Signed match results). `api:smoke` then builds the API's production
image (`api:build`), runs it with `PORT` set on the `postgres` service's
network, and checks that `/v1/health` reaches the database.
It then sends 31 `POST /v1/session` from one IPv6 `X-Forwarded-For` address
and expects a 429. Then it sends one from another IPv6 /64 and one from an
IPv4 address, and expects a 200 for each. So it fails if the production
image stops keying the guest account limit by the client's address.

`web-client:ci` runs `npm ci`, lint, build and tests in the running `dev`
container, so it needs the stack up (run it via `ci`).

`web-client:routes-check` then runs a Vite build in the `dev` container, which
regenerates `web-client/src/routeTree.gen.ts` (see Routing). It fails if git
shows the file changed, so a route change without the regenerated tree breaks
CI. A new route file that the committed tree doesn't list can fail earlier,
with a type error from `tsc -b` in `web-client:ci`.

`openapi:check` then regenerates `api/openapi.json` and the web-client's
types from it in the running containers, and fails if git shows them changed,
so a route or model change without `api:openapi` breaks CI.

`openapi:breaking` then runs `oasdiff breaking --fail-on ERR` in the `dev`
container. It compares the `api/openapi.json` of the main the change builds on
with the current one, and fails on a change that breaks `/v1` (see OpenAPI
schema and clients). On a branch, that base is the merge base with
`origin/main`. On a push to `main`, CI sets `OPENAPI_BASE` to
`github.event.before`, the commit `main` pointed at before the push. If the
base has no `api/openapi.json`, the task skips the check and says why. git runs
on the host, because a worktree's `.git` points outside the bind mount. So CI
checks out the full history (`fetch-depth: 0`). mise installs oasdiff from its
GitHub release (`github:oasdiff/oasdiff` in `mise.container.toml`). CI passes
`GITHUB_TOKEN` to the `dev` service, so the install doesn't hit GitHub's
anonymous rate limit.

`web-client:e2e` then starts the Vite dev server in the `dev` container
(`docker compose exec -d`), waits for it, and runs Playwright in the
`playwright` container. It also needs the stack up and `npm ci` done, so it
runs after `web-client:ci`.

`.github/workflows/ci.yml` runs `./bin/mise run ci` on every push, deploys the
API and then the web-client (production from `main`, a Preview from any other
branch; see Deploy below), runs the post-deploy suite against that
deployment, then uploads the Playwright traces and HTML report
as the `playwright-traces` artifact and posts (or updates) a comment linking
it on the commit's open PR. It runs one at a time per branch, so deploys land
in push order.

The deploys are recorded as GitHub deployments (`actions/github-script`, no
job-level `environment:`), so they show in the repo's and the PR's
Deployments panel: `main` in the `production` environment linking to
`https://fortymm.com`, any other branch in a transient `Preview (<branch>)`
environment linking to its Cloudflare Preview URL. A deployment whose deploy
or post-deploy check fails is marked failed, and its description carries the
API's URL.
