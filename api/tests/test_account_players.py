"""The HTTP layer of the account's players. tests/services/test_players.py
covers the rules."""

import uuid
from collections.abc import Iterator

import httpx2 as httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from fortymm_api.main import create_app

JSON = {"Content-Type": "application/json"}


@pytest.fixture
def client(
    migrated_database: Engine,
    throwaway_database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[TestClient]:
    monkeypatch.setenv("DATABASE_URL", throwaway_database_url)
    # The session cookie is Secure, so the client sends it only over https.
    with TestClient(
        create_app(), base_url="https://testserver", client=("203.0.113.7", 50000)
    ) as client:
        yield client


@pytest.fixture
def player(client: TestClient, migrated_database: Engine) -> dict[str, str]:
    """The session's player, with its question open, as verify in place
    leaves it."""
    account = client.post("/v1/session", headers=JSON).json()["data"]["account"]
    with migrated_database.begin() as connection:
        connection.execute(
            text(
                "UPDATE player_managers SET relationship = 'managed',"
                " adopted_from = account_id WHERE account_id = :id"
            ),
            {"id": account["id"]},
        )
    found: dict[str, str] = account["player"]
    return found


def answer(client: TestClient, player_id: str, value: str) -> httpx.Response:
    return client.post(
        f"/v1/account/players/{player_id}/answer",
        headers=JSON,
        json={"answer": value},
    )


def test_lists_the_accounts_players(client: TestClient, player: dict[str, str]) -> None:
    response = client.get("/v1/account/players")

    assert response.status_code == 200
    assert response.json() == {
        "data": [
            {
                "id": player["id"],
                "display_name": player["display_name"],
                "relationship": "managed",
                "open_question": True,
            }
        ]
    }


def test_an_answer_returns_the_accounts_players(
    client: TestClient, player: dict[str, str]
) -> None:
    response = answer(client, player["id"], "yes")

    assert response.status_code == 200
    assert response.json() == {
        "data": [
            {
                "id": player["id"],
                "display_name": player["display_name"],
                "relationship": "self",
                "open_question": False,
            }
        ]
    }


def test_answers_404_for_a_player_the_account_doesnt_manage(
    client: TestClient, player: dict[str, str]
) -> None:
    response = answer(client, str(uuid.uuid4()), "no")

    assert response.status_code == 404
    assert response.json() == {
        "errors": [{"status": "404", "title": "You don't manage this player"}]
    }


def test_answers_409_for_not_mine_after_an_answer(
    client: TestClient, player: dict[str, str]
) -> None:
    answer(client, player["id"], "no")

    response = answer(client, player["id"], "not_mine")

    assert response.status_code == 409
    assert response.json() == {
        "errors": [{"status": "409", "title": "This question was already answered"}]
    }


def test_answers_422_for_an_unknown_answer(
    client: TestClient, player: dict[str, str]
) -> None:
    assert answer(client, player["id"], "maybe").status_code == 422


def test_answers_401_without_a_session(client: TestClient) -> None:
    assert client.get("/v1/account/players").status_code == 401
    assert answer(client, str(uuid.uuid4()), "no").status_code == 401
