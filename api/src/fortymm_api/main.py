from fastapi import FastAPI
from fastapi.routing import APIRoute

from fortymm_api import v1


def operation_id(route: APIRoute) -> str:
    """Name each OpenAPI operation after its route function (e.g. `ping`).

    FastAPI's default IDs embed the path and method (`ping_v1_ping_get`), which
    leak into the clients generated from the schema.
    """
    return route.name


def create_app() -> FastAPI:
    app = FastAPI(
        title="FortyMM API",
        version="0.1.0",
        generate_unique_id_function=operation_id,
    )
    app.include_router(v1.router)
    return app


app = create_app()
