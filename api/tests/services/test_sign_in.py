import uuid
from collections.abc import Callable
from ipaddress import ip_address

import pytest
from locks import wait_behind
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
from fortymm_api.ownership import OWNERSHIP_RULES, OwnershipRule
from fortymm_api.services.sessions import (
    GUEST_ACCOUNT_LIMIT,
    AccountAdopted,
    GuestAccountLimitReached,
    authenticate,
    lock_account_for_write,
    new_session,
    start_session,
)
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
        (None, OTHER, SwitchAccount(OTHER)),
        (None, None, CreateAccount()),
    ],
)
def test_resolves_each_login(
    current: CurrentAccount | None, owner: AccountId | None, outcome: object
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
    login_state: str | None = None,
    error: str | None = None,
) -> SignedIn | SignInFailed | Replayed:
    return in_transaction(
        database,
        lambda session: finish_sign_in(
            session, token, login_state, Callback(state, "code", error), exchange
        ),
    )


def sign_in(database: Engine, token: str | None, exchange: ExchangeCode) -> str:
    """Sign the token's browser in, and return its new token."""
    started = begin(database, token)
    result = finish(
        database,
        started.token,
        started.state,
        exchange,
        login_state=started.login_state,
    )
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


BOB = identity("email|bob", "bob@example.com")


def bob_signed_in(database: Engine) -> tuple[str, AccountId]:
    """Bob's verified account, and the token of the browser he signed in on."""
    token = sign_in(database, guest_token(database), BOB)
    return token, account_of(database, token).id


def add_managed_player(session: Session, account: AccountId, name: str) -> None:
    session.execute(
        text(
            "WITH player AS ("
            "  INSERT INTO players (display_name) VALUES (:name) RETURNING id"
            ") INSERT INTO player_managers (player_id, account_id, relationship)"
            " SELECT id, :account, 'managed' FROM player"
        ),
        {"name": name, "account": account},
    )


def managers_of_players_from(
    database: Engine, guest: AccountId
) -> list[tuple[AccountId, str]]:
    with database.connect() as connection:
        rows = connection.execute(
            text(
                "SELECT account_id, relationship FROM player_managers"
                " WHERE adopted_from = :guest"
            ),
            {"guest": guest},
        ).all()
    return [(row.account_id, row.relationship) for row in rows]


def managed_by(database: Engine, account: AccountId) -> int:
    return count(
        database,
        "SELECT count(*) FROM player_managers WHERE account_id = :id",
        id=account,
    )


def test_adoption_hands_the_guests_players_and_browser_to_the_account(
    migrated_database: Engine,
) -> None:
    _, bob = bob_signed_in(migrated_database)
    first_browser = guest_token(migrated_database)
    guest = account_of(migrated_database, first_browser).id
    _, second_browser = in_transaction(
        migrated_database, lambda session: new_session(session, guest)
    )
    in_transaction(
        migrated_database,
        lambda session: add_managed_player(session, guest, "guest's friend"),
    )

    new_token = sign_in(migrated_database, first_browser, BOB)

    assert account_of(migrated_database, new_token).id == bob
    assert signed_in(migrated_database, first_browser) is None
    assert signed_in(migrated_database, second_browser) is None
    assert managers_of_players_from(migrated_database, guest) == [
        (bob, "managed"),
        (bob, "managed"),
    ]
    assert managed_by(migrated_database, guest) == 0


def test_adoption_keeps_the_accounts_other_sessions(
    migrated_database: Engine,
) -> None:
    bobs_laptop, bob = bob_signed_in(migrated_database)

    sign_in(migrated_database, guest_token(migrated_database), BOB)

    assert account_of(migrated_database, bobs_laptop).id == bob


def test_adoption_keeps_the_guest_account_and_names_its_new_owner(
    migrated_database: Engine,
) -> None:
    _, bob = bob_signed_in(migrated_database)
    token = guest_token(migrated_database)
    guest = account_of(migrated_database, token).id

    sign_in(migrated_database, token, BOB)

    assert (
        count(
            migrated_database,
            "SELECT count(*) FROM accounts WHERE id = :id AND adopted_into = :bob",
            id=guest,
            bob=bob,
        )
        == 1
    )


