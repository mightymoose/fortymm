"""The HTTP layer of sessions. tests/services/test_sessions.py covers the rules."""

import secrets
from collections.abc import Iterator
from http.cookies import SimpleCookie

import httpx2 as httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine

from fortymm_api.auth import RequestAccount
from fortymm_api.main import create_app

COOKIE = "__Host-fortymm_session"
MAX_AGE = 34560000
JSON = {"Content-Type": "application/json"}
NO_SESSION = {
    "errors": [{"status": "401", "title": "The request has no valid session"}]
}


@pytest.fixture
def client(
    migrated_database: Engine,
    throwaway_database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[TestClient]:
    monkeypatch.setenv("DATABASE_URL", throwaway_database_url)
    app = create_app()
    add_routes(app)
    # The session cookie is Secure, so the client sends it only over https.
    with TestClient(app, base_url="https://testserver") as client:
        yield client


def add_routes(app: FastAPI) -> None:
    @app.get("/whoami")
    def whoami(account: RequestAccount) -> dict[str, str]:
        return {"id": str(account.id), "kind": account.kind}


def start_session(client: TestClient) -> httpx.Response:
    return client.post("/v1/session", headers=JSON)


def account_id(response: httpx.Response) -> str:
    id: str = response.json()["data"]["account"]["id"]
    return id


def session_cookie(response: httpx.Response) -> str:
    """The token the response's Set-Cookie carries, after checking its attributes."""
    cookie = SimpleCookie(response.headers["Set-Cookie"])[COOKIE]
    assert cookie["path"] == "/"
    assert cookie["secure"] is True
    assert cookie["httponly"] is True
    assert cookie["samesite"].lower() == "lax"
    assert cookie["max-age"] == str(MAX_AGE)
    return cookie.value


def test_answers_with_the_account_and_sets_the_cookie(client: TestClient) -> None:
    response = start_session(client)

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.json() == {
        "data": {"account": {"id": account_id(response), "kind": "guest"}}
    }
    session_cookie(response)


def test_reads_the_cookie_and_sets_it_again(client: TestClient) -> None:
    first = start_session(client)

    response = start_session(client)

    assert response.headers["Cache-Control"] == "no-store"
    assert account_id(response) == account_id(first)
    assert session_cookie(response) == session_cookie(first)


def test_rejects_a_request_that_does_not_send_json(client: TestClient) -> None:
    response = client.post("/v1/session")

    assert response.status_code == 415
    assert "Set-Cookie" not in response.headers


def test_the_dependency_gives_a_route_the_sessions_account(
    client: TestClient,
) -> None:
    first = start_session(client)

    response = client.get("/whoami")

    assert response.status_code == 200
    assert response.json() == {"id": account_id(first), "kind": "guest"}


def test_the_dependency_answers_401_without_a_cookie(client: TestClient) -> None:
    response = client.get("/whoami")

    assert response.status_code == 401
    assert response.json() == NO_SESSION


def test_the_dependency_answers_401_for_an_invalid_session(
    client: TestClient,
) -> None:
    client.cookies.set(COOKIE, secrets.token_urlsafe(32))

    response = client.get("/whoami")

    assert response.status_code == 401
    assert response.json() == NO_SESSION
