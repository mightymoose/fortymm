"""HTTP layer for push notifications: register a device token, and fire a test
push to the caller's devices. Parses, delegates to ``NotificationService``,
shapes the response — no data/domain logic inline."""

from fastapi import APIRouter, Depends, HTTPException, status

from app.models import User
from app.notifications.dependencies import get_notification_service
from app.notifications.service import NotificationService, PushNotConfiguredError
from app.schemas.notification import (
    DeviceTokenResponse,
    RegisterDeviceTokenRequest,
    TestNotificationResponse,
)
from app.sessions import get_current_user

router = APIRouter()


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
