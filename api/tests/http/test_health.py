"""GET /v1/health through the app's HTTP interface: wiring only.

The logic is proven in tests/services/test_health_check.py. Here the real HealthCheck
runs against a real database, nothing faked: one case per outcome, to show the route is
hooked up and turns each result into its status code and document.
"""

import pytest

from tests.support.api_client import api_client
from tests.support.database_faults import unreachable
from tests.support.openapi import assert_matches_documented_response

pytestmark = pytest.mark.anyio


async def test_ok_answers_200_with_the_health_resource(database_url: str) -> None:
    async with api_client(database_url) as client:
        response = await client.get("/v1/health")

    assert response.status_code == 200
    assert response.json() == {
        "data": {"type": "health", "id": "api", "attributes": {"database": "ok"}}
    }


async def test_unavailable_answers_503_with_a_database_error(database_url: str) -> None:
    # A real database address with nothing listening: the real service reports it.
    async with api_client(unreachable(database_url)) as client:
        response = await client.get("/v1/health")

    assert response.status_code == 503
    # Exactly this body: no error text, connection string or trace.
    assert response.json() == {
        "errors": [
            {
                "status": "503",
                "code": "database_unavailable",
                "title": "The database did not answer",
            }
        ]
    }


async def test_unversioned_health_path_is_gone(database_url: str) -> None:
    async with api_client(database_url) as client:
        response = await client.get("/health")

    assert response.status_code == 404


async def test_200_answer_matches_the_openapi_document(database_url: str) -> None:
    async with api_client(database_url) as client:
        document = (await client.get("/openapi.json")).json()
        response = await client.get("/v1/health")

    assert response.status_code == 200
    assert_matches_documented_response(document, "get", "/v1/health", response)


async def test_503_answer_matches_the_openapi_document(database_url: str) -> None:
    async with api_client(unreachable(database_url)) as client:
        document = (await client.get("/openapi.json")).json()
        response = await client.get("/v1/health")

    assert response.status_code == 503
    assert_matches_documented_response(document, "get", "/v1/health", response)
