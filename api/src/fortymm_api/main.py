import hmac
import os
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from fortymm_api import v1

WORKER_SECRET_HEADER = "X-FortyMM-Worker-Secret"


def operation_id(route: APIRoute) -> str:
    """Name each OpenAPI operation after its route function (e.g. `ping`).

    FastAPI's default IDs embed the path and method (`ping_v1_ping_get`), which
    leak into the clients generated from the schema.
    """
    return route.name


def require_worker_secret(app: FastAPI, secret: str) -> None:
    """Reject every request that doesn't carry the Worker secret.

    The Cloud Run URL is public, so this is what keeps clients from going
    around the Cloudflare Worker, which adds the header (see worker/index.ts).
    """

    @app.middleware("http")
    async def check_worker_secret(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        sent = request.headers.get(WORKER_SECRET_HEADER, "")
        if not hmac.compare_digest(sent.encode(), secret.encode()):
            return JSONResponse(
                {
                    "errors": [
                        {
                            "status": "403",
                            "title": "Requests must come through the Worker",
                        }
                    ]
                },
                status_code=403,
            )
        return await call_next(request)


def create_app() -> FastAPI:
    secret = os.environ.get("WORKER_SECRET", "")
    # Cloud Run sets K_SERVICE. Failing there stops a revision without the
    # secret from starting, rather than serving the API to anyone.
    if os.environ.get("K_SERVICE") and not secret:
        raise RuntimeError("WORKER_SECRET must be set when running on Cloud Run")

    app = FastAPI(
        title="FortyMM API",
        version="0.1.0",
        generate_unique_id_function=operation_id,
    )
    app.include_router(v1.router)
    if secret:
        require_worker_secret(app, secret)
    return app


app = create_app()
