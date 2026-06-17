"""Domain + data logic for notifications: device-token registration, test
pushes, the persisted in-app feed, per-channel/per-category preferences, and
admin broadcast.

Plain class wired by ``notifications/dependencies.py`` — no FastAPI imports
(api/CLAUDE.md service-layer rules). It raises ``PushNotConfiguredError`` rather
than an ``HTTPException`` so the HTTP mapping stays in the router.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, assert_never, cast

from sqlalchemy import CursorResult, delete, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app import queue as queue_module
from app.models import (
    DeviceToken,
    Notification,
    NotificationChannelSetting,
    NotificationPreference,
    User,
)
from app.notifications.apns import Environment, PushSender, SendOutcome
from app.notifications.taxonomy import (
    CHANNEL_AVAILABLE,
    LOCKED_CELLS,
    LOCKED_CHANNELS,
    NotificationCategory,
    NotificationChannel,
    cell_default,
    channel_default,
    resolve_cell_enabled,
    resolve_channel_enabled,
)
from app.players import escape_like
from app.schemas.notification import (
    BroadcastRecipient,
    BroadcastRecipientList,
    BroadcastResponse,
    MarkAllReadResponse,
    NotificationCategoryCell,
    NotificationCategoryPreference,
    NotificationChannelState,
    NotificationFeed,
    NotificationItem,
    NotificationPreferences,
    NotificationPreferencesUpdate,
    RegisterDeviceTokenRequest,
    TestNotificationResponse,
    UnreadCountResponse,
)

log = logging.getLogger(__name__)

_TEST_TITLE = "FortyMM"
_TEST_BODY = "🏓 Test notification — your push setup is working."

# The bell dropdown and the notifications page both read this feed; cap it so a
# long-running account doesn't ship thousands of rows. The unread *count* is a
# separate aggregate, so the badge stays accurate past the cap.
FEED_LIMIT = 50
# Recipient picker cap — fortymm's player base is small; this keeps the
# typeahead snappy while ``total`` still reports the true match count.
RECIPIENT_LIMIT = 50

# Admin broadcasts are filed as tournament news, so a player's tournament-news
# preferences decide which channels actually reach them.
BROADCAST_CATEGORY = NotificationCategory.TOURNAMENT


class PushNotConfiguredError(Exception):
    """Raised when a push is requested but no APNs credentials are configured.
    The router maps this to a 503."""


@dataclass
class NotifyResult:
    """What a single ``notify`` call delivered, for broadcast aggregation."""

    in_app_created: bool = False
    pushed: int = 0
    emailed: bool = False


def _as_environment(value: str) -> Environment | None:
    if value == "sandbox":
        return "sandbox"
    if value == "production":
        return "production"
    return None


def _parse_channel(value: str) -> NotificationChannel | None:
    try:
        return NotificationChannel(value)
    except ValueError:
        return None


class NotificationService:
    def __init__(self, db: AsyncSession, sender: PushSender) -> None:
        self._db = db
        self._sender = sender

    # ----- device tokens (unchanged) ---------------------------------------

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
        because this environment has no push credentials.

        ``category``/``data`` here are the *APNs* category (action group) and
        payload — distinct from the notification taxonomy category."""
        if not self._sender.is_configured:
            return 0
        tokens = await self._tokens_for_user(user_id)
        sent, _ = await self._fan_out(
            tokens, title=title, body=body, category=category, data=data
        )
        return sent

    # ----- the high-level "notify a user" primitive ------------------------

    async def notify(
        self,
        *,
        user_id: uuid.UUID,
        category: NotificationCategory,
        title: str,
        body: str,
        link: str | None = None,
        action_label: str | None = None,
        delta: str | None = None,
        channels: Collection[NotificationChannel] | None = None,
        push_category: str | None = None,
        push_data: Mapping[str, str] | None = None,
    ) -> NotifyResult:
        """Deliver one notification to one user across every channel the user's
        preferences allow (intersected with ``channels`` when the caller
        restricts the candidates, e.g. an admin broadcast).

        The in-app channel persists a ``Notification`` row — the durable record
        the bell/feed read. Push reuses ``send_to_user`` (best-effort) and email
        enqueues an RQ job (best-effort). A missing or tombstoned recipient is a
        no-op."""
        user = await self._db.get(User, user_id)
        if user is None or user.merged_into_user_id is not None:
            return NotifyResult()

        candidates = set(channels) if channels is not None else set(NotificationChannel)
        effective = await self._effective_channels(user_id, category, candidates)
        result = NotifyResult()

        if NotificationChannel.IN_APP in effective:
            self._db.add(
                Notification(
                    user_id=user_id,
                    category=category.value,
                    title=title,
                    body=body,
                    link=link,
                    action_label=action_label,
                    delta=delta,
                )
            )
            await self._db.commit()
            result.in_app_created = True

        if NotificationChannel.PUSH in effective:
            result.pushed = await self.send_to_user(
                user_id,
                title=title,
                body=body,
                category=push_category,
                data=push_data,
            )

        if (
            NotificationChannel.EMAIL in effective
            and user.email
            and user.confirmed_at is not None
        ):
            if self._enqueue_notification_email(user.email, title, body, link):
                result.emailed = True

        return result

    def _enqueue_notification_email(
        self, to_email: str, title: str, body: str, link: str | None
    ) -> bool:
        """Fire-and-forget the notification email. A Redis hiccup must not fail
        the originating flow, so enqueue failures are logged and swallowed
        (mirrors ``app.sessions._enqueue_rating_recompute_after_merge``)."""
        try:
            queue_module.get_email_queue().enqueue(
                "app.email.send_notification_email",
                to_email,
                title,
                body,
                link,
                result_ttl=60,
                failure_ttl=300,
            )
        except Exception:
            log.exception("Failed to enqueue notification email")
            return False
        return True

    # ----- the in-app feed -------------------------------------------------

    async def list_feed(self, user_id: uuid.UUID) -> NotificationFeed:
        """The most recent notifications (capped) plus the live unread total."""
        rows = (
            (
                await self._db.execute(
                    select(Notification)
                    .where(Notification.user_id == user_id)
                    .order_by(Notification.created_at.desc())
                    .limit(FEED_LIMIT)
                )
            )
            .scalars()
            .all()
        )
        unread = await self._unread_count(user_id)
        return NotificationFeed(
            items=[NotificationItem.model_validate(row) for row in rows],
            unread_count=unread,
        )

    async def unread_count(self, user_id: uuid.UUID) -> UnreadCountResponse:
        return UnreadCountResponse(unread_count=await self._unread_count(user_id))

    async def _unread_count(self, user_id: uuid.UUID) -> int:
        return int(
            (
                await self._db.execute(
                    select(func.count(Notification.id)).where(
                        Notification.user_id == user_id,
                        Notification.read_at.is_(None),
                    )
                )
            ).scalar_one()
        )

    async def mark_read(
        self, user_id: uuid.UUID, notification_id: uuid.UUID
    ) -> NotificationItem | None:
        """Mark one notification read. Scoped to the owner — returns ``None``
        (router → 404) for a notification that isn't theirs or doesn't exist.
        Idempotent: re-marking an already-read row is a no-op."""
        notification = (
            await self._db.execute(
                select(Notification).where(
                    Notification.id == notification_id,
                    Notification.user_id == user_id,
                )
            )
        ).scalar_one_or_none()
        if notification is None:
            return None
        if notification.read_at is None:
            notification.read_at = datetime.now(UTC)
            await self._db.commit()
            await self._db.refresh(notification)
        return NotificationItem.model_validate(notification)

    async def mark_all_read(self, user_id: uuid.UUID) -> MarkAllReadResponse:
        result = await self._db.execute(
            update(Notification)
            .where(
                Notification.user_id == user_id,
                Notification.read_at.is_(None),
            )
            .values(read_at=datetime.now(UTC))
        )
        await self._db.commit()
        return MarkAllReadResponse(marked=cast(CursorResult[Any], result).rowcount or 0)

    # ----- preferences -----------------------------------------------------

    async def get_preferences(self, user: User) -> NotificationPreferences:
        channel_overrides = await self._channel_overrides(user.id)
        cell_overrides = await self._cell_overrides(user.id)
        device_count = await self._device_count(user.id)
        return self._build_preferences(
            user, channel_overrides, cell_overrides, device_count
        )

    async def update_preferences(
        self, user: User, update_req: NotificationPreferencesUpdate
    ) -> NotificationPreferences:
        """Apply a partial update, storing only values that differ from the
        default (and deleting overrides that fall back to the default).
        Locked/unavailable channels and cells are ignored — the user can't
        change them. Returns the freshly re-resolved preferences."""
        for channel_update in update_req.channels:
            channel = channel_update.channel
            if channel in LOCKED_CHANNELS or not CHANNEL_AVAILABLE[channel]:
                continue
            await self._set_channel_override(user.id, channel, channel_update.enabled)
        for cell_update in update_req.cells:
            cell = (cell_update.category, cell_update.channel)
            if cell in LOCKED_CELLS or not CHANNEL_AVAILABLE[cell_update.channel]:
                continue
            await self._set_cell_override(
                user.id, cell_update.category, cell_update.channel, cell_update.enabled
            )
        await self._db.commit()
        return await self.get_preferences(user)

    async def _set_channel_override(
        self, user_id: uuid.UUID, channel: NotificationChannel, enabled: bool
    ) -> None:
        # Storing the default is the same as having no row — keep the table
        # sparse so "reset to default" is a delete, not a row that drifts.
        if enabled == channel_default(channel):
            await self._db.execute(
                delete(NotificationChannelSetting).where(
                    NotificationChannelSetting.user_id == user_id,
                    NotificationChannelSetting.channel == channel.value,
                )
            )
            return
        stmt = insert(NotificationChannelSetting).values(
            user_id=user_id, channel=channel.value, enabled=enabled
        )
        await self._db.execute(
            stmt.on_conflict_do_update(
                constraint="uq_notification_channel_settings_user_channel",
                set_={"enabled": enabled, "updated_at": func.now()},
            )
        )

    async def _set_cell_override(
        self,
        user_id: uuid.UUID,
        category: NotificationCategory,
        channel: NotificationChannel,
        enabled: bool,
    ) -> None:
        if enabled == cell_default(category, channel):
            await self._db.execute(
                delete(NotificationPreference).where(
                    NotificationPreference.user_id == user_id,
                    NotificationPreference.category == category.value,
                    NotificationPreference.channel == channel.value,
                )
            )
            return
        stmt = insert(NotificationPreference).values(
            user_id=user_id,
            category=category.value,
            channel=channel.value,
            enabled=enabled,
        )
        await self._db.execute(
            stmt.on_conflict_do_update(
                constraint="uq_notification_preferences_user_category_channel",
                set_={"enabled": enabled, "updated_at": func.now()},
            )
        )

    def _build_preferences(
        self,
        user: User,
        channel_overrides: dict[NotificationChannel, bool],
        cell_overrides: dict[tuple[NotificationCategory, NotificationChannel], bool],
        device_count: int,
    ) -> NotificationPreferences:
        channels = [
            NotificationChannelState(
                channel=channel,
                enabled=resolve_channel_enabled(
                    channel, channel_overrides.get(channel)
                ),
                available=CHANNEL_AVAILABLE[channel],
                locked=channel in LOCKED_CHANNELS,
                destination=self._channel_destination(channel, user, device_count),
            )
            for channel in NotificationChannel
        ]
        categories = [
            NotificationCategoryPreference(
                category=category,
                cells=[
                    NotificationCategoryCell(
                        channel=channel,
                        enabled=resolve_cell_enabled(
                            category, channel, cell_overrides.get((category, channel))
                        ),
                        locked=(category, channel) in LOCKED_CELLS,
                    )
                    for channel in NotificationChannel
                ],
            )
            for category in NotificationCategory
        ]
        return NotificationPreferences(channels=channels, categories=categories)

    @staticmethod
    def _channel_destination(
        channel: NotificationChannel, user: User, device_count: int
    ) -> str:
        # Exhaustive match (no catch-all): adding a channel becomes a mypy error
        # at the assert_never, per api/CLAUDE.md's enum-mapping rule.
        match channel:
            case NotificationChannel.IN_APP:
                return "Always on, in your feed"
            case NotificationChannel.PUSH:
                if device_count == 0:
                    return "No devices yet — open the app"
                return f"{device_count} device{'s' if device_count != 1 else ''}"
            case NotificationChannel.EMAIL:
                if user.email and user.confirmed_at is not None:
                    return user.email
                return "Add an email in settings"
            case NotificationChannel.SMS:
                return "Not available yet"
        assert_never(channel)

    async def _channel_overrides(
        self, user_id: uuid.UUID
    ) -> dict[NotificationChannel, bool]:
        rows = (
            (
                await self._db.execute(
                    select(NotificationChannelSetting).where(
                        NotificationChannelSetting.user_id == user_id
                    )
                )
            )
            .scalars()
            .all()
        )
        overrides: dict[NotificationChannel, bool] = {}
        for row in rows:
            channel = _parse_channel(row.channel)
            if channel is not None:
                overrides[channel] = row.enabled
        return overrides

    async def _cell_overrides(
        self, user_id: uuid.UUID, category: NotificationCategory | None = None
    ) -> dict[tuple[NotificationCategory, NotificationChannel], bool]:
        query = select(NotificationPreference).where(
            NotificationPreference.user_id == user_id
        )
        if category is not None:
            query = query.where(NotificationPreference.category == category.value)
        rows = (await self._db.execute(query)).scalars().all()
        overrides: dict[tuple[NotificationCategory, NotificationChannel], bool] = {}
        for row in rows:
            channel = _parse_channel(row.channel)
            parsed_category = _parse_category(row.category)
            if channel is not None and parsed_category is not None:
                overrides[(parsed_category, channel)] = row.enabled
        return overrides

    async def _effective_channels(
        self,
        user_id: uuid.UUID,
        category: NotificationCategory,
        candidates: Collection[NotificationChannel],
    ) -> set[NotificationChannel]:
        channel_overrides = await self._channel_overrides(user_id)
        cell_overrides = await self._cell_overrides(user_id, category)
        effective: set[NotificationChannel] = set()
        for channel in candidates:
            master = resolve_channel_enabled(channel, channel_overrides.get(channel))
            cell = resolve_cell_enabled(
                category, channel, cell_overrides.get((category, channel))
            )
            if master and cell:
                effective.add(channel)
        return effective

    async def _device_count(self, user_id: uuid.UUID) -> int:
        return int(
            (
                await self._db.execute(
                    select(func.count(DeviceToken.id)).where(
                        DeviceToken.user_id == user_id
                    )
                )
            ).scalar_one()
        )

    # ----- admin broadcast -------------------------------------------------

    async def broadcast(
        self,
        *,
        all_users: bool,
        user_ids: Sequence[uuid.UUID],
        channels: Collection[NotificationChannel],
        title: str,
        body: str,
    ) -> BroadcastResponse:
        """Fan a tournament-news notification out to the chosen recipients,
        respecting each player's preferences. Counts users (not devices) who
        actually got each delivery kind after preference filtering."""
        targets = await self._broadcast_targets(all_users, user_ids)
        in_app = pushed = emailed = 0
        for target in targets:
            result = await self.notify(
                user_id=target.id,
                category=BROADCAST_CATEGORY,
                title=title,
                body=body,
                channels=channels,
            )
            in_app += int(result.in_app_created)
            pushed += int(result.pushed > 0)
            emailed += int(result.emailed)
        return BroadcastResponse(
            recipients=len(targets),
            in_app_created=in_app,
            pushed=pushed,
            emailed=emailed,
        )

    async def _broadcast_targets(
        self, all_users: bool, user_ids: Sequence[uuid.UUID]
    ) -> Sequence[User]:
        query = select(User).where(User.merged_into_user_id.is_(None))
        if not all_users:
            if not user_ids:
                return []
            query = query.where(User.id.in_(user_ids))
        return (await self._db.execute(query)).scalars().all()

    async def list_recipients(self, query_text: str | None) -> BroadcastRecipientList:
        """Players the admin can target, filtered by username substring. Returns
        a capped list plus the true total so "select all" reports the real
        audience size."""
        base = select(User).where(User.merged_into_user_id.is_(None))
        if query_text:
            pattern = f"%{escape_like(query_text)}%"
            base = base.where(User.username.ilike(pattern, escape="\\"))
        total = int(
            (
                await self._db.execute(
                    select(func.count()).select_from(base.subquery())
                )
            ).scalar_one()
        )
        rows = (
            (
                await self._db.execute(
                    base.order_by(User.username).limit(RECIPIENT_LIMIT)
                )
            )
            .scalars()
            .all()
        )
        return BroadcastRecipientList(
            recipients=[BroadcastRecipient.model_validate(row) for row in rows],
            total=total,
        )

    # ----- internals (push fan-out) ----------------------------------------

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


def _parse_category(value: str) -> NotificationCategory | None:
    try:
        return NotificationCategory(value)
    except ValueError:
        return None
