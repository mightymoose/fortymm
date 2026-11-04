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


def test_the_logout_body_is_optional_with_no_null_branch() -> None:
    """swift-openapi-generator skips a request body that is `anyOf` with
    `null`, so the iOS app couldn't send `signing_key_id`."""
    paths: dict[str, Any] = create_app().openapi()["paths"]

    body = paths["/v1/auth/logout"]["post"]["requestBody"]
    assert body.get("required", False) is False
    assert body["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/LogoutRequest"
    }


def test_a_route_with_an_optional_session_allows_anonymous_access() -> None:
    """Without the empty requirement, OpenAPI reads the session as required,
    and oasdiff reports a break for a route that never needed one."""
    paths: dict[str, Any] = create_app().openapi()["paths"]

    for path in (
        "/v1/matches/{match_id}/boards",
        "/v1/matches/{match_id}/approvals",
    ):
        assert paths[path]["post"]["security"] == [{"session": []}, {}]
