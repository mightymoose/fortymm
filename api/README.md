# FortyMM API

FastAPI service for FortyMM.

## Setup

Python is managed via [mise](https://mise.jdx.dev/) (see `mise.toml` at the repo root).

From this directory:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
```

## Run

The API needs Redis for the solver queue. Set `REDIS_URL` (defaults to `redis://localhost:6379/0`).

Start the API:

```bash
uvicorn app.main:app --reload
```

Start an RQ worker in a separate process so health checks can complete:

```bash
rq worker solver --url "$REDIS_URL"
```

`GET /v1/health` enqueues a small CP-SAT hello-world problem, waits for the worker to solve it, and returns `{"solver": {"healthy": true}}` when the round trip succeeds.

## Database

PostgreSQL via async SQLAlchemy. Set `DATABASE_URL` (defaults to `postgresql+asyncpg://postgres:postgres@localhost:5432/fortymm`).

Start a local Postgres:

```bash
docker run --rm -d --name fortymm-pg \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=fortymm -p 5432:5432 postgres:16-alpine
```

Apply migrations:

```bash
alembic upgrade head
```

## Test

The test suite uses [testcontainers](https://testcontainers-python.readthedocs.io/) to spin up an ephemeral Postgres for DB-backed tests, so a working Docker daemon is required by default. To use an already-running Postgres instead, set `TEST_DATABASE_URL`:

```bash
pytest
# or, against a local Postgres:
TEST_DATABASE_URL="postgresql+asyncpg://postgres:postgres@localhost:5432/fortymm_test" pytest
```

The suite creates and migrates a disposable database on that server. Its login
needs `CREATEDB` and permission to set `session_replication_role` (the default
testcontainers `postgres` superuser already has both). For a dedicated test role,
an administrator can grant the latter with
`GRANT SET ON PARAMETER session_replication_role TO your_test_role`.

Between tests, cleanup deletes rows with retention and foreign-key triggers
bypassed only inside the cleanup transaction. The setting is restored on commit
or rollback; tests still exercise the real migrated constraints and can commit
across multiple connections. This avoids the table/index storage rewrites from
truncating the entire schema after every test.

Required background repairs survive Redis outages in PostgreSQL. See the
[required repair operator runbook](../docs/required-repair-operations.md) for
failure inspection and explicit retry with `python -m app.repair_cli`.
