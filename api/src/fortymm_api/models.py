"""The ORM's mapped classes, and the declarative base they subclass."""

import functools
import uuid
from datetime import datetime
from typing import Any, ClassVar

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    LargeBinary,
    MetaData,
    SmallInteger,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    orm,
    text,
)
from sqlalchemy import Identity as GeneratedIdentity
from sqlalchemy.dialects.postgresql import CIDR
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from fortymm_api.accounts import AccountId, Email, PlayerId
from fortymm_api.leagues import LeagueId
from fortymm_api.matches import MatchId, MatchResultId
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
        MatchId: Uuid,
        MatchResultId: Uuid,
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
    still verifies the results it signed. A revoked key verifies nothing.
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
    revoked_by: Mapped[AccountId | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT")
    )


class MatchSettings(Base):
    """A match's rules, fixed when the match is made. A trigger refuses every
    UPDATE and DELETE."""

    __tablename__ = "match_settings"
    __table_args__ = (
        # Doubles waits for a v2 of the signed result format, whose players
        # are sides of player ids.
        CheckConstraint("team_size = 1", name="singles_only"),
        CheckConstraint("best_of IN (1, 3, 5, 7)", name="best_of"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=func.gen_random_uuid()
    )
    team_size: Mapped[int] = mapped_column(SmallInteger)
    best_of: Mapped[int] = mapped_column(SmallInteger)
    rated: Mapped[bool]
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Match(Base):
    """A match between two sides. Its state is derived, not stored: it is
    final once current_result_id is set (#181)."""

    __tablename__ = "matches"
    __table_args__ = (
        ForeignKeyConstraint(
            ["current_result_id", "id"],
            ["match_results.id", "match_results.match_id"],
            name="fk_matches_current_result_id_match_results",
            use_alter=True,
        ),
        Index("ix_matches_created_at", text("created_at DESC")),
    )

    # Made on the client, so a result can reach the server before its match.
    id: Mapped[MatchId] = mapped_column(primary_key=True)
    settings_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("match_settings.id", ondelete="RESTRICT"), unique=True
    )
    league_id: Mapped[LeagueId] = mapped_column(
        ForeignKey("leagues.id", ondelete="RESTRICT"), index=True
    )
    # The account that made the match, kept as a record through adoption.
    created_by: Mapped[AccountId | None] = mapped_column(ForeignKey("accounts.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    current_result_id: Mapped[MatchResultId | None]


class MatchSide(Base):
    """One of a match's two sides. `side` is the index the signed result's
    players and signer headers use. A trigger refuses every UPDATE and
    DELETE."""

    __tablename__ = "match_sides"
    __table_args__ = (
        CheckConstraint("side IN (0, 1)", name="side"),
        UniqueConstraint("match_id", "side"),
        UniqueConstraint("id", "match_id", name="uq_match_sides_id_match_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=func.gen_random_uuid()
    )
    match_id: Mapped[MatchId] = mapped_column(ForeignKey("matches.id"))
    side: Mapped[int] = mapped_column(SmallInteger)


class MatchSidePlayer(Base):
    """A player on a side. A trigger refuses every UPDATE and DELETE, and a
    deferred one checks at commit that the match has two sides of
    team_size players each."""

    __tablename__ = "match_side_players"
    __table_args__ = (
        ForeignKeyConstraint(
            ["match_side_id", "match_id"],
            ["match_sides.id", "match_sides.match_id"],
            name="fk_match_side_players_match_side_id_match_sides",
        ),
        UniqueConstraint("match_id", "player_id"),
    )

    match_side_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    match_id: Mapped[MatchId]
    player_id: Mapped[PlayerId] = mapped_column(
        ForeignKey("players.id"), primary_key=True, index=True
    )


class StoredMatchResult(Base):
    """A signed result, or an administrator's override. A client names a
    result by the SHA-256 of its payload, which match_results_by_hash
    indexes, so look one up with `sha256(payload) = :hash`.

    A match's results form one chain through replaces_id, and each has at
    most one successor. Only the head, the result nothing replaces, can be
    approved. The match's current_result_id names its newest accepted
    result. Who sent a result, and when, is its first submission. A trigger
    refuses DELETE, and every UPDATE but the one that sets accepted_at.
    """

    __tablename__ = "match_results"
    __table_args__ = (
        CheckConstraint("replaces_id <> id", name="not_replacing_itself"),
        CheckConstraint(
            "override_reason = btrim(override_reason) AND override_reason <> ''",
            name="override_reason_trimmed",
        ),
        UniqueConstraint("id", "match_id", name="uq_match_results_id_match_id"),
        ForeignKeyConstraint(
            ["replaces_id", "match_id"],
            ["match_results.id", "match_results.match_id"],
            name="fk_match_results_replaces_id_match_results",
        ),
        Index(
            "one_successor",
            "match_id",
            "replaces_id",
            unique=True,
            postgresql_nulls_not_distinct=True,
        ),
    )

    id: Mapped[MatchResultId] = mapped_column(
        primary_key=True, server_default=func.gen_random_uuid()
    )
    match_id: Mapped[MatchId] = mapped_column(ForeignKey("matches.id"))
    # The CBOR payload, the only copy of the scores.
    payload: Mapped[bytes] = mapped_column(LargeBinary)
    replaces_id: Mapped[MatchResultId | None]
    override_reason: Mapped[str | None] = mapped_column(Text)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


Index(
    "match_results_by_hash",
    func.sha256(StoredMatchResult.payload),
    unique=True,
)


class MatchSubmission(Base):
    """Every request that sent a match a board, a result or an override,
    accepted or refused, so a match's history shows who sent what and from
    where. A request for a match that never exists leaves no row. The
    current board is the newest accepted board. A trigger refuses every UPDATE and
    DELETE."""

    __tablename__ = "match_submissions"
    __table_args__ = (
        CheckConstraint("kind IN ('board', 'result', 'override')", name="kind"),
        CheckConstraint("outcome ~ '^[a-z_]+$'", name="outcome_is_a_code"),
        UniqueConstraint("id", "result_id", name="uq_match_submissions_id_result_id"),
        ForeignKeyConstraint(
            ["result_id", "match_id"],
            ["match_results.id", "match_results.match_id"],
            name="fk_match_submissions_result_id_match_results",
        ),
        Index(
            "ix_match_submissions_match_id_kind",
            "match_id",
            "kind",
            text("id DESC"),
        ),
        Index("ix_match_submissions_result_id", "result_id"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger, GeneratedIdentity(always=True), primary_key=True
    )
    match_id: Mapped[MatchId] = mapped_column(ForeignKey("matches.id"))
    kind: Mapped[str] = mapped_column(Text)
    # The URL fragment's bytes for a board, the envelope's for a result, and
    # the payload the server encoded for an override.
    body: Mapped[bytes] = mapped_column(LargeBinary)
    account_id: Mapped[AccountId | None] = mapped_column(ForeignKey("accounts.id"))
    # An IPv6 client's /64, or an IPv4 address, as the guest limit keys it.
    network: Mapped[str | None] = mapped_column(CIDR)
    # "accepted", or the refusal's code.
    outcome: Mapped[str] = mapped_column(Text)
    result_id: Mapped[MatchResultId | None]
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class MatchApproval(Base):
    """A signature that approves a result for one side, counted once however
    many envelopes carry it. It keeps who signed and for whom as they were
    when it was accepted, and the submission that first brought it. A
    trigger refuses every UPDATE and DELETE."""

    __tablename__ = "match_approvals"
    __table_args__ = (
        CheckConstraint("side IN (0, 1)", name="side"),
        CheckConstraint("octet_length(signature) = 64", name="signature_length"),
        CheckConstraint("authority IN ('self', 'representative')", name="authority"),
        ForeignKeyConstraint(
            ["submission_id", "result_id"],
            ["match_submissions.id", "match_submissions.result_id"],
            name="fk_match_approvals_submission_id_match_submissions",
        ),
    )

    result_id: Mapped[MatchResultId] = mapped_column(
        ForeignKey("match_results.id"), primary_key=True
    )
    key_id: Mapped[KeyId] = mapped_column(
        ForeignKey("signing_keys.id", ondelete="RESTRICT"), primary_key=True
    )
    side: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    signature: Mapped[bytes] = mapped_column(LargeBinary)
    account_id: Mapped[AccountId] = mapped_column(ForeignKey("accounts.id"))
    player_id: Mapped[PlayerId] = mapped_column(ForeignKey("players.id"))
    authority: Mapped[str] = mapped_column(Text)
    submission_id: Mapped[int] = mapped_column(BigInteger)
