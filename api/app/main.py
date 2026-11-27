from fastapi import APIRouter, FastAPI
from fastapi.routing import APIRoute

from app.v1 import health, parcels

# Every route lives under /api: the web client's dev server proxies /api here unchanged
# (see web-client/vite.config.ts), so the docs are at /api/docs too.
api = APIRouter(prefix="/api")

v1 = APIRouter(prefix="/v1")
v1.include_router(health.router)
v1.include_router(parcels.router)
api.include_router(v1)


def operation_id(route: APIRoute) -> str:
    """Name each operation after its function (`health`), not FastAPI's path-derived default."""
    return route.name


app = FastAPI(
    title="fortymm",
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
    generate_unique_id_function=operation_id,
)
app.include_router(api)
