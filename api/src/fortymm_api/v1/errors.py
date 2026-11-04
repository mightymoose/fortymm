"""The `errors` shape of every error the API answers itself, and the OpenAPI
entries that document it on each route."""

from math import ceil
from typing import Any

from fastapi.responses import JSONResponse
from pydantic import BaseModel

from fortymm_api.services.sessions import GuestAccountLimitReached

type Responses = dict[int | str, dict[str, Any]]


class Error(BaseModel):
    # The HTTP status, as a string, as JSON:API has it.
    status: str
    title: str


class ErrorsResponse(BaseModel):
    errors: list[Error]


def error_response(status: int, title: str) -> JSONResponse:
    body = ErrorsResponse(errors=[Error(status=str(status), title=title)])
    return JSONResponse(body.model_dump(), status_code=status)


def errors(status: int, description: str, **extra: Any) -> Responses:
    return {status: {"model": ErrorsResponse, "description": description, **extra}}


NO_SESSION = errors(401, "The request has no valid session")
FORBIDDEN = errors(
    403, "The account's roles don't grant the permission the route needs"
)
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


def retry_after_seconds(error: GuestAccountLimitReached) -> int:
    """The whole seconds until the network can start more guest accounts, at
    least 1. The 429's Retry-After and a rate-limited web login's
    `retry_after` both give it."""
    return max(1, ceil(error.retry_after.total_seconds()))


NO_PROVIDER = errors(503, "The API has no identity provider configured")
