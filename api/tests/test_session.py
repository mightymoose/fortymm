import hashlib
import secrets
import uuid
from collections.abc import Iterator
from datetime import datetime, timedelta
from http.cookies import SimpleCookie

import httpx2 as httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from fortymm_api.accounts import GuestAccount
from fortymm_api.auth import RequestAccount
from fortymm_api.main import create_app

COOKIE = "__Host-fortymm_session"
MAX_AGE = 34560000
JSON = {"Content-Type": "application/json"}


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
        kind = "guest" if isinstance(account, GuestAccount) else "verified"
        return {"id": str(account.id), "kind": kind}


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
    assert len(cookie.value) == 43  # 32 bytes, base64url without padding
    return cookie.value


def token_hash(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


def expires_at(database: Engine, token: str) -> datetime | None:
    with database.connect() as connection:
        expiry: datetime | None = connection.scalar(
            text("SELECT expires_at FROM sessions WHERE token_hash = :token_hash"),
            {"token_hash": token_hash(token)},
        )
        return expiry


def run(database: Engine, sql: str, **params: object) -> None:
    with database.begin() as connection:
        connection.execute(text(sql), params)


def expire(database: Engine, token: str) -> None:
    run(
        database,
        "UPDATE sessions SET expires_at = now() - interval '1 second'"
        " WHERE token_hash = :token_hash",
        token_hash=token_hash(token),
    )


def adopt(database: Engine, account_id: str) -> None:
    """Adopt the account into a new one, as adoption will (no route does yet)."""
    run(
        database,
        "WITH adopter AS (INSERT INTO accounts DEFAULT VALUES RETURNING id)"
        " UPDATE accounts SET adopted_into = (SELECT id FROM adopter) WHERE id = :id",
        id=account_id,
    )


def assert_new_guest(response: httpx.Response, old_token: str) -> str:
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.json()["data"]["account"]["kind"] == "guest"
    token = session_cookie(response)
    assert token != old_token
    return token


def test_starts_a_guest_session_without_a_cookie(
    client: TestClient, migrated_database: Engine
) -> None:
    response = start_session(client)

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.json() == {
        "data": {"account": {"id": account_id(response), "kind": "guest"}}
    }
    uuid.UUID(account_id(response))
    token = session_cookie(response)
    expiry = expires_at(migrated_database, token)
    assert expiry is not None
    assert expiry - datetime.now(expiry.tzinfo) > timedelta(days=399)


def test_resumes_a_valid_session(client: TestClient, migrated_database: Engine) -> None:
    first = start_session(client)
    token = session_cookie(first)
    run(
        migrated_database,
        "UPDATE sessions SET expires_at = now() + interval '1 day'"
        " WHERE token_hash = :token_hash",
        token_hash=token_hash(token),
    )

    response = start_session(client)

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.json() == {
        "data": {"account": {"id": account_id(first), "kind": "guest"}}
    }
    assert session_cookie(response) == token
    expiry = expires_at(migrated_database, token)
    assert expiry is not None
    assert expiry - datetime.now(expiry.tzinfo) > timedelta(days=399)


def test_resuming_a_session_records_the_account_as_seen(
    client: TestClient, migrated_database: Engine
) -> None:
    first = start_session(client)
    run(
        migrated_database,
        "UPDATE accounts SET last_seen_at = now() - interval '1 day' WHERE id = :id",
        id=account_id(first),
    )

    start_session(client)

    with migrated_database.connect() as connection:
        seen = connection.scalar(
            text(
                "SELECT now() - last_seen_at < interval '1 hour' FROM accounts"
                " WHERE id = :id"
            ),
            {"id": account_id(first)},
        )
    assert seen is True


def test_resumes_a_verified_accounts_session(
    client: TestClient, migrated_database: Engine
) -> None:
    first = start_session(client)
    run(
        migrated_database,
        "UPDATE accounts SET email = 'ann@example.com' WHERE id = :id",
        id=account_id(first),
    )

    response = start_session(client)

    assert response.json() == {
        "data": {"account": {"id": account_id(first), "kind": "verified"}}
    }


def test_starts_a_guest_session_for_an_unknown_cookie(client: TestClient) -> None:
    unknown = secrets.token_urlsafe(32)
    client.cookies.set(COOKIE, unknown)

    assert_new_guest(start_session(client), unknown)


def test_replaces_an_expired_session(
    client: TestClient, migrated_database: Engine
) -> None:
    first = start_session(client)
    old_token = session_cookie(first)
    expire(migrated_database, old_token)

    response = start_session(client)

    assert_new_guest(response, old_token)
    assert account_id(response) != account_id(first)
    assert expires_at(migrated_database, old_token) is None


def test_replaces_a_session_whose_account_was_adopted(
    client: TestClient, migrated_database: Engine
) -> None:
    first = start_session(client)
    old_token = session_cookie(first)
    adopt(migrated_database, account_id(first))

    response = start_session(client)

    assert_new_guest(response, old_token)
    assert account_id(response) != account_id(first)
    assert expires_at(migrated_database, old_token) is None
    with migrated_database.connect() as connection:
        adopted = connection.scalar(
            text("SELECT adopted_into IS NOT NULL FROM accounts WHERE id = :id"),
            {"id": account_id(first)},
        )
    assert adopted is True


def test_rejects_a_request_that_does_not_send_json(client: TestClient) -> None:
    response = client.post("/v1/session")

    assert response.status_code == 415
    assert "Set-Cookie" not in response.headers


NO_SESSION = {
    "errors": [{"status": "401", "title": "The request has no valid session"}]
}


def test_the_dependency_gives_a_route_the_sessions_account(
    client: TestClient,
) -> None:
    first = start_session(client)

    response = client.get("/whoami")

    assert response.status_code == 200
    assert response.json() == {"id": account_id(first), "kind": "guest"}


def test_the_dependency_rejects_a_request_without_a_cookie(
    client: TestClient,
) -> None:
    response = client.get("/whoami")

    assert response.status_code == 401
    assert response.json() == NO_SESSION


def test_the_dependency_rejects_an_unknown_cookie(client: TestClient) -> None:
    client.cookies.set(COOKIE, secrets.token_urlsafe(32))

    response = client.get("/whoami")

    assert response.status_code == 401
    assert response.json() == NO_SESSION


def test_the_dependency_rejects_an_expired_session(
    client: TestClient, migrated_database: Engine
) -> None:
    expire(migrated_database, session_cookie(start_session(client)))

    response = client.get("/whoami")

    assert response.status_code == 401
    assert response.json() == NO_SESSION


def test_the_dependency_rejects_a_session_whose_account_was_adopted(
    client: TestClient, migrated_database: Engine
) -> None:
    adopt(migrated_database, account_id(start_session(client)))

    response = client.get("/whoami")

    assert response.status_code == 401
    assert response.json() == NO_SESSION


def test_the_dependency_starts_no_session(
    client: TestClient, migrated_database: Engine
) -> None:
    client.get("/whoami")

    with migrated_database.connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM accounts")) == 0
