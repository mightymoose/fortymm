import os
import secrets
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import make_url, text

from fortymm_api.database import create_database_engine
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
