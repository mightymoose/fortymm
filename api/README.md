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

## Test

```bash
pytest
```
