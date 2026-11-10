"""Version 1 of the API: every route under /v1. A new route module joins here, with its
paths written without the prefix."""

from fastapi import APIRouter

from api.routes import health

router = APIRouter(prefix="/v1")
router.include_router(health.router)
