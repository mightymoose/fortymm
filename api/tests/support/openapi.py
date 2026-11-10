from typing import Any

import httpx
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012


def assert_matches_documented_response(
    document: dict[str, Any], method: str, path: str, response: httpx.Response
) -> None:
    """Fail unless the OpenAPI document lists the response's status for this operation
    and the response's JSON body matches the schema it gives there."""
    code = str(response.status_code)
    documented = document["paths"][path][method]["responses"]
    assert code in documented, f"{method.upper()} {path} does not document status {code}"
    assert response.headers["content-type"] == "application/json"
    assert "application/json" in documented[code]["content"]

    escaped_path = path.replace("~", "~0").replace("/", "~1")
    pointer = f"/paths/{escaped_path}/{method}/responses/{code}/content/application~1json/schema"
    registry: Registry[Any] = Registry().with_resource(
        "urn:openapi", Resource.from_contents(document, default_specification=DRAFT202012)
    )
    validator = Draft202012Validator({"$ref": f"urn:openapi#{pointer}"}, registry=registry)
    validator.validate(response.json())
