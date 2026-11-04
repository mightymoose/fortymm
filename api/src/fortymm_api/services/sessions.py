"""Sessions: which account a session token signs in, and starting a session."""

import hashlib
import secrets
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta
from ipaddress import IPv4Address, IPv4Network, IPv6Address, IPv6Network, ip_network

from sqlalchemy import case, delete, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from fortymm_api.accounts import (
    AccountId,
    CurrentAccount,
    GuestAccount,
    SelfPlayer,
    VerifiedAccount,
)
from fortymm_api.models import (
    Account,
    AuthSession,
    GuestAccountCount,
    Player,
    PlayerManager,
)
from fortymm_api.services.authorization import permissions_of
from fortymm_api.services.display_names import random_display_name

# 400 days, the longest Max-Age browsers keep, so a session expires with its
# cookie.
SESSION_LIFETIME = timedelta(days=400)

# A client's IP address, parsed at the HTTP boundary.
type ClientAddress = IPv4Address | IPv6Address
# The network that counts as one client for the guest account limit.
type ClientNetwork = IPv4Network | IPv6Network

# A client network can start this many guest accounts per window.
GUEST_ACCOUNT_LIMIT = 30
GUEST_ACCOUNT_WINDOW = timedelta(minutes=1)
# One IPv6 host can use every address in its /64 for free.
IPV6_CLIENT_PREFIX = 64
# Each guest start deletes at most this many ended windows, so a start after a
# quiet spell stays short.
PRUNE_BATCH = 100
# Display names are unique, so a start tries this many before it gives up.
DISPLAY_NAME_ATTEMPTS = 10


class GuestAccountLimitReached(Exception):
    """The client's network started GUEST_ACCOUNT_LIMIT guest accounts in its
    current window. `create_app()` answers 429."""

    def __init__(self, retry_after: timedelta) -> None:
        super().__init__(retry_after)
        self.retry_after = retry_after


class AccountAdopted(Exception):
    """The account was adopted, so a write as it must not land. `create_app()`
    answers 401."""


def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


@dataclass(frozen=True)
class ValidSession:
    row: AuthSession
    account: CurrentAccount


@dataclass(frozen=True)
class InvalidSession:
    """A session that has expired, or whose account was adopted."""

    row: AuthSession


@dataclass(frozen=True)
class StartedSession:
    session_id: uuid.UUID
    account: CurrentAccount
    player: SelfPlayer
    token: str
    # The keys of the permissions the account's roles grant.
    permissions: frozenset[str]


def current_account(account: Account) -> CurrentAccount | None:
    """The account's kind, or None for an adopted account."""
    if account.adopted_into is not None:
        return None
    if account.email is None:
        return GuestAccount(account.id)
    return VerifiedAccount(account.id, account.email)


def find_session(
    session: Session, token: str | None, *, lock: bool = False
) -> ValidSession | InvalidSession | None:
    """The session the token names, if any.

    `lock` takes the account row FOR UPDATE, for a caller that writes it. The
    lock comes before the adopted_into check, so an adoption that commits
    meanwhile can't slip through.
    """
    if token is None:
        return None
    query = (
        select(AuthSession, Account, AuthSession.expires_at > func.now())
        .join(Account, Account.id == AuthSession.account_id)
        .where(AuthSession.token_hash == hash_token(token))
    )
    if lock:
        query = query.with_for_update(of=Account)
    found = session.execute(query).one_or_none()
    if found is None:
        return None
    row, account, unexpired = found
    kind = current_account(account)
    if kind is None or not unexpired:
        return InvalidSession(row)
    return ValidSession(row, kind)


