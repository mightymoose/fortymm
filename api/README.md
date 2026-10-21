# api

The FortyMM HTTP API: a [FastAPI](https://fastapi.tiangolo.com) app whose
request and response bodies are [Pydantic](https://docs.pydantic.dev) models.
It's managed with [uv](https://docs.astral.sh/uv/) and runs in the `api`
Docker Compose service; see the repo's `CLAUDE.md` for the tasks that drive it.

- `src/fortymm_api/main.py`: `create_app()`, the app factory.
- `src/fortymm_api/v1/`: the `/v1` routes, one module per resource.
- `openapi.json`: the committed OpenAPI schema clients generate types from.
  Regenerate it (and the web-client's types) with `./bin/mise run api:openapi`.
