import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    username: Mapped[str] = mapped_column(
        String(255), unique=True, nullable=False, index=True
    )
    email: Mapped[str | None] = mapped_column(
        String(320), unique=True, nullable=True, index=True
    )
    # Auth0 subject (`sub`) bound to this user by the in-session link flow. One
    # Auth0 identity maps to at most one fortymm user (unique); NULL until the
    # user explicitly links. See ADR
    # ``20260722-the-mcp-server-is-an-oauth-resource-server-trusting-auth0``.
    auth0_sub: Mapped[str | None] = mapped_column(
        String(255), unique=True, nullable=True, index=True
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
        ForeignKey("users.id", ondelete="SET NULL"),
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
