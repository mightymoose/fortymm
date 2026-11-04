"""The HTTP layer of matches. tests/services/test_matches.py and
tests/services/test_opponents.py cover the rules."""

import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from match_setup import add_player
from sqlalchemy import Engine
from sqlalchemy.orm import sessionmaker

from fortymm_api.main import create_app
from fortymm_api.matches import MatchId
from fortymm_api.models import Player

JSON = {"Content-Type": "application/json"}
MATCH = MatchId(uuid.UUID("01970000-0000-7000-8000-0000000000a1"))


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


def create_body(players: list[dict[str, str]], best_of: int = 5) -> dict[str, object]:
    return {
        "id": str(MATCH),
        "best_of": best_of,
        "rated": False,
        "players": [player["id"] for player in players],
    }


def test_a_new_match_answers_201_and_a_retry_200_with_its_id(
    client: TestClient, players: list[dict[str, str]]
) -> None:
    client.post("/v1/session", headers=JSON)

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


def test_other_details_answer_409_with_what_differs(
    client: TestClient, players: list[dict[str, str]]
) -> None:
    client.post("/v1/session", headers=JSON)
    client.post("/v1/matches", headers=JSON, json=create_body(players))

    response = client.post(
        "/v1/matches", headers=JSON, json=create_body(players, best_of=7)
    )

    assert response.status_code == 409
    title = "The best of differs from the match's"
    assert response.json() == {"errors": [{"status": "409", "title": title}]}


@pytest.mark.parametrize(
    ("other", "title"),
    [
        (None, "A player of the match doesn't exist"),
        (0, "Both sides of the match are the same player"),
    ],
)
def test_players_that_cannot_play_answer_422_in_the_errors_shape(
    client: TestClient, players: list[dict[str, str]], other: int | None, title: str
) -> None:
    client.post("/v1/session", headers=JSON)
    second = {"id": str(uuid.uuid4())} if other is None else players[other]

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
