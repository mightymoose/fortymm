import time
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from ipaddress import ip_address

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session, sessionmaker

from fortymm_api.accounts import (
    AccountId,
    CurrentAccount,
    Email,
    GuestAccount,
    VerifiedAccount,
)
from fortymm_api.identity_provider import ExchangeFailed, IdToken
from fortymm_api.services.sessions import authenticate, new_session, start_session
from fortymm_api.services.sign_in import (
    AdoptGuest,
    AlreadySignedIn,
    Callback,
    CreateAccount,
    ExchangeCode,
    LoginStarted,
    Replayed,
    SignedIn,
    SignInError,
    SignInFailed,
    SwitchAccount,
    VerifyInPlace,
    begin_sign_in,
    finish_sign_in,
    resolve_login,
    safe_return_to,
)

ANN = ip_address("203.0.113.7")
GUEST = GuestAccount(AccountId(uuid.uuid4()))
VERIFIED = VerifiedAccount(AccountId(uuid.uuid4()), Email("ann@example.com"))
OTHER = AccountId(uuid.uuid4())


@pytest.mark.parametrize(
    ("current", "owner", "outcome"),
    [
        (GUEST, None, VerifyInPlace(GUEST.id)),
        (GUEST, GUEST.id, AlreadySignedIn(GUEST.id)),
        (VERIFIED, VERIFIED.id, AlreadySignedIn(VERIFIED.id)),
        (GUEST, OTHER, AdoptGuest(GUEST.id, OTHER)),
        (VERIFIED, OTHER, SwitchAccount(OTHER)),
        (VERIFIED, None, CreateAccount()),
    ],
)
def test_resolves_each_login(
    current: CurrentAccount, owner: AccountId | None, outcome: object
) -> None:
    assert resolve_login(current, owner) == outcome


@pytest.mark.parametrize(
    ("value", "return_to"),
    [
        ("/games?tab=open", "/games?tab=open"),
        ("/", "/"),
        (None, "/"),
        ("", "/"),
        ("games", "/"),
        ("https://evil.example/", "/"),
        ("//evil.example/", "/"),
        ("/\\evil.example/", "/"),
        ("/\t/evil.example/", "/"),
        ("/games\r\nSet-Cookie: x=1", "/"),
    ],
)
def test_accepts_only_a_path_on_this_site(value: str | None, return_to: str) -> None:
    assert safe_return_to(value) == return_to


def in_transaction[T](database: Engine, work: Callable[[Session], T]) -> T:
    with sessionmaker(database).begin() as session:
        return work(session)


def identity(sub: str, email: str, *, verified: bool = True) -> ExchangeCode:
    """An exchange that returns this identity, as the provider would."""

    def exchange(code: str, code_verifier: str, nonce: str) -> IdToken:
        return IdToken(sub, Email(email), verified)

    return exchange


def guest_token(database: Engine) -> str:
    return in_transaction(
        database, lambda session: start_session(session, None, ANN).token
    )


def begin(database: Engine, token: str | None) -> LoginStarted:
    return in_transaction(
        database, lambda session: begin_sign_in(session, token, ANN, "/games")
    )


def finish(
    database: Engine,
    token: str | None,
    state: str | None,
    exchange: ExchangeCode,
    *,
    error: str | None = None,
) -> SignedIn | SignInFailed | Replayed:
    return in_transaction(
        database,
        lambda session: finish_sign_in(
            session, token, Callback(state, "code", error), exchange
        ),
    )


def sign_in(database: Engine, token: str | None, exchange: ExchangeCode) -> str:
    """Sign the token's browser in, and return its new token."""
    started = begin(database, token)
    result = finish(database, started.token, started.state, exchange)
    assert isinstance(result, SignedIn)
    return result.token


def signed_in(database: Engine, token: str) -> CurrentAccount | None:
    return in_transaction(database, lambda session: authenticate(session, token))


def account_of(database: Engine, token: str) -> CurrentAccount:
    account = signed_in(database, token)
    assert account is not None
    return account


def count(database: Engine, sql: str, **params: object) -> int:
    with database.connect() as connection:
        rows: int = connection.scalar(text(sql), params)
        return rows


def test_a_guest_with_a_new_email_keeps_its_account(migrated_database: Engine) -> None:
    token = guest_token(migrated_database)
    guest = account_of(migrated_database, token)

    new_token = sign_in(migrated_database, token, identity("a|1", "ann@example.com"))

    assert account_of(migrated_database, new_token) == VerifiedAccount(
        guest.id, Email("ann@example.com")
    )


