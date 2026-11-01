"""The identity provider adapter, against the mock in the `oidc` Compose service."""

import json
import os
import secrets
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import httpx2 as httpx
import pytest

from fortymm_api.accounts import Email
from fortymm_api.identity_provider import ExchangeFailed, IdentityProvider, IdToken

REDIRECT_URI = "https://testserver/v1/auth/callback"
VERIFIER = secrets.token_urlsafe(64)


@pytest.fixture
def provider() -> IdentityProvider:
    return IdentityProvider(os.environ["AUTH0_DOMAIN"], "fortymm-test", "secret")


def code(provider: IdentityProvider, nonce: str = "n1") -> str:
    """A code from the mock for a sign-in as Ann."""
    authorize_url = provider.authorize_url(
        state="s1",
        nonce=nonce,
        code_verifier=VERIFIER,
        redirect_uri=REDIRECT_URI,
    )
    claims = {"email": "Ann@Example.com", "email_verified": True}
    response = httpx.post(
        authorize_url,
        data={"username": "auth0|ann", "claims": json.dumps(claims)},
        follow_redirects=False,
    )
    return parse_qs(urlsplit(response.headers["Location"]).query)["code"][0]


def test_asks_the_provider_to_authenticate_the_person_again(
    provider: IdentityProvider,
) -> None:
    authorize_url = provider.authorize_url(
        state="s1", nonce="n1", code_verifier=VERIFIER, redirect_uri=REDIRECT_URI
    )

    query = parse_qs(urlsplit(authorize_url).query)
    assert query["prompt"] == ["login"]
    assert query["max_age"] == ["0"]


def test_exchanges_a_code_for_its_verified_identity(
    provider: IdentityProvider,
) -> None:
    before = datetime.now(UTC).replace(microsecond=0)
    id_token = provider.exchange(code(provider), VERIFIER, REDIRECT_URI, "n1")

    # The mock puts auth_time in the ID token because the request has max_age.
    assert id_token.auth_time is not None
    assert before - timedelta(seconds=5) <= id_token.auth_time
    assert id_token.auth_time <= datetime.now(UTC) + timedelta(seconds=5)
    assert id_token == IdToken(
        "auth0|ann", Email("ann@example.com"), True, id_token.auth_time
    )


@pytest.mark.parametrize(
    "claims",
    [{}, {"auth_time": "yesterday"}, {"auth_time": True}],
    ids=["missing", "a string", "a bool"],
)
def test_an_id_token_without_a_usable_auth_time_has_none(
    provider: IdentityProvider, claims: dict[str, object]
) -> None:
    """The mock adds auth_time only when the request has max_age, and lets a
    claim typed into its form replace it."""
    authorize_url = provider.authorize_url(
        state="s1", nonce="n1", code_verifier=VERIFIER, redirect_uri=REDIRECT_URI
    )
    if not claims:
        # Drop max_age, so the mock adds no auth_time.
        authorize_url = authorize_url.replace("&max_age=0", "")
    response = httpx.post(
        authorize_url,
        data={
            "username": "auth0|ann",
            "claims": json.dumps({"email": "ann@example.com", **claims}),
        },
        follow_redirects=False,
    )
    issued = parse_qs(urlsplit(response.headers["Location"]).query)["code"][0]

    id_token = provider.exchange(issued, VERIFIER, REDIRECT_URI, "n1")

    assert id_token.auth_time is None


def test_refuses_an_id_token_with_another_nonce(provider: IdentityProvider) -> None:
    with pytest.raises(ExchangeFailed):
        provider.exchange(code(provider), VERIFIER, REDIRECT_URI, "n2")


def test_refuses_a_code_with_the_wrong_verifier(provider: IdentityProvider) -> None:
    with pytest.raises(ExchangeFailed):
        provider.exchange(code(provider), secrets.token_urlsafe(64), REDIRECT_URI, "n1")


def test_a_provider_that_stops_answering_fails_the_exchange(
    provider: IdentityProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    def timed_out(*args: object, **kwargs: object) -> None:
        raise TimeoutError

    monkeypatch.setattr("fortymm_api.identity_provider.urlopen", timed_out)

    with pytest.raises(ExchangeFailed):
        provider.exchange("code", VERIFIER, REDIRECT_URI, "n1")
