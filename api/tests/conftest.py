import os
import secrets
from collections.abc import Callable, Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, make_url, text

from fortymm_api.database import create_database_engine, migrate
from fortymm_api.main import create_app


@pytest.fixture(autouse=True)
def no_deploy_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Start every test as in local dev, whatever the shell has set."""
    monkeypatch.delenv("WORKER_SECRET", raising=False)
    monkeypatch.delenv("K_SERVICE", raising=False)


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(create_app()) as client:
        yield client


@pytest.fixture
def throwaway_database_url() -> Iterator[str]:
    """A new, empty database for one test, dropped after it.

    Tests that make tables use one, so the dev database's schema stays what
    its migrations say and `alembic check` passes.
    """
    url = make_url(os.environ["DATABASE_URL"])
    name = f"fortymm_test_{secrets.token_hex(4)}"
    admin = create_database_engine(url.render_as_string(hide_password=False))
    admin = admin.execution_options(isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.execute(text(f"CREATE DATABASE {name}"))
    try:
        yield url.set(database=name).render_as_string(hide_password=False)
    finally:
        with admin.connect() as connection:
            connection.execute(text(f"DROP DATABASE {name} WITH (FORCE)"))
        admin.engine.dispose()


@pytest.fixture
def migrated_database(throwaway_database_url: str) -> Iterator[Engine]:
    """An engine for a throwaway database that the migrations have run on."""
    engine = create_database_engine(throwaway_database_url)
    migrate(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def players_have_activity(monkeypatch: pytest.MonkeyPatch) -> None:
    """Treat every player as one that has played, so a sign-in asks "Is this
    you?" about it, without a match for each player. A test of what counts
    as having played makes the matches (`services/test_player_matches.py`)."""
    monkeypatch.setattr(
        "fortymm_api.services.adoption.has_activity", lambda session, player: True
    )


@pytest.fixture
def spend_guest_budget(migrated_database: Engine) -> Callable[[str], None]:
    """Spend a network's guest account budget for the current window, so its
    next guest start, or sign-in with no session, gets
    `GuestAccountLimitReached`."""

    def spend(network: str) -> None:
        with migrated_database.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO guest_account_counts"
                    " (network, window_ends_at, started)"
                    " VALUES (CAST(:network AS cidr), now() + interval '1 minute', 30)"
                ),
                {"network": network},
            )

    return spend
