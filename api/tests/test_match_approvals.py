"""The HTTP layer of a match's approvals. tests/services/test_match_results.py
covers the rules."""

import hashlib
from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from match_setup import add_match
from sqlalchemy import Engine, insert, text
from sqlalchemy.orm import sessionmaker

from fortymm_api.accounts import PlayerId
from fortymm_api.main import create_app
from fortymm_api.matches import MatchId
from fortymm_api.models import Account, Player, PlayerManager
from fortymm_api.services.matches import MatchDetails
from fortymm_api.services.signing_keys import register_key
from fortymm_api.signed_results import (
    Completed,
    MatchResult,
    append_signature,
    encode_payload,
    sign,
)
from fortymm_api.signing_keys import SigningPrivateKey

JSON = {"Content-Type": "application/json"}
MATCH = MatchId(UUID("6f1c2a52-3c1e-4d51-9b0c-0d6f9f0a1b01"))
ANN = PlayerId(UUID("0b7f3e0c-1a2b-4c3d-8e4f-5a6b7c8d9e01"))
BOB = PlayerId(UUID("0b7f3e0c-1a2b-4c3d-8e4f-5a6b7c8d9e02"))
ANN_KEY = SigningPrivateKey(hashlib.sha256(b"ann's route device").digest())
BOB_KEY = SigningPrivateKey(hashlib.sha256(b"bob's route device").digest())
ISSUED_AT = datetime(2026, 11, 3, 18, 30, tzinfo=UTC)
RESULT = MatchResult(
    match=MATCH,
    best_of=3,
    rated=False,
    players=(ANN, BOB),
    games=((11, 5), (11, 7)),
    ending=Completed(),
)
PATH = f"/v1/matches/{MATCH}/approvals"


@pytest.fixture
def client(
    migrated_database: Engine,
    throwaway_database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[TestClient]:
    """Ann and Bob, each playing as their own player with their own key, and
    the match between them, which Ann's account made."""
    with sessionmaker(migrated_database).begin() as session:
        accounts = []
        for player, key in ((ANN, ANN_KEY), (BOB, BOB_KEY)):
            session.execute(
                insert(Player).values(id=player, display_name=f"player {player}")
            )
            account = session.scalars(insert(Account).returning(Account.id)).one()
            session.add(
                PlayerManager(player_id=player, account_id=account, relationship="self")
            )
            session.flush()
            register_key(
                session,
                account,
                public_key=key.public_key.to_cose_key(),
                proof=key.registration_proof(account),
                label="Phone",
            )
            accounts.append(account)
        add_match(session, MATCH, MatchDetails.of(RESULT), accounts[0])
    monkeypatch.setenv("DATABASE_URL", throwaway_database_url)
    # The session cookie is Secure, so the client sends it only over https.
    with TestClient(
        create_app(), base_url="https://testserver", client=("203.0.113.7", 50000)
    ) as client:
        yield client


@pytest.fixture
def scorer(client: TestClient, migrated_database: Engine) -> None:
    """A guest session that holds `matches.score`, through the default role."""
    with migrated_database.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO role_permissions (role_id, permission_key)"
                " SELECT id, 'matches.score' FROM roles WHERE is_default"
            )
        )
    client.post("/v1/session", headers=JSON)


def envelope(result: MatchResult = RESULT) -> str:
    return append_signature(sign(result, ISSUED_AT, ANN_KEY, ANN), BOB_KEY, BOB).hex()


@pytest.mark.usefixtures("scorer")
def test_a_recorded_result_answers_201(client: TestClient) -> None:
    response = client.post(PATH, headers=JSON, json={"envelope": envelope()})

    assert response.status_code == 201
    kids = sorted([ANN_KEY.public_key.kid, BOB_KEY.public_key.kid])
    sides = {ANN_KEY.public_key.kid: (ANN, 0), BOB_KEY.public_key.kid: (BOB, 1)}
    data = response.json()["data"]
    assert data == {
        "hash": hashlib.sha256(encode_payload(RESULT, ISSUED_AT)).hexdigest(),
        "match_id": str(MATCH),
        "approvals": [
            {
                "key_id": kid.hex(),
                "player_id": str(sides[kid][0]),
                "side": sides[kid][1],
                "authority": "self",
            }
            for kid in kids
        ],
        "accepted_at": data["accepted_at"],
    }
    assert data["accepted_at"] is not None


@pytest.mark.usefixtures("scorer")
def test_a_refused_result_answers_409_in_the_errors_shape(
    client: TestClient,
) -> None:
    client.post(PATH, headers=JSON, json={"envelope": envelope()})
    fresh = replace(RESULT, games=((11, 9), (11, 7)))

    response = client.post(PATH, headers=JSON, json={"envelope": envelope(fresh)})

    assert response.status_code == 409
    title = "The result doesn't replace the match's newest result"
    assert response.json() == {"errors": [{"status": "409", "title": title}]}


@pytest.mark.usefixtures("scorer")
def test_a_refused_result_answers_422_in_the_errors_shape(
    client: TestClient,
) -> None:
    response = client.post(PATH, headers=JSON, json={"envelope": "00"})

    assert response.status_code == 422
    assert response.json() == {
        "errors": [
            {"status": "422", "title": "The envelope isn't a FortyMM signed result"}
        ]
    }


@pytest.mark.usefixtures("scorer")
def test_a_body_without_json_answers_415(client: TestClient) -> None:
    response = client.post(PATH, content=f'{{"envelope": "{envelope()}"}}')

    assert response.status_code == 415


@pytest.mark.usefixtures("scorer")
def test_a_result_for_an_unknown_match_answers_404(client: TestClient) -> None:
    other = MatchId(UUID("6f1c2a52-3c1e-4d51-9b0c-0d6f9f0a1b02"))
    data = envelope(replace(RESULT, match=other))

    response = client.post(
        f"/v1/matches/{other}/approvals", headers=JSON, json={"envelope": data}
    )

    assert response.status_code == 404
    assert response.json() == {
        "errors": [{"status": "404", "title": "No match has this id"}]
    }


def test_a_result_needs_a_session_holding_matches_score(client: TestClient) -> None:
    body = {"envelope": envelope()}

    signed_out = client.post(PATH, headers=JSON, json=body)
    client.post("/v1/session", headers=JSON)
    without = client.post(PATH, headers=JSON, json=body)

    assert signed_out.status_code == 401
    assert without.status_code == 403
