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
from sqlalchemy.dialects.postgresql import CIDR
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from fortymm_api.accounts import AccountId, Email, PlayerId
from fortymm_api.leagues import LeagueId
from fortymm_api.permissions import RoleId
from fortymm_api.signing_keys import KeyId


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
        RoleId: Uuid,
        LeagueId: Uuid,
        Email: Text,
        KeyId: LargeBinary,
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


# A merged player gives up its display name, so a new player can take it.
Index(
    "unique_display_name",
    func.lower(Player.display_name),
    unique=True,
    postgresql_where=text("merged_into IS NULL"),
)


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


class Identity(Base):
    """An Auth0 login, by its `sub`. Its verified email is its account's email."""

    __tablename__ = "identities"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=func.gen_random_uuid()
    )
    auth0_sub: Mapped[str] = mapped_column(Text, unique=True)
    account_id: Mapped[AccountId] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class LoginAttempt(Base):
    """A sign-in sent to Auth0, waiting for its callback.

    The callback must come from the browser that started it. A browser with a
    session proves it with that session. A browser without one proves it with
    the login cookie, which holds the state.

    The attempt outlives its session, such as when another tab's sign-in
    replaces it. Its session_id becomes NULL, and started_with_session tells
    its callback to fail rather than read it as a replay.
    """

    __tablename__ = "login_attempts"
    __table_args__ = (
        CheckConstraint(
            "session_id IS NULL OR started_with_session",
            name="session_only_if_started_with_one",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=func.gen_random_uuid()
    )
    state: Mapped[str] = mapped_column(Text, unique=True)
    started_with_session: Mapped[bool]
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("sessions.id", ondelete="SET NULL")
    )
    code_verifier: Mapped[str] = mapped_column(Text)
    nonce: Mapped[str] = mapped_column(Text)
    return_to: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class GuestAccountCount(Base):
    """How many guest accounts one client network started in its current window."""

    __tablename__ = "guest_account_counts"

    # The service writes str(ClientNetwork). Nothing reads it back into Python.
    network: Mapped[str] = mapped_column(CIDR, primary_key=True)
    # Indexed, so the prune finds ended windows without a scan.
    window_ends_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), index=True
    )
    started: Mapped[int]


class StoredPermission(Base):
    """A permission a role can grant. A built-in one is a `Permission`, which
    the code checks. Admins add and delete the others."""

    __tablename__ = "permissions"
    __table_args__ = (
        CheckConstraint(
            r"key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'", name="key_format"
        ),
        CheckConstraint("char_length(key) <= 64", name="key_length"),
    )

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    description: Mapped[str] = mapped_column(Text, server_default="")
    built_in: Mapped[bool] = mapped_column(server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Role(Base):
    """A named set of permissions that admins edit and grant to accounts."""

    __tablename__ = "roles"
    __table_args__ = (
        CheckConstraint("name = btrim(name) AND name <> ''", name="name_trimmed"),
        CheckConstraint("char_length(name) <= 50", name="name_length"),
    )

    id: Mapped[RoleId] = mapped_column(
        primary_key=True, server_default=func.gen_random_uuid()
    )
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text, server_default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


Index("unique_role_name", func.lower(Role.name), unique=True)


class RolePermission(Base):
    __tablename__ = "role_permissions"

    role_id: Mapped[RoleId] = mapped_column(
        ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True
    )
    permission_key: Mapped[str] = mapped_column(
        ForeignKey("permissions.key", ondelete="CASCADE"), primary_key=True
    )


class AccountRole(Base):
    """A role that a verified account holds."""

    __tablename__ = "account_roles"

    account_id: Mapped[AccountId] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )
    role_id: Mapped[RoleId] = mapped_column(
        ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True
    )
    granted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    # Null for a grant that no account made, such as a claimed email grant.
    granted_by: Mapped[AccountId | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL")
    )


class EmailRoleGrant(Base):
    """A role waiting for the account with this email. A sign-in that ends
    on that account moves it to `account_roles` and deletes it, so a later
    revoke sticks."""

    __tablename__ = "email_role_grants"
    __table_args__ = (CheckConstraint("email = lower(email)", name="email_lowercase"),)

    email: Mapped[Email] = mapped_column(primary_key=True)
    role_id: Mapped[RoleId] = mapped_column(
        ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True
    )


class League(Base):
    """The scope a match, and later a rating, belongs to."""

    __tablename__ = "leagues"
    __table_args__ = (
        CheckConstraint("name = btrim(name) AND name <> ''", name="name_trimmed"),
        CheckConstraint("char_length(name) <= 50", name="name_length"),
        Index(
            "one_default_league",
            "is_default",
            unique=True,
            postgresql_where=text("is_default"),
        ),
    )

    id: Mapped[LeagueId] = mapped_column(
        primary_key=True, server_default=func.gen_random_uuid()
    )
    name: Mapped[str] = mapped_column(Text)
    is_default: Mapped[bool] = mapped_column(server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


Index("unique_league_name", func.lower(League.name), unique=True)


class LeagueMember(Base):
    """A player in a league. The `players_join_default_league` trigger adds
    every new player to the default league."""

    __tablename__ = "league_members"

    league_id: Mapped[LeagueId] = mapped_column(
        ForeignKey("leagues.id", ondelete="RESTRICT"), primary_key=True
    )
    player_id: Mapped[PlayerId] = mapped_column(
        ForeignKey("players.id"), primary_key=True, index=True
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class SigningKey(Base):
    """A device's signing key: the public half, registered to the account
    whose signatures it makes. The private half never leaves the device.

    A live key has neither signed_out_at nor revoked_at. A signed-out key
    still verifies the results it signed. A revoked key verifies nothing,
    and names who revoked it: its own account or an administrator.
    services/signing_keys.py holds the rules.
    """

    __tablename__ = "signing_keys"
    __table_args__ = (
        CheckConstraint("id = sha256(public_key)", name="id_is_thumbprint"),
        CheckConstraint("octet_length(public_key) = 75", name="public_key_length"),
        CheckConstraint("label = btrim(label) AND label <> ''", name="label_trimmed"),
        CheckConstraint("char_length(label) <= 50", name="label_length"),
        CheckConstraint(
            "(revoked_at IS NULL) = (revoked_by IS NULL)",
            name="revoked_by_with_revoked_at",
        ),
    )

    # The RFC 9679 thumbprint of public_key: the kid every signature cites.
    id: Mapped[KeyId] = mapped_column(primary_key=True)
    # SigningPublicKey.to_cose_key().
    public_key: Mapped[bytes] = mapped_column(LargeBinary)
    # A key attributes signed results to its account, so no delete may take
    # the account out from under its keys.
    account_id: Mapped[AccountId] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT"), index=True
    )
    label: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    signed_out_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The account that revoked the key: its own, or an administrator's.
    revoked_by: Mapped[AccountId | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT")
    )
