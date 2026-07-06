import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.notifications.taxonomy import NotificationCategory, NotificationChannel


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


# ----- the in-app feed (bell + notifications page) --------------------------


class NotificationItem(BaseModel):
    """One persisted notification, as the bell dropdown and the notifications
    page render it. ``read_at`` is the source of truth for unread state — the
    client derives ``unread = read_at is None`` rather than us shipping both."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    category: NotificationCategory
    title: str
    body: str
    # A deep-link target (e.g. "/matches/<id>"), the call-to-action label, and a
    # rating-delta chip — all optional in-app affordances.
    link: str | None = None
    action_label: str | None = None
    delta: str | None = None
    read_at: datetime | None = None
    created_at: datetime


class NotificationFeed(BaseModel):
    """The bell/notifications-page payload: the most recent notifications plus
    the unread total (which can exceed ``len(items)`` when the feed is capped)."""

    items: list[NotificationItem]
    unread_count: int


class UnreadCountResponse(BaseModel):
    """Just the unread total — the cheap endpoint the bell badge polls."""

    unread_count: int


class MarkReadRequest(BaseModel):
    """A batch of notification ids to mark read in one round-trip. The client
    debounces visible-on-screen rows into a single call rather than firing one
    request per row."""

    model_config = ConfigDict(extra="forbid")

    ids: list[uuid.UUID] = Field(min_length=1)


class MarkAllReadResponse(BaseModel):
    """How many previously-unread notifications were just marked read — the
    response shape for both ``read-all`` and the batched ``read`` endpoint."""

    marked: int


# ----- display taxonomy (labels + order, DB-backed) -------------------------


class NotificationTypeInfo(BaseModel):
    """One notification category for display: its key plus the human labels and
    ordering the UI renders. Sourced from the ``notification_types`` table so the
    server owns the labels/order (the client keeps only icons/colours)."""

    key: NotificationCategory
    label: str
    short: str
    description: str | None = None


class NotificationChannelInfo(BaseModel):
    """One delivery channel for display: its key, label, and whether the server
    can deliver on it (SMS is shown but unavailable). Sourced from the
    ``notification_channels`` table."""

    key: NotificationChannel
    label: str
    available: bool
    description: str | None = None


class NotificationTaxonomy(BaseModel):
    """The shared display taxonomy — the ordered lists of categories and channels
    every notification surface (preferences, feed filters, broadcast) renders.
    Reference data, fetched once and cached on the client."""

    types: list[NotificationTypeInfo]
    channels: list[NotificationChannelInfo]


# ----- preferences (per-channel masters + per-cell matrix) ------------------


class NotificationChannelState(BaseModel):
    """One channel "sign-up" card at the top of the preferences page.

    ``enabled`` is the resolved master toggle; ``available`` is whether the
    server can deliver on this channel at all (SMS isn't wired up yet);
    ``locked`` means the user can't switch it off (in-app is the feed itself);
    ``destination`` is a human hint about where it lands (email address, device
    count, ...), computed server-side. ``setup_required`` is true when the
    channel is available but the user hasn't completed the prerequisite to
    actually receive on it (no confirmed email; no registered push devices), so
    the UI can prompt them to finish setup."""

    channel: NotificationChannel
    enabled: bool
    available: bool
    locked: bool
    destination: str | None = None
    setup_required: bool = False


class NotificationCategoryCell(BaseModel):
    """One cell of the matrix: this category's setting for one channel.

    ``enabled`` is the cell's own resolved state, independent of the channel
    master — the UI greys the cell out when the master is off but preserves the
    underlying choice. ``locked`` cells (e.g. match reminders in-app/push) are
    always on and can't be changed."""

    channel: NotificationChannel
    enabled: bool
    locked: bool


class NotificationCategoryPreference(BaseModel):
    """One row of the matrix: a category and its per-channel cells."""

    category: NotificationCategory
    cells: list[NotificationCategoryCell]


class NotificationPreferences(BaseModel):
    """The whole preferences page: the channel masters and the category matrix.
    Returned by both GET and PATCH so the client always re-syncs to the
    server-resolved truth (locked/unavailable channels can't be overridden)."""

    channels: list[NotificationChannelState]
    categories: list[NotificationCategoryPreference]


class NotificationChannelUpdate(BaseModel):
    """A requested change to one channel master."""

    model_config = ConfigDict(extra="forbid")

    channel: NotificationChannel
    enabled: bool


class NotificationCellUpdate(BaseModel):
    """A requested change to one matrix cell."""

    model_config = ConfigDict(extra="forbid")

    category: NotificationCategory
    channel: NotificationChannel
    enabled: bool


class NotificationPreferencesUpdate(BaseModel):
    """A partial update to the preferences. Only the channels/cells listed are
    touched; everything else is left as-is. Attempts to change a locked or
    unavailable channel/cell are ignored (the response reflects the real,
    server-resolved state)."""

    model_config = ConfigDict(extra="forbid")

    channels: list[NotificationChannelUpdate] = Field(default_factory=list)
    cells: list[NotificationCellUpdate] = Field(default_factory=list)


# ----- admin broadcast ------------------------------------------------------


class BroadcastRecipientsAll(BaseModel):
    """Send to every (live) player."""

    model_config = ConfigDict(extra="forbid")

    mode: Literal["all"]


class BroadcastRecipientsSelected(BaseModel):
    """Send to a hand-picked set of players."""

    model_config = ConfigDict(extra="forbid")

    mode: Literal["selected"]
    user_ids: list[uuid.UUID] = Field(min_length=1, max_length=2000)


BroadcastRecipients = Annotated[
    BroadcastRecipientsAll | BroadcastRecipientsSelected,
    Field(discriminator="mode"),
]


class BroadcastRequest(BaseModel):
    """An admin broadcast: pick recipients, a category, and the copy.

    The chosen ``category`` decides which preference each recipient is delivered
    against — each player only receives it on the channels they haven't muted for
    that category (there is no admin channel override). Defaults to *tournament*
    news when omitted."""

    model_config = ConfigDict(extra="forbid")

    recipients: BroadcastRecipients
    category: NotificationCategory = NotificationCategory.TOURNAMENT
    title: str = Field(min_length=1, max_length=100)
    body: str = Field(min_length=1, max_length=280)


class BroadcastResponse(BaseModel):
    """What the broadcast enqueued: how many players were targeted. Delivery
    happens in the background (one job per recipient resolves that player's
    preferences and delivers), so per-channel counts aren't known here."""

    recipients: int
    queued: bool = True


class NotificationJob(BaseModel):
    """The queue payload for one background delivery: a category + copy for a
    single recipient. The worker resolves *this user's* preferences and delivers
    on the channels they opted into — there is no channel restriction on the
    payload. Serialized as JSON onto the ``notifications`` RQ queue."""

    user_id: uuid.UUID
    category: NotificationCategory
    title: str
    body: str
    link: str | None = None
    action_label: str | None = None
    delta: str | None = None
    push_category: str | None = None
    push_data: dict[str, str] | None = None
    collapse_id: str | None = None


class BroadcastRecipient(BaseModel):
    """One selectable player in the admin recipient picker."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    username: str


class BroadcastRecipientList(BaseModel):
    """Recipient-picker results: the matching players (capped) and the total
    number that matched, so "select all" can report the true audience size."""

    recipients: list[BroadcastRecipient]
    total: int
