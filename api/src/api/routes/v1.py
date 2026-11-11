"""Version 1 of the API: every route under /v1. A new route module joins here, with its
paths written without the prefix."""

from fastapi import APIRouter

from api.routes import health, match_database
from api.routes.errors import InternalServerError, documented

# Any operation can fail with an unhandled exception, so every one documents the 500.
router = APIRouter(prefix="/v1", responses=documented(InternalServerError))
router.include_router(health.router)
router.include_router(match_database.router)
