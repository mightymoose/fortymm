"""The HTTP layer of sign-in, run against the mock OpenID Connect provider in
the `oidc` Compose service. tests/services/test_sign_in.py covers the rules.
"""

import json
from collections.abc import Callable, Iterator
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, urlsplit

import httpx2 as httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from fortymm_api.auth import RequestAccount
from fortymm_api.main import create_app

COOKIE = "__Host-fortymm_session"
JSON = {"Content-Type": "application/json"}
CALLBACK = "https://testserver/v1/auth/callback"

type Browser = Callable[[], TestClient]


@pytest.fixture
def app(
    migrated_database: Engine,
    throwaway_database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[FastAPI]:
    monkeypatch.setenv("DATABASE_URL", throwaway_database_url)
    # The tests reach the mock's sign-in page directly, not through the dev
    # server's proxy.
    monkeypatch.delenv("AUTH0_AUTHORIZE_URL", raising=False)
    app = create_app()
    with TestClient(app):
        yield app


@pytest.fixture
def new_browser(app: FastAPI) -> Browser:
    """A browser with its own cookie jar. The cookie is Secure, so it rides
    only https."""
    return lambda: TestClient(
        app,
        base_url="https://testserver",
        client=("203.0.113.7", 50000),
        follow_redirects=False,
    )


@pytest.fixture
def browser(new_browser: Browser) -> TestClient:
    return new_browser()


def start_session(browser: TestClient) -> dict[str, str]:
    response = browser.post("/v1/session", headers=JSON)
    assert response.status_code == 200
    account: dict[str, str] = response.json()["data"]["account"]
    return account


def token(browser: TestClient) -> str | None:
    return browser.cookies.get(COOKIE)


def login(browser: TestClient, return_to: str = "/games?tab=open") -> httpx.Response:
    return browser.get("/v1/auth/login", params={"return_to": return_to})


def at_mock(
    authorize_url: str, sub: str, email: str, *, email_verified: bool = True
) -> str:
    """Sign in at the mock's sign-in page. Returns the callback path it sends
    the browser to."""
    claims = {"email": email, "email_verified": email_verified}
    response = httpx.post(
        authorize_url,
        data={"username": sub, "claims": json.dumps(claims)},
        follow_redirects=False,
    )
    assert response.status_code == 302
    location = response.headers["Location"]
    assert location.startswith(CALLBACK)
    return location.removeprefix("https://testserver")


def sign_in(
    browser: TestClient,
    sub: str,
    email: str,
    *,
    email_verified: bool = True,
    return_to: str = "/games?tab=open",
) -> httpx.Response:
    """Run the whole sign-in, and return the callback's response."""
    authorize_url = login(browser, return_to).headers["Location"]
    callback = at_mock(authorize_url, sub, email, email_verified=email_verified)
    return browser.get(callback)


def signed_in(browser: TestClient, sub: str, email: str) -> dict[str, str]:
    response = sign_in(browser, sub, email)
    assert response.status_code == 302
    return start_session(browser)


def test_login_sends_the_browser_to_the_providers_sign_in_page(
    browser: TestClient,
) -> None:
    response = login(browser)

    assert response.status_code == 302
    assert response.headers["Cache-Control"] == "no-store"
    location = urlsplit(response.headers["Location"])
    assert f"{location.scheme}://{location.netloc}{location.path}" == (
        "http://oidc:8080/default/authorize"
    )
    query = parse_qs(location.query)
    assert query["response_type"] == ["code"]
    assert query["response_mode"] == ["query"]
    assert query["redirect_uri"] == [CALLBACK]
    assert query["code_challenge_method"] == ["S256"]
    assert {"state", "nonce", "code_challenge", "client_id"} <= query.keys()
    assert "prompt" not in query


def test_login_starts_a_guest_account_for_a_browser_with_no_session(
    browser: TestClient,
) -> None:
    response = login(browser)

    assert COOKIE in SimpleCookie(response.headers["Set-Cookie"])
    assert start_session(browser)["kind"] == "guest"


def test_login_makes_a_verified_account_sign_in_again(browser: TestClient) -> None:
    signed_in(browser, "auth0|ann", "ann@example.com")

    location = urlsplit(login(browser).headers["Location"])

    assert parse_qs(location.query)["prompt"] == ["login"]


def test_login_answers_503_without_a_provider(
    app: FastAPI, browser: TestClient
) -> None:
    app.state.identity_provider = None

    response = login(browser)

    assert response.status_code == 503
    assert response.json() == {
        "errors": [{"status": "503", "title": "Sign-in isn't set up on this server"}]
    }


def test_a_guest_with_a_new_email_becomes_verified(browser: TestClient) -> None:
    guest = start_session(browser)
    guest_token = token(browser)

    response = sign_in(browser, "auth0|ann", "Ann@Example.com")

    assert response.status_code == 302
    assert response.headers["Location"] == "/games?tab=open&signed_in=1"
    assert token(browser) not in (None, guest_token)
    account = start_session(browser)
    assert account["id"] == guest["id"]
    assert account["kind"] == "verified"
    assert account["email"] == "ann@example.com"
    # The guest's player waits for "Is this you?", so the account gets a new one.
    assert account["player"]["id"] != guest["player"]["id"]


def test_a_verified_account_signing_in_again_gets_a_new_token(
    browser: TestClient,
) -> None:
    ann = signed_in(browser, "auth0|ann", "ann@example.com")
    old_token = token(browser)

    response = sign_in(browser, "auth0|ann", "ann@example.com")

    assert response.status_code == 302
    assert token(browser) not in (None, old_token)
    assert start_session(browser)["id"] == ann["id"]


def test_signing_in_as_another_account_switches_to_it(
    new_browser: Browser,
) -> None:
    bobs_laptop, anns_phone = new_browser(), new_browser()
    bob = signed_in(bobs_laptop, "auth0|bob", "bob@example.com")
    signed_in(anns_phone, "auth0|ann", "ann@example.com")
    old_token = token(anns_phone)

    response = sign_in(anns_phone, "auth0|bob", "bob@example.com")

    assert response.status_code == 302
    assert token(anns_phone) not in (None, old_token)
    assert start_session(anns_phone)["id"] == bob["id"]
    assert start_session(bobs_laptop)["id"] == bob["id"]


def test_a_verified_account_with_a_new_email_reaches_a_new_account(
    browser: TestClient,
) -> None:
    ann = signed_in(browser, "auth0|ann", "ann@example.com")
    old_token = token(browser)

    response = sign_in(browser, "auth0|ann-work", "ann@work.example")

    assert response.status_code == 302
    assert token(browser) not in (None, old_token)
    account = start_session(browser)
    assert account["id"] != ann["id"]
    assert account["email"] == "ann@work.example"


def test_a_guest_signing_in_to_another_account_joins_it(
    app: FastAPI, new_browser: Browser
) -> None:
    @app.get("/whoami")
    def whoami(account: RequestAccount) -> dict[str, str]:
        return {"id": str(account.id)}

    bobs_laptop, guest_browser = new_browser(), new_browser()
    bob = signed_in(bobs_laptop, "auth0|bob", "bob@example.com")
    guest = start_session(guest_browser)
    guest_token = token(guest_browser)

    response = sign_in(guest_browser, "auth0|bob", "bob@example.com")

    assert response.status_code == 302
    assert response.headers["Location"] == "/games?tab=open&signed_in=1"
    assert token(guest_browser) not in (None, guest_token)
    assert start_session(guest_browser)["id"] == bob["id"]
    stale_tab = new_browser()
    stale_tab.cookies.set(COOKIE, guest_token or "", domain="testserver")
    assert stale_tab.get("/whoami").status_code == 401
    assert start_session(stale_tab)["id"] not in (guest["id"], bob["id"])
    assert start_session(stale_tab)["kind"] == "guest"


def test_a_replayed_callback_goes_home_and_changes_nothing(
    browser: TestClient,
) -> None:
    authorize_url = login(browser).headers["Location"]
    callback = at_mock(authorize_url, "auth0|ann", "ann@example.com")
    browser.get(callback)
    account = start_session(browser)

    response = browser.get(callback)

    assert response.status_code == 302
    assert response.headers["Location"] == "/"
    assert "Set-Cookie" not in response.headers
    assert start_session(browser) == account


def expire_login_attempts(database: Engine) -> None:
    with database.begin() as connection:
        connection.execute(
            text("UPDATE login_attempts SET expires_at = now() - interval '1s'")
        )


@pytest.mark.parametrize(
    "code", ["cancelled", "email_not_verified", "expired", "failed"]
)
def test_a_failed_callback_returns_with_its_error_and_changes_nothing(
    migrated_database: Engine, new_browser: Browser, code: str
) -> None:
    browser = new_browser()
    guest = start_session(browser)
    authorize_url = login(browser).headers["Location"]
    state = parse_qs(urlsplit(authorize_url).query)["state"][0]
    if code == "cancelled":
        callback = (
            f"/v1/auth/callback?state={state}&error=access_denied"
            "&error_description=The+user+cancelled"
        )
    else:
        callback = at_mock(
            authorize_url,
            "auth0|ann",
            "ann@example.com",
            email_verified=code != "email_not_verified",
        )
    if code == "expired":
        expire_login_attempts(migrated_database)
    if code == "failed":
        # A state from another browser's session.
        browser.cookies.clear()
        start_session(browser)
        guest = start_session(browser)

    response = browser.get(callback)

    assert response.status_code == 302
    assert response.headers["Location"] == f"/games?tab=open&sign_in_error={code}"
    assert "Set-Cookie" not in response.headers
    assert start_session(browser) == guest


def test_a_callback_whose_attempt_is_gone_returns_home_with_no_error(
    browser: TestClient,
) -> None:
    start_session(browser)

    response = browser.get("/v1/auth/callback?state=unknown&error=access_denied")

    assert response.headers["Location"] == "/"


def test_an_unsafe_return_to_becomes_home(browser: TestClient) -> None:
    response = sign_in(
        browser, "auth0|ann", "ann@example.com", return_to="//evil.example/"
    )

    assert response.headers["Location"] == "/?signed_in=1"


def test_logout_ends_the_session_and_expires_the_cookie(
    browser: TestClient,
) -> None:
    ann = signed_in(browser, "auth0|ann", "ann@example.com")
    old_token = token(browser)

    response = browser.post("/v1/auth/logout", headers=JSON)

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    cookie = SimpleCookie(response.headers["Set-Cookie"])[COOKIE]
    assert cookie["max-age"] == "0"
    assert cookie["path"] == "/"
    assert cookie["secure"] is True
    logout_url = urlsplit(response.json()["data"]["logout_url"])
    assert logout_url.path == "/default/v2/logout"
    assert parse_qs(logout_url.query)["returnTo"] == ["https://testserver/"]
    browser.cookies.set(COOKIE, old_token or "", domain="testserver")
    assert start_session(browser)["id"] != ann["id"]
