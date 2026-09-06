import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.account import Account


class DeviceToken(Base):
    """An APNs device token registered by an installed iOS app, owned by the
    user whose session registered it. The backend sends remote pushes to these.

    ``token`` is unique on its own: an APNs token identifies a single
    device+app install globally, so re-registration from a device that has
    since signed into a different account re-points the existing row's
    ``user_id`` rather than inserting a duplicate (see
    ``NotificationService.register_device_token``).
    """

    __tablename__ = "device_tokens"
    # Named explicitly (not via the column's ``unique=True``) so the constraint
    # name is stable across both create_all (tests) and the migration, which is
    # what the registration upsert targets in ``on_conflict_do_update``.
    __table_args__ = (UniqueConstraint("token", name="uq_device_tokens_token"),)

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    token: Mapped[str] = mapped_column(String(512), nullable=False)
    # Open today (only "ios"), but kept a string rather than an enum so adding
    # a platform later doesn't need a migration. The schema layer pins the
    # accepted inbound values with a Literal.
    platform: Mapped[str] = mapped_column(String(16), nullable=False)
    # "sandbox" (Xcode/dev builds) or "production" (TestFlight/App Store) —
    # decides which APNs host the push goes to. The device reports it at
    # registration based on its build configuration.
    environment: Mapped[str] = mapped_column(String(16), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
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

    user: Mapped[Account] = relationship(Account)
