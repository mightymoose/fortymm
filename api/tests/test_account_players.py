"""The HTTP layer of the account's players. tests/services/test_players.py
covers the rules."""

import uuid
from collections.abc import Iterator

import httpx2 as httpx
import pytest
from fastapi.testclient import TestClient
from played_matches import played
from sqlalchemy import Engine, text
from sqlalchemy.orm import sessionmaker

from fortymm_api.accounts import PlayerId
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
    leaves a player that has played."""
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


def answer(
    client: TestClient, player_id: str, value: str, body: dict[str, str] | None = None
) -> httpx.Response:
    return client.post(
        f"/v1/account/players/{player_id}/answer",
        headers=JSON,
        json={"answer": value, **(body or {})},
    )


def managed_player(database: Engine, beside: str) -> str:
    """A player that the account of `beside` manages, with no open question,
    made before `beside`."""
    with database.begin() as connection:
        account = connection.scalar(
            text("SELECT account_id FROM player_managers WHERE player_id = :player"),
            {"player": beside},
        )
        player: uuid.UUID = connection.scalar(
            text(
                "INSERT INTO players (display_name, created_at)"
                " VALUES ('able ant 102', now() - interval '1 day') RETURNING id"
            )
        )
        connection.execute(
            text(
                "INSERT INTO player_managers (player_id, account_id, relationship)"
                " VALUES (:player, :account, 'managed')"
            ),
            {"player": player, "account": account},
        )
    return str(player)


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
                "match_count": 0,
                "recent_matches": [],
                "played_against": [],
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
                "match_count": 0,
                "recent_matches": [],
                "played_against": [],
            }
        ],
        "meta": {"outcome": "self"},
    }


def test_a_merge_says_which_player_survived(
    client: TestClient, player: dict[str, str], migrated_database: Engine
) -> None:
    ant = managed_player(migrated_database, player["id"])

    response = answer(client, player["id"], "same_as", {"player_id": ant})

    assert response.status_code == 200
    assert response.json()["meta"] == {
        "outcome": "merged",
        "survivor": ant,
        "merged": player["id"],
    }
    assert [listed["id"] for listed in response.json()["data"]] == [ant]


@pytest.mark.parametrize(
    ("value", "body"),
    [("same_as", {}), ("no", {"player_id": str(uuid.uuid4())})],
    ids=["same_as_without_player_id", "no_with_player_id"],
)
def test_answers_422_when_player_id_and_same_as_dont_go_together(
    client: TestClient, player: dict[str, str], value: str, body: dict[str, str]
) -> None:
    assert answer(client, player["id"], value, body).status_code == 422


def test_answers_422_for_same_as_the_answered_player(
    client: TestClient, player: dict[str, str]
) -> None:
    response = answer(client, player["id"], "same_as", {"player_id": player["id"]})

    assert response.status_code == 422
    assert response.json() == {
        "errors": [{"status": "422", "title": "A player can't be the same as itself"}]
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


@pytest.mark.parametrize("value", ["yes", "same_as"])
def test_answers_409_for_a_merge_of_two_players_who_played_each_other(
    client: TestClient,
    player: dict[str, str],
    migrated_database: Engine,
    value: str,
) -> None:
    ant = managed_player(migrated_database, player["id"])
    if value == "yes":
        with migrated_database.begin() as connection:
            connection.execute(
                text(
                    "UPDATE player_managers SET relationship = 'self'"
                    " WHERE player_id = :ant"
                ),
                {"ant": ant},
            )
    with sessionmaker(migrated_database).begin() as session:
        played(session, (PlayerId(uuid.UUID(ant)), PlayerId(uuid.UUID(player["id"]))))

    listed = client.get("/v1/account/players").json()["data"]
    response = answer(
        client, player["id"], value, {"player_id": ant} if value == "same_as" else {}
    )

    assert {p["id"]: p["played_against"] for p in listed} == {
        ant: [player["id"]],
        player["id"]: [ant],
    }
    assert response.status_code == 409
    assert response.json() == {
        "errors": [
            {
                "status": "409",
                "title": "These players played each other, so they are two people",
            }
        ]
    }


def test_answers_422_for_an_unknown_answer(
    client: TestClient, player: dict[str, str]
) -> None:
    assert answer(client, player["id"], "maybe").status_code == 422


def test_answers_401_without_a_session(client: TestClient) -> None:
    assert client.get("/v1/account/players").status_code == 401
    assert answer(client, str(uuid.uuid4()), "no").status_code == 401
