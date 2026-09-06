import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    case,
    func,
    select,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.ext.hybrid import hybrid_property
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import SQLColumnExpression

from app.config import get_settings
from app.db import Base
from app.models.player import Player


class Account(Base):
    __tablename__ = "accounts"
    __table_args__ = (
        CheckConstraint(
            "(merged_at IS NULL) = (merged_into_user_id IS NULL)",
            name="ck_accounts_tombstone_pair",
        ),
        CheckConstraint(
            "merged_into_user_id <> id", name="ck_accounts_not_self_merged"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    display_name: Mapped[str] = mapped_column(
        String(255), nullable=False, default="Account", server_default="Account"
    )
    email: Mapped[str | None] = mapped_column(
        String(320), unique=True, nullable=True, index=True
    )
    # When ``auth0_sub`` was first bound to this user — i.e. the moment an Auth0
    # identity became linked to this fortymm account, so the agent-access
    # settings surface can say "Connected <date>". Stamped at the two bind sites
    # in ``app.auth0_provisioning`` (match-bind onto an existing account, and the
    # fresh provision) and nowhere else: the steady-state resolve-by-``sub`` path
    # every later token takes must stay write-free, so this keeps reading as the
    # *original* link time. NULL for an account that has never linked.
    agent_access_linked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # When the *player* switched agent access off. This is the user's own
    # revocation — distinct from the operator's RBAC ``mcp.access`` grant and
    # from the ``auth0_sub`` binding; both of those can be present while this is
    # set, and a set value wins. It is enforced at the MCP transport
    # (``app.mcp_server.FortymmAuth0TokenVerifier.verify_token``), *after* the
    # token resolves to a user, so it defeats an already-issued, still-valid
    # Auth0 JWT: re-binding the ``sub`` does not help a caller whose user is
    # revoked. Sticky — there is no timer and no implicit clear; only an
    # explicit re-allow sets it back to NULL. See ADR ``20260728-disconnecting-
    # an-agent-is-a-user-held-revocation-checked-at-the-mcp-transport``.
    agent_access_revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # When a session cookie last resolved this row through the auth resolver
    # (`app.sessions._resolve_current_user`), throttled to one write per window.
    # NULL means no person has EVER browsed this account: it was minted by
    # ``POST /v1/login/request`` for an unknown address (no session token is
    # issued) or by an abandoned login-token consume, so nobody can reach it —
    # which is exactly why public listings must not show it (#1438). A row that
    # lists it would let an attacker diff the roster around ``POST
    # /v1/login/request`` and learn which addresses hold accounts. The listings'
    # single predicate lives in ``app.listed.is_listed_player``; the by-id
    # lookups deliberately do NOT apply it, so a guest's own profile still
    # resolves. Not stamped at mint: ``GET /v1/session`` mints without stamping,
    # so a drive-by bootstrap call stays unlisted until the visitor actually
    # browses.
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Set when this (ephemeral) user has been folded into another account by the
    # merge service. A live user has both NULL; a tombstoned guest has both set.
    # The row is kept (not deleted) so its session token still resolves and the
    # auth layer can tell the holder their session was merged. See
    # ``app.account_merge.merge_user``.
    merged_into_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )
    merged_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
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

    login_identities: Mapped[list["LoginIdentity"]] = relationship(
        cascade="all, delete-orphan", lazy="selectin"
    )

    @hybrid_property
    def auth0_sub(self) -> str | None:
        issuer = get_settings().auth0_issuer
        return next(
            (
                identity.subject
                for identity in self.login_identities
                if identity.provider == "auth0" and identity.issuer == issuer
            ),
            None,
        )

    @auth0_sub.inplace.setter
    def _set_auth0_sub(self, value: str | None) -> None:
        issuer = get_settings().auth0_issuer
        existing = next(
            (
                identity
                for identity in self.login_identities
                if identity.provider == "auth0" and identity.issuer == issuer
            ),
            None,
        )
        if existing is not None:
            if value is None:
                self.login_identities.remove(existing)
            else:
                existing.subject = value
        elif value is not None:
            self.login_identities.append(
                LoginIdentity(provider="auth0", issuer=issuer, subject=value)
            )

    @auth0_sub.inplace.expression
    @classmethod
    def _auth0_expression(cls) -> SQLColumnExpression[str | None]:
        return (
            select(LoginIdentity.subject)
            .where(
                LoginIdentity.account_id == cls.id,
                LoginIdentity.provider == "auth0",
                LoginIdentity.issuer == get_settings().auth0_issuer,
            )
            .correlate(cls)
            .scalar_subquery()
        )

    player_grants: Mapped[list["AccountPlayer"]] = relationship(
        cascade="all, delete-orphan", lazy="selectin"
    )

    def __init__(self, **kwargs: Any) -> None:
        # The legacy constructor provisions today's one-account/one-player
        # experience. Account(email=...) alone creates no sporting identity.
        username = kwargs.pop("username", None)
        auth0_sub = kwargs.pop("auth0_sub", None)
        kwargs.setdefault("display_name", username or "Account")
        kwargs.setdefault("player_grants", [])
        kwargs.setdefault("login_identities", [])
        if username is not None:
            account_id = kwargs.setdefault("id", uuid.uuid4())
            kwargs["player_grants"] = [
                AccountPlayer(
                    player=Player(
                        id=account_id,
                        username=username,
                        last_seen_at=kwargs.get("last_seen_at"),
                    ),
                    is_primary=True,
                )
            ]
        super().__init__(**kwargs)
        if auth0_sub is not None:
            self.auth0_sub = auth0_sub

    @property
    def primary_player(self) -> Player | None:
        return next(
            (grant.player for grant in self.player_grants if grant.is_primary), None
        )

    @property
    def player_id(self) -> uuid.UUID:
        player = self.primary_player
        if player is None:
            raise ValueError("Account has no primary player")
        return player.id

    @hybrid_property
    def username(self) -> str:
        player = self.primary_player
        return player.username if player else self.display_name

    @username.inplace.setter
    def _set_username(self, value: str) -> None:
        player = self.primary_player
        if player is None:
            raise ValueError("Account has no primary player")
        player.username = value
        self.display_name = value

    @username.inplace.expression
    @classmethod
    def _username_expression(cls) -> SQLColumnExpression[str]:
        name = (
            select(Player.username)
            .join(AccountPlayer)
            .where(AccountPlayer.account_id == cls.id, AccountPlayer.is_primary)
            .correlate(cls)
            .scalar_subquery()
        )
        # Referencing the outer account also supports select(Account.username).
        return case(
            (cls.id.is_not(None), func.coalesce(name, cls.display_name)), else_=""
        )


class AccountPlayer(Base):
    __tablename__ = "account_players"
    __table_args__ = (
        Index(
            "uq_account_players_primary",
            "account_id",
            unique=True,
            postgresql_where=text("is_primary"),
        ),
    )

    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="CASCADE"),
        primary_key=True,
    )
    player_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("players.id", ondelete="RESTRICT"),
        primary_key=True,
    )
    is_primary: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    player: Mapped[Player] = relationship(lazy="joined")


class LoginIdentity(Base):
    __tablename__ = "login_identities"
    __table_args__ = (
        UniqueConstraint(
            "issuer", "provider", "subject", name="uq_login_identities_subject"
        ),
        UniqueConstraint(
            "account_id",
            "issuer",
            "provider",
            name="uq_login_identities_account_provider",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("accounts.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    issuer: Mapped[str] = mapped_column(String(512), nullable=False)
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    subject: Mapped[str] = mapped_column(String(512), nullable=False)
