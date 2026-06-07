"""Domain + data logic for device-token registration and test pushes.

Plain class wired by ``notifications/dependencies.py`` — no FastAPI imports
(api/CLAUDE.md service-layer rules). It raises ``PushNotConfiguredError`` rather
than an ``HTTPException`` so the HTTP mapping stays in the router.
"""

from __future__ import annotations

import uuid

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import DeviceToken, User
from app.notifications.apns import Environment, PushSender, SendOutcome
from app.schemas.notification import (
    RegisterDeviceTokenRequest,
    TestNotificationResponse,
)

_TEST_TITLE = "FortyMM"
_TEST_BODY = "🏓 Test notification — your push setup is working."


class PushNotConfiguredError(Exception):
    """Raised when a push is requested but no APNs credentials are configured.
    The router maps this to a 503."""


def _as_environment(value: str) -> Environment | None:
    if value == "sandbox":
        return "sandbox"
    if value == "production":
        return "production"
    return None


class NotificationService:
    def __init__(self, db: AsyncSession, sender: PushSender) -> None:
        self._db = db
        self._sender = sender

    async def register_device_token(
        self, user: User, req: RegisterDeviceTokenRequest
    ) -> None:
        """Upsert keyed on the globally-unique APNs token: a device that has
        since signed into a different account re-points to the new owner rather
        than creating a duplicate row."""
        stmt = insert(DeviceToken).values(
            token=req.token,
            platform=req.platform,
            environment=req.environment,
            user_id=user.id,
        )
        stmt = stmt.on_conflict_do_update(
            constraint="uq_device_tokens_token",
            set_={
                "user_id": user.id,
                "platform": req.platform,
                "environment": req.environment,
                "updated_at": func.now(),
            },
        )
        await self._db.execute(stmt)
        await self._db.commit()

    async def send_test_notification(self, user: User) -> TestNotificationResponse:
        """Fan a test push out to every device the user has registered, pruning
        any token APNs reports as gone. Raises ``PushNotConfiguredError`` if no
        credentials are set; returns ``sent=0`` (not an error) if the user has
        no registered devices."""
        if not self._sender.is_configured:
            raise PushNotConfiguredError

        rows = await self._db.execute(
            select(DeviceToken).where(DeviceToken.user_id == user.id)
        )
        tokens = rows.scalars().all()

        sent = 0
        gone_ids: list[uuid.UUID] = []
        for device in tokens:
            environment = _as_environment(device.environment)
            if environment is None:
                continue
            result = await self._sender.send(
                device.token,
                environment=environment,
                title=_TEST_TITLE,
                body=_TEST_BODY,
            )
            if result.outcome is SendOutcome.SUCCESS:
                sent += 1
            elif result.outcome is SendOutcome.GONE:
                gone_ids.append(device.id)

        if gone_ids:
            await self._db.execute(
                delete(DeviceToken).where(DeviceToken.id.in_(gone_ids))
            )
            await self._db.commit()

        return TestNotificationResponse(sent=sent, pruned=len(gone_ids))
