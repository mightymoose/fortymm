"""The notification taxonomy: the closed set of categories a notification can
belong to, the closed set of channels it can be delivered on, and the rules for
how a user's stored preferences resolve into "do we actually deliver this".

This is the single source of truth shared by the model layer (string columns
validated against these), the service layer (preference resolution + delivery),
and the OpenAPI schema (the enums serialize into the generated TS client). The
frontend owns the *visual* taxonomy (icons, colours, labels); the server owns
the *behavioural* one (what exists, what's available, what's locked).
"""

from __future__ import annotations

from enum import StrEnum


class NotificationCategory(StrEnum):
    """What a notification is about. Mirrors the product's notification kinds;
    a user can mute each category independently per channel."""

    MATCH_REMINDER = "match_reminder"
    RATING_CHANGE = "rating_change"
    TOURNAMENT = "tournament"
    OPPONENT = "opponent"
    RESULT_CONFIRM = "result_confirm"


class NotificationChannel(StrEnum):
    """How a notification reaches a user. ``in_app`` is the persisted feed (the
    bell); the rest are external fan-out from the same stored record."""

    IN_APP = "in_app"
    PUSH = "push"
    EMAIL = "email"
    SMS = "sms"


# Channels the server can actually deliver on today. SMS has no provider wired
# up, so it's surfaced in the preferences matrix (the design includes it) but
# greyed out and never delivered — rather than pretending it works.
CHANNEL_AVAILABLE: dict[NotificationChannel, bool] = {
    NotificationChannel.IN_APP: True,
    NotificationChannel.PUSH: True,
    NotificationChannel.EMAIL: True,
    NotificationChannel.SMS: False,
}

# Master per-channel default (the channel "sign-up" cards at the top of the
# preferences page). Unavailable channels default off.
DEFAULT_CHANNEL_ENABLED: dict[NotificationChannel, bool] = {
    NotificationChannel.IN_APP: True,
    NotificationChannel.PUSH: True,
    NotificationChannel.EMAIL: True,
    NotificationChannel.SMS: False,
}

# A channel a user can't switch off. ``in_app`` *is* the feed/bell — turning it
# off would mean notifications that exist nowhere — so it's always on.
LOCKED_CHANNELS: frozenset[NotificationChannel] = frozenset(
    {NotificationChannel.IN_APP}
)

# (category, channel) cells the user can't switch off *individually* — "you're up
# next" calls to the table are too important to mute one channel at a time. The
# per-channel master card still wins (turning the whole Push channel off greys
# this cell out), so these stay reachable unless the user opts out of the channel
# entirely. Rendered as a checked, disabled cell in the matrix.
LOCKED_CELLS: frozenset[tuple[NotificationCategory, NotificationChannel]] = frozenset(
    {
        (NotificationCategory.MATCH_REMINDER, NotificationChannel.IN_APP),
        (NotificationCategory.MATCH_REMINDER, NotificationChannel.PUSH),
    }
)


def channel_default(channel: NotificationChannel) -> bool:
    """The out-of-the-box master state for a channel, before any user override."""
    return DEFAULT_CHANNEL_ENABLED[channel]


def cell_default(category: NotificationCategory, channel: NotificationChannel) -> bool:
    """The out-of-the-box per-category/per-channel state, before any override.
    Available channels start on; the unavailable SMS column starts off."""
    if (category, channel) in LOCKED_CELLS:
        return True
    return CHANNEL_AVAILABLE[channel]


def resolve_channel_enabled(
    channel: NotificationChannel, override: bool | None
) -> bool:
    """The effective master toggle: a locked channel is always on, an
    unavailable channel is always off, otherwise the stored override (or the
    default when none is stored)."""
    if channel in LOCKED_CHANNELS:
        return True
    if not CHANNEL_AVAILABLE[channel]:
        return False
    return channel_default(channel) if override is None else override


def resolve_cell_enabled(
    category: NotificationCategory,
    channel: NotificationChannel,
    override: bool | None,
) -> bool:
    """The effective per-cell toggle, before the master gate. Locked cells are
    always on; unavailable channels always off; otherwise the override (or the
    default when none is stored)."""
    if (category, channel) in LOCKED_CELLS:
        return True
    if not CHANNEL_AVAILABLE[channel]:
        return False
    return cell_default(category, channel) if override is None else override
