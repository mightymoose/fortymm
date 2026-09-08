"""Explicit tournament-scoped delegation, independent of ownership."""

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Enum,
    FetchedValue,
    ForeignKey,
    Index,
    Integer,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class TournamentAccountRole(enum.StrEnum):
    director = "director"


class AuthorityChangeReason(enum.StrEnum):
    explicit = "explicit"
    account_merge = "account_merge"


class TournamentAccountGrant(Base):
    __tablename__ = "tournament_account_grants"
    __table_args__ = (
        CheckConstraint(
            "(reason = 'explicit' AND granted_by_account_id IS NOT NULL AND "
            "inherited_from_grant_id IS NULL) OR (reason = 'account_merge' AND"
            " granted_by_account_id IS NULL AND inherited_from_grant_id IS NOT"
            " NULL)",
            name="ck_tournament_account_grants_provenance",
        ),
        Index(
            "ix_tournament_account_grants_account_active",
            "account_id",
            "tournament_id",
            postgresql_where=text("revoked_at IS NULL"),
        ),
        Index(
            "uq_tournament_account_grants_active",
            "tournament_id",
            "account_id",
            "role",
            unique=True,
            postgresql_where=text("revoked_at IS NULL"),
        ),
        CheckConstraint(
            "(revoked_at IS NULL) = (revocation_reason IS NULL) AND "
            "(revoked_at IS NOT NULL OR revoked_by_account_id IS NULL) AND "
            "(revocation_reason IS DISTINCT FROM 'explicit' OR "
            "revoked_by_account_id IS NOT NULL) AND (revocation_reason IS "
            "DISTINCT FROM 'account_merge' OR revoked_by_account_id IS NULL)",
            name="ck_tournament_account_grants_revocation_pair",
        ),
        CheckConstraint(
            "revoked_at >= granted_at", name="ck_tournament_account_grants_chronology"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    tournament_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tournaments.id", ondelete="CASCADE"), nullable=False
    )
    account_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=False
    )
    role: Mapped[TournamentAccountRole] = mapped_column(
        Enum(TournamentAccountRole, name="tournament_account_role"),
        nullable=False,
        default=TournamentAccountRole.director,
    )
    granted_by_account_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=True
    )
    granted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.clock_timestamp()
    )
    reason: Mapped[AuthorityChangeReason] = mapped_column(
        Enum(AuthorityChangeReason, name="authority_change_reason"),
        nullable=False,
        default=AuthorityChangeReason.explicit,
    )
    revocation_reason: Mapped[AuthorityChangeReason | None] = mapped_column(
        Enum(AuthorityChangeReason, name="authority_change_reason"), nullable=True
    )
    inherited_from_grant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tournament_account_grants.id", ondelete="RESTRICT"), nullable=True
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    revoked_by_account_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=True
    )


class TournamentOwnershipTransfer(Base):
    __tablename__ = "tournament_ownership_transfers"
    __table_args__ = (
        UniqueConstraint(
            "tournament_id",
            "revision",
            name="uq_tournament_ownership_transfers_revision",
        ),
        CheckConstraint(
            "revision >= 1", name="ck_tournament_ownership_transfers_revision"
        ),
        CheckConstraint(
            "(reason = 'explicit' AND actor_account_id IS NOT NULL) OR (reason"
            " = 'account_merge' AND actor_account_id IS NULL)",
            name="ck_tournament_ownership_transfers_actor",
        ),
        CheckConstraint(
            "previous_owner_account_id <> new_owner_account_id",
            name="ck_tournament_ownership_transfers_distinct",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    tournament_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("tournaments.id", ondelete="CASCADE"), nullable=False
    )
    revision: Mapped[int] = mapped_column(
        Integer, server_default=FetchedValue(), nullable=False
    )
    previous_owner_account_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=False
    )
    new_owner_account_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=False
    )
    actor_account_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=True
    )
    transferred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.clock_timestamp()
    )
    reason: Mapped[AuthorityChangeReason] = mapped_column(
        Enum(AuthorityChangeReason, name="authority_change_reason"), nullable=False
    )
