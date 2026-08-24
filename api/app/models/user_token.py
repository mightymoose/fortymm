import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, LargeBinary, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.user import User


class UserToken(Base):
    __tablename__ = "user_tokens"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    token: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, index=True)
    context: Mapped[str] = mapped_column(String(255), nullable=False)
    sent_to: Mapped[str | None] = mapped_column(String(255), nullable=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Set when a newer login request supersedes this row (login-context tokens
    # only — see ``_issue_and_send_login_email``). Lets ``consume_login_token``
    # tell "a newer link was requested" apart from every other invalid/expired
    # cause, without stacking a second bit onto the already-overloaded
    # ``context`` string. NULL means live, or not a login token at all.
    replaced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    user: Mapped[User] = relationship(User)
