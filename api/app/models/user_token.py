import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, LargeBinary, String, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.account import Account


class UserToken(Base):
    __tablename__ = "user_tokens"
    __table_args__ = (
        # Serves the one ALL-users statement on this table — the hourly sweep
        # in ``app.email_token_sweep`` — whose context / replaced_at /
        # created_at predicate nothing else indexes. Without it every run
        # seq-scans the whole table even when there is nothing to delete, and
        # the table is dominated by session tokens the sweep must never
        # touch. The partial predicate mirrors that sweep's WHERE clause
        # exactly, so the index holds only the tiny replaced pending-email
        # population; both prefixes must stay in step with the sweep's
        # EMAIL_*_CONTEXT_PREFIX constants (tests/test_email.py pins this
        # predicate against those constants and those constants against the
        # router's, and the migration carries the same declaration for
        # databases built from the migrations).
        #
        # "Mirrors exactly" is about the predicate, not the literal SQL: the
        # sweep binds its prefixes, so Postgres only proves the partial
        # predicate once it folds those parameters, which it does under a
        # custom plan. One statement per ``python -m app.email_token_sweep``
        # process always gets one. A caller that ran the sweep repeatedly on
        # one connection would cross into a generic plan and silently return
        # to the seq scan.
        Index(
            "ix_user_tokens_replaced_pending_email",
            "created_at",
            postgresql_where=text(
                "replaced_at IS NOT NULL "
                "AND (context LIKE 'change:%' OR context LIKE 'merge:%')"
            ),
        ),
    )

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
        ForeignKey("accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Set when a newer request supersedes this row: a new sign-in request
    # (``_issue_and_send_login_email``) or a new confirmation token
    # (``_issue_confirmation_token`` — change and merge flavours alike).
    # Lets ``consume_login_token`` and ``confirm_email`` tell "a newer link
    # was requested" apart from every other invalid/expired cause, without
    # stacking a second bit onto the already-overloaded ``context`` string.
    # NULL means live, or a token flavour that never gets replaced.
    replaced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    user: Mapped[Account] = relationship(Account)
