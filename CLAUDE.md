# CLAUDE.md

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
the models and the migrations disagree. `api:smoke` then builds the API's production
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

## References

`references/` holds reference material that isn't built or deployed (see
`references/README.md`). `references/design-system/` is the FortyMM design
system (v2.1), and the app matches it. Read its `README.md` and
`colors_and_type.css` before designing or styling UI.

## api

`api/` is a FastAPI app managed with uv. mise installs its Python (pinned in
`mise.container.toml`; there's no `.python-version`) and the Dockerfile tells
uv to use only that interpreter. uv manages the dependencies (`pyproject.toml`
and `uv.lock`). Code is in `src/fortymm_api/`, tests in `tests/` (pytest,
through FastAPI's `TestClient`).

- `main.py`: `create_app()`, the app factory. Operation IDs are the route
  functions' names, so generated clients get names like `health`. If
  `WORKER_SECRET` is set, the app answers 403 to every request without a
  matching `X-FortyMM-Worker-Secret` header (see Deploy). Local dev, the
  tests and `api:smoke` don't set it, so they need no secret. The app
  answers 415 to a `POST`, `PUT`, `PATCH` or `DELETE` whose `Content-Type`
  isn't `application/json`. The check ignores case and parameters such as
  `charset`. A cross-site HTML form can't send that type, so another site
  can't make `POST /v1/session` replace a visitor's session. The 403 check
  runs first. Both answer in the `errors` shape, such as `{"errors":
  [{"status": "415", "title": "..."}]}`.
- `v1/`: the `/v1` routes, one module per resource, each with its own
  `APIRouter` and Pydantic request/response models; `v1/__init__.py` mounts
  them. Annotate route return types with the response model. A route does
  only the HTTP work. It reads the request, calls a service and writes the
  response.
- `services/`: the business logic, one module per area, such as
  `services/sessions.py`. A service takes an ORM `Session` and plain values,
  and returns domain types. It never sees a request, a response or a cookie.
  `tests/services/` tests each rule by calling the service directly, on a
  `migrated_database`. A route's tests check only its HTTP work, such as
  the status, the headers, the cookie and the body's shape.
  [.claude/rules/business-logic-in-services.md](.claude/rules/business-logic-in-services.md)
  says why.
- `database.py`: the Postgres connections, through SQLAlchemy 2.0 and the
  psycopg 3 driver. If `DATABASE_URL` is set, `create_app()` makes an
  `Engine` (at most 4 connections) and a `sessionmaker`. The app's lifespan
  migrates the database first (see Migrations). A route takes an ORM
  `Session` with a `DatabaseSession` parameter. Each request runs in one
  transaction. It commits before the response goes out, so a failed commit
  answers 500. An exception rolls it back. `DATABASE_URL` is optional off
  Cloud Run, so the OpenAPI export runs with no database. On Cloud Run,
  `create_app()` raises without it.
- `models.py`: the ORM's declarative `Base`. Its metadata has a naming
  convention, so constraints get stable names in migrations. Mapped classes
  subclass it and take the singular entity name, such as `Account` and
  `Player`. The model for the `sessions` table is `AuthSession`, so
  `Session` stays SQLAlchemy's. Use `relationship()` from `models.py`. It
  defaults to `lazy="raise"`, so a lazy load fails and every load shows in
  its query. Code uses the mapped classes directly. The ids and emails use
  the NewTypes `AccountId`, `PlayerId` and `Email` from `accounts.py`.
  SQLAlchemy can't see through a NewType, so `Base.type_annotation_map`
  gives each one its column type. The tables are `accounts`, `players`,
  `player_managers`, `sessions`, `guest_account_counts`, `identities` and
  `login_attempts` (see Accounts and sessions, and Sign-in).
- `/v1/health` runs `SELECT 1` and returns `{"data": {"database": "ok"}}`.
  The healthchecks, `api:smoke`, the 403 check and the post-deploy suite use
  it.
- Response bodies follow JSON:API's top-level shape: the payload goes under
  `data` (e.g. `/v1/health` returns `{"data": {"database": "ok"}}`), so each
  response model has a `data` field rather than naming the payload itself.
- An error the API answers itself is in the `errors` shape,
  `ErrorsResponse` in `v1/errors.py`. Each route lists the errors it can
  answer with the entries there, such as `NO_SESSION` and `GUEST_LIMIT`, so
  the schema types each error's body. `GUEST_LIMIT` also declares
  `Retry-After`. The 403 of the Worker secret and FastAPI's own 422 aren't
  listed.

It runs in the `api` Compose service (uvicorn with `--reload` on port 8000)
with no published port: the web-client dev server proxies `/api/*` to it with
the prefix stripped, so `/v1/health` is at
`http://localhost:<web-client port>/api/v1/health` and the interactive docs at
`/api/docs`. Its virtualenv lives in the `api-venv` volume.

The database is the `postgres` Compose service (`postgres:18`, the same major
version as Cloud SQL), with user, password and database all `fortymm`. Its
data lives in the `postgres-data` volume. The `api` service gets
`DATABASE_URL` pointing at it. Port 5432 is published on a free host port,
which `list-ports` prints. `api:test` starts `postgres` and `oidc` first, and
the tests use the real database and the mock provider. A test that makes tables uses the
`throwaway_database_url` fixture, a new database that the test drops after.
Tables a test makes in `fortymm` would fail `alembic check`. The
`migrated_database` fixture is an `Engine` for a throwaway database that the
migrations ran on.

### Accounts and sessions

Every visitor gets a guest account the first time the app loads. A guest
account has no `email`. A verified account has one, always lowercase.

- `accounts.py`: `CurrentAccount = GuestAccount | VerifiedAccount`, the
  account of a valid session. An adopted account (`adopted_into` set) is
  neither kind, so its sessions are invalid. `current_account()` in
  `services/sessions.py` decides the kind in one place. It checks `adopted_into` first, then `email`.
- Players are permanent. The `players_are_permanent` trigger refuses every
  `DELETE` on `players`. An account manages players through
  `player_managers`. Each row has `relationship` `self` or `managed`. An
  account has at most one `self` player, and a player at most one `self`
  account.
- `start_session()` gives every account it returns a `self` player
  (`SelfPlayer` in `accounts.py`). A new guest account gets a new player
  with a default display name, such as `excited egret 387`. A resumed
  account that has no `self` player gets one too. That includes an account
  that a sign-in with no session made, and a verified account whose only
  player waits for the "Is this you?" answer. A "Yes" then merges the two
  players (see Is this you?).
- `services/display_names.py` makes the default names: an animal, an
  adjective with the same first letter, and a number from 100 to 999. The
  adjectives are kind or neutral. `lower(display_name)` is unique among
  players with no `merged_into` (the partial index `unique_display_name`).
  So the insert skips a taken name with `ON CONFLICT DO NOTHING` and tries
  another, up to 10 times. A merged player's name is free again. Its test
  fails if an animal's initial has no adjective. `tests/test_schema.py`
  checks the index's `WHERE` clause, because `alembic check` doesn't.
- `ownership.py`: `OWNERSHIP_RULES` says what adoption and player merge do
  to each foreign key to `accounts` or `players`. `tests/test_ownership.py`
  reads every such foreign key from `information_schema`. It fails if one
  has no entry. So a new foreign key to either table needs an entry in the
  same change.
- `POST /v1/session` (`v1/session.py`) starts or resumes the visitor's
  session through `services.sessions.start_session()`. With a valid session, it updates `accounts.last_seen_at`, moves
  `sessions.expires_at` to 400 days from now and sets the same cookie
  again. With no cookie, or an unknown, expired or adopted one, it makes a
  guest account and a session. It deletes the session row that the old
  cookie matched, and keeps that row's account. Every response sets
  `Cache-Control: no-store`. The body is `{"data": {"account": {"id":
  "...", "kind": "guest", "email": null, "player": {"id": "...",
  "display_name": "excited egret 387"}}}}`. A verified account has kind
  `"verified"` and its email. Every account has a `player`.
- `start_session()` limits guest accounts per client network. A network can
  start 30 guest accounts per window of one minute (`GUEST_ACCOUNT_LIMIT`,
  `GUEST_ACCOUNT_WINDOW`). The 31st gets `GuestAccountLimitReached`, and
  `create_app()` answers 429 with `Retry-After`. A resume never counts. A
  sign-in from a browser with no session counts too (see Sign-in). An
  IPv4 address is one network. An IPv6 address counts as its /64. The counts
  live in `guest_account_counts`, so every API instance shares them. Each
  counted start deletes up to 100 rows whose windows ended. So a row lasts
  until the first guest start, from any network, after its window ends. The route reads
  the client address from `request.client`. In production, uvicorn's
  `--proxy-headers` sets it from the `X-Forwarded-For` that the Worker
  writes.
- The cookie is `__Host-fortymm_session`: 32 random bytes in base64url, with
  `Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000` (400 days).
  `sessions.expires_at` also ends 400 days after the last `POST
  /v1/session`. The API stores only the token's sha256, in
  `sessions.token_hash`.
- `services/sessions.py`: a session is valid if its `token_hash` matches,
  `expires_at` is in the future and its account has no `adopted_into`.
  `authenticate()` returns the account of a valid session, or `None`.
- `auth.py`: the session and login cookies, and the `RequestAccount`
  dependency. A route that needs the account takes a `RequestAccount`
  parameter. Without a valid session, that dependency answers 401 in the
  `errors` shape. Only `POST /v1/session` makes a guest account.
- A service that writes as an account first calls
  `lock_account_for_write()` in `services/sessions.py`. It holds the account
  row `FOR SHARE` until the transaction ends. After the lock, it checks
  `adopted_into` again. If it is set, it raises `AccountAdopted`, and
  `create_app()` answers 401 in the `errors` shape. So a write can't land on
  a guest account after an adoption moved its data.
  `RequestAccount` takes no lock. `POST /v1/session` locks the account `FOR
  UPDATE`, because it writes `last_seen_at`.
- `alembic check` doesn't compare a partial index's `WHERE` clause. So
  `tests/test_schema.py` checks each constraint, each index and the trigger
  on a `migrated_database`.

### Is this you?

A sign-in can bring players that have played to an account with
`adopted_from` set (see Sign-in). Each one is an open "Is this you?"
question. No table records play yet, so today no sign-in asks it.
`services/players.py` holds the rules, and `v1/players.py` the routes.

- `GET /v1/account/players` lists the account's players, its `self`
  player first, then by display name. Each has `relationship`,
  `open_question`, `match_count` and `recent_matches`. It leaves out merged
  players. No player has a match yet, so the service always gives
  `match_count` 0 and no `recent_matches`. The games work fills them.
- `POST /v1/account/players/{player_id}/answer` takes `{"answer": "yes"}`,
  `"no"`, `"not_mine"`, or `"same_as"` with a `player_id`. It returns the
  same list after the answer as `data`, and what the answer did as `meta`.
  `yes` makes the row `self`. If the account already has a `self` player,
  `yes` merges the two players instead (see below). `no` keeps it
  `managed`. `not_mine` deletes the `player_managers` row. The player
  stays, with no manager. `same_as` merges it with the player that
  `player_id` names. That player must be a `managed` player of the account
  with a closed question. A merge would close an open question with no
  answer.
- `meta.outcome` is `self`, `managed`, `removed`, `merged` or
  `already_answered`. A `merged` outcome also has `survivor`, the id of the
  player that survived, and `merged`, the id of the other. `services/players.py` decides it, as
  `Settled` or `Merged`.
- Every answer clears `adopted_from`. A second answer changes nothing,
  whatever the first answer was, and its outcome is `already_answered`.
- The API answers 409 to `not_mine` for a question already answered. It
  answers 404 for a player the account doesn't manage, or a merged player.
  It also answers 404 if `same_as` names a player that isn't a `managed`
  player of the account with a closed question. It answers 422 if
  `player_id` is missing with `same_as` or comes with another answer. That
  422 is FastAPI's own `detail` body. A `same_as` that names the answered
  player gets a 422 in the `errors` shape.
- Both routes call `lock_account_for_write()`. The answer also locks every
  `player_managers` row of the account `FOR UPDATE`. So two answers from
  two tabs take turns, and the second `yes` merges with the first one's
  player.
- `merge_players()` in `services/player_merge.py` merges a player into
  another player the account manages: the `self` player for `yes`, a
  `managed` player for `same_as`. The original player survives. It is the
  one created first (`players.created_at`, then `id`). It keeps its id and
  display name. Its row takes the relationship of the player it merged
  into, so a `yes` keeps the account's `self` player. The other player gets
  `merged_into` set to the survivor and gives up its display name. Its row
  stays, as `managed` (`STAYS_ON_PLAYER_MERGE`). The merge also points
  every player already merged into the merged player at the survivor. So
  `merged_into` always names a player that isn't merged.
- A view that combines a player with the players merged into it comes
  with games.

### Sign-in

Sign-in uses Auth0. Local dev and the tests use a mock OpenID Connect
provider, because Auth0 doesn't accept a random dev port in a callback URL.
Production and the Previews use the real tenant (see Auth0 under Deploy).

- The `oidc` Compose service runs navikt's mock-oauth2-server. Its issuer is
  `http://oidc:8080/default`. Its sign-in page signs in any `sub` with the
  claims typed into it, such as `{"email": "ann@example.com",
  "email_verified": true}`. It has no published port.
- The API reads `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET`.
  `AUTH0_DOMAIN` is Auth0's host, or a base URL with a scheme, such as the
  mock's. Compose points it at the mock. Without `AUTH0_DOMAIN`, the sign-in
  routes answer 503. On Cloud Run, `create_app()` raises if any of the three
  is missing.
- `identity_provider.py` talks to the provider. It finds the endpoints in
  the provider's discovery document, exchanges the code with PKCE and
  verifies the ID token against the provider's JWKS, with the nonce. It
  lowercases the email.
- The browser can't resolve `oidc`. So in Compose, `AUTH0_AUTHORIZE_URL` is
  `/oidc/default/authorize`, and the web-client dev server proxies `/oidc/*`
  to the mock. The API still reaches the mock at `http://oidc:8080`. The
  tests unset `AUTH0_AUTHORIZE_URL` and post the mock's form directly.
- `GET /v1/auth/login?return_to=...` (`v1/auth.py`) stores a
  `login_attempts` row for 10 minutes and answers 302 to the provider. A
  verified account also gets `prompt=login`. The callback must come from the
  browser that started the attempt. A browser with a valid session proves
  it with that session (`login_attempts.session_id`). A browser without one
  gets no guest account. After a sign-out, a guest account would hold
  nothing, and adoption would merge its new player away at once. Its
  attempt has no `session_id`. The browser gets the attempt's `state` in the
  `__Host-fortymm_login` cookie instead, for 10 minutes, and the callback
  checks that the cookie matches the `state` in its URL. Another browser can
  open that URL, but it can't set this browser's cookie. Such a login
  counts toward the guest account limit, because nothing else bounds it.
  `return_to` must start with `/`, its second character must be neither `/`
  nor `\`, and it must hold no control character. Any other value becomes
  `/`.
- `GET /v1/auth/callback` runs `finish_sign_in()` in
  `services/sign_in.py`, in one transaction. It deletes the attempt first.
  `resolve_login()` is a pure function that picks the outcome from the
  current account and the identity's owner. The owner is the account with
  the `sub`, or else the account with the email.
- A browser with no session at login has no current account, unless
  another tab started a guest account meanwhile. With no current account,
  `resolve_login()` gives `SwitchAccount` to the owner, or `CreateAccount`.
  The callback expires the login cookie, whatever the result.
- Every outcome gives the browser a new session and token.
  `VerifyInPlace` calls `convert_guest()` in `services/sessions.py`, which
  deletes every session of the guest account. It also calls
  `hand_over_players()` in `services/adoption.py`, with the guest account
  as the target.
- `hand_over_players()` asks "Is this you?" only about a player that has
  played. `has_activity()` in `services/adoption.py` decides it. It says no
  for every player until the games work fills it (#124). Such a player's
  row becomes `managed`, with `adopted_from` set to the guest account (see
  Is this you?). A player that hasn't played asks nothing. `VerifyInPlace`
  keeps it as it is, so the guest keeps its player and name. `AdoptGuest`
  merges the guest's `self` player into the target account's `self`
  player, as "Yes" does, so the older player survives. If the target
  account has no `self` player, the guest's becomes it. A `managed` player
  moves as `managed`. It locks the target account row and its
  `player_managers` rows `FOR UPDATE` first, so a `POST /v1/session` that
  makes the account's `self` player meanwhile takes turns with it.
- `AdoptGuest` calls `adopt_guest()` in `services/adoption.py`. It locks
  the guest account row `FOR UPDATE`. It hands the guest's players to the
  target account through `hand_over_players()`. It moves every other
  column whose `OWNERSHIP_RULES` entry is `MOVES_ON_ADOPT`, read from the
  registry at call time. Then it calls `convert_guest()` and sets
  `adopted_into` on the guest account. The API never deletes that row. The
  target account's other sessions stay valid. A new `sub` that adoption
  finds by email gets its `identities` row on the target account.
- A sign-in takes a Postgres advisory lock on the email before it finds the
  owner. So two sign-ins with one new email take turns, and they make one
  account.
- A successful callback answers 302 to the attempt's `return_to` with
  `signed_in=1` added to its query. The web client opens "Is this you?"
  by itself only then.
- A failed callback answers 302 to the attempt's `return_to` with
  `sign_in_error` added to its query: `cancelled`, `email_not_verified`,
  `expired` or `failed`. It changes no account and sets no cookie. A
  callback whose `state` matches no attempt, such as a replay, answers 302
  to `/` with no error.
- `POST /v1/auth/logout` deletes the session, expires the cookie and
  returns Auth0's `/v2/logout` URL as `data.logout_url`. Its `returnTo` is
  the origin's `/signed-out`, a public page that starts no session. `/`
  would start a new guest account at once, so the sign-out wouldn't show.
  In dev, that URL
  is the mock's `http://oidc:8080/default/v2/logout`. The browser can't
  reach it, and the mock answers 405 there. So a dev sign-out ends on an
  error page. Open `/signed-out` to see the page.
- The iOS app signs in through three routes of its own, because its sign-in
  sheet (`ASWebAuthenticationSession`) is a browser with none of the app's
  cookies. `POST /v1/auth/app-login` runs `begin_sign_in()` and returns the
  provider's URL as `data.authorize_url`, which is relative in dev. Its
  `redirect_uri` is `/v1/auth/app-callback`. That route touches nothing. It
  answers 302 to `fortymm://sign-in` with its query, which ends the sheet.
  The app sends that query's `state`, `code` and `error` to
  `POST /v1/auth/app-finish`, which runs `finish_sign_in()` with the app's
  cookies. It answers `data.outcome`: `signed_in` or a `sign_in_error`
  code, and a replay is `expired`. A code that another app catches is
  useless without this app's session or login cookie.

### Migrations

Alembic migrates the database. `api/migrations/` holds `env.py`, the
revision template and the revisions in `versions/`. `api/alembic.ini` points
the CLI (run from `api/`) and the app at it. The app reads `alembic.ini`
from its working directory: `api/` in dev and the tests, `/app` in the
production image.

- The app runs `alembic upgrade head` in its lifespan, before it serves. So
  dev, the tests, `api:smoke` and Cloud Run all get the schema the same way.
  If the database can't be reached or a migration fails, the API doesn't
  start.
- `env.py` takes a Postgres advisory lock before it migrates. A second
  instance waits for the lock, then finds nothing left to apply.
- Migrations are forward-only. The template has no `downgrade()`.
  Autogenerate can't see triggers, functions or views, so write those as
  `op.execute(...)`.
- `api:revision` drafts a revision with autogenerate from the models'
  changes. A person reviews every draft before commit. ruff fixes and
  formats the draft, so it passes the ruff checks in `api:ci`.
- `api:ci` runs `alembic check`, which fails when a model changes without a
  revision.

```sh
./bin/mise run api:dev       # start the API and stream its logs
./bin/mise run api:test      # run the API's tests
./bin/mise run api:openapi   # regenerate the OpenAPI schema and client types
./bin/mise run api:revision "add accounts"  # draft a migration from the models' changes
./bin/mise run api:build     # build the production image as fortymm-api-production
```

`api/Dockerfile` is its production image, separate from the dev image: a
multi-stage uv build (`uv sync --locked --no-dev`) that runs uvicorn as a
non-root user on `$PORT` with `--root-path /api` and the proxy headers
trusted, without `--reload`. It copies `alembic.ini` and `migrations/` to
its working directory, `/app`, for the startup migration. `api:build` passes it the Python and uv versions
from `mise.container.toml`, so it runs the same ones as the dev container.

### OpenAPI schema and clients

`api/openapi.json` is the committed OpenAPI schema, written from the app by
`python -m fortymm_api.openapi`. Clients generate their types from it; the
web-client's are in `web-client/src/api/schema.d.ts` (`npm run
generate:api`, openapi-typescript). After changing a route or model, run
`api:openapi` and commit both files; CI's `openapi:check` fails if either is
stale.

The iOS app generates its client from the same file (see ios-client).
swift-openapi-generator drops a property whose schema is `anyOf` with
`null`, which is how Pydantic writes a nullable. So `create_app()` rewrites
each such schema in `components.schemas` as `type: [X, "null"]`, which means
the same. Parameters keep `anyOf`, because oasdiff reads a parameter's type
array as a break. `tests/test_openapi.py` checks both.

A published API version (today `/v1`) never changes in a breaking way. Released
iOS and Android apps stay installed for months, and they call the API that
`main` deploys. So the apps' code in the same commit doesn't protect them. A
deliberate break goes in a new version, and the old version keeps working.
`openapi:breaking` catches the breaks nobody meant to make. Examples are a
renamed Pydantic field, a response field that becomes optional or nullable, a
new required request field, stricter validation and a removed enum value.

Until the first app store release, the only client is the web-client, which
deploys with the API. Until then, `api/openapi-breaking-ignore.txt` can let a
deliberate break to `/v1` through. Add the error's line as oasdiff prints it,
`METHOD PATH description`, e.g. ``GET /v1/health removed the required property
`data/database` from the response with the `200` status``. The task applies only
the lines that the change adds to the file, compared with its base. So an entry
covers only the change that adds it, and it can't hide a later break once it's
on `main`. Lines that start with `#` are comments.

## web-client

`web-client/` is a Vite + React + TypeScript app, tested with Vitest and React
Testing Library. Each task builds the dev image if needed, installs Node
(pinned in `mise.container.toml`) and the app's npm dependencies inside the
container, then runs.

```sh
./bin/mise run web-client:test   # run the unit tests once
./bin/mise run web-client:dev    # start the Vite dev server on a free host port
```

### Routing

Routes use TanStack Router's file-based routing. Each file in
`web-client/src/routes/` defines one route, and its path in that directory
gives the URL (see TanStack Router's file naming conventions). The
`@tanstack/router-plugin` Vite plugin (in `vite.config.ts`, before the React
plugin) reads the directory and writes the route tree to
`web-client/src/routeTree.gen.ts`. `createAppRouter()` in `src/router.tsx`
builds the router from that tree.

The plugin writes the tree when Vite starts: the dev server (which also
watches the directory), `vite build` and Vitest. Commit
`routeTree.gen.ts` with the route change. `tsc -b` reads it before Vite runs
in `npm run build`. If it is stale, CI fails (see `web-client:routes-check`).
oxlint skips it. The web-client has no formatter.

`autoCodeSplitting` puts each route's component in its own JS chunk. The
router loads a route's chunk before it shows the route. A route file holds
only the route definition. The components it shows live outside
`src/routes/`, because the plugin treats every file there as a route:
`src/pages/` holds the page and layout components and their tests. Import the
component in the route file and don't export it from there, or it stays in
the entry chunk.

To add a page, add its component to `src/pages/` and a route file that shows
it to `src/routes/`.

- `__root.tsx`: the root route, with component `Root` (`src/pages/Root.tsx`),
  and the router context type (`api` and `queryClient`). `Root` gives every
  page toasts and tooltips, and no frame.
- `_authenticated.tsx`: a pathless layout route with no path segment and no
  component. Pages that will need a signed-in user go in `_authenticated/`.
  Its loader starts the session, and its `pendingComponent` is the loading
  screen (see API client).
- `_authenticated/_shell.tsx`: a pathless layout route under
  `_authenticated`, with component `ShellLayout`
  (`src/pages/ShellLayout.tsx`). Its pages, such as `/`
  (`_authenticated/_shell/index.tsx`), go in `_authenticated/_shell/`. A
  page that stands alone, such as `/review-players`, goes directly in
  `_authenticated/`. The layout puts the page in `AppShell`
  (`src/pages/AppShell.tsx`): a topbar over a sidebar of
  the `_shell` pages, which folds to its icons and remembers it in
  `localStorage`. Below 900px the sidebar is a tab bar along the bottom. To
  add a page to the sidebar, add its link in `AppShell`. Below 600px, the
  tab bar also links to each mobile beta in `mobileApps`
  (`src/mobileApps.ts`), in a new tab. From 600px up, where tablets and
  desktops land, neither the tab bar nor the sidebar shows them.
  `e2e/mobile-apps.spec.ts` checks the widths, because jsdom applies no
  media queries. The topbar's right
  end shows `UserMenu` (`src/pages/userMenu/UserMenu.tsx`): a chip of the
  player's `PlayerAvatar` (`src/components/PlayerAvatar.tsx`, the initials
  of the display name, whose accessible name is the full name) and the
  name. Below 600px the chip hides the name. The chip opens the account
  menu. A verified account gets Sign out, which signs out at once. A guest
  gets Sign in, and Sign out behind a dialog. The dialog says nobody can
  get a guest account back after it signs out, and links to sign-in. The
  menu reads the session without suspending, so it never holds up the
  loading screen.
- `SignInErrorAlert` (`src/pages/SignInErrorAlert.tsx`) sits in
  `ShellLayout`, inside `AppShell` and above the page. If the URL
  has `sign_in_error`, it shows that code's message from `signInErrors`
  (`src/pages/signInErrors.ts`). An unknown code shows the `failed`
  message. It keeps the message in state and removes the param with a
  history replace, so a reload shows nothing. `cancelled` is a neutral
  `fm-alert` with `role="status"`. The other codes are `fm-alert--error`
  with `role="alert"`. Its Try again link starts another sign-in.
- Home (`src/pages/Home.tsx`) shows `AdoptionReview`
  (`src/pages/adoption/`) above the roadmap.
- The sign-in links come from `useSignInHref()`
  (`src/pages/useSignInHref.ts`). Each is a full page load of
  `/api/v1/auth/login` with the current path and query as `return_to`,
  because the API answers with a 302.
- `AdoptionReview`: for a verified account, it
  reads `GET /v1/account/players` in its own `QueryBoundary`, with no
  skeleton and the inline error (see API client). A guest asks for no
  players. With open questions, it shows a
  reminder with a "Review players" link to `/review-players`. If the URL
  has `signed_in=1`, the router replaces it with `/review-players` when a
  question is open, or with `/` without the param when none is. So a
  reload shows only the reminder.
- `review-players.tsx`: the page `PlayerReview`
  (`src/pages/adoption/PlayerReview.tsx`), with the wordmark and no
  `AppShell`. The wordmark always shows. The question and its answers read
  `GET /v1/account/players` in a `QueryBoundary`, with a skeleton of the
  question and the action bar, and an error that also links to Home. A
  guest goes to `/` before it asks for players. It asks "Is this you?"
  about one open question at a time. Under the question, a match preview
  shows "No matches yet". The games work adds the player's matches there.
  "Yes, this is me" answers `yes`. "Someone else played" asks "Do you
  manage this player?". There "Remove from my account" answers `not_mine`,
  and Back goes back. "I manage this player" answers `no`, unless the
  account manages another player with a closed question. Then it asks
  "Which player?", with one button per such player, which answers
  `same_as`. Its "Keep as a separate player" answers `no`, and its Back
  goes back. "Review later" goes to `/` with no answer. A reducer holds the page's
  state: every player it has queued this visit, the last confirmation,
  and the step and failed answer of the player on screen. The counter
  "Player N of M" counts the queued players, so it holds when another tab
  answers one, and grows when a new one comes. A ref holds the answer in
  flight, so a second quick click sends nothing. An answer button also
  ignores a click whose `detail` is above 1. That is the second click of a
  double click, which can land on the next player's button. A keyboard
  press has `detail` 0. "Yes" says it merges the player into the `self`
  player of the players list. An answer first cancels a players request
  in flight, because that request read the list from before the answer.
  An answer puts the API's list in the players query. If `meta` says the
  account's `self` player changed, the answer also puts the list's `self`
  player in the session's account, so the topbar shows it. The
  confirmation comes from `meta`, such as "brave badger 214 merged into
  excited egret 387, your player." A merge into a `managed` player drops
  ", your player". The merged player can be the reviewed one or the other
  one. The merged player has left the list after the answer, so its name
  comes from the list before it. `already_answered` says "<player> was
  already answered in another tab." While players remain, the
  confirmation shows above the answers. After the last one, the page goes
  to `/` and shows it as a toast. A save that fails shows its error under
  its button. A 409 means that another tab answered the player first, so
  the page says so too, and refetches the players. A 404 can mean that
  another tab merged the player. Then the page refetches the players, and
  says so only if the player left the list. A 404 to `same_as` can also
  mean that another tab merged the chosen player away. Then "Which player?"
  says that the player isn't one of the account's players any more. With no
  open question, or for a guest, the page goes to `/` at once. For a verified account, each time the page goes to `/`, it sets
  `fromReview` in the router's history state (typed in `src/router.tsx`).
  That covers Review later, the last answer and a visit with no open
  question. Home then focuses the reminder's link while questions remain,
  or else its title, so focus doesn't fall to the document.
- `design-system.tsx`: a public page. Public pages go directly in
  `src/routes/`. They make no request and never show the loading screen.
  The design system page has no `AppShell`, and no page links to it.
- `signed-out.tsx`: a public page, with component `SignedOut`
  (`src/pages/SignedOut.tsx`). Auth0 sends the browser there after
  sign-out. It is an `ErrorScreen` that says the visitor is signed out,
  with Sign in (back to `/`) and Play as a guest (a link to `/`).

### API client

`src/api/client.ts` exports `api`, an openapi-fetch client typed by the
generated schema, with base URL `/api`: `const { data, error } = await
api.POST('/v1/session', { headers: { 'Content-Type': 'application/json' } })`.
openapi-fetch sends no `Content-Type` for a request with no body. The API
answers 415 to such a `POST`, so a bodyless `POST` sets it itself. `createApiClient()` builds one with other options (e.g.
an absolute base URL in tests). In production the Cloudflare Worker forwards `/api/*`
the same way (see Deploy). The dev server's proxy target defaults to
`http://api:8000` and can be overridden with `API_PROXY_TARGET`.

Components fetch through TanStack Query. `src/api/queries.ts` holds the query
options, one function per request, each taking the typed client, e.g.
`useSuspenseQuery(sessionQuery(api))`. Each `queryFn` calls the client and
throws an `ApiError` with the status when the response has no data.
`createQueryClient()` makes the app's `QueryClient`. It retries a query only
after a network error or a 5xx, which can pass. A 4xx comes back the same.
A retry after a lost `POST /v1/session` response can leave one unused guest
account, which is an accepted cost. `createAppRouter()` puts the client in the router context as `api`,
with the `QueryClient` as `queryClient`, and wraps the router in a
`QueryClientProvider`.

A component that loads data reads it with `useSuspenseQuery`, inside its own
`QueryBoundary` (`src/components/QueryBoundary.tsx`).
[.claude/rules/loading-and-errors.md](.claude/rules/loading-and-errors.md)
says why. The boundary puts `Suspense` inside the `ErrorBoundary` of
`react-error-boundary`, inside TanStack Query's `QueryErrorResetBoundary`.
While the data loads, it shows its `skeleton`. Build the skeleton from
`.fm-skeleton` blocks in the shape of the content. The kit's skeleton is
static, because the design system removed shimmer. If the request fails, the
boundary shows an `fm-alert--error` with `role="alert"`. `classifyFailure()`
in `src/api/errors.ts` sorts the failure, and `failureMessages` there gives
its title and sentence. `ErrorPage` uses both too. After a 429, the alert
also shows the time from `Retry-After` (`RetryTime`). Its Try again resets the boundary, so the query
fetches again. A caller can add more actions, such as a link to Home. One
boundary wraps one loading component, and the component's file exports
them together. The skeleton may be `null` only when the component usually
renders nothing, such as Home's reminder. The root route's error page stays
as the safety net for what no boundary catches.

`sessionQuery` sends `POST /v1/session` and returns the account, with its
player. Pages read the account from it. It passes no abort `signal`. An
aborted request still starts a guest account on the API, but the browser
drops its cookie, so the query would start another one. The `_authenticated`
route's loader waits for the session (`ensureQueryData`). The loader stays in
the entry chunk, so the request runs while the page's chunk downloads. The
router shows the page only once the session has answered and the page's
chunk has loaded. Until then it shows the route's `pendingComponent`,
`LoadingScreen` (`src/components/LoadingScreen.tsx`), if the wait passes
`SHOW_AFTER_MS` (300ms, the route's `pendingMs`). So a fast load shows the
page with no loading screen. Once shown, the loading screen stays up for at
least `MIN_SHOWN_MS` (900ms, `pendingMinMs`). Then the page replaces it in
one frame, with no fade. A navigation to an authenticated page waits for the
session the same way. `sessionQuery` never goes stale, so the
session starts once per page load, and coming back to an authenticated page
doesn't show the loading screen again. If the session fails after the
retries, the root route's error page shows (see Error pages). The web-client no
longer calls `/v1/health`.

`logout(api)` in `queries.ts` sends `POST /v1/auth/logout` and returns
`data.logout_url`. `useSignOut()` (`src/pages/useSignOut.ts`) runs it
through `useMutation`, for `UserMenu`. On success, it
calls `leavePage()` (`src/leavePage.ts`), which loads the URL with
`window.location.assign`. jsdom's `location.assign` can't be spied on, so
tests `vi.mock` that module. If the request fails, the menu
says so and offers Sign out again.

### Error pages

The root route (`__root.tsx`) has `errorComponent: ErrorPage` and
`notFoundComponent: NotFoundPage` (`src/pages/ErrorPages.tsx`). Other routes
set neither, so every error and unknown path reaches the root. The page
replaces the whole app, with no `AppShell`. Each page is an `ErrorScreen`
(`src/components/ErrorScreen.tsx`): the loading screen's wordmark, a title,
a sentence and the fixes. The root route is never code-split, so the pages
are in the entry chunk and still show when the network is down.

A query throws `ApiError` (`src/api/errors.ts`) when the API answers without
data. It carries the status and the time from `Retry-After`. A query throws
`ApiUnreachable` when no response came back. `ErrorPage` reads them:

- `ApiUnreachable`, 502, 503 or 504: "Can’t reach FortyMM".
- 429: "Wait a minute, then try again", with the time from `Retry-After`.
- Anything else: "Something went wrong".

"Try again" reloads the page.

### Tests

Vitest is configured in the `test` block of `web-client/vite.config.ts` (jsdom
environment). `web-client/src/setupTests.ts` loads the jest-dom matchers,
starts the mock API, and cleans up rendered components after each test. Tests
live next to the code as `*.test.tsx`.

Tests go through page objects in `web-client/src/test/pages/`. A static async
`render()` renders the app's router at the page's path (via
`src/test/renderRoute.tsx`, using a memory history) and returns the object,
whose getters query `screen` on each access (e.g.
`(await HomePage.render()).title`). Page objects expose elements located by
accessible role; assertions stay in the tests. The design system page has no
link to it, so `navigate()` on a page object goes to another page through the
router, as a link would.

Unit tests mock the API with MSW. `src/test/server.ts` holds the mock server
and its default handlers, and `setupTests.ts` starts it. An unhandled request
fails the test. A test overrides a handler with `server.use()`, and the
override resets after the test. Type each mock body with the schema's type,
e.g. `components['schemas']['SessionResponse']`. The default handler answers
`POST /v1/session` with `sessionResponse`, a guest account whose player is
`excited egret 387`. Another default handler answers `POST /v1/auth/logout`
with `logoutResponse`, and another answers `GET /v1/account/players` with
no players. `listedPlayer()` makes a player for the players list, with no
matches. `mockVerifiedAccount()` signs the mock API in as a verified
account with the players it gets. One of them must be `self`, and their
order is the order the API made them. It answers "Is this you?" as the API
does, with `meta`, a merge into the older player and `same_as`. On a
closed question it changes nothing and returns `already_answered`, except
that `not_mine` gets a 409. It returns the answers it got, and
`answerInAnotherTab()`, which answers a question without the page
knowing. `failAnswers` makes every answer fail with a 500.
`PlayerReviewPage` renders `/review-players` by default, or Home with or
without `signed_in=1`. Its `clickTwiceAtOnce()` clicks a button twice before React
renders again, as a quick double click can.

`HomePage.render({ path })` renders the app at another path, such as one
with a query. `homePage.href` is the router's current path and query, so a
test can check what `SignInErrorAlert` left in the URL.

`renderRoute` gives each render its own `QueryClient` with retries off and an
API client with base URL `API_BASE_URL` (`http://localhost/api`), because
Node's `Request` rejects a relative URL. It loads the route before it
renders, and an authenticated route's loader waits for the session, so the
page is on screen when `render()` resolves. To test the loading screen, hold
the session response with `holdSession()` from `src/test/server.ts` and
render with `waitForLoad: false` (see `src/components/LoadingScreen.test.tsx`).
The router times `pendingMs` with `Date.now()`, so that test fakes `Date`
with the timers. It loads the page's chunks once first, because they load
in real time while the fake clock stands still. To test a skeleton, hold the players
response with `holdPlayers()`. `failPlayersOnce()` fails the next players
request, for a boundary's error. React keeps a Suspense fallback up for a
moment after the data comes, so wait for the content with a `find*` query. `DesignSystemPage.render()` never
waits for the session, because the page doesn't start one.
`src/api/queries.test.ts` checks the retry rule through `createQueryClient()`. `renderRoute` calls
`router.load()`, which also loads the route's chunk. A navigation after the
render can load another chunk. So `PlayerReviewPage.findQuestion()` waits
for the review's heading after Home sends the browser there.

### End-to-end tests

The Playwright suite lives in `web-client/e2e/` (`*.spec.ts`, excluded from
Vitest) and is configured in `web-client/playwright.config.ts`. It runs in the
`playwright` Compose service: the official Playwright image, which ships the
browsers, sharing the `dev` service's network so the dev server is on
`localhost:5173`. Keep the image tag in `compose.yaml` in sync with
`@playwright/test` in `package.json` (pinned exactly).

Specs import `test` and `expect` from `e2e/fixtures.ts`, which provides page
objects (`e2e/pages/`) as fixtures: `test('...', async ({ homePage }) => ...)`.
As in the unit tests, page objects expose role-based locators and actions like
`goto()`, and the specs do the asserting.

`e2e/session.spec.ts` runs against the real API. It checks that a page load
sends one `POST /v1/session`, that a reload keeps the account, and that a new
browser context gets another. So it also checks that Chromium keeps the
`__Host-` cookie, which is `Secure`, over `http://localhost`. `home.spec.ts`
holds the session request with `page.route()` to show the loading screen.

`e2e/sign-in.spec.ts` signs in through the dev server's `/oidc` proxy and
the mock's sign-in page. It has one test for each outcome of
`resolve_login()`. Each test reads the account from `POST /api/v1/session`
with the page's cookies. The `SignInPage` page object returns to
`/design-system`, which starts no session, unless the test passes
`returnTo: '/'`. Each run makes a new `sub` and email, because the dev
database keeps its accounts.

`e2e/adoption.spec.ts` signs in back to Home. No player has played, so no
sign-in asks "Is this you?", and Home stays on `/`. The VerifyInPlace test
checks that the topbar shows the guest's player after a person's first
sign-in. The AdoptGuest test signs the same person in from a second guest.
It checks that the topbar shows the account's player, and through
`GET /v1/account/players` that the account has only that player. The
Vitest unit tests cover the "Is this you?" page.

`e2e/sign-out.spec.ts` opens `/`, picks Sign in from the account menu and
fills the mock's form with `SignInPage.completeSignIn()`. It lands back on
`/` as a verified account, with the guest's player, signs out and ends on
`/signed-out`. Then Play as a guest opens `/` as a new
guest account. The mock answers 405 to the
logout URL. So the spec answers that navigation with `page.route()`, a 302
to its `returnTo`. The API builds `returnTo` from the browser's `Host`, so
in the e2e suite it is `http://localhost:5173/signed-out`. A second test
signs a guest out from the account menu, through its dialog, to
`/signed-out`. A third signs in again from `/signed-out`, and checks that
the account keeps its one player.

The suite counts about 23 guest accounts and sign-ins with no session,
under the limit of 30 a minute.

The design system page is a copy of the reference's component gallery
(`references/design-system/ui_kits/components/index.html`). It has one
component per gallery section, in `src/pages/designSystem/`
(`ButtonsSection`, `FieldsSection` and so on). Each section and example
carries the gallery's `data-testid` (`section-actions`, `ex-variants`).

The app also has the gallery's screenshot test mode (`src/testMode.ts`, see
the gallery's `TESTING.md`). `?test` turns off transitions, animations and
the text caret. `?test&only=<testid>` shows one element alone, flush top-left
with 24px padding. `<html data-fm-ready="true">` marks the page ready. The
mode's rules are in `kit.css`. Components read `isTestMode()` for the
mode's behaviour, such as toasts that stay until dismissed.

So one set of page objects serves both pages. `GalleryPage` holds the page
chrome, `goto(only?)`, and one object per section in
`e2e/pages/designSystem/`, found by test id. `DesignSystemPage` opens the
app's page, and `ReferenceKitPage` opens the gallery from disk.

Screenshot tests use `toHaveScreenshot`; their baselines live next to the spec
in `e2e/<spec>-snapshots/` and only match when taken in the `playwright`
container, so regenerate them there (`docker compose exec playwright npx
playwright test --update-snapshots`, with the stack and dev server up as in
`web-client:e2e`). `design-system.spec.ts` compares the app's page with the
gallery. Each section has one journey test. The journey opens each section
and example with `goto('<testid>')` and takes its screenshots on the app,
then the same screenshots on the gallery, each in its own `test.step`. The
two pages share each png, so they must render identically. The checks are
soft, so one mismatch doesn't hide the rest. The journey reaches hover,
focus and open states through the real UI on both pages. The header has its
own pair of tests, with the app's title swapped into the gallery's.

An update run writes the png from whichever page it checks last, and it
never fails. After `--update-snapshots`, run the suite again without the
flag. Only that run proves that the app matches the gallery.

`e2e/reference-styles.spec.ts` fails if `src/styles/` stops matching the
reference (see Styles).

Every run records a trace: `web-client/test-results/<test>/trace.zip` (open
with `npx playwright show-trace` or https://trace.playwright.dev) and an HTML
report in `web-client/playwright-report/`.

#### Post-deploy suite

`web-client/e2e/deployed/` is a separate suite, run against a deployment
rather than the dev server, that checks the Worker, the assets and the API
are wired together: `/api/v1/health` reaches the database through the API,
`/api/openapi.json` and `/api/docs` come from the API, an unknown `/api/*` path
gets the API's JSON 404 rather than the SPA's `index.html` (so
`run_worker_first` works), and `/` and `/design-system` load the app (so the
assets and the SPA fallback work). On a Preview, `sign-in.spec.ts` checks
that `GET /api/v1/auth/login` answers 302 to the Auth0 tenant's
`/authorize`, with the Preview's client ID and callback URL. It reads them
from `api/deploy/auth0.env`. It doesn't sign in. The
main config ignores it; `web-client/playwright.deployed.config.ts` runs it,
with `baseURL` from `PLAYWRIGHT_BASE_URL` (it fails fast without one) and no
screenshot tests. Its `ready` project retries `/api/v1/health` for up to a
minute (Cloud Run cold starts, Preview propagation) before the other specs
run. Against production (`fortymm.com` or `www.fortymm.com`), the config runs
only the `ready` project.
Against a Preview, the `session-limit` project runs last. It makes guest
accounts with a new connection each until the API answers 429, so it checks
the guest account limit through the Worker. It has no retries, because a
retry in the same minute finds the budget spent.
A page load of `/` without a session cookie starts a guest account, and
production keeps every account. So a production run checks only `/api/v1/health`. Against a
Preview, `app.spec.ts` answers `POST /api/v1/session` itself with
`page.route()`, so its page loads make no account. The stub is in that spec,
not in `e2e/fixtures.ts`, because the main suite needs the real endpoint.
Only `sign-in.spec.ts` and `session-limit.spec.ts` count toward the guest
account limit. `sign-in.spec.ts` starts a login with no session, which
counts as one, so `session-limit` gets 29 before the 429.

```sh
DEPLOY_URL=https://fortymm.com ./bin/mise run web-client:e2e-deployed
```

`web-client:e2e-deployed` starts just the `playwright` container (and `dev`,
whose network it shares), runs the suite there against `DEPLOY_URL`, then
removes the containers. It needs `npm ci` done (as `ci` does). Its traces and
report go to `web-client/test-results/deployed/` and
`web-client/playwright-report/deployed/`, so they don't replace the main
run's, and CI uploads them in the same `playwright-traces` artifact.

### Styles

The design system's styles apply to the whole app; `main.tsx` imports them:

- `src/styles/tokens.css`: the `:root` tokens (CSS variables) of
  `references/design-system/colors_and_type.css`, plus the self-hosted fonts
  in `src/assets/fonts/`.
- `src/styles/base.css`: the base, type roles, status markers and motion of
  the same file. Then the app's own styles: the loading screen,
  `.app-shell` (`src/pages/AppShell.tsx`), `.roadmap`, the list of what's
  ready and what's coming that Home shows (`src/pages/Home.tsx`), and
  `.sign-in-error` (`SignInErrorAlert`).
- `src/styles/kit.css`: the component classes (`fm-*`) of
  `references/design-system/ui_kits/components/kit.css`.
- `src/styles/page.css`: the gallery's page chrome (`.doc-*`), with `.page`
  (the page's wrapper in `AppShell` and in `src/pages/DesignSystem.tsx`) for
  its `.doc`.

The reference's parts of these files are copies. Don't edit them.
`e2e/reference-styles.spec.ts` fails when a copy differs from the reference.
If the reference changes, copy the change in.

`public/favicon.svg` is the reference's `assets/logo-mark.svg` without its
C2PA manifest. The same spec fails if the two differ.

Each font is split into woff2 files by `unicode-range`, so a page downloads
only the files its text uses. `space-grotesk.css` comes from Fontsource.
`web-client/scripts/subset-fonts.py` writes `bebas-neue.css`,
`jetbrains-mono.css` and their files from the reference's TTFs, the same
files the reference kit embeds. If the reference's fonts change, run it again
(`docker compose run --rm dev /app/bin/docker-entrypoint uv run --no-project
web-client/scripts/subset-fonts.py`).

`index.html` preloads the latin file of each font, because every first paint
uses them. Without the preloads, the browser
finds the fonts only after `main.tsx` renders, so the page and the loading
screen show fallback text first. Vite rewrites the preload `href`s to the
same hashed files the CSS uses. If you rename or add a font that the first
paint uses, update the preloads too.

Use these classes and CSS variables rather than raw values or page-specific
styles. `/design-system` is where the app's styles are checked against the
reference (see the screenshot tests above).

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

## ios-client

`ios-client/` is the iOS app, in SwiftUI. It has the web client's guest
accounts, sign-in and sign-out, with Home's roadmap. It builds on the macOS
host with Xcode, not in the dev container.

```sh
./bin/mise run ios-client:generate   # write ios-client/FortyMM.xcodeproj
./bin/mise run ios-client:test       # run the unit tests on an iPhone simulator
./bin/mise run ios-client:e2e        # run the UI tests on an iPhone simulator
./bin/mise run ios-client:ci         # run both
BUILD_NUMBER=7 ./bin/mise run ios-client:testflight  # archive and upload to TestFlight
```

- `project.yml` is the project's source. XcodeGen (`tools` on
  `ios-client:generate`, so Linux never installs it) writes
  `FortyMM.xcodeproj` and `FortyMM/Info.plist` from it. Both are
  gitignored, so run `ios-client:generate` before you open the project in
  Xcode, and after you add a file or change `project.yml`.
- The app bundles Bebas Neue from `references/design-system/fonts/` by
  path, so it has no copy to drift. `DesignToken` (`FortyMM/DesignToken.swift`)
  holds the colour tokens the app uses. `FortyMMTests` (Swift Testing) fails
  if a token's hex differs from `colors_and_type.css`, if the launch
  screen's `LaunchBackground` colour differs from the splash background
  (`Color.bgApp`), or if the font isn't in the bundle. It also bundles
  JetBrains Mono, for the time in the 429 message. Space Grotesk isn't in
  the reference's fonts, so other text uses the system font with Dynamic
  Type.
- The app talks to `FORTYMM_API_BASE_URL` from its launch environment, or
  else `https://fortymm.com`, under `/api`. Point it at the web dev
  server's port for local dev (see `ios-client/README.md`). A hosted unit
  test run makes no request, and every UI test passes a base URL, so tests
  never reach production.
- swift-openapi-generator's build plugin generates the API client from
  `api/openapi.json`, which `project.yml` lists by path.
  `FortyMM/API/openapi-generator-config.yaml` picks the operations the app
  calls. So a schema change that the app's code doesn't handle breaks the
  build. `FortyMMAPI.swift` is the one place that reads the generated types.
  It turns each response into `Account`, `SignInOutcome` or `Failure`.
  The scripts pass `-skipPackagePluginValidation` to trust the plugin.
  `Package.resolved` pins every package. `ios-client:generate` copies it
  into the gitignored project, and the scripts build only from it. After
  you change a package, copy the project's new `Package.resolved` back.
- Apple's cookie storage drops the API's `Secure` cookies over
  `http://localhost`. So the app keeps the session and login cookies
  itself, in the Keychain, one item per base URL. `CookieMiddleware` sends
  them, keeps each `Set-Cookie`, and gives each `POST` its JSON
  `Content-Type`.
- `AppModel` holds the app's state: a phase (`starting`, `ready`, `failed`,
  `signedOut`), the sign-in in flight with its last error, and the sign-out
  in flight. Starting shows the splash, as the web's loading screen.
  A failure shows the web's error page text with Try again.
- Sign-in uses `POST /v1/auth/app-login` and `app-finish` (see Sign-in),
  through SwiftUI's `webAuthenticationSession` with the `fortymm` scheme
  and an ephemeral browser session. That session keeps no provider cookie,
  so sign-out calls `POST /v1/auth/logout` and doesn't open `logout_url`.
  Closing the sheet shows nothing. A refused sign-in shows the web's
  `signInErrors` message in a banner above Home or on the signed-out
  screen.
- Home has the wordmark as the navigation bar's centred title, where iOS
  puts it (a leading toolbar item crops it to a glass capsule), and the
  account menu at the right, whose label is the player's avatar. Its menu matches
  the web's `UserMenu`. A guest's Sign out asks first, in an alert with the
  web dialog's text, "device" for "browser". Signed out shows the web's
  `/signed-out` text with Sign in and Play as a guest. A relaunch after a
  sign-out starts a new guest account, as opening `/` does. There's no tab
  bar while Home is the only page.
- `FortyMMUITests` (XCUITest) launches the app and goes through page objects
  in `Screens.swift`, which find elements by what VoiceOver reads. The
  launch tests answer the app from `StubAPI`, a listener on 127.0.0.1 in the
  test runner. The account and sign-in tests run against the dev stack
  when `FORTYMM_API_BASE_URL` is set, and skip otherwise, so iOS CI skips
  them. `bin/xcodebuild-test` passes it to the runner as
  `TEST_RUNNER_FORTYMM_API_BASE_URL`. The sign-in test fills the mock
  provider's form in the sign-in sheet.
- `bin/xcodebuild-test` runs the tests on the first available iPhone
  simulator, or on `IOS_SIMULATOR` (a name or UDID). It writes a result
  bundle per run to `build/results/`.
- `.github/workflows/ios-client.yml` runs `ios-client:ci` on a macOS runner,
  only on a push that changes the app, its design-system inputs,
  `api/openapi.json`, `mise.toml`, `bin/mise` or the workflow. It uploads the result bundles as `ios-client-results`.
- `bin/app-icon` writes the app icon, `AppIcon.png` in
  `FortyMM/Assets.xcassets`, from `references/design-system/assets/logo-mark.svg`
  on `--ink-950`. The PNG has no alpha channel, because the App Store
  refuses one that has. The PNG is committed, so run the script again if
  the logo mark changes.
- On a push to `main`, after the tests, the workflow uploads the app to
  TestFlight with `ios-client:testflight`. `bin/xcodebuild-testflight`
  archives the app unsigned, then exports it with Xcode's cloud-managed
  signing, through an App Store Connect API key, and uploads it. No
  certificate or profile is stored anywhere. The build number is the
  workflow's run number, and the version is `MARKETING_VERSION` in
  `project.yml`. Until the Apple team and the key are set, the workflow
  warns and skips the upload. A run on `main` isn't cancelled by the next
  push, so an upload never stops midway. `ARCHIVE_ONLY=1` stops the script
  after the archive, with no request to Apple. `ios-client/README.md`
  describes the one-time setup.
- `ITSAppUsesNonExemptEncryption` is false in the Info.plist, so TestFlight
  asks no export compliance question per build. An app that adds its own
  encryption must change it.

## Deploy

Production is `https://fortymm.com`: a Cloudflare Worker serves the
web-client and forwards `/api/*` to the API on Google Cloud Run, so the app's `/api` client is same-origin, as in dev, with no CORS.

The API's `*.run.app` URLs are public, so the Worker proves each request came
through it. It sends the Worker secret in the `X-FortyMM-Worker-Secret`
header, and the API answers 403 to any request without it. The Worker also
answers 429 to a client IP that sends more than about 100 `/api/*` requests
a minute to one Cloudflare machine. A client that opens a new connection per
request reaches many machines, so this limit doesn't stop it (#88). The API
limits guest accounts itself (see Accounts and sessions). The Worker secret section below describes where the value lives.

```sh
./bin/mise run api:deploy           # build, push and deploy the API; prints its URL last
./bin/mise run api:preview          # the same, as this branch's Preview revision
./bin/mise run api:url              # print the production API's URL
./bin/mise run web-client:deploy    # wrangler deploy of web-client/dist and the Worker
./bin/mise run web-client:preview   # a Cloudflare Preview named after the git branch
./bin/mise run api:preview-delete <branch>         # remove that branch's API Preview tag and database
./bin/mise run web-client:preview-delete <branch>  # delete that branch's Cloudflare Preview
```

CI deploys on every push after `ci` passes, the API first, so the Worker
never points at a route that isn't there yet:

- `main`: `api:deploy`, then `web-client:deploy` with `API_ORIGIN` set to the
  URL it printed.
- Any other branch: `api:preview`, then `web-client:preview` with
  `API_ORIGIN` set to that revision's URL, so each Cloudflare Preview talks to
  the API built from the same commit. Both Preview URLs are in the deploy
  steps' logs.

Before the deploys, CI pins one version of the Worker secret, and both
deploys use it. After the API deploy, CI requests `$API_ORIGIN/v1/health`
without the header and fails unless the API answers 403.

Then CI runs the post-deploy suite (`web-client:e2e-deployed`, see
End-to-end tests) against what it just deployed:

- Any other branch: against the Cloudflare Preview, whose URL the deploy step
  takes from wrangler's `Preview URL:` line (failing if it's missing). This
  checks the branch's full stack, Worker, assets and API revision, before
  it's merged.
- `main`: against `https://fortymm.com` after `web-client:deploy`. Production
  has already changed by then, so this detects a broken deploy rather than
  preventing one. It runs only the health check, so it makes no account.

Both are skipped while the API deploys are (see below), since `/api/*`
answers 503 then.

When a branch other than `main` is deleted,
`.github/workflows/preview-cleanup.yml` removes its Previews.
GitHub runs the workflow from `main`, so the deleted branch's name comes from
the `delete` event. The workflow runs `api:preview-delete` and then
`web-client:preview-delete` with that name. Each task succeeds if its Preview
isn't there. The workflow skips the API step while the API deploys are
skipped. It uses the CI concurrency group of the deleted branch. So it waits
for that branch's running CI deploy, and a CI deploy can't recreate the
Previews after the cleanup.

### web-client (Cloudflare Workers)

`web-client/wrangler.jsonc` configures it. `worker/index.ts` is the Worker
(unit-tested in `worker/index.test.ts`): requests to `/api/*` go to
`API_ORIGIN` with the `/api` prefix stripped, keeping the method, headers,
query and body and setting `X-Forwarded-Host`, `X-Forwarded-Proto` and
`X-Forwarded-For`; with no `API_ORIGIN` they get a 503. The Worker sets
`X-FortyMM-Worker-Secret` from `WORKER_SECRET`, and removes a client's own
copy when `WORKER_SECRET` is empty. Before it forwards a request, the
`API_RATE_LIMIT` binding (`ratelimits` in `wrangler.jsonc`) counts it against
the client's `CF-Connecting-IP`. Above about 100 requests a minute, the
Worker answers 429 with `Retry-After: 60`. Each Cloudflare machine keeps its
own count and shares it in the background, so the limit is approximate. A
client on one keep-alive connection gets 429 after about 100 requests. A
client that opens a new connection per request was never limited in
production or a Preview (#88). Previews get only the bindings under
`previews` in `wrangler.jsonc`, so that block repeats the rate limit. If
`CF-Connecting-IP` is missing, the Worker deletes the client's own
`X-Forwarded-For`, because the API keys guest accounts by it.
Everything else goes to the static assets in `dist/` (the `ASSETS` binding).
`assets.run_worker_first: true` runs the Worker before the assets for every
path, so the host redirect below also covers `/`. When the Worker passes a
request to `ASSETS`, `not_found_handling: "single-page-application"` serves
`index.html` for any path with no matching file. So client-side routes load
directly.

`API_ORIGIN` isn't in `wrangler.jsonc`: `web-client:deploy` and
`web-client:preview` pass it with `--var` from the environment (CI sets it
from the API deploy), and warn if it's empty. They also pass `WORKER_SECRET`
from the environment, with `--secrets-file`. wrangler runs in the `dev`
container, so the tasks write the file there. If `WORKER_SECRET` is empty,
they warn that the API will answer the Worker with a 403.

Production is served on `fortymm.com` and `www.fortymm.com` (Custom Domains
in `routes`, whose DNS records and certificates Cloudflare manages). Each host
has its own cookie jar. So the Worker answers requests on `www.fortymm.com`
with a 301 to the same path and query on `fortymm.com`, and a browser keeps one
cookie jar. This includes `/api/*` paths.

The Worker's own workers.dev URL, `fortymm.mightymoose.workers.dev`, is off.
Cloudflare answers it with a 404 (error 1042) and never runs the Worker. The
Worker still lists it with `www.fortymm.com`, so the URL redirects to
`fortymm.com` if someone turns it on. The Worker names both hosts exactly,
so Previews get no redirect.

Previews (`wrangler preview`, open beta) are served on
`<preview-name>-fortymm.mightymoose.workers.dev` because `preview_urls` is on in
`wrangler.jsonc`; changes to that setting only take effect after a production
deploy. `bin/preview-name` makes the name from the branch (`claude/foo_bar` ->
`claude-foo-bar`, at most 30 characters, starting with a letter); the API's
Preview revision uses the same name as its tag. `bin/preview-name` takes an
optional branch name and defaults to the current branch, so it can also name
a deleted branch.

The tasks deploy whatever is in `web-client/dist`, so build first (CI deploys
the build `ci` just tested). They need `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in the environment; CI reads them from the repo's
Actions secrets of the same names.

`web-client:preview-delete` runs `npm ci` and then `wrangler preview delete
--name <name> -y`. wrangler can't check whether a Preview exists first. So
the task reads wrangler's error when the delete fails. If the request to the
Preview API failed with a "not found" error, the task succeeds.

### api (Cloud Run)

The API runs on Cloud Run in GCP project `fortymm`, region `us-central1`
(`GCP_PROJECT` and `GCP_REGION` in `mise.toml`'s `[env]`; set either in the
environment to override). `api:deploy` and `api:preview` build the production
image, push it to Artifact Registry as
`us-central1-docker.pkg.dev/fortymm/fortymm/api:<commit>`, and run
`gcloud run deploy` through `api/deploy/cloud-run-deploy`, which holds the
service settings: min instances 0 (scale to zero), max 3 (1 for Previews),
1 CPU, 256 MiB, unauthenticated access, with the Worker secret as
`WORKER_SECRET`, the Cloud SQL database and Auth0 (see below). Production runs as
the `api-runtime` service account, and Previews as `api-preview-runtime`.
They need `gcloud` logged in as an account that can deploy, and Docker.

- `api:deploy` deploys the `api` service, and the new revision takes all its
  traffic.
- `api:preview` deploys a revision of a separate `api-preview` service tagged
  with the branch's Preview name and no traffic, served on
  `https://<preview-name>---<api-preview's host>`. Each push moves the tag to
  the new revision. Keeping Previews on their own service means a branch
  deploy can never change production's traffic or settings. The revision
  uses the branch's own database (see The database below).
- `api:preview-delete <branch>` removes the branch's tag from `api-preview`
  (`gcloud run services update-traffic --remove-tags`), then drops the
  branch's database. It first checks that the service and the tag exist, and
  skips the tag removal if either is missing. It drops the database in every
  case, because a database can outlive its tag. The revision stays, untagged
  and with no traffic. Cloud Run keeps a limited number of revisions per
  service, and an idle revision costs nothing, so nothing deletes revisions.

#### The database

The API's database is the Cloud SQL instance `fortymm` (Postgres 18,
Enterprise edition, `db-f1-micro`, 10 GB SSD) in the same region.
`cloud-run-deploy` mounts it with `--add-cloudsql-instances` and sets
`DATABASE_URL` to its Unix socket. libpq reads the password from
`PGPASSWORD`, which Cloud Run sets from a secret at `latest`:

| Target | Database | User | Password secret | Runs as |
| --- | --- | --- | --- | --- |
| `api` | `fortymm` | `api` | `api-database-password` | `api-runtime` |
| `api-preview` | `fortymm_preview_<name>` | `api_preview` | `api-preview-database-password` | `api-preview-runtime` |

Each Preview gets its own database, because the API migrates its database at
startup and two branches can have different schemas.
`api/deploy/preview-database` makes the name. It is `fortymm_preview_` and
then the Preview name with dashes changed to underscores
(`feat-db-per-preview` -> `fortymm_preview_feat_db_per_preview`). `cloud-run-deploy` creates the
database on the branch's first Preview deploy. `api:preview-delete` drops it,
and the preview-cleanup workflow runs that task when the branch is deleted.
All Previews connect as `api_preview`. Cloud SQL runs one admin operation per
instance at a time, so `preview-database` retries a create or drop that
collides with another one for about 5 minutes.

Only the matching runtime service account can read each password secret, so
branch code can't read production's password. The instance allows 25
connections. Production holds up to 12 (3 instances with 4 each), and each
warm Preview holds up to 4, so about 3 warm Previews fit at once. The
instance costs about $9-10 a month and never scales to zero.

#### The Worker secret

The Worker secret is a 64-character hex value in Secret Manager, as the
secret `api-worker-secret`. Cloud Run allows unauthenticated requests, so the
Worker secret is the only thing that keeps clients from going around the
Worker.

- `cloud-run-deploy` mounts it as `WORKER_SECRET` at a pinned version number:
  `WORKER_SECRET_VERSION` if set, otherwise the newest enabled version. It
  never uses `latest`. Instances scale to zero and read `latest` again on each
  cold start, so a new version would reach the API before the Worker.
- CI sets `WORKER_SECRET_VERSION` once per run. The Cloudflare deploy steps
  read that version with `gcloud secrets versions access`, mask it in the
  log, and pass it to `web-client:deploy` or `web-client:preview` as
  `WORKER_SECRET`. The value stays in those steps.
- Cloud Run sets `K_SERVICE`. If `K_SERVICE` is set and `WORKER_SECRET` is
  not, `create_app()` raises, so the revision fails to start instead of
  serving the API to anyone.

To rotate the Worker secret, add a version, then push `main`:

```sh
openssl rand -hex 32 | tr -d '\n' |
  gcloud secrets versions add api-worker-secret --project fortymm --data-file=-
```

Production answers 403 for about a minute, between the API deploy and the
Worker deploy. Each Preview picks up the new version on its next push. After
that, disable the old version (`gcloud secrets versions disable <n> --secret
api-worker-secret --project fortymm`) to retire it. A Preview revision still
pinned to a disabled version can't start, so push its branch again first.

CI authenticates to Google Cloud with Workload Identity Federation
(`google-github-actions/auth`; no service-account key), as the
`github-deployer` service account, from two Actions **variables**:
`GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_SERVICE_ACCOUNT`. Until both are
set, CI skips the API deploys with a warning, and the Worker answers `/api/*`
with a 503.

The Artifact Registry repository has a cleanup policy
(`api/deploy/cleanup-policy.json`, applied by `bootstrap-gcp.sh`): it deletes
images older than 30 days except the 10 newest and the one tagged
`production`, which `cloud-run-deploy` moves to each production deploy.

The one-time GCP setup (enabling the APIs, the Artifact Registry repository,
the service accounts and their roles, the Worker secret, the Cloud SQL
instance with its databases, users and password secrets, the two Auth0
client secrets with no value, the Workload
Identity pool and provider for `mightymoose/fortymm`, the budget) is
`api/deploy/bootstrap-gcp.sh`, run once by a project owner; it prints the
variables to set. `api/deploy/README.md` describes it step by step.

The budget `FortyMM (fortymm)` covers the project's monthly spend. Google
Cloud emails the billing account's admins and users when the spend passes
$10 and $25. The Cloud SQL instance alone costs about $9-10 a month, so the
$10 alert will likely fire most months.

#### Auth0

Production and the Previews sign in through one Auth0 tenant, with two
applications of type Regular Web Application. The tenant has only the
email code and Google connections, because the API links logins by verified
email (see Sign-in).

| Target | Auth0 application | Allowed callback URLs | Client secret |
| --- | --- | --- | --- |
| `api` | `fortymm` | `https://fortymm.com/api/v1/auth/callback`, `https://fortymm.com/api/v1/auth/app-callback` | `auth0-client-secret` |
| `api-preview` | `fortymm-preview` | `https://*-fortymm.mightymoose.workers.dev/api/v1/auth/callback`, `https://*-fortymm.mightymoose.workers.dev/api/v1/auth/app-callback` | `auth0-preview-client-secret` |

Each application's allowed logout URL is its origin with `/signed-out`.
`api/deploy/auth0.env` holds `AUTH0_DOMAIN`, `AUTH0_TENANT_DOMAIN`,
`AUTH0_CLIENT_ID` and `AUTH0_PREVIEW_CLIENT_ID`. `AUTH0_DOMAIN` is the
custom domain `auth.fortymm.com`, where Auth0 serves the sign-in page.
`AUTH0_TENANT_DOMAIN` is the tenant's own domain, where the Management API
answers. These values are public, so the file is committed. `cloud-run-deploy` reads it before it pushes the image, and fails
without it. It sets `AUTH0_DOMAIN` and the target's `AUTH0_CLIENT_ID`. It
mounts the target's client secret as `AUTH0_CLIENT_SECRET` at `latest`, so a
cold start reads a rotated secret. Only the matching runtime service account
can read each client secret.

`api/deploy/setup-auth0` is a wizard that a person runs once, after
`bootstrap-gcp.sh`. It walks them through the Auth0 dashboard and the Google
Cloud console. It adds each client secret to Secret Manager and writes
`auth0.env`. `api/deploy/README.md` describes it.

`api/deploy/apply-auth0-branding` gives the tenant's sign-in page the
design system's look, from the files in `api/deploy/auth0-branding/`. A
person runs it with a Management API token. It changes the page for
production and the Previews at once. Its logo is
`web-client/public/logo-wordmark.svg`, served from `https://fortymm.com`.
`api/deploy/README.md` describes it, and the steps to serve the page on
`auth.fortymm.com`.
