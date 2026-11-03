"""The HTTP layer of a match's approvals. tests/services/test_match_results.py
covers the rules."""

import hashlib
from collections.abc import Iterator
from datetime import UTC, datetime
from ipaddress import ip_address
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.orm import sessionmaker

from fortymm_api.accounts import PlayerId
from fortymm_api.main import create_app
from fortymm_api.matches import MatchId
from fortymm_api.services.sessions import start_session
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
NETWORK = ip_address("203.0.113.7")


@pytest.fixture
def client(
    migrated_database: Engine,
    throwaway_database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[TestClient]:
    with sessionmaker(migrated_database).begin() as session:
        account = start_session(session, None, NETWORK).account.id
        for key in (ANN_KEY, BOB_KEY):
            register_key(
                session,
                account,
                public_key=key.public_key.to_cose_key(),
                proof=key.registration_proof(account),
                label="Phone",
            )
    monkeypatch.setenv("DATABASE_URL", throwaway_database_url)
    with TestClient(create_app()) as client:
        yield client


def envelope() -> str:
    return append_signature(sign(RESULT, ISSUED_AT, ANN_KEY, ANN), BOB_KEY, BOB).hex()


def test_a_checked_result_answers_201_without_a_session(client: TestClient) -> None:
    response = client.post(PATH, headers=JSON, json={"envelope": envelope()})

    assert response.status_code == 201
    assert "set-cookie" not in response.headers
    kids = sorted([ANN_KEY.public_key.kid, BOB_KEY.public_key.kid])
    players = {ANN_KEY.public_key.kid: ANN, BOB_KEY.public_key.kid: BOB}
    assert response.json() == {
        "data": {
            "hash": hashlib.sha256(encode_payload(RESULT, ISSUED_AT)).hexdigest(),
            "match_id": str(MATCH),
            "approvals": [
                {"key_id": kid.hex(), "player_id": str(players[kid])} for kid in kids
            ],
        }
    }


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


def test_a_body_without_json_answers_415(client: TestClient) -> None:
    response = client.post(PATH, content=f'{{"envelope": "{envelope()}"}}')

    assert response.status_code == 415
