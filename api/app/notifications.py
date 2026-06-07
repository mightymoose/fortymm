"""Push notification device token registration and APNs send utilities."""

import asyncio
import logging
import os
import time
import uuid
from typing import Literal

import httpx
import jwt
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models.device_token import DeviceToken
from app.models.user import User
from app.sessions import get_current_user

log = logging.getLogger(__name__)
router = APIRouter()

_APNS_SANDBOX_HOST = "https://api.sandbox.push.apple.com"
_APNS_PROD_HOST = "https://api.push.apple.com"

# Persistent HTTP/2 clients, one per APNs host. APNs requires HTTP/2; keeping
# the connection alive lets multiple sends share the same TCP+TLS session.
_apns_clients: dict[str, httpx.AsyncClient] = {}


def _get_apns_client(host: str) -> httpx.AsyncClient:
    if host not in _apns_clients:
        _apns_clients[host] = httpx.AsyncClient(http2=True, base_url=host)
    return _apns_clients[host]


async def close_apns_clients() -> None:
    """Close all persistent APNs HTTP/2 clients. Call from the app lifespan."""
    for client in _apns_clients.values():
        await client.aclose()
    _apns_clients.clear()


# ---------------------------------------------------------------------------
# Device token registration
# ---------------------------------------------------------------------------


class RegisterDeviceTokenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str
    environment: Literal["development", "production"]


class RegisterDeviceTokenResponse(BaseModel):
    ok: bool


@router.post("/v1/device-tokens")
async def register_device_token(
    payload: RegisterDeviceTokenRequest,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> RegisterDeviceTokenResponse:
    """Upsert an APNs device token for the current user.

    The token is globally unique — if it was previously associated with a
    different user (e.g. after a re-install), this re-points it to the caller.
    """
    await db.execute(
        pg_insert(DeviceToken)
        .values(
            user_id=current_user.id,
            token=payload.token,
            environment=payload.environment,
        )
        .on_conflict_do_update(
            index_elements=["token"],
            set_={
                "user_id": current_user.id,
                "environment": payload.environment,
                "updated_at": func.now(),
            },
        )
    )
    await db.commit()
    return RegisterDeviceTokenResponse(ok=True)


# ---------------------------------------------------------------------------
# APNs sending
# ---------------------------------------------------------------------------


def _make_apns_jwt(key_pem: str, key_id: str, team_id: str) -> str:
    """Return a signed APNs provider auth token (ES256 JWT, valid ~1 hour)."""
    payload = {"iss": team_id, "iat": int(time.time())}
    return jwt.encode(payload, key_pem, algorithm="ES256", headers={"kid": key_id})


async def send_push_notification(
    *,
    device_token: str,
    environment: str,
    title: str,
    body: str,
) -> bool:
    """Send a single APNs alert push notification.

    Returns False if APNs reports the token is permanently invalid (410), so
    the caller can remove the stale row. Returns True for success or transient
    errors (the token itself is not at fault).

    Reads credentials from env vars:
      APNS_AUTH_KEY  — PEM contents of the .p8 key file
      APNS_KEY_ID    — 10-char key ID from Apple Developer portal
      APNS_TEAM_ID   — 10-char team ID
      APNS_BUNDLE_ID — app bundle ID (default: com.fortymm.ios-client)

    If any required credential is absent, logs a warning and returns True
    without sending — the app stays functional without APNs configured.
    """
    key_pem = os.environ.get("APNS_AUTH_KEY")
    key_id = os.environ.get("APNS_KEY_ID")
    team_id = os.environ.get("APNS_TEAM_ID")
    if key_pem is None or key_id is None or team_id is None:
        log.warning("APNs credentials not configured; skipping push notification")
        return True

    bundle_id = os.environ.get("APNS_BUNDLE_ID", "com.fortymm.ios-client")
    auth_token = _make_apns_jwt(key_pem, key_id, team_id)
    host = _APNS_SANDBOX_HOST if environment == "development" else _APNS_PROD_HOST
    headers = {
        "authorization": f"bearer {auth_token}",
        "apns-topic": bundle_id,
        "apns-push-type": "alert",
    }
    notification = {"aps": {"alert": {"title": title, "body": body}}}

    response = await _get_apns_client(host).post(
        f"/3/device/{device_token}", json=notification, headers=headers
    )
    if response.status_code == 410:
        log.warning("APNs token expired/unregistered: %s", device_token)
        return False
    if response.status_code != 200:
        log.warning("APNs request failed [%s]: %s", response.status_code, response.text)
    return True


async def send_push_to_user(
    *,
    db: AsyncSession,
    user_id: uuid.UUID,
    title: str,
    body: str,
) -> None:
    """Send a push notification to every registered device for a user.

    Tokens that APNs marks as permanently invalid (410) are deleted so they
    are not retried on future sends.
    """
    token_rows = list(
        await db.scalars(select(DeviceToken).where(DeviceToken.user_id == user_id))
    )
    if not token_rows:
        return
    results = await asyncio.gather(
        *(
            send_push_notification(
                device_token=row.token,
                environment=row.environment,
                title=title,
                body=body,
            )
            for row in token_rows
        )
    )
    stale = [row.token for row, ok in zip(token_rows, results, strict=True) if not ok]
    if stale:
        await db.execute(delete(DeviceToken).where(DeviceToken.token.in_(stale)))
        await db.commit()
