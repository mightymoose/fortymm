# api

FastAPI on Python, managed with uv. Runs only in Docker (see the root `CLAUDE.md`); never run `python`, `uv` or `pip` on the host.

- Dev server: `./bin/mise run api:dev` (reloads on change; docs at `/api/docs`).
- uv: `./bin/mise run api:uv -- <args>` (e.g. `add <pkg>`, `add --dev <pkg>`). Rebuild the image afterwards: `docker compose build api`.
- App is in `app/`; the entry point is `app/main.py`. Every route goes under `/api` (the `APIRouter` prefix): the web client's Vite dev server proxies `/api` here unchanged.
- Versioned routes go in `app/v1/` (one module per resource, each with its own `APIRouter`), mounted at `/api/v1`. Responses are typed: wrap the payload model in `Document[T]` from `app/jsonapi.py`, which serializes as `{"data": ...}`.
- OpenAPI: `openapi.json` is committed. After changing any route or model, run `./bin/mise run api:openapi`, then `./bin/mise run web-client:api-client` to regenerate the web client's typed fetch, and commit the result. Verify fails if it is stale (drift), and if `oasdiff breaking` finds a breaking change against `main`'s spec (as of where the branch split off).
- Tests: pytest with FastAPI's `TestClient`, in `tests/`. One assertion per test. `./bin/mise run api:test`.
- Lint and format: ruff. Typecheck: mypy (strict). `./bin/mise run verify` runs all of them.
