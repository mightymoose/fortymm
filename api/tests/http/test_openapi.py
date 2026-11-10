"""Rules the served OpenAPI document follows for every route, not just today's."""

import pytest
from fastapi import APIRouter

from tests.support.api_client import api_client

pytestmark = pytest.mark.anyio


async def test_a_new_route_gets_its_function_name_as_operation_id(database_url: str) -> None:
    # A test-only route, declared the way any new route is, with no operation_id given.
    widgets = APIRouter()

    @widgets.get("/v1/test-only/widgets")
    async def list_widgets() -> None:
        pass

    async with api_client(database_url, extra_routes=widgets) as client:
        document = (await client.get("/openapi.json")).json()

    assert document["paths"]["/v1/test-only/widgets"]["get"]["operationId"] == "list_widgets"