def lock_account_for_write(
    session: Session, account: AccountId, *, exclusive: bool = False
) -> None:
    """Hold the account row FOR SHARE until the transaction ends, or raise
    AccountAdopted. A service that writes as an account calls it first.

    Adoption takes the row FOR UPDATE, so the two take turns. A write that
    waited reads adopted_into after the lock, so it can't land on an account
    whose data adoption already moved.

    `exclusive` holds the row FOR UPDATE instead, so writes as the account
    also take turns with each other. A write whose rule counts rows that
    another write could add meanwhile needs it, such as the live key cap: a
    row lock can't see a row that moves in. Take it as the transaction's
    first lock on the account. Two transactions that both hold FOR SHARE and
    then ask for it deadlock.
    """
    # A scalar, not the entity: the ORM keeps a loaded Account's old
    # attributes, but this needs the row as the lock found it.
    adopted_into = session.scalar(
        select(Account.adopted_into)
        .where(Account.id == account)
        .with_for_update(read=not exclusive)
    )
    if adopted_into is not None:
        raise AccountAdopted


def authenticate(session: Session, token: str | None) -> CurrentAccount | None:
    """The account a valid session signs in, or None."""
    found = find_session(session, token)
    return found.account if isinstance(found, ValidSession) else None


def client_network(address: ClientAddress) -> ClientNetwork:
    """The network that counts as one client.

    An IPv4 address is its own /32. An IPv6 address counts as its /64. An
    IPv4-mapped IPv6 address counts as its IPv4 address, because its /64
    would hold every IPv4-mapped address.
    """
    if isinstance(address, IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    prefix = 32 if isinstance(address, IPv4Address) else IPV6_CLIENT_PREFIX
    return ip_network(f"{address}/{prefix}", strict=False)


def start_session(
    session: Session,
    token: str | None,
    address: ClientAddress,
    *,
    new_display_name: Callable[[], str] = random_display_name,
) -> StartedSession:
    """Resume the token's session, or start a guest account and its session.

    A valid session expires SESSION_LIFETIME from now and keeps its token. It
    never counts toward the guest account limit. Otherwise the visitor gets a
    new guest account and token, and the session the old token named is
    deleted. Its account stays. Raises GuestAccountLimitReached before any
    write when the address's network is at the limit.

    It returns the permissions the account holds, through `permissions_of`.
    A guest holds only the default role's.

    Every account it returns has a self player. A new guest account gets
    one with a name from `new_display_name`. So does a resumed account that
    has none, such as one that a sign-in with no session made, or one whose
    only player waits for the "Is this you?" answer. A "Yes" then merges the
    two players.
    """
    found = find_session(session, token, lock=True)
    if isinstance(found, ValidSession) and token is not None:
        found.row.expires_at = func.now() + SESSION_LIFETIME
        session.execute(
            update(Account)
            .where(Account.id == found.account.id)
            .values(last_seen_at=func.now())
        )
        player = _self_player(session, found.account.id)
        if player is None:
            player = _create_self_player(session, found.account.id, new_display_name)
        return StartedSession(
            found.row.id,
            found.account,
            player,
            token,
            permissions_of(session, found.account.id),
        )

    _count_guest_account(session, client_network(address))
    if found is not None:
        session.delete(found.row)
    guest = Account()
    session.add(guest)
    session.flush()
    row, token = new_session(session, guest.id)
    player = _create_self_player(session, guest.id, new_display_name)
    return StartedSession(
        row.id,
        GuestAccount(guest.id),
        player,
        token,
        permissions_of(session, guest.id),
    )


def count_start_without_session(session: Session, address: ClientAddress) -> None:
    """Count a start that makes no guest account toward the guest account
    limit, or raise GuestAccountLimitReached.

    A sign-in from a browser with no session is one. Before it made a guest
    account, the limit was the only thing that bounded its writes.
    """
    _count_guest_account(session, client_network(address))


def new_session(session: Session, account_id: AccountId) -> tuple[AuthSession, str]:
    """A new session row for the account, and its token."""
    token = new_token()
    row = AuthSession(
        token_hash=hash_token(token),
        account_id=account_id,
        expires_at=func.now() + SESSION_LIFETIME,
    )
    session.add(row)
    session.flush()
    return row, token


def convert_guest(session: Session, guest: AccountId, into: AccountId) -> str:
    """End the guest account's life as a guest, and give the browser that
    signed in a session for `into`. Returns its token.

    Deletes every session of the guest account, in every browser, so a copied
    guest cookie stops working (REVOKED_ON_GUEST_CONVERSION). Never touches
    the other sessions of `into`. Verify in place passes the guest account as
    `into`, and adoption passes the account that adopts it.
    """
    session.execute(delete(AuthSession).where(AuthSession.account_id == guest))
    _, token = new_session(session, into)
    return token


def session_account(session: Session, token: str | None) -> AccountId | None:
    """The account of the session the token names, expired or not, with no
    lock. None if no session has the token."""
    if token is None:
        return None
    account: AccountId | None = session.scalar(
        select(AuthSession.account_id).where(
            AuthSession.token_hash == hash_token(token)
        )
    )
    return account


def end_session(session: Session, token: str | None) -> None:
    """Delete the session the token names, if any."""
    if token is not None:
        session.execute(
            delete(AuthSession).where(AuthSession.token_hash == hash_token(token))
        )


def _self_player(session: Session, account_id: AccountId) -> SelfPlayer | None:
    found = session.execute(
        select(Player.id, Player.display_name)
        .join(PlayerManager, PlayerManager.player_id == Player.id)
        .where(
            PlayerManager.account_id == account_id,
            PlayerManager.relationship == "self",
        )
    ).one_or_none()
    return None if found is None else SelfPlayer(found.id, found.display_name)


def _create_self_player(
    session: Session, account_id: AccountId, new_display_name: Callable[[], str]
) -> SelfPlayer:
    """Make the account's self player, with the first free name.

    ON CONFLICT DO NOTHING skips a taken name. A plain INSERT would raise and
    abort the request's transaction.
    """
    for _ in range(DISPLAY_NAME_ATTEMPTS):
        display_name = new_display_name()
        player_id = session.scalar(
            insert(Player)
            .values(display_name=display_name)
            .on_conflict_do_nothing()
            .returning(Player.id)
        )
        if player_id is not None:
            session.add(
                PlayerManager(
                    player_id=player_id, account_id=account_id, relationship="self"
                )
            )
            return SelfPlayer(player_id, display_name)
    raise RuntimeError(f"No free display name after {DISPLAY_NAME_ATTEMPTS} tries")


def _count_guest_account(session: Session, network: ClientNetwork) -> None:
    """Count one more guest account for the network, or raise
    GuestAccountLimitReached.

    The upsert locks the network's row until the request commits, so starts
    from one network take turns and each sees the last one's count. A refused
    start writes nothing, so retrying never pushes its window later.
    """
    count = GuestAccountCount
    ended = count.window_ends_at <= func.now()
    insert_first = insert(count).values(
        network=str(network),
        window_ends_at=func.now() + GUEST_ACCOUNT_WINDOW,
        started=1,
    )
    counted = session.scalar(
        insert_first.on_conflict_do_update(
            index_elements=[count.network],
            set_={
                "window_ends_at": case(
                    (ended, insert_first.excluded.window_ends_at),
                    else_=count.window_ends_at,
                ),
                "started": case((ended, 1), else_=count.started + 1),
            },
            where=ended | (count.started < GUEST_ACCOUNT_LIMIT),
        ).returning(count.started)
    )
    if counted is None:
        retry_after: timedelta = session.scalar(
            select(count.window_ends_at - func.now()).where(
                count.network == str(network)
            )
        )
        raise GuestAccountLimitReached(retry_after)

    # SKIP LOCKED leaves a row that another start is counting.
    stale = (
        select(count.network)
        .where(count.window_ends_at < func.now())
        .order_by(count.window_ends_at)
        .limit(PRUNE_BATCH)
        .with_for_update(skip_locked=True)
    )
    session.execute(
        delete(count)
        .where(count.network.in_(stale))
        .execution_options(synchronize_session=False)
    )
