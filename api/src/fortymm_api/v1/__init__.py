"""Version 1 of the API, served under `/v1`."""

from fastapi import APIRouter

from fortymm_api.v1 import (
    admin,
    auth,
    health,
    matches,
    players,
    session,
    signing_keys,
)

router = APIRouter(prefix="/v1")
router.include_router(health.router)
router.include_router(session.router)
router.include_router(auth.router)
router.include_router(players.router)
router.include_router(signing_keys.router)
router.include_router(matches.router)
router.include_router(admin.router)
