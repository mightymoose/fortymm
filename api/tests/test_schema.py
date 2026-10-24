import uuid
from collections.abc import Iterator

import psycopg
import pytest
from sqlalchemy import Connection, Engine, text
from sqlalchemy.exc import IntegrityError, ProgrammingError


@pytest.fixture
def connection(migrated_database: Engine) -> Iterator[Connection]:
    with migrated_database.connect() as connection:
        yield connection


def add_account(connection: Connection) -> uuid.UUID:
    id: uuid.UUID = connection.scalar(
        text("INSERT INTO accounts DEFAULT VALUES RETURNING id")
    )
    return id


def add_player(connection: Connection, display_name: str = "Ann") -> uuid.UUID:
    id: uuid.UUID = connection.scalar(
        text("INSERT INTO players (display_name) VALUES (:name) RETURNING id"),
        {"name": display_name},
    )
    return id


def add_manager(
    connection: Connection,
    player_id: uuid.UUID,
    account_id: uuid.UUID,
    relationship: str = "self",
) -> None:
    connection.execute(
        text(
            "INSERT INTO player_managers (player_id, account_id, relationship)"
            " VALUES (:player_id, :account_id, :relationship)"
        ),
        {
            "player_id": player_id,
            "account_id": account_id,
            "relationship": relationship,
        },
    )


def add_session(
    connection: Connection, account_id: uuid.UUID, token_hash: bytes
) -> None:
    connection.execute(
        text(
            "INSERT INTO sessions (token_hash, account_id, expires_at)"
            " VALUES (:token_hash, :account_id, now() + interval '1 day')"
        ),
        {"token_hash": token_hash, "account_id": account_id},
    )


def violated_constraint(error: pytest.ExceptionInfo[IntegrityError]) -> str | None:
    orig = error.value.orig
    assert isinstance(orig, psycopg.Error)
    return orig.diag.constraint_name


def test_an_email_is_lowercase(connection: Connection) -> None:
    with pytest.raises(IntegrityError) as error:
        connection.execute(text("INSERT INTO accounts (email) VALUES ('Ann@x.com')"))

    assert violated_constraint(error) == "ck_accounts_email_lowercase"


def test_an_account_cannot_be_adopted_into_itself(connection: Connection) -> None:
    account = add_account(connection)

    with pytest.raises(IntegrityError) as error:
        connection.execute(
            text("UPDATE accounts SET adopted_into = id WHERE id = :id"),
            {"id": account},
        )

    assert violated_constraint(error) == "ck_accounts_not_adopted_into_self"


def test_a_player_cannot_be_merged_into_itself(connection: Connection) -> None:
    player = add_player(connection)

    with pytest.raises(IntegrityError) as error:
        connection.execute(
            text("UPDATE players SET merged_into = id WHERE id = :id"),
            {"id": player},
        )

    assert violated_constraint(error) == "ck_players_not_merged_into_self"


def test_a_player_is_never_deleted(connection: Connection) -> None:
    player = add_player(connection)

    with pytest.raises(ProgrammingError, match="players are never deleted"):
        connection.execute(text("DELETE FROM players WHERE id = :id"), {"id": player})


def test_display_names_are_unique_whatever_their_case(
    connection: Connection,
) -> None:
    add_player(connection, "Ann")

    with pytest.raises(IntegrityError) as error:
        add_player(connection, "aNN")

    assert violated_constraint(error) == "unique_display_name"


def test_an_account_has_at_most_one_self_player(connection: Connection) -> None:
    account = add_account(connection)
    add_manager(connection, add_player(connection, "Ann"), account)

    with pytest.raises(IntegrityError) as error:
        add_manager(connection, add_player(connection, "Bob"), account)

    assert violated_constraint(error) == "one_self_player_per_account"


def test_an_account_can_manage_other_players_beside_its_self_player(
    connection: Connection,
) -> None:
    account = add_account(connection)
    add_manager(connection, add_player(connection, "Ann"), account)
    add_manager(connection, add_player(connection, "Bob"), account, "managed")
    add_manager(connection, add_player(connection, "Cy"), account, "managed")


def test_a_player_has_at_most_one_self_account(connection: Connection) -> None:
    player = add_player(connection)
    add_manager(connection, player, add_account(connection))

    with pytest.raises(IntegrityError) as error:
        add_manager(connection, player, add_account(connection))

    assert violated_constraint(error) == "one_self_account_per_player"


def test_a_player_can_have_managers_beside_its_self_account(
    connection: Connection,
) -> None:
    player = add_player(connection)
    add_manager(connection, player, add_account(connection))
    add_manager(connection, player, add_account(connection), "managed")
    add_manager(connection, player, add_account(connection), "managed")


def test_an_account_manages_a_player_once(connection: Connection) -> None:
    player = add_player(connection)
    account = add_account(connection)
    add_manager(connection, player, account, "managed")

    with pytest.raises(IntegrityError) as error:
        add_manager(connection, player, account, "managed")

    assert violated_constraint(error) == "uq_player_managers_player_id"


def test_two_sessions_cannot_share_a_token_hash(connection: Connection) -> None:
    token_hash = uuid.uuid4().bytes
    add_session(connection, add_account(connection), token_hash)

    with pytest.raises(IntegrityError) as error:
        add_session(connection, add_account(connection), token_hash)

    assert violated_constraint(error) == "uq_sessions_token_hash"
