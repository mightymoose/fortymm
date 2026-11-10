"""The error document every failing response uses, shaped after JSON:API's errors
document (https://jsonapi.org/format/#errors), with only the members we use:

    {"errors": [{"status": "503", "code": "database_unavailable", "title": "..."}]}

- status: the HTTP status code, as a string.
- code: an application-specific code a client can branch on, in snake_case.
- title: a short, human-readable summary that is the same for every occurrence.

No member carries occurrence-specific text (JSON:API's `detail`) yet: that is where
internals leak. Add `detail`, and `source` for request errors, when an endpoint has
something safe and useful to say there.

install() makes the errors FastAPI raises by itself (404, 405, unhandled exceptions)
come out in this shape too.
"""

from collections.abc import Mapping
from http import HTTPStatus

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.exceptions import HTTPException as StarletteHTTPException


class ErrorObject(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str
    code: str
    title: str


class ErrorDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    errors: list[ErrorObject] = Field(min_length=1)


def error_response(
    status_code: int,
    code: str | None = None,
    title: str | None = None,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    """A response carrying one error. Without a code or title, both come from the HTTP
    status: 404 gives code "not_found" and title "Not Found"."""
    status = HTTPStatus(status_code)
    error = ErrorObject(
        status=str(status.value),
        code=code or status.phrase.lower().replace(" ", "_").replace("-", "_"),
        title=title or status.phrase,
    )
    return JSONResponse(
        status_code=status_code,
        content=ErrorDocument(errors=[error]).model_dump(),
        headers=headers,
    )


async def _http_error(request: Request, exc: Exception) -> JSONResponse:
    # FastAPI's own 404 (no route) and 405 (wrong method); the Allow header is kept.
    assert isinstance(exc, StarletteHTTPException)
    return error_response(exc.status_code, headers=exc.headers)


async def _unhandled_error(request: Request, exc: Exception) -> JSONResponse:
    # The server still logs the traceback; the client learns only that it was ours.
    return error_response(HTTPStatus.INTERNAL_SERVER_ERROR)


def install(app: FastAPI) -> None:
    app.add_exception_handler(StarletteHTTPException, _http_error)
    app.add_exception_handler(Exception, _unhandled_error)
