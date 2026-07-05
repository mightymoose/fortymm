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

from sqlalchemy import ColumnElement, CursorResult, delete, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app import queue as queue_module
from app.models import (
    DeviceToken,
    Notification,
    NotificationChannelSetting,
    NotificationPreference,
    NotificationType,
    User,
)
from app.models import NotificationChannel as NotificationChannelModel
from app.notifications.apns import Environment, PushSender, SendOutcome
from app.notifications.taxonomy import (
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
    MarkReadRequest,
    NotificationCategoryCell,
    NotificationCategoryPreference,
    NotificationChannelInfo,
    NotificationChannelState,
    NotificationFeed,
    NotificationItem,
    NotificationJob,
    NotificationPreferences,
    NotificationPreferencesUpdate,
    NotificationTaxonomy,
    NotificationTypeInfo,
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
        # The notification_types / notification_channels lookup tables are
        # deploy-stable (never written at runtime), and the service is
        # request-scoped, so load each once and reuse it for the request — a
        # broadcast to N recipients otherwise re-queries the same tiny tables N
        # times via _effective_channels.
        self._type_rows: Sequence[NotificationType] | None = None
        self._channel_rows: Sequence[NotificationChannelModel] | None = None

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
        push_category: str | None = None,
        push_data: Mapping[str, str] | None = None,
    ) -> NotifyResult:
        """Deliver one notification to one user across every channel the user's
        preferences allow for the notification's category.

        Runs in the RQ worker (enqueued via ``enqueue_notification`` /
        ``enqueue_broadcast``). The in-app channel persists a ``Notification``
        row — the durable record the bell/feed read. Push reuses ``send_to_user``
        (best-effort) and email enqueues an RQ job (best-effort). A missing or
        tombstoned recipient is a no-op."""
        user = await self._db.get(User, user_id)
        if user is None or user.merged_into_user_id is not None:
            return NotifyResult()

        effective = await self._effective_channels(
            user_id, category, set(NotificationChannel)
        )
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
            # Push is best-effort and must never sink the whole notification:
            # the in-app row above is already committed, and the email below
            # still needs to enqueue. The APNs client already self-guards its
            # own send (a bad auth key returns FAILED rather than raising, see
            # apns.py), so the residual raiser on this path is a DB error from
            # the device-token query or the gone-token prune — catch that
            # specifically (not a bare Exception, which would also swallow the
            # programmer errors we want to surface) so a Redis/DB flap can't
            # drop the email (#753). Roll back so the failed push transaction
            # doesn't taint the session for the email enqueue below.
            try:
                result.pushed = await self.send_to_user(
                    user_id,
                    title=title,
                    body=body,
                    category=push_category,
                    data=push_data,
                )
            except SQLAlchemyError:
                await self._db.rollback()
                log.exception(
                    "Push delivery failed; continuing with remaining channels",
                    extra={"user_id": str(user_id), "category": category.value},
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

    # ----- enqueueing background delivery ----------------------------------

    def enqueue_notification(self, job: NotificationJob) -> bool:
        """Hand one notification to the worker, which resolves the recipient's
        preferences and delivers (see ``app.notifications.jobs``). Fire-and-
        forget: a Redis hiccup must not fail the originating flow, so enqueue
        failures are logged and swallowed (mirrors ``_enqueue_notification_email``)."""
        # Imported lazily (not at module level) because app.notifications.jobs
        # imports this service — a top-level import would be a cycle. The
        # function-level import keeps the job name a single source of truth.
        from app.notifications.jobs import DELIVER_NOTIFICATION_JOB

        try:
            queue_module.get_notifications_queue().enqueue(
                DELIVER_NOTIFICATION_JOB,
                job.model_dump_json(),
                result_ttl=60,
                failure_ttl=300,
            )
        except Exception:
            log.exception("Failed to enqueue notification delivery")
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

    async def _mark_read_where(
        self, *conditions: ColumnElement[bool]
    ) -> MarkAllReadResponse:
        """Stamp ``read_at`` on every notification matching ``conditions`` in one
        statement; ``marked`` is how many rows actually flipped. Shared by the
        batch and mark-all endpoints — callers supply the owner/unread scoping."""
        result = await self._db.execute(
            update(Notification).where(*conditions).values(read_at=datetime.now(UTC))
        )
        await self._db.commit()
        return MarkAllReadResponse(marked=cast(CursorResult[Any], result).rowcount or 0)

    async def mark_many_read(
        self, user_id: uuid.UUID, payload: MarkReadRequest
    ) -> MarkAllReadResponse:
        """Mark a batch of notifications read in one statement. Scoped to the
        owner and to still-unread rows, so ids that aren't theirs, don't exist,
        or are already read are silently skipped — ``marked`` reports how many
        rows actually flipped. Lets the client coalesce many on-screen rows into
        a single round-trip."""
        return await self._mark_read_where(
            Notification.user_id == user_id,
            Notification.id.in_(payload.ids),
            Notification.read_at.is_(None),
        )

    async def mark_all_read(self, user_id: uuid.UUID) -> MarkAllReadResponse:
        return await self._mark_read_where(
            Notification.user_id == user_id,
            Notification.read_at.is_(None),
        )

    # ----- display taxonomy (DB-backed labels + order) ---------------------

    async def get_taxonomy(self) -> NotificationTaxonomy:
        """The shared display taxonomy: the ordered category/channel lists with
        their labels, read from the lookup tables. Every notification surface
        (preferences, feed filters, broadcast) renders from this."""
        type_rows = await self._load_type_rows()
        channel_rows = await self._load_channel_rows()
        types = [
            NotificationTypeInfo(
                key=category,
                label=row.name,
                short=row.short_label,
                description=row.description,
            )
            for row in type_rows
            if (category := _parse_category(row.key)) is not None
        ]
        channels = [
            NotificationChannelInfo(
                key=channel,
                label=row.name,
                available=row.is_available,
                description=row.description,
            )
            for row in channel_rows
            if (channel := _parse_channel(row.key)) is not None
        ]
        return NotificationTaxonomy(types=types, channels=channels)

    async def _load_type_rows(self) -> Sequence[NotificationType]:
        """Active notification-type rows in display order (cached per request)."""
        if self._type_rows is None:
            self._type_rows = (
                (
                    await self._db.execute(
                        select(NotificationType)
                        .where(NotificationType.is_active.is_(True))
                        .order_by(NotificationType.display_order)
                    )
                )
                .scalars()
                .all()
            )
        return self._type_rows

    async def _load_channel_rows(self) -> Sequence[NotificationChannelModel]:
        """Active notification-channel rows in display order (cached per request)."""
        if self._channel_rows is None:
            self._channel_rows = (
                (
                    await self._db.execute(
                        select(NotificationChannelModel)
                        .where(NotificationChannelModel.is_active.is_(True))
                        .order_by(NotificationChannelModel.display_order)
                    )
                )
                .scalars()
                .all()
            )
        return self._channel_rows

    async def _channel_order_and_availability(
        self,
    ) -> tuple[list[NotificationChannel], dict[NotificationChannel, bool]]:
        """The active channels in display order plus their availability map,
        both sourced from ``notification_channels``."""
        order: list[NotificationChannel] = []
        availability: dict[NotificationChannel, bool] = {}
        for row in await self._load_channel_rows():
            channel = _parse_channel(row.key)
            if channel is None:
                continue
            order.append(channel)
            availability[channel] = row.is_available
        return order, availability

    async def _category_order(self) -> list[NotificationCategory]:
        """The active categories in display order, from ``notification_types``."""
        order: list[NotificationCategory] = []
        for row in await self._load_type_rows():
            category = _parse_category(row.key)
            if category is not None:
                order.append(category)
        return order

    # ----- preferences -----------------------------------------------------

    async def get_preferences(self, user: User) -> NotificationPreferences:
        channel_overrides = await self._channel_overrides(user.id)
        cell_overrides = await self._cell_overrides(user.id)
        device_count = await self._device_count(user.id)
        channel_order, availability = await self._channel_order_and_availability()
        category_order = await self._category_order()
        return self._build_preferences(
            user,
            channel_overrides,
            cell_overrides,
            device_count,
            channel_order,
            availability,
            category_order,
        )

    async def update_preferences(
        self, user: User, update_req: NotificationPreferencesUpdate
    ) -> NotificationPreferences:
        """Apply a partial update, storing only values that differ from the
        default (and deleting overrides that fall back to the default).
        Locked/unavailable channels and cells are ignored — the user can't
        change them. Returns the freshly re-resolved preferences."""
        _, availability = await self._channel_order_and_availability()
        for channel_update in update_req.channels:
            channel = channel_update.channel
            if channel in LOCKED_CHANNELS or not availability.get(channel, False):
                continue
            await self._set_channel_override(user.id, channel, channel_update.enabled)
        for cell_update in update_req.cells:
            cell = (cell_update.category, cell_update.channel)
            if cell in LOCKED_CELLS or not availability.get(cell_update.channel, False):
                continue
            await self._set_cell_override(
                user.id,
                cell_update.category,
                cell_update.channel,
                cell_update.enabled,
                availability.get(cell_update.channel, False),
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
        available: bool,
    ) -> None:
        if enabled == cell_default(category, channel, available):
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
        channel_order: Sequence[NotificationChannel],
        availability: Mapping[NotificationChannel, bool],
        category_order: Sequence[NotificationCategory],
    ) -> NotificationPreferences:
        channels = [
            NotificationChannelState(
                channel=channel,
                enabled=resolve_channel_enabled(
                    channel, availability[channel], channel_overrides.get(channel)
                ),
                available=availability[channel],
                locked=channel in LOCKED_CHANNELS,
                destination=self._channel_destination(channel, user, device_count),
                setup_required=self._channel_setup_required(
                    channel, user, device_count, availability[channel]
                ),
            )
            for channel in channel_order
        ]
        categories = [
            NotificationCategoryPreference(
                category=category,
                cells=[
                    NotificationCategoryCell(
                        channel=channel,
                        enabled=resolve_cell_enabled(
                            category,
                            channel,
                            availability[channel],
                            cell_overrides.get((category, channel)),
                        ),
                        locked=(category, channel) in LOCKED_CELLS,
                    )
                    for channel in channel_order
                ],
            )
            for category in category_order
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

    @staticmethod
    def _channel_setup_required(
        channel: NotificationChannel,
        user: User,
        device_count: int,
        available: bool,
    ) -> bool:
        """Whether the user still has to do something before this channel can
        deliver. Email needs a confirmed address; push needs a registered
        device. A channel the server can't deliver on at all (``available`` is
        false, e.g. SMS today) never prompts for setup — there's nothing the
        user can do to make it work — so the availability gate comes first."""
        if not available:
            return False
        # Exhaustive match (no catch-all) per api/CLAUDE.md's enum-mapping rule.
        match channel:
            case NotificationChannel.IN_APP:
                return False
            case NotificationChannel.PUSH:
                return device_count == 0
            case NotificationChannel.EMAIL:
                return not (user.email and user.confirmed_at is not None)
            case NotificationChannel.SMS:
                return False
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
        _, availability = await self._channel_order_and_availability()
        effective: set[NotificationChannel] = set()
        for channel in candidates:
            available = availability.get(channel, False)
            master = resolve_channel_enabled(
                channel, available, channel_overrides.get(channel)
            )
            cell = resolve_cell_enabled(
                category, channel, available, cell_overrides.get((category, channel))
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

    async def enqueue_broadcast(
        self,
        *,
        all_users: bool,
        user_ids: Sequence[uuid.UUID],
        category: NotificationCategory,
        title: str,
        body: str,
    ) -> BroadcastResponse:
        """Resolve the target players and hand one delivery job per recipient to
        the worker, which resolves *that* player's preferences for ``category``
        and delivers accordingly. Returns the recipient count immediately —
        actual delivery happens in the background."""
        target_ids = await self._broadcast_target_ids(all_users, user_ids)
        for target_id in target_ids:
            self.enqueue_notification(
                NotificationJob(
                    user_id=target_id,
                    category=category,
                    title=title,
                    body=body,
                )
            )
        return BroadcastResponse(recipients=len(target_ids))

    async def _broadcast_target_ids(
        self, all_users: bool, user_ids: Sequence[uuid.UUID]
    ) -> Sequence[uuid.UUID]:
        # Only the ids are needed (one job per recipient), so don't hydrate
        # full User rows — an "all users" broadcast would load the whole table.
        query = select(User.id).where(User.merged_into_user_id.is_(None))
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