def test_verify_in_place_revokes_the_guests_sessions_in_every_browser(
    migrated_database: Engine,
) -> None:
    first_browser = guest_token(migrated_database)
    guest = account_of(migrated_database, first_browser)
    _, second_browser = in_transaction(
        migrated_database, lambda session: new_session(session, guest.id)
    )

    new_token = sign_in(
        migrated_database, first_browser, identity("a|1", "ann@example.com")
    )

    assert signed_in(migrated_database, first_browser) is None
    assert signed_in(migrated_database, second_browser) is None
    assert account_of(migrated_database, new_token).id == guest.id


def test_verify_in_place_asks_is_this_you_about_the_self_player(
    migrated_database: Engine,
) -> None:
    token = guest_token(migrated_database)
    guest = account_of(migrated_database, token)

    sign_in(migrated_database, token, identity("a|1", "ann@example.com"))

    with migrated_database.connect() as connection:
        rows = connection.execute(
            text(
                "SELECT relationship, adopted_from FROM player_managers"
                " WHERE account_id = :id"
            ),
            {"id": guest.id},
        ).all()
    assert [tuple(row) for row in rows] == [("managed", guest.id)]


def test_a_verified_account_with_its_own_identity_stays_signed_in(
    migrated_database: Engine,
) -> None:
    ann = identity("a|1", "ann@example.com")
    token = sign_in(migrated_database, guest_token(migrated_database), ann)
    account = account_of(migrated_database, token)

    new_token = sign_in(migrated_database, token, ann)

    assert new_token != token
    assert signed_in(migrated_database, token) is None
    assert account_of(migrated_database, new_token) == account
    assert count(migrated_database, "SELECT count(*) FROM accounts") == 1


def test_switching_accounts_keeps_the_destinations_other_sessions(
    migrated_database: Engine,
) -> None:
    bob = identity("b|1", "bob@example.com")
    bobs_browser = sign_in(migrated_database, guest_token(migrated_database), bob)
    anns_browser = sign_in(
        migrated_database,
        guest_token(migrated_database),
        identity("a|1", "ann@example.com"),
    )
    ann = account_of(migrated_database, anns_browser)

    new_token = sign_in(migrated_database, anns_browser, bob)

    assert account_of(migrated_database, new_token) == account_of(
        migrated_database, bobs_browser
    )
    assert signed_in(migrated_database, anns_browser) is None
    assert (
        count(
            migrated_database,
            "SELECT count(*) FROM accounts WHERE id = :id AND email = :email",
            id=ann.id,
            email="ann@example.com",
        )
        == 1
    )


def test_a_verified_account_with_a_new_email_reaches_a_new_account(
    migrated_database: Engine,
) -> None:
    token = sign_in(
        migrated_database,
        guest_token(migrated_database),
        identity("a|1", "ann@example.com"),
    )
    ann = account_of(migrated_database, token)

    new_token = sign_in(migrated_database, token, identity("a|2", "ann@work.example"))

    created = account_of(migrated_database, new_token)
    assert created == VerifiedAccount(created.id, Email("ann@work.example"))
    assert created.id != ann.id
    assert signed_in(migrated_database, token) is None


def test_two_identities_for_one_email_reach_one_account(
    migrated_database: Engine,
) -> None:
    token = sign_in(
        migrated_database,
        guest_token(migrated_database),
        identity("email|ann", "ann@example.com"),
    )
    ann = account_of(migrated_database, token)

    google = sign_in(
        migrated_database,
        sign_in(migrated_database, token, identity("x|1", "x@example.com")),
        identity("google|ann", "ann@example.com"),
    )

    assert account_of(migrated_database, google) == ann
    assert (
        count(
            migrated_database,
            "SELECT count(*) FROM identities WHERE account_id = :id",
            id=ann.id,
        )
        == 2
    )


def test_a_guest_signing_in_to_another_account_waits_for_adoption(
    migrated_database: Engine,
) -> None:
    bob = identity("b|1", "bob@example.com")
    sign_in(migrated_database, guest_token(migrated_database), bob)
    token = guest_token(migrated_database)
    guest = account_of(migrated_database, token)
    started = begin(migrated_database, token)

    result = finish(migrated_database, started.token, started.state, bob)

    assert result == SignInFailed("/games", SignInError.FAILED)
    assert account_of(migrated_database, token) == guest


