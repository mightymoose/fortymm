"""Sessions: which account a session token signs in, and starting a session."""

import hashlib
import secrets
from dataclasses import dataclass
from datetime import timedelta
from ipaddress import IPv4Address, IPv4Network, IPv6Address, IPv6Network, ip_network

from sqlalchemy import case, delete, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from fortymm_api.accounts import CurrentAccount, GuestAccount, VerifiedAccount
from fortymm_api.models import Account, AuthSession, GuestAccountCount

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


class GuestAccountLimitReached(Exception):
    """The client's network started GUEST_ACCOUNT_LIMIT guest accounts in its
    current window. `create_app()` answers 429."""

    def __init__(self, retry_after: timedelta) -> None:
        super().__init__(retry_after)
        self.retry_after = retry_after


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
    account: CurrentAccount
    token: str


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
    session: Session, token: str | None, address: ClientAddress
) -> StartedSession:
    """Resume the token's session, or start a guest account and its session.

    A valid session expires SESSION_LIFETIME from now and keeps its token. It
    never counts toward the guest account limit. Otherwise the visitor gets a
    new guest account and token, and the session the old token named is
    deleted. Its account stays. Raises GuestAccountLimitReached before any
    write when the address's network is at the limit.
    """
    found = find_session(session, token, lock=True)
    if isinstance(found, ValidSession) and token is not None:
        found.row.expires_at = func.now() + SESSION_LIFETIME
        session.execute(
            update(Account)
            .where(Account.id == found.account.id)
            .values(last_seen_at=func.now())
        )
        return StartedSession(found.account, token)

    _count_guest_account(session, client_network(address))
    if found is not None:
        session.delete(found.row)
    guest = Account()
    session.add(guest)
    session.flush()
    token = new_token()
    session.add(
        AuthSession(
            token_hash=hash_token(token),
            account_id=guest.id,
            expires_at=func.now() + SESSION_LIFETIME,
        )
    )
    return StartedSession(GuestAccount(guest.id), token)


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
