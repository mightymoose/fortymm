import hashlib
import secrets
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from ipaddress import ip_address

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session, sessionmaker

from fortymm_api.accounts import AccountId, CurrentAccount, GuestAccount
from fortymm_api.services.sessions import (
    ClientAddress,
    GuestAccountLimitReached,
    StartedSession,
    authenticate,
    start_session,
)

ANN = ip_address("203.0.113.7")


def in_transaction[T](database: Engine, work: Callable[[Session], T]) -> T:
    """Run `work` in one committed transaction, as a request does."""
    with sessionmaker(database).begin() as session:
        return work(session)


def start(
    database: Engine, token: str | None = None, *, address: ClientAddress = ANN
) -> StartedSession:
    return in_transaction(
        database, lambda session: start_session(session, token, address)
    )


def signed_in(database: Engine, token: str | None) -> CurrentAccount | None:
    return in_transaction(database, lambda session: authenticate(session, token))


def run(database: Engine, sql: str, **params: object) -> None:
    with database.begin() as connection:
        connection.execute(text(sql), params)


def token_hash(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


def expires_at(database: Engine, token: str) -> datetime | None:
    with database.connect() as connection:
        expiry: datetime | None = connection.scalar(
            text("SELECT expires_at FROM sessions WHERE token_hash = :token_hash"),
            {"token_hash": token_hash(token)},
        )
        return expiry


def expire(database: Engine, token: str) -> None:
    run(
        database,
        "UPDATE sessions SET expires_at = now() - interval '1 second'"
        " WHERE token_hash = :token_hash",
        token_hash=token_hash(token),
    )


def adopt(database: Engine, account_id: AccountId) -> None:
    """Adopt the account into a new one, as adoption will (no service does yet)."""
    run(
        database,
        "WITH adopter AS (INSERT INTO accounts DEFAULT VALUES RETURNING id)"
        " UPDATE accounts SET adopted_into = (SELECT id FROM adopter) WHERE id = :id",
        id=account_id,
    )


def count(database: Engine, table: str) -> int:
    with database.connect() as connection:
        rows: int = connection.scalar(text(f"SELECT count(*) FROM {table}"))
        return rows


def seed_count(
    database: Engine, network: str, started: int, ends_in: str = "1 minute"
) -> None:
    """Record `started` guest accounts for the network, as another instance would."""
    run(
        database,
        "INSERT INTO guest_account_counts (network, window_ends_at, started)"
        " VALUES (CAST(:network AS cidr),"
        " now() + CAST(:ends_in AS interval), :started)",
        network=network,
        ends_in=ends_in,
        started=started,
    )


def lasts_about_400_days(expiry: datetime | None) -> bool:
    assert expiry is not None
    return expiry - datetime.now(expiry.tzinfo) > timedelta(days=399)


def test_starts_a_guest_session_without_a_token(migrated_database: Engine) -> None:
    started = start(migrated_database)

    assert isinstance(started.account, GuestAccount)
    assert len(started.token) == 43  # 32 bytes, base64url without padding
    assert lasts_about_400_days(expires_at(migrated_database, started.token))


def test_resumes_a_valid_session(migrated_database: Engine) -> None:
    first = start(migrated_database)
    run(
        migrated_database,
        "UPDATE sessions SET expires_at = now() + interval '1 day'"
        " WHERE token_hash = :token_hash",
        token_hash=token_hash(first.token),
    )

    resumed = start(migrated_database, first.token)

    assert resumed == first
    assert lasts_about_400_days(expires_at(migrated_database, first.token))
    assert count(migrated_database, "accounts") == 1


def test_resuming_a_session_records_the_account_as_seen(
    migrated_database: Engine,
) -> None:
    first = start(migrated_database)
    run(
        migrated_database,
        "UPDATE accounts SET last_seen_at = now() - interval '1 day' WHERE id = :id",
        id=first.account.id,
    )

    start(migrated_database, first.token)

    with migrated_database.connect() as connection:
        seen = connection.scalar(
            text(
                "SELECT now() - last_seen_at < interval '1 hour' FROM accounts"
                " WHERE id = :id"
            ),
            {"id": first.account.id},
        )
    assert seen is True


def test_resumes_a_verified_accounts_session(migrated_database: Engine) -> None:
    first = start(migrated_database)
    run(
        migrated_database,
        "UPDATE accounts SET email = 'ann@example.com' WHERE id = :id",
        id=first.account.id,
    )

    resumed = start(migrated_database, first.token)

    assert resumed.account.kind == "verified"
    assert resumed.account.id == first.account.id


def test_starts_a_guest_session_for_an_unknown_token(
    migrated_database: Engine,
) -> None:
    unknown = secrets.token_urlsafe(32)

    started = start(migrated_database, unknown)

    assert isinstance(started.account, GuestAccount)
    assert started.token != unknown


def test_replaces_an_expired_session(migrated_database: Engine) -> None:
    first = start(migrated_database)
    expire(migrated_database, first.token)

    replaced = start(migrated_database, first.token)

    assert isinstance(replaced.account, GuestAccount)
    assert replaced.account.id != first.account.id
    assert replaced.token != first.token
    assert expires_at(migrated_database, first.token) is None
    assert count(migrated_database, "accounts") == 2


def test_replaces_a_session_whose_account_was_adopted(
    migrated_database: Engine,
) -> None:
    first = start(migrated_database)
    adopt(migrated_database, first.account.id)

    replaced = start(migrated_database, first.token)

    assert isinstance(replaced.account, GuestAccount)
    assert replaced.account.id != first.account.id
    assert expires_at(migrated_database, first.token) is None
    with migrated_database.connect() as connection:
        adopted = connection.scalar(
            text("SELECT adopted_into IS NOT NULL FROM accounts WHERE id = :id"),
            {"id": first.account.id},
        )
    assert adopted is True


def test_authenticates_a_valid_session(migrated_database: Engine) -> None:
    started = start(migrated_database)

    assert signed_in(migrated_database, started.token) == started.account


def test_authenticates_no_one_without_a_token(migrated_database: Engine) -> None:
    assert signed_in(migrated_database, None) is None


def test_authenticates_no_one_for_an_unknown_token(migrated_database: Engine) -> None:
    assert signed_in(migrated_database, secrets.token_urlsafe(32)) is None


def test_authenticates_no_one_for_an_expired_session(
    migrated_database: Engine,
) -> None:
    started = start(migrated_database)
    expire(migrated_database, started.token)

    assert signed_in(migrated_database, started.token) is None


def test_authenticates_no_one_for_an_adopted_account(
    migrated_database: Engine,
) -> None:
    started = start(migrated_database)
    adopt(migrated_database, started.account.id)

    assert signed_in(migrated_database, started.token) is None


def test_authenticating_starts_no_session(migrated_database: Engine) -> None:
    signed_in(migrated_database, None)

    assert count(migrated_database, "accounts") == 0
    assert count(migrated_database, "sessions") == 0


def test_refuses_the_31st_guest_account_from_one_address(
    migrated_database: Engine,
) -> None:
    for _ in range(30):
        start(migrated_database)

    with pytest.raises(GuestAccountLimitReached):
        start(migrated_database)

    assert count(migrated_database, "accounts") == 30


def test_reads_the_count_that_another_instance_wrote(
    migrated_database: Engine,
) -> None:
    seed_count(migrated_database, "203.0.113.7/32", 30)

    with pytest.raises(GuestAccountLimitReached):
        start(migrated_database)

    assert count(migrated_database, "accounts") == 0


def backend_waits_for_a_lock(database: Engine, pid: int) -> bool:
    with database.connect() as connection:
        wait: str | None = connection.scalar(
            text("SELECT wait_event_type FROM pg_stat_activity WHERE pid = :pid"),
            {"pid": pid},
        )
        return wait == "Lock"


def test_a_second_start_from_one_network_waits_for_the_first(
    migrated_database: Engine,
) -> None:
    seed_count(migrated_database, "203.0.113.7/32", 29)
    sessions = sessionmaker(migrated_database)
    pids: list[int] = []

    def second_start() -> StartedSession:
        with sessions.begin() as session:
            pids.append(session.scalar(text("SELECT pg_backend_pid()")))
            return start_session(session, None, ANN)

    first = sessions()
    try:
        first.begin()
        start_session(first, None, ANN)
        with ThreadPoolExecutor(max_workers=1) as executor:
            second = executor.submit(second_start)
            deadline = time.monotonic() + 10
            while not (pids and backend_waits_for_a_lock(migrated_database, pids[0])):
                assert not second.done(), "the second start never waited for the first"
                assert time.monotonic() < deadline, (
                    "the second start was not waiting after 10 seconds"
                )
                time.sleep(0.05)
            first.commit()

            with pytest.raises(GuestAccountLimitReached):
                second.result(timeout=10)
    finally:
        first.close()

    assert count(migrated_database, "accounts") == 1
