from collections.abc import Callable
from ipaddress import ip_address

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.orm import Session, sessionmaker

from fortymm_api.accounts import PlayerId
from fortymm_api.services.sessions import StartedSession, start_session

ANN = ip_address("203.0.113.7")


def in_transaction[T](database: Engine, work: Callable[[Session], T]) -> T:
    with sessionmaker(database).begin() as session:
        return work(session)


def start(database: Engine, token: str | None = None) -> StartedSession:
    return in_transaction(database, lambda session: start_session(session, token, ANN))


def in_default_league(database: Engine, player_id: PlayerId) -> bool:
    with database.connect() as connection:
        found: bool = connection.scalar(
            text(
                "SELECT EXISTS (SELECT FROM league_members"
                " JOIN leagues ON leagues.id = league_id"
                " WHERE is_default AND player_id = :id)"
            ),
            {"id": player_id},
        )
        return found


def players_outside_default_league(database: Engine) -> int:
    with database.connect() as connection:
        missing: int = connection.scalar(
            text(
                "SELECT count(*) FROM players WHERE NOT EXISTS"
                " (SELECT FROM league_members JOIN leagues ON leagues.id = league_id"
                " WHERE is_default AND player_id = players.id)"
            )
        )
        return missing


def test_the_migration_makes_one_default_league(migrated_database: Engine) -> None:
    with migrated_database.connect() as connection:
        leagues = connection.execute(text("SELECT name, is_default FROM leagues")).all()

    assert leagues == [("FortyMM", True)]


def test_a_new_guests_player_joins_the_default_league(
    migrated_database: Engine,
) -> None:
    started = start(migrated_database)

    assert in_default_league(migrated_database, started.player.id)


def test_a_new_self_player_on_resume_joins_the_default_league(
    migrated_database: Engine,
) -> None:
    first = start(migrated_database)
    with migrated_database.begin() as connection:
        connection.execute(
            text("DELETE FROM player_managers WHERE account_id = :id"),
            {"id": first.account.id},
        )

    resumed = start(migrated_database, first.token)

    assert resumed.player != first.player
    assert in_default_league(migrated_database, resumed.player.id)


def test_every_player_is_in_the_default_league(migrated_database: Engine) -> None:
    first = start(migrated_database)
    with migrated_database.begin() as connection:
        connection.execute(
            text("DELETE FROM player_managers WHERE account_id = :id"),
            {"id": first.account.id},
        )
    start(migrated_database, first.token)

    assert players_outside_default_league(migrated_database) == 0


def test_a_player_cannot_be_made_without_a_default_league(
    migrated_database: Engine,
) -> None:
    with migrated_database.begin() as connection:
        connection.execute(text("UPDATE leagues SET is_default = false"))

    with pytest.raises(ProgrammingError, match="no default league"):
        start(migrated_database)

    with migrated_database.connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM players")) == 0