def test_a_new_identity_that_adopts_a_guest_belongs_to_the_account(
    migrated_database: Engine,
) -> None:
    _, bob = bob_signed_in(migrated_database)
    token = guest_token(migrated_database)
    guest = account_of(migrated_database, token).id

    new_token = sign_in(
        migrated_database, token, identity("google|bob", "bob@example.com")
    )

    assert account_of(migrated_database, new_token).id == bob
    identities = "SELECT count(*) FROM identities WHERE account_id = :id"
    assert count(migrated_database, identities, id=bob) == 2
    assert count(migrated_database, identities, id=guest) == 0


def test_adoption_moves_the_rows_of_every_table_whose_rule_says_so(
    migrated_database: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    with migrated_database.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE notes ("
                "  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"
                "  author_id uuid REFERENCES accounts (id)"
                ")"
            )
        )
    monkeypatch.setitem(
        OWNERSHIP_RULES, ("notes", "author_id"), OwnershipRule.MOVES_ON_ADOPT
    )
    _, bob = bob_signed_in(migrated_database)
    token = guest_token(migrated_database)
    guest = account_of(migrated_database, token).id
    with migrated_database.begin() as connection:
        connection.execute(
            text("INSERT INTO notes (author_id) VALUES (:id), (:id)"), {"id": guest}
        )

    sign_in(migrated_database, token, BOB)

    notes = "SELECT count(*) FROM notes WHERE author_id = :id"
    assert count(migrated_database, notes, id=bob) == 2
    assert count(migrated_database, notes, id=guest) == 0


def accounts_and_managers(database: Engine) -> list[tuple[object, ...]]:
    with database.connect() as connection:
        return [
            tuple(row)
            for row in connection.execute(
                text(
                    "SELECT a.id, a.email, a.adopted_into, m.player_id,"
                    " m.relationship, m.adopted_from"
                    " FROM accounts a"
                    " LEFT JOIN player_managers m ON m.account_id = a.id"
                    " ORDER BY a.id, m.player_id"
                )
            )
        ]


def test_a_replayed_adoption_changes_nothing(migrated_database: Engine) -> None:
    _, bob = bob_signed_in(migrated_database)
    started = begin(migrated_database, guest_token(migrated_database))
    first = finish(migrated_database, started.token, started.state, BOB)
    assert isinstance(first, SignedIn)
    before = accounts_and_managers(migrated_database)

    replay = finish(migrated_database, first.token, started.state, BOB)

    assert replay == Replayed()
    assert accounts_and_managers(migrated_database) == before
    assert account_of(migrated_database, first.token).id == bob


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


def finish_with(
    attempt: LoginStarted, exchange: ExchangeCode
) -> Callable[[Session], SignedIn | SignInFailed | Replayed]:
    return lambda session: finish_sign_in(
        session,
        attempt.token,
        attempt.login_state,
        Callback(attempt.state, "code", None),
        exchange,
    )


def test_a_browser_with_no_session_signs_in_with_no_guest_account(
    migrated_database: Engine,
) -> None:
    # Such as after a sign-out. A guest account here would hold nothing, yet
    # its player would ask "Is this you?".
    token = sign_in(migrated_database, guest_token(migrated_database), ANN_IDENTITY)
    ann = account_of(migrated_database, token)
    before = accounts_and_managers(migrated_database)

    started = begin(migrated_database, None)
    result = finish(
        migrated_database,
        None,
        started.state,
        ANN_IDENTITY,
        login_state=started.login_state,
    )

    assert started.token is None
    assert isinstance(result, SignedIn)
    assert account_of(migrated_database, result.token) == ann
    assert accounts_and_managers(migrated_database) == before


def test_a_browser_with_no_session_and_a_new_email_gets_a_new_account(
    migrated_database: Engine,
) -> None:
    token = sign_in(migrated_database, None, ANN_IDENTITY)

    created = account_of(migrated_database, token)
    assert created == VerifiedAccount(created.id, Email("ann@example.com"))
    assert count(migrated_database, "SELECT count(*) FROM accounts") == 1
    # start_session() gives it a self player on the next POST /v1/session.
    assert count(migrated_database, "SELECT count(*) FROM player_managers") == 0


