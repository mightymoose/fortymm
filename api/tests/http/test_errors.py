"""Errors FastAPI produces by itself come out as the API's error document
(api.routes.errors), with nothing from inside the server in them."""

import pytest
from fastapi import APIRouter

from tests.support.api_client import api_client

pytestmark = pytest.mark.anyio


async def test_unknown_path_answers_404_with_an_error_document(database_url: str) -> None:
    async with api_client(database_url) as client:
        response = await client.get("/v1/no-such-thing")

    assert response.status_code == 404
    assert response.json() == {
        "errors": [{"status": "404", "code": "not_found", "title": "Not Found"}]
    }


async def test_wrong_method_answers_405_with_an_error_document(database_url: str) -> None:
    async with api_client(database_url) as client:
        response = await client.post("/v1/health")

    assert response.status_code == 405
    assert response.headers["allow"] == "GET"
    assert response.json() == {
        "errors": [{"status": "405", "code": "method_not_allowed", "title": "Method Not Allowed"}]
    }


async def test_unhandled_exception_answers_500_without_internals(database_url: str) -> None:
    # A test-only route: no real route fails this way on demand.
    failing = APIRouter()

    @failing.get("/v1/test-only/failure")
    async def fail() -> None:
        raise RuntimeError(f"internal detail: {database_url}")

    async with api_client(database_url, extra_routes=failing) as client:
        response = await client.get("/v1/test-only/failure")

    assert response.status_code == 500
    assert response.json() == {
        "errors": [
            {"status": "500", "code": "internal_server_error", "title": "Internal Server Error"}
        ]
    }
