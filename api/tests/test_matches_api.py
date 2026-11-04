"""The HTTP layer of matches. tests/services/test_matches.py and
tests/services/test_opponents.py cover the rules. The board and read tests
insert their match with make()."""

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from match_setup import add_match, add_player, merge
from sqlalchemy import Engine, text
from sqlalchemy.orm import sessionmaker

from fortymm_api.accounts import PlayerId
from fortymm_api.main import create_app
from fortymm_api.matches import BestOf, MatchId
from fortymm_api.models import Player
from fortymm_api.services.matches import MatchDetails
from fortymm_api.signed_results import Completed, MatchResult, encode_payload

JSON = {"Content-Type": "application/json"}
MATCH = MatchId(uuid.UUID("01970000-0000-7000-8000-0000000000a1"))
PATH = f"/v1/matches/{MATCH}"


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
def players(migrated_database: Engine) -> list[dict[str, str]]:
    """Two players that nobody manages."""
    with sessionmaker(migrated_database).begin() as session:
        found = [session.get_one(Player, add_player(session)) for _ in range(2)]
        return [{"id": str(p.id), "display_name": p.display_name} for p in found]


@pytest.fixture
def creator(client: TestClient, migrated_database: Engine) -> None:
    """A session whose account is verified and holds Administrator, which
    grants `matches.create`."""
    account = client.post("/v1/session", headers=JSON).json()["data"]["account"]
    with migrated_database.begin() as connection:
        connection.execute(
            text("UPDATE accounts SET email = 'ann@example.com' WHERE id = :id"),
            {"id": account["id"]},
        )
        connection.execute(
            text(
                "INSERT INTO account_roles (account_id, role_id)"
                " SELECT :id, id FROM roles WHERE name = 'Administrator'"
            ),
            {"id": account["id"]},
        )


def create_body(players: list[dict[str, str]], best_of: int = 5) -> dict[str, object]:
    return {
        "id": str(MATCH),
        "best_of": best_of,
        "rated": False,
        "players": [player["id"] for player in players],
    }


@pytest.mark.usefixtures("creator")
def test_a_new_match_answers_201_and_a_retry_200_with_its_id(
    client: TestClient, players: list[dict[str, str]]
) -> None:
    created = client.post("/v1/matches", headers=JSON, json=create_body(players))
    again = client.post("/v1/matches", headers=JSON, json=create_body(players))

    assert created.status_code == 201
    assert again.status_code == 200
    assert created.json() == again.json() == {"data": {"id": str(MATCH)}}


def test_making_a_match_needs_a_session(
    client: TestClient, players: list[dict[str, str]]
) -> None:
    response = client.post("/v1/matches", headers=JSON, json=create_body(players))

    assert response.status_code == 401


def test_making_a_match_needs_matches_create(
    client: TestClient, players: list[dict[str, str]]
) -> None:
    client.post("/v1/session", headers=JSON)

    response = client.post("/v1/matches", headers=JSON, json=create_body(players))

    assert response.status_code == 403
    title = "You don't have permission to do this"
    assert response.json() == {"errors": [{"status": "403", "title": title}]}


@pytest.mark.usefixtures("creator")
def test_other_details_answer_409_with_what_differs(
    client: TestClient, players: list[dict[str, str]]
) -> None:
    client.post("/v1/matches", headers=JSON, json=create_body(players))

    response = client.post(
        "/v1/matches", headers=JSON, json=create_body(players, best_of=7)
    )

    assert response.status_code == 409
    title = "The best of differs from the match's"
    assert response.json() == {"errors": [{"status": "409", "title": title}]}


@pytest.mark.usefixtures("creator")
@pytest.mark.parametrize(
    ("other", "title"),
    [
        ("unknown", "A player of the match doesn't exist"),
        (
            "merged",
            "A player of the match merged into another player. Pick them again",
        ),
        ("same", "Both sides of the match are the same player"),
    ],
)
def test_players_that_cannot_play_answer_422_in_the_errors_shape(
    client: TestClient,
    migrated_database: Engine,
    players: list[dict[str, str]],
    other: str,
    title: str,
) -> None:
    second = {"id": str(uuid.uuid4())}
    if other == "merged":
        with sessionmaker(migrated_database).begin() as session:
            merge(
                session,
                PlayerId(uuid.UUID(players[1]["id"])),
                PlayerId(uuid.UUID(players[0]["id"])),
            )
        second = players[1]
    elif other == "same":
        second = players[0]

    response = client.post(
        "/v1/matches", headers=JSON, json=create_body([players[0], second])
    )

    assert response.status_code == 422
    assert response.json() == {"errors": [{"status": "422", "title": title}]}


def test_opponents_answer_players_by_name_with_a_session(
    client: TestClient, players: list[dict[str, str]]
) -> None:
    assert client.get("/v1/matches/opponents").status_code == 401
    client.post("/v1/session", headers=JSON)

    searched = client.get("/v1/matches/opponents", params={"search": "player "})
    recent = client.get("/v1/matches/opponents")

    assert searched.status_code == 200
    assert searched.json() == {"data": sorted(players, key=lambda p: p["display_name"])}
    assert recent.json() == {"data": []}


def make(database: Engine, players: list[dict[str, str]], best_of: BestOf = 3) -> None:
    first, second = (PlayerId(uuid.UUID(player["id"])) for player in players)
    details = MatchDetails(best_of, False, (first, second))
    with sessionmaker(database).begin() as session:
        add_match(session, MATCH, details)


def board(players: list[dict[str, str]]) -> str:
    first, second = (PlayerId(uuid.UUID(player["id"])) for player in players)
    result = MatchResult(
        match=MATCH,
        best_of=3,
        rated=False,
        players=(first, second),
        games=((11, 5),),
        ending=Completed(),
    )
    return encode_payload(result, datetime(2026, 11, 4, 12, tzinfo=UTC)).hex()


def test_a_board_answers_201_without_a_session(
    client: TestClient, players: list[dict[str, str]], migrated_database: Engine
) -> None:
    make(migrated_database, players)

    response = client.post(
        f"{PATH}/boards", headers=JSON, json={"board": board(players)}
    )

    assert response.status_code == 201
    pushed = response.json()["data"]
    assert pushed == {"match_id": str(MATCH), "received_at": pushed["received_at"]}


def test_a_refused_board_answers_in_the_errors_shape(
    client: TestClient, players: list[dict[str, str]], migrated_database: Engine
) -> None:
    make(migrated_database, players)

    response = client.post(f"{PATH}/boards", headers=JSON, json={"board": "00"})

    assert response.status_code == 422
    title = "The board isn't a FortyMM draft or signed result"
    assert response.json() == {"errors": [{"status": "422", "title": title}]}


def test_a_board_with_other_details_answers_409(
    client: TestClient, players: list[dict[str, str]], migrated_database: Engine
) -> None:
    make(migrated_database, players, best_of=5)

    response = client.post(
        f"{PATH}/boards", headers=JSON, json={"board": board(players)}
    )

    assert response.status_code == 409
    title = "The best of differs from the match's"
    assert response.json() == {"errors": [{"status": "409", "title": title}]}


def test_a_board_for_an_unknown_match_answers_404(
    client: TestClient, players: list[dict[str, str]]
) -> None:
    response = client.post(
        f"{PATH}/boards", headers=JSON, json={"board": board(players)}
    )

    assert response.status_code == 404
    assert response.json() == {
        "errors": [{"status": "404", "title": "No match has this id"}]
    }
