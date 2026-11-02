"""The HTTP layer of the account's signing keys.
tests/services/test_signing_keys.py covers the rules."""

import hashlib
from collections.abc import Callable, Iterator
from uuid import UUID

import httpx2 as httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine

from fortymm_api.accounts import AccountId
from fortymm_api.main import create_app
from fortymm_api.signing_keys import SigningPrivateKey

JSON = {"Content-Type": "application/json"}
KEY = SigningPrivateKey(hashlib.sha256(b"route test key").digest())
OTHER_KEY = SigningPrivateKey(hashlib.sha256(b"another route test key").digest())
KID = KEY.public_key.kid.hex()
PATH = "/v1/account/signing-keys"

type Browser = Callable[[], TestClient]


@pytest.fixture
def app(
    migrated_database: Engine,
    throwaway_database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[FastAPI]:
    monkeypatch.setenv("DATABASE_URL", throwaway_database_url)
    app = create_app()
    with TestClient(app):
        yield app


@pytest.fixture
def new_browser(app: FastAPI) -> Browser:
    """A browser with its own cookie jar. The session cookie is Secure, so
    it rides only https."""
    return lambda: TestClient(
        app, base_url="https://testserver", client=("203.0.113.7", 50000)
    )


@pytest.fixture
def browser(new_browser: Browser) -> TestClient:
    return new_browser()


def start_session(browser: TestClient) -> AccountId:
    response = browser.post("/v1/session", headers=JSON)
    assert response.status_code == 200
    return AccountId(UUID(response.json()["data"]["account"]["id"]))


def body(
    account: AccountId, key: SigningPrivateKey = KEY, label: str = "Ann's phone"
) -> dict[str, str]:
    return {
        "public_key": key.public_key.to_cose_key().hex(),
        "proof": key.registration_proof(account).hex(),
        "label": label,
    }


def register(browser: TestClient, account: AccountId, **changes: str) -> httpx.Response:
    return browser.post(PATH, headers=JSON, json={**body(account), **changes})


def assert_errors(response: httpx.Response, status: int) -> None:
    assert response.status_code == status
    payload = response.json()
    assert list(payload) == ["errors"]
    [error] = payload["errors"]
    assert error["status"] == str(status)
    assert isinstance(error["title"], str) and error["title"]


def test_registers_a_key(browser: TestClient) -> None:
    account = start_session(browser)

    response = register(browser, account, label="  Ann's phone ")

    assert response.status_code == 200
    key = response.json()["data"]
    assert key == {
        "id": KID,
        "label": "Ann's phone",
        "created_at": key["created_at"],
        "signed_out_at": None,
        "revoked_at": None,
    }
    assert isinstance(key["created_at"], str)


def test_lists_the_accounts_keys(browser: TestClient) -> None:
    account = start_session(browser)
    registered = register(browser, account).json()["data"]
    other = register(browser, account, **body(account, OTHER_KEY)).json()["data"]

    response = browser.get(PATH)

    assert response.status_code == 200
    assert response.json() == {"data": [other, registered]}


def test_revokes_a_key(browser: TestClient) -> None:
    account = start_session(browser)
    registered = register(browser, account).json()["data"]

    response = browser.post(f"{PATH}/{KID}/revoke", headers=JSON)

    assert response.status_code == 200
    key = response.json()["data"]
    assert key == {**registered, "revoked_at": key["revoked_at"]}
    assert isinstance(key["revoked_at"], str)


@pytest.mark.parametrize(
    "change",
    [
        {"label": " "},
        {"public_key": "a0"},
        {"proof": "d2"},
    ],
    ids=["blank label", "not a key", "not a proof"],
)
def test_a_body_that_breaks_a_rule_is_refused_in_the_errors_shape(
    browser: TestClient, change: dict[str, str]
) -> None:
    account = start_session(browser)

    assert_errors(register(browser, account, **change), 422)


@pytest.mark.parametrize(
    "change",
    [
        {"public_key": "A0"},
        {"proof": "not hex"},
        {"label": None},
    ],
    ids=["uppercase hex", "not hex", "no label"],
)
def test_a_body_that_isnt_the_shape_gets_fastapis_422(
    browser: TestClient, change: dict[str, str | None]
) -> None:
    account = start_session(browser)
    payload = {**body(account), **change}
    payload = {k: v for k, v in payload.items() if v is not None}

    response = browser.post(PATH, headers=JSON, json=payload)

    assert response.status_code == 422
    assert "detail" in response.json()


def test_a_key_of_another_account_answers_409(new_browser: Browser) -> None:
    ann, bob = new_browser(), new_browser()
    register(ann, start_session(ann))

    assert_errors(register(bob, start_session(bob)), 409)


def test_revoking_a_key_the_account_doesnt_own_answers_404(
    browser: TestClient,
) -> None:
    start_session(browser)

    assert_errors(browser.post(f"{PATH}/{KID}/revoke", headers=JSON), 404)


def test_a_revoke_path_that_isnt_a_kid_gets_fastapis_422(browser: TestClient) -> None:
    start_session(browser)

    response = browser.post(f"{PATH}/{KID[:-1]}/revoke", headers=JSON)

    assert response.status_code == 422
    assert "detail" in response.json()


def test_a_write_without_json_answers_415(browser: TestClient) -> None:
    account = start_session(browser)

    assert_errors(browser.post(PATH, content=str(body(account))), 415)
    assert_errors(browser.post(f"{PATH}/{KID}/revoke"), 415)


def test_every_route_answers_401_without_a_session(browser: TestClient) -> None:
    account = AccountId(UUID(int=1))

    assert_errors(register(browser, account), 401)
    assert_errors(browser.get(PATH), 401)
    assert_errors(browser.post(f"{PATH}/{KID}/revoke", headers=JSON), 401)
