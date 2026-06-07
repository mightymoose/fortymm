from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class RegisterDeviceTokenRequest(BaseModel):
    """An installed iOS app registering its APNs device token against the
    caller's session, so the backend can push to it later."""

    model_config = ConfigDict(extra="forbid")

    token: str = Field(min_length=1, max_length=512)
    platform: Literal["ios"]
    environment: Literal["sandbox", "production"]


class DeviceTokenResponse(BaseModel):
    """Confirmation that the device token is registered to the current user."""

    registered: bool = True


class TestNotificationResponse(BaseModel):
    """Outcome of firing a test push to the current user's devices.

    ``sent`` counts deliveries APNs accepted; ``pruned`` counts tokens APNs
    reported as gone (unregistered / bad), which are deleted as a side effect.
    """

    sent: int
    pruned: int
