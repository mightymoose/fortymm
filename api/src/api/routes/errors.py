"""The error document every failing response uses, shaped after JSON:API's errors
document (https://jsonapi.org/format/#errors), with only the members we use:

    {"errors": [{"status": "503", "code": "database_unavailable", "title": "..."}]}

- status: the HTTP status code, as a string.
- code: an application-specific code a client can branch on, in snake_case.
- title: a short, human-readable summary that is the same for every occurrence.

Each error is a subclass of ErrorObject that pins all three to constants, so the OpenAPI
document says exactly what a client gets:

    class DatabaseUnavailableError(ErrorObject):
        status: Literal["503"] = "503"
        code: Literal["database_unavailable"] = "database_unavailable"
        title: Literal["The database did not answer"] = "The database did not answer"

A route declares it with `responses=documented(DatabaseUnavailableError)` and sends it
with `error_response(DatabaseUnavailableError())`, so the document and the response come
from the same class.

No member carries occurrence-specific text (JSON:API's `detail`) yet: that is where
internals leak. Add `detail`, and `source` for request errors, when an endpoint has
something safe and useful to say there.

install() makes the errors FastAPI raises by itself (404, 405, unhandled exceptions)
come out in this shape too.
"""

import functools
from collections.abc import Mapping
from http import HTTPStatus
from typing import Any, Literal

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, create_model
from starlette.exceptions import HTTPException as StarletteHTTPException


class ErrorObject(BaseModel):
    # The shape every error shares. Subclass it, with constants, for each error.

    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)

    status: str
    code: str
    title: str


class ErrorDocument(BaseModel):
    # The document every error goes out in. error_document() narrows it per error.

    model_config = ConfigDict(extra="forbid")

    errors: list[ErrorObject] = Field(min_length=1)


@functools.cache
def error_document(error: type[ErrorObject]) -> type[ErrorDocument]:
    """ErrorDocument holding this error: DatabaseUnavailableError gives the schema
    DatabaseUnavailableErrorDocument. Both the OpenAPI document and the response use it."""
    document: type[ErrorDocument] = create_model(
        f"{error.__name__}Document",
        __base__=ErrorDocument,
        __module__=error.__module__,
        errors=(list[error], Field(min_length=1)),  # type: ignore[valid-type]
    )
    return document


class NotFoundError(ErrorObject):
    status: Literal["404"] = "404"
    code: Literal["not_found"] = "not_found"
    title: Literal["Not Found"] = "Not Found"


class MethodNotAllowedError(ErrorObject):
    status: Literal["405"] = "405"
    code: Literal["method_not_allowed"] = "method_not_allowed"
    title: Literal["Method Not Allowed"] = "Method Not Allowed"


class InternalServerError(ErrorObject):
    status: Literal["500"] = "500"
    code: Literal["internal_server_error"] = "internal_server_error"
    title: Literal["Internal Server Error"] = "Internal Server Error"


def documented(*errors: type[ErrorObject]) -> dict[int | str, dict[str, Any]]:
    """The `responses=` entries that declare these errors in the OpenAPI document, one per
    status. Each one's description is the error's title."""
    responses: dict[int | str, dict[str, Any]] = {}
    for error in errors:
        status = int(error.model_fields["status"].default)
        if status in responses:
            raise ValueError(f"Two documented errors share status {status}")
        responses[status] = {
            "model": error_document(error),
            "description": error.model_fields["title"].default,
        }
    return responses


def error_response(error: ErrorObject, headers: Mapping[str, str] | None = None) -> JSONResponse:
    """The response carrying this one error, with its status, serialized by the same
    document class that documented() declares for it."""
    return JSONResponse(
        status_code=int(error.status),
        content=error_document(type(error))(errors=[error]).model_dump(),
        headers=headers,
    )


_FRAMEWORK_ERRORS: dict[int, ErrorObject] = {404: NotFoundError(), 405: MethodNotAllowedError()}


async def _http_error(request: Request, exc: Exception) -> JSONResponse:
    # FastAPI's own 404 (no route) and 405 (wrong method); the Allow header is kept.
    assert isinstance(exc, StarletteHTTPException)
    error = _FRAMEWORK_ERRORS.get(exc.status_code)
    if error is None:
        # Any other status Starlette raises: the same shape, from its HTTP phrase.
        status = HTTPStatus(exc.status_code)
        error = ErrorObject(
            status=str(status.value),
            code=status.phrase.lower().replace(" ", "_").replace("-", "_"),
            title=status.phrase,
        )
    return error_response(error, headers=exc.headers)


async def _unhandled_error(request: Request, exc: Exception) -> JSONResponse:
    # The server still logs the traceback; the client learns only that it was ours.
    return error_response(InternalServerError())


def install(app: FastAPI) -> None:
    app.add_exception_handler(StarletteHTTPException, _http_error)
    app.add_exception_handler(Exception, _unhandled_error)
