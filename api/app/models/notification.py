import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.user import User


class Notification(Base):
    """A persisted in-app notification owned by its recipient — the records the
    bell, the unread badge, and the notifications page read from.

    A notification is created once (the in-app channel is the durable record);
    push / email fan-out happens off the same data but isn't stored here. Read
    state is the nullable ``read_at`` timestamp, not a tri-state boolean: a row
    is unread iff ``read_at IS NULL``.

    ``category`` is a string (validated against
    ``app.notifications.taxonomy.NotificationCategory`` at the boundary) rather
    than a Postgres enum, matching ``DeviceToken.platform`` — adding a category
    later needs no enum migration. It carries an FK to ``notification_types.key``
    so a value off the taxonomy can't be stored.

    ``result_id`` binds a *hideable* prompt (e.g. "Accept your match result") to
    the specific ``MatchResult`` it's asking about, so the feed/unread-count
    queries (``NotificationService.list_feed`` / ``_unread_count``) can hide the
    row once that result is no longer live — accepted, superseded by a counter,
    or auto-accepted by the retirement sweep — without deleting it (issue
    #1583). ``NULL`` for every other notification, including the FYI notices
    that must never disappear ("Your result was accepted", "Match finalized").
    ``SET NULL`` on delete: losing the ``MatchResult`` row (cascaded from its
    match) just un-hides a stale row rather than orphaning the notification.
    """

    __tablename__ = "notifications"
    # The feed query is ``WHERE user_id = ? ORDER BY created_at DESC``; the
    # composite index serves both the filter and the ordering.
    __table_args__ = (
        Index("ix_notifications_user_id_created_at", "user_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    category: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("notification_types.key", ondelete="RESTRICT"),
        nullable=False,
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str] = mapped_column(String(500), nullable=False)
    # Optional in-app affordances mirrored from the design's notification row:
    # a deep-link target, a call-to-action button label, and a rating delta chip
    # (e.g. "+12"). All optional — a plain announcement carries none of them.
    link: Mapped[str | None] = mapped_column(String(512), nullable=True)
    action_label: Mapped[str | None] = mapped_column(String(40), nullable=True)
    delta: Mapped[str | None] = mapped_column(String(16), nullable=True)
    result_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("match_results.id", ondelete="SET NULL"),
        nullable=True,
    )
    read_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    user: Mapped[User] = relationship(User)


class NotificationChannelSetting(Base):
    """A user's master toggle for one delivery channel — the channel "sign-up"
    cards at the top of the preferences page.

    Sparse: only channels the user has changed away from the default are stored.
    Absent rows resolve to the channel default
    (``app.notifications.taxonomy``). One row per (user, channel).
    """

    __tablename__ = "notification_channel_settings"
    # Named constraint (not the column's ``unique=True``) so the name is stable
    # across create_all (tests) and the migration — the upsert keys on it.
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "channel",
            name="uq_notification_channel_settings_user_channel",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    channel: Mapped[str] = mapped_column(
        String(16),
        ForeignKey("notification_channels.key", ondelete="RESTRICT"),
        nullable=False,
    )
    enabled: Mapped[bool] = mapped_column(nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    user: Mapped[User] = relationship(User)


class NotificationPreference(Base):
    """A user's per-(category, channel) override — one cell of the preferences
    matrix ("mute rating-change emails but keep push").

    Sparse, like ``NotificationChannelSetting``: only cells changed away from
    the default are stored; absent cells resolve to the default. One row per
    (user, category, channel). A cell is only *effective* when its channel's
    master toggle is also on — that gate lives in the service, not here.
    """

    __tablename__ = "notification_preferences"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "category",
            "channel",
            name="uq_notification_preferences_user_category_channel",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    category: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("notification_types.key", ondelete="RESTRICT"),
        nullable=False,
    )
    channel: Mapped[str] = mapped_column(
        String(16),
        ForeignKey("notification_channels.key", ondelete="RESTRICT"),
        nullable=False,
    )
    enabled: Mapped[bool] = mapped_column(nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    user: Mapped[User] = relationship(User)