@pytest.mark.parametrize("case", ["no login cookie", "another browser's"])
def test_a_sign_in_with_no_session_needs_the_browser_that_started_it(
    migrated_database: Engine, case: str
) -> None:
    started = begin(migrated_database, None)
    other = begin(migrated_database, None)
    login_state = None if case == "no login cookie" else other.login_state

    result = finish(
        migrated_database,
        None,
        started.state,
        ANN_IDENTITY,
        login_state=login_state,
    )

    assert result == SignInFailed("/games", SignInError.FAILED)
    assert count(migrated_database, "SELECT count(*) FROM accounts") == 0


def test_a_guest_started_during_a_sign_in_with_no_session_is_adopted(
    migrated_database: Engine,
) -> None:
    _, bob = bob_signed_in(migrated_database)
    started = begin(migrated_database, None)
    # Another tab opened Home meanwhile.
    token = guest_token(migrated_database)
    guest = account_of(migrated_database, token).id

    result = finish(
        migrated_database, token, started.state, BOB, login_state=started.login_state
    )

    assert isinstance(result, SignedIn)
    assert account_of(migrated_database, result.token).id == bob
    assert managers_of_players_from(migrated_database, guest) == [(bob, "managed")]


def test_a_sign_in_with_no_session_counts_toward_the_guest_account_limit(
    migrated_database: Engine,
) -> None:
    for _ in range(GUEST_ACCOUNT_LIMIT):
        begin(migrated_database, None)

    with pytest.raises(GuestAccountLimitReached):
        begin(migrated_database, None)
    assert count(migrated_database, "SELECT count(*) FROM accounts") == 0


def test_two_sign_ins_with_one_new_email_make_one_account(
    migrated_database: Engine,
) -> None:
    first_attempt = begin(migrated_database, guest_token(migrated_database))
    second_attempt = begin(migrated_database, guest_token(migrated_database))

    first_result, second = wait_behind(
        migrated_database,
        finish_with(first_attempt, identity("email|ann", "ann@example.com")),
        finish_with(second_attempt, identity("google|ann", "ann@example.com")),
    )

    second_result = second.result()
    assert isinstance(first_result, SignedIn)
    # The second browser is a guest, and the email now has an account, so the
    # account adopts it.
    assert isinstance(second_result, SignedIn)
    assert account_of(migrated_database, second_result.token) == account_of(
        migrated_database, first_result.token
    )
    assert (
        count(
            migrated_database,
            "SELECT count(*) FROM accounts WHERE email = 'ann@example.com'",
        )
        == 1
    )


def create_player(guest: AccountId) -> Callable[[Session], None]:
    """A write as the guest account, as a route that creates a player makes."""

    def create(session: Session) -> None:
        lock_account_for_write(session, guest)
        add_managed_player(session, guest, "made during adoption")

    return create


def players(database: Engine) -> int:
    return count(database, "SELECT count(*) FROM players")


def test_a_player_made_before_adoption_moves_to_the_account(
    migrated_database: Engine,
) -> None:
    _, bob = bob_signed_in(migrated_database)
    token = guest_token(migrated_database)
    attempt = begin(migrated_database, token)
    guest = account_of(migrated_database, token).id

    _, adoption = wait_behind(
        migrated_database, create_player(guest), finish_with(attempt, BOB)
    )

    assert isinstance(adoption.result(), SignedIn)
    assert managed_by(migrated_database, guest) == 0
    assert managers_of_players_from(migrated_database, guest) == [
        (bob, "managed"),
        (bob, "managed"),
    ]


def test_a_write_that_waits_for_adoption_is_refused(
    migrated_database: Engine,
) -> None:
    _, bob = bob_signed_in(migrated_database)
    token = guest_token(migrated_database)
    attempt = begin(migrated_database, token)
    guest = account_of(migrated_database, token).id
    before = players(migrated_database)

    adoption, create = wait_behind(
        migrated_database, finish_with(attempt, BOB), create_player(guest)
    )

    assert isinstance(adoption, SignedIn)
    assert isinstance(create.exception(), AccountAdopted)
    assert players(migrated_database) == before
    assert managed_by(migrated_database, guest) == 0
    assert managers_of_players_from(migrated_database, guest) == [(bob, "managed")]
