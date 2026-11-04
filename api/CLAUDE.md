# api

`api/` is a FastAPI app managed with uv. mise installs its Python (pinned in
`mise.container.toml`; there's no `.python-version`) and the Dockerfile tells
uv to use only that interpreter. uv manages the dependencies (`pyproject.toml`
and `uv.lock`). Code is in `src/fortymm_api/`, tests in `tests/` (pytest,
through FastAPI's `TestClient`).

This file holds the API's conventions. What each area does is in `docs/`.
Read the area's doc before you change it:

- `docs/accounts.md`: accounts and sessions, "Is this you?", sign-in, roles
  and permissions, leagues.
- `docs/matches-api.md`: matches, signed results, approvals, overrides and
  signing keys.
- `references/matches.md`: why matches work the way they do.
- `api/signed-results/README.md`: the signed result format.
- `docs/deploy.md`: Cloud Run, Cloud SQL, the Worker secret and Auth0.

- `main.py`: `create_app()`, the app factory. Operation IDs are the route
  functions' names, so generated clients get names like `health`. If
  `WORKER_SECRET` is set, the app answers 403 to every request without a
  matching `X-FortyMM-Worker-Secret` header (see `docs/deploy.md`). Local dev, the
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
  gives each one its column type.
- `ownership.py`: `OWNERSHIP_RULES` says what adoption and player merge do
  to each foreign key to `accounts` or `players`. `tests/test_ownership.py`
  fails if one has no entry, so a new foreign key to either table needs an
  entry in the same change.
- `alembic check` doesn't compare a partial index's `WHERE` clause, nor
  triggers. `tests/test_schema.py` checks each constraint, index and
  trigger on a `migrated_database`, so add a test there for each one.
- A service that writes as an account first calls
  `lock_account_for_write()` in `services/sessions.py` (see
  `docs/accounts.md`).
- A route that needs the account takes a `RequestAccount` parameter, and
  one that needs a permission takes `require_permission()` from `auth.py`.
  A new permission the code checks needs a migration that adds its row,
  or a test fails.
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


## Migrations

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

## OpenAPI schema and clients

`api/openapi.json` is the committed OpenAPI schema, written from the app by
`python -m fortymm_api.openapi`. Clients generate their types from it; the
web-client's are in `web-client/src/api/schema.d.ts` (`npm run
generate:api`, openapi-typescript). After changing a route or model, run
`api:openapi` and commit both files; CI's `openapi:check` fails if either is
stale.

The iOS app generates its client from the same file (see `ios-client/CLAUDE.md`).
swift-openapi-generator drops a property whose schema is `anyOf` with
`null`, which is how Pydantic writes a nullable. So `create_app()` rewrites
each such schema in `components.schemas` as `type: [X, "null"]`, which means
the same. Parameters keep `anyOf`, because oasdiff reads a parameter's type
array as a break. The generator also skips a request body that is `anyOf`
with `null`, which `body: Model | None = None` writes. So an optional body
takes a default instead, as `POST /v1/auth/logout` does. `tests/test_openapi.py`
checks all three.

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


## Dependencies

To add a Python dependency, run `docker compose run --rm --no-deps -T api
uv add <pkg>` (`uv add --dev <pkg>` for a dev one) and commit
`pyproject.toml` with `uv.lock`. The production image installs without the
dev group, so the app can't import one.