def refused(code: str, code_verifier: str, nonce: str) -> IdToken:
    raise ExchangeFailed


ANN_IDENTITY = identity("a|1", "ann@example.com")


@pytest.mark.parametrize(
    ("case", "exchange", "callback_error", "error"),
    [
        ("cancelled", ANN_IDENTITY, "access_denied", SignInError.CANCELLED),
        (
            "unverified",
            identity("a|1", "ann@example.com", verified=False),
            None,
            SignInError.EMAIL_NOT_VERIFIED,
        ),
        ("expired", ANN_IDENTITY, None, SignInError.EXPIRED),
        ("provider error", ANN_IDENTITY, "server_error", SignInError.FAILED),
        ("refused code", refused, None, SignInError.FAILED),
        ("another session", ANN_IDENTITY, None, SignInError.FAILED),
    ],
)
def test_a_failed_sign_in_changes_nothing_and_ends_the_attempt(
    migrated_database: Engine,
    case: str,
    exchange: ExchangeCode,
    callback_error: str | None,
    error: SignInError,
) -> None:
    token = guest_token(migrated_database)
    guest = account_of(migrated_database, token)
    started = begin(migrated_database, token)
    browser = guest_token(migrated_database) if case == "another session" else token
    if case == "expired":
        with migrated_database.begin() as connection:
            connection.execute(
                text("UPDATE login_attempts SET expires_at = now() - interval '1s'")
            )

    result = finish(
        migrated_database, browser, started.state, exchange, error=callback_error
    )

    assert result == SignInFailed("/games", error)
    assert account_of(migrated_database, token) == guest
    assert count(migrated_database, "SELECT count(*) FROM login_attempts") == 0
    assert count(migrated_database, "SELECT count(*) FROM identities") == 0


def test_a_replayed_callback_changes_nothing(migrated_database: Engine) -> None:
    ann = identity("a|1", "ann@example.com")
    started = begin(migrated_database, guest_token(migrated_database))
    first = finish(migrated_database, started.token, started.state, ann)
    assert isinstance(first, SignedIn)

    replay = finish(migrated_database, first.token, started.state, ann)

    assert replay == Replayed()
    assert signed_in(migrated_database, first.token) is not None


def backend_waits_for_a_lock(database: Engine, pid: int) -> bool:
    with database.connect() as connection:
        wait: str | None = connection.scalar(
            text("SELECT wait_event_type FROM pg_stat_activity WHERE pid = :pid"),
            {"pid": pid},
        )
        return wait == "Lock"


def test_two_sign_ins_with_one_new_email_make_one_account(
    migrated_database: Engine,
) -> None:
    first_attempt = begin(migrated_database, guest_token(migrated_database))
    second_attempt = begin(migrated_database, guest_token(migrated_database))
    sessions = sessionmaker(migrated_database)
    pids: list[int] = []

    def second_sign_in() -> SignedIn | SignInFailed | Replayed:
        with sessions.begin() as session:
            pids.append(session.scalar(text("SELECT pg_backend_pid()")))
            return finish_sign_in(
                session,
                second_attempt.token,
                Callback(second_attempt.state, "code", None),
                identity("google|ann", "ann@example.com"),
            )

    first = sessions()
    try:
        first.begin()
        first_result = finish_sign_in(
            first,
            first_attempt.token,
            Callback(first_attempt.state, "code", None),
            identity("email|ann", "ann@example.com"),
        )
        with ThreadPoolExecutor(max_workers=1) as executor:
            second = executor.submit(second_sign_in)
            deadline = time.monotonic() + 10
            while not (pids and backend_waits_for_a_lock(migrated_database, pids[0])):
                assert not second.done(), "the second sign-in never waited"
                assert time.monotonic() < deadline, "the second sign-in never waited"
                time.sleep(0.05)
            first.commit()
            second_result = second.result(timeout=10)
    finally:
        first.close()

    assert isinstance(first_result, SignedIn)
    # The second browser is a guest, and the email now has an account, so it
    # waits for adoption.
    assert second_result == SignInFailed("/games", SignInError.FAILED)
    assert (
        count(
            migrated_database,
            "SELECT count(*) FROM accounts WHERE email = 'ann@example.com'",
        )
        == 1
    )
