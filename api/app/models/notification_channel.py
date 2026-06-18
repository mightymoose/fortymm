import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class NotificationChannel(Base):
    """Lookup row for one delivery channel — the DB backing for
    ``app.notifications.taxonomy.NotificationChannel`` (the enum, which keeps the
    same name).

    The enum stays the code source of truth (validation + OpenAPI keys); this
    table mirrors it for the FK on the ``channel`` columns and the server-driven
    display taxonomy. ``is_available`` is whether the server can actually deliver
    on this channel today (``sms`` is present but unavailable). Behavioural rules
    (default-on, locked) stay in ``app.notifications.taxonomy``. One row per
    channel ``key``.
    """

    __tablename__ = "notification_channels"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    key: Mapped[str] = mapped_column(
        String(16), unique=True, nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    display_order: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    is_available: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
