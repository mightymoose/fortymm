"""The ORM's mapped classes, and the declarative base they subclass."""

import functools
import uuid
from datetime import datetime
from typing import Any, ClassVar

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    LargeBinary,
    MetaData,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    orm,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from fortymm_api.accounts import AccountId, Email, PlayerId


class Base(DeclarativeBase):
    # Named constraints, so a migration can refer to one by a stable name.
    metadata = MetaData(
        naming_convention={
            "ix": "ix_%(column_0_label)s",
            "uq": "uq_%(table_name)s_%(column_0_name)s",
            "ck": "ck_%(table_name)s_%(constraint_name)s",
            "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
            "pk": "pk_%(table_name)s",
        }
    )
    # SQLAlchemy can't see through a NewType, so the ids and emails name theirs.
    type_annotation_map: ClassVar[dict[Any, Any]] = {
        AccountId: Uuid,
        PlayerId: Uuid,
        Email: Text,
    }


# lazy="raise" makes a lazy load fail, so every load shows in the query that
# needs it. Pass another `lazy` to choose a loader for one relationship.
relationship = functools.partial(orm.relationship, lazy="raise")


class Account(Base):
    __tablename__ = "accounts"
    __table_args__ = (
        CheckConstraint("email = lower(email)", name="email_lowercase"),
        CheckConstraint(
            "adopted_into IS NULL OR adopted_into <> id", name="not_adopted_into_self"
        ),
    )

    id: Mapped[AccountId] = mapped_column(
        primary_key=True, server_default=func.gen_random_uuid()
    )
    # Null for a guest account.
    email: Mapped[Email | None] = mapped_column(unique=True)
    adopted_into: Mapped[AccountId | None] = mapped_column(ForeignKey("accounts.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    player_managers: Mapped[list[PlayerManager]] = relationship(
        foreign_keys="PlayerManager.account_id"
    )
    sessions: Mapped[list[AuthSession]] = relationship()


class Player(Base):
    __tablename__ = "players"
    __table_args__ = (
        CheckConstraint(
            "merged_into IS NULL OR merged_into <> id", name="not_merged_into_self"
        ),
    )

    id: Mapped[PlayerId] = mapped_column(
        primary_key=True, server_default=func.gen_random_uuid()
    )
    display_name: Mapped[str] = mapped_column(Text)
    merged_into: Mapped[PlayerId | None] = mapped_column(ForeignKey("players.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    managers: Mapped[list[PlayerManager]] = relationship()


Index("unique_display_name", func.lower(Player.display_name), unique=True)


class PlayerManager(Base):
    __tablename__ = "player_managers"
    __table_args__ = (
        UniqueConstraint("player_id", "account_id"),
        CheckConstraint("relationship IN ('self', 'managed')", name="relationship"),
        Index(
            "one_self_player_per_account",
            "account_id",
            unique=True,
            postgresql_where=text("relationship = 'self'"),
        ),
        Index(
            "one_self_account_per_player",
            "player_id",
            unique=True,
            postgresql_where=text("relationship = 'self'"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=func.gen_random_uuid()
    )
    player_id: Mapped[PlayerId] = mapped_column(ForeignKey("players.id"))
    account_id: Mapped[AccountId] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE")
    )
    relationship: Mapped[str] = mapped_column(Text)
    # The guest account it came from, until the "is this you?" question is
    # answered.
    adopted_from: Mapped[AccountId | None] = mapped_column(ForeignKey("accounts.id"))


class AuthSession(Base):
    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=func.gen_random_uuid()
    )
    # The sha256 of the cookie's token. The token itself is never stored.
    token_hash: Mapped[bytes] = mapped_column(LargeBinary, unique=True)
    account_id: Mapped[AccountId] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
