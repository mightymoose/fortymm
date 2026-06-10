"""Domain + data logic for device-token registration and test pushes.

Plain class wired by ``notifications/dependencies.py`` — no FastAPI imports
(api/CLAUDE.md service-layer rules). It raises ``PushNotConfiguredError`` rather
than an ``HTTPException`` so the HTTP mapping stays in the router.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence

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

        tokens = await self._tokens_for_user(user.id)
        sent, pruned = await self._fan_out(tokens, title=_TEST_TITLE, body=_TEST_BODY)
        return TestNotificationResponse(sent=sent, pruned=pruned)

    async def send_to_user(
        self,
        user_id: uuid.UUID,
        *,
        title: str,
        body: str,
        category: str | None = None,
        data: Mapping[str, str] | None = None,
    ) -> int:
        """Best-effort push to every device a user has registered. Returns the
        number APNs accepted and prunes any gone tokens as a side effect.

        Unlike ``send_test_notification`` this **silently no-ops** (returns 0)
        when APNs isn't configured: an event-driven push fired from another
        flow (e.g. a posted match result) must never fail that flow just
        because this environment has no push credentials."""
        if not self._sender.is_configured:
            return 0
        tokens = await self._tokens_for_user(user_id)
        sent, _ = await self._fan_out(
            tokens, title=title, body=body, category=category, data=data
        )
        return sent

    async def _tokens_for_user(self, user_id: uuid.UUID) -> Sequence[DeviceToken]:
        rows = await self._db.execute(
            select(DeviceToken).where(DeviceToken.user_id == user_id)
        )
        return rows.scalars().all()

    async def _fan_out(
        self,
        tokens: Sequence[DeviceToken],
        *,
        title: str,
        body: str,
        category: str | None = None,
        data: Mapping[str, str] | None = None,
    ) -> tuple[int, int]:
        """Send one push per token, returning ``(sent, pruned)``. Tokens APNs
        reports as gone are deleted in a single statement."""
        sent = 0
        gone_ids: list[uuid.UUID] = []
        for device in tokens:
            environment = _as_environment(device.environment)
            if environment is None:
                continue
            result = await self._sender.send(
                device.token,
                environment=environment,
                title=title,
                body=body,
                category=category,
                data=data,
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

        return sent, len(gone_ids)
