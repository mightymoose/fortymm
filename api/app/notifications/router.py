"""HTTP layer for notifications: device-token registration, test pushes, the
persisted in-app feed (bell + notifications page), per-channel/per-category
preferences, and the admin broadcast tool. Parses, delegates to
``NotificationService``, shapes the response — no data/domain logic inline."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status

from app.models import User
from app.notifications.dependencies import get_notification_service
from app.notifications.service import NotificationService, PushNotConfiguredError
from app.rbac import require_permission
from app.schemas.notification import (
    BroadcastRecipientList,
    BroadcastRequest,
    BroadcastResponse,
    DeviceTokenResponse,
    MarkAllReadResponse,
    NotificationFeed,
    NotificationItem,
    NotificationPreferences,
    NotificationPreferencesUpdate,
    NotificationTaxonomy,
    RegisterDeviceTokenRequest,
    TestNotificationResponse,
    UnreadCountResponse,
)
from app.sessions import get_current_user

router = APIRouter()

# Gate the admin broadcast tool. Permissions are created at runtime via the RBAC
# admin UI, not seeded — an operator grants this to the role that may broadcast.
NOTIFICATIONS_BROADCAST_PERMISSION = "notifications.broadcast"


@router.post("/v1/device-tokens", response_model=DeviceTokenResponse)
async def register_device_token(
    payload: RegisterDeviceTokenRequest,
    service: NotificationService = Depends(get_notification_service),
    current_user: User = Depends(get_current_user),
) -> DeviceTokenResponse:
    await service.register_device_token(current_user, payload)
    return DeviceTokenResponse()


@router.post("/v1/notifications/test", response_model=TestNotificationResponse)
async def send_test_notification(
    service: NotificationService = Depends(get_notification_service),
    current_user: User = Depends(get_current_user),
) -> TestNotificationResponse:
    try:
        return await service.send_test_notification(current_user)
    except PushNotConfiguredError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Push notifications are not configured on the server.",
        ) from None


# ----- in-app feed ----------------------------------------------------------


@router.get("/v1/notifications", response_model=NotificationFeed)
async def list_notifications(
    service: NotificationService = Depends(get_notification_service),
    current_user: User = Depends(get_current_user),
) -> NotificationFeed:
    """The caller's most recent notifications plus their unread total — the
    single payload the bell dropdown and the notifications page render."""
    return await service.list_feed(current_user.id)


@router.get("/v1/notifications/unread-count", response_model=UnreadCountResponse)
async def get_unread_count(
    service: NotificationService = Depends(get_notification_service),
    current_user: User = Depends(get_current_user),
) -> UnreadCountResponse:
    """Just the unread total — the lightweight endpoint the bell badge polls."""
    return await service.unread_count(current_user.id)


@router.post("/v1/notifications/read-all", response_model=MarkAllReadResponse)
async def mark_all_notifications_read(
    service: NotificationService = Depends(get_notification_service),
    current_user: User = Depends(get_current_user),
) -> MarkAllReadResponse:
    return await service.mark_all_read(current_user.id)


@router.post(
    "/v1/notifications/{notification_id}/read", response_model=NotificationItem
)
async def mark_notification_read(
    notification_id: uuid.UUID,
    service: NotificationService = Depends(get_notification_service),
    current_user: User = Depends(get_current_user),
) -> NotificationItem:
    item = await service.mark_read(current_user.id, notification_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Notification not found.")
    return item


# ----- display taxonomy -----------------------------------------------------


@router.get("/v1/notification-taxonomy", response_model=NotificationTaxonomy)
async def get_notification_taxonomy(
    service: NotificationService = Depends(get_notification_service),
    current_user: User = Depends(get_current_user),
) -> NotificationTaxonomy:
    """The shared display taxonomy: the ordered category/channel lists with their
    labels, read from the lookup tables. The preferences page, feed filters, and
    broadcast tool all render their labels/order from this."""
    return await service.get_taxonomy()


# ----- preferences ----------------------------------------------------------


@router.get("/v1/notification-preferences", response_model=NotificationPreferences)
async def get_notification_preferences(
    service: NotificationService = Depends(get_notification_service),
    current_user: User = Depends(get_current_user),
) -> NotificationPreferences:
    """The caller's channel masters + per-category matrix, resolved against the
    defaults (so locked/unavailable channels read correctly)."""
    return await service.get_preferences(current_user)


@router.patch("/v1/notification-preferences", response_model=NotificationPreferences)
async def update_notification_preferences(
    payload: NotificationPreferencesUpdate,
    service: NotificationService = Depends(get_notification_service),
    current_user: User = Depends(get_current_user),
) -> NotificationPreferences:
    """Partial update: only the listed channels/cells change. Attempts to alter
    a locked or unavailable channel are ignored; the response reflects the
    server-resolved state."""
    return await service.update_preferences(current_user, payload)


# ----- admin broadcast ------------------------------------------------------


@router.get(
    "/v1/notifications/broadcast/recipients",
    response_model=BroadcastRecipientList,
    dependencies=[Depends(require_permission(NOTIFICATIONS_BROADCAST_PERMISSION))],
)
async def list_broadcast_recipients(
    q: str | None = None,
    service: NotificationService = Depends(get_notification_service),
) -> BroadcastRecipientList:
    """Players the admin can target, filtered by username substring."""
    return await service.list_recipients(q)


@router.post(
    "/v1/notifications/broadcast",
    response_model=BroadcastResponse,
    dependencies=[Depends(require_permission(NOTIFICATIONS_BROADCAST_PERMISSION))],
)
async def broadcast_notification(
    payload: BroadcastRequest,
    service: NotificationService = Depends(get_notification_service),
) -> BroadcastResponse:
    """Send an announcement to all players or a hand-picked set. Filed as
    tournament news, so each recipient only receives it on channels they
    haven't muted for that category."""
    recipients = payload.recipients
    all_users = recipients.mode == "all"
    user_ids = recipients.user_ids if recipients.mode == "selected" else []
    return await service.broadcast(
        all_users=all_users,
        user_ids=user_ids,
        channels=payload.channels,
        title=payload.title,
        body=payload.body,
    )
