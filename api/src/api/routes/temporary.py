"""The mark for a temporary endpoint: one that will be removed or changed without notice,
such as a stand-in used while the real thing is built.

    @router.post("/match-database/apply", openapi_extra=TEMPORARY, ...)

It puts `x-stability-level: draft` on the operation in the OpenAPI document. oasdiff,
which api:openapi-breaking runs, reports no breaking change for a draft operation, so
removing or changing one never fails that check, while every unmarked operation is still
checked. The operation stays in api/openapi.json, so web-client's types still cover it.

Mark an endpoint temporary only if no client may depend on it beyond the next change.
"""

from typing import Any, Final

TEMPORARY: Final[dict[str, Any]] = {"x-stability-level": "draft"}
