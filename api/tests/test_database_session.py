from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from fortymm_api.database import DatabaseSession, create_database_engine
from fortymm_api.main import create_app

JSON = {"Content-Type": "application/json"}


@pytest.fixture
def database(throwaway_database_url: str) -> Iterator[Engine]:
    engine = create_database_engine(throwaway_database_url)
    with engine.begin() as connection:
        connection.execute(
            text("CREATE TABLE notes (body text UNIQUE DEFERRABLE INITIALLY DEFERRED)")
        )
    yield engine
    engine.dispose()


@pytest.fixture
def client(
    database: Engine, throwaway_database_url: str, monkeypatch: pytest.MonkeyPatch
) -> Iterator[TestClient]:
    monkeypatch.setenv("DATABASE_URL", throwaway_database_url)
    app = create_app()
    add_routes(app)
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


def add_routes(app: FastAPI) -> None:
    @app.post("/notes")
    def add_note(session: DatabaseSession) -> None:
        session.execute(text("INSERT INTO notes VALUES ('kept')"))

    @app.post("/notes-then-fail")
    def add_note_then_fail(session: DatabaseSession) -> None:
        session.execute(text("INSERT INTO notes VALUES ('lost')"))
        raise RuntimeError("the route failed after writing")

    @app.post("/notes-that-fail-to-commit")
    def add_duplicate_notes(session: DatabaseSession) -> None:
        # The unique check is deferred, so the commit is what fails.
        session.execute(text("INSERT INTO notes VALUES ('twice'), ('twice')"))


def notes(database: Engine) -> list[str]:
    with database.connect() as connection:
        return list(connection.scalars(text("SELECT body FROM notes")))


def test_commits_a_request_that_succeeds(client: TestClient, database: Engine) -> None:
    assert client.post("/notes", headers=JSON).status_code == 200
    assert notes(database) == ["kept"]


def test_rolls_back_a_request_that_fails(client: TestClient, database: Engine) -> None:
    assert client.post("/notes-then-fail", headers=JSON).status_code == 500
    assert notes(database) == []


def test_answers_500_when_the_commit_fails(
    client: TestClient, database: Engine
) -> None:
    assert client.post("/notes-that-fail-to-commit", headers=JSON).status_code == 500
    assert notes(database) == []
