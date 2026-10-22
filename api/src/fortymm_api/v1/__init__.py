"""Version 1 of the API, served under `/v1`."""

from fastapi import APIRouter

from fortymm_api.v1 import health

router = APIRouter(prefix="/v1")
router.include_router(health.router)
