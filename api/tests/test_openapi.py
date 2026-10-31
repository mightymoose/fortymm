"""The parts of the OpenAPI schema that the iOS client's generator needs."""

import json
from typing import Any

from fortymm_api.main import create_app


def test_models_write_nullables_as_type_arrays() -> None:
    schemas = create_app().openapi()["components"]["schemas"]

    assert schemas["SessionAccount"]["properties"]["email"]["type"] == [
        "string",
        "null",
    ]
    assert '{"type": "null"}' not in json.dumps(schemas)


def test_guest_limit_documents_retry_after() -> None:
    paths: dict[str, Any] = create_app().openapi()["paths"]

    for path in ("/v1/session", "/v1/auth/app-login"):
        too_many = paths[path]["post"]["responses"]["429"]
        assert too_many["headers"]["Retry-After"]["schema"] == {"type": "integer"}
        assert too_many["content"]["application/json"]["schema"] == {
            "$ref": "#/components/schemas/ErrorsResponse"
        }
