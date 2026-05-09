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

```bash
uvicorn app.main:app --reload
```

The health endpoint is available at `GET /v1/health` and returns an empty JSON body.

## Test

```bash
pytest
```
