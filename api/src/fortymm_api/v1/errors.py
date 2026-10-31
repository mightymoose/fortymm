"""The `errors` shape of every error the API answers itself, and the OpenAPI
entries that document it on each route."""

from typing import Any

from pydantic import BaseModel

type Responses = dict[int | str, dict[str, Any]]


class Error(BaseModel):
    # The HTTP status, as a string, as JSON:API has it.
    status: str
    title: str


class ErrorsResponse(BaseModel):
    errors: list[Error]


def errors(status: int, description: str, **extra: Any) -> Responses:
    return {status: {"model": ErrorsResponse, "description": description, **extra}}


NO_SESSION = errors(401, "The request has no valid session")
UNSUPPORTED_MEDIA_TYPE = errors(
    415, "The request's Content-Type isn't application/json"
)
GUEST_LIMIT = errors(
    429,
    "The client's network started too many guest accounts. "
    "Retry-After gives the seconds until it can start more.",
    headers={
        "Retry-After": {
            "description": "The seconds until the network can start more",
            "schema": {"type": "integer"},
        }
    },
)
NO_PROVIDER = errors(503, "The API has no identity provider configured")
