"""The Auth0 account-link lifecycle routes (``app/auth0_link.py``).

A signed-in fortymm user binds exactly one Auth0 identity, reads its status, and
clears it — and cannot hijack another user's binding. The Auth0 ``/oauth/token``
and JWKS endpoints are mocked end-to-end with ``httpx.MockTransport`` (no real
network), and the id_token is signed with a locally-generated RS256 keypair whose
public JWK the mock JWKS serves — so the real exchange + verification code path
runs, not a stubbed seam.

Covered: status reports ``linked=false`` then ``linked=true`` after a successful
mocked callback; a callback whose ``sub`` already belongs to another user is
``409`` and leaves that user's binding untouched; ``DELETE`` clears it; ``start``
with Auth0 unconfigured fails cleanly (``404``, not ``500``); and an
invalid/mismatched ``state`` on the callback is rejected. Also: every route is
gated on the ``mcp.access`` permission (a signed-in user lacking it is ``403``, a
holder is admitted), and the Auth0-touching routes are two-tier rate limited
(the per-session cap trips ``429``).
"""

import json
import time
import uuid
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm
from sqlalchemy.ext.asyncio import AsyncSession

import app.auth0_link as auth0_link
from app.main import app as fastapi_app
from tests._helpers import grant_permissions, make_user, start_session

MCP_ACCESS = "mcp.access"

DOMAIN = "fortymm-test.us.auth0.com"
CLIENT_ID = "link-client-abc"
# Realistic length: a real Auth0 client secret is 40+ chars, above the HS256 key
# floor, so the signed PKCE cookie doesn't trip an insecure-key-length warning.
CLIENT_SECRET = "link-client-secret-" + "x" * 40
REDIRECT_URI = "https://uat.fortymm.com/api/v1/auth0/link/callback"
ISSUER = f"https://{DOMAIN}/"
KID = "test-signing-key-1"


@pytest.fixture
def configured_auth0(monkeypatch: pytest.MonkeyPatch) -> None:
    """Point ``Settings`` at a fully-configured Auth0 tenant. ``get_settings``
    reads the environment fresh per call, so ``setenv`` takes effect per test."""
    monkeypatch.setenv("AUTH0_DOMAIN", DOMAIN)
    monkeypatch.setenv("AUTH0_LINK_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("AUTH0_LINK_CLIENT_SECRET", CLIENT_SECRET)
    monkeypatch.setenv("AUTH0_LINK_REDIRECT_URI", REDIRECT_URI)


@pytest.fixture(scope="module")
def rsa_keypair() -> tuple[str, dict[str, object]]:
    """A private-key PEM to sign id_tokens with, and the matching public JWK the
    mocked JWKS serves. Module-scoped: keygen is slow and the key is stateless."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    jwk: dict[str, object] = json.loads(RSAAlgorithm.to_jwk(key.public_key()))
    jwk["kid"] = KID
    jwk["use"] = "sig"
    jwk["alg"] = "RS256"
    return private_pem, jwk


def _id_token(private_pem: str, *, sub: str, aud: str = CLIENT_ID) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "aud": aud, "iss": ISSUER, "iat": now, "exp": now + 300},
        private_pem,
        algorithm="RS256",
        headers={"kid": KID},
    )


def _install_auth0_mock(
    monkeypatch: pytest.MonkeyPatch, *, id_token: str, jwk: dict[str, object]
) -> None:
    """Route Auth0's ``/oauth/token`` and JWKS through an in-memory transport, so
    the real exchange + verification runs with no network."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/oauth/token":
            return httpx.Response(
                200, json={"id_token": id_token, "token_type": "Bearer"}
            )
        if request.url.path == "/.well-known/jwks.json":
            return httpx.Response(200, json={"keys": [jwk]})
        return httpx.Response(404)

    monkeypatch.setattr(
        auth0_link,
        "_http_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


async def _start_and_get_state(api_client: httpx.AsyncClient) -> str:
    """Hit ``start``, assert the 302 to Auth0, and return the CSRF ``state`` from
    the authorize URL. The signed PKCE cookie lands in the client's jar as a
    side effect (used by the follow-up callback)."""
    response = await api_client.get("/v1/auth0/link/start")
    assert response.status_code == 302, response.text
    location = response.headers["location"]
    assert location.startswith(f"https://{DOMAIN}/authorize?")
    query = parse_qs(urlparse(location).query)
    assert query["code_challenge_method"] == ["S256"]
    assert query["client_id"] == [CLIENT_ID]
    return query["state"][0]


async def test_status_false_then_true_after_link(
    api_client: httpx.AsyncClient,
    db_session: AsyncSession,
    configured_auth0: None,
    rsa_keypair: tuple[str, dict[str, object]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    private_pem, jwk = rsa_keypair
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, [MCP_ACCESS])

    before = await api_client.get("/v1/auth0/link")
    assert before.status_code == 200, before.text
    assert before.json() == {"linked": False}

    sub = "auth0|" + uuid.uuid4().hex
    _install_auth0_mock(monkeypatch, id_token=_id_token(private_pem, sub=sub), jwk=jwk)

    state = await _start_and_get_state(api_client)
    callback = await api_client.get(
        f"/v1/auth0/link/callback?code=auth-code&state={state}"
    )
    assert callback.status_code == 302, callback.text
    assert callback.headers["location"] == "/settings?linked=1"

    after = await api_client.get("/v1/auth0/link")
    assert after.json() == {"linked": True}

    await db_session.refresh(user)
    assert user.auth0_sub == sub


async def test_callback_rejects_sub_already_linked_to_another_user(
    api_client: httpx.AsyncClient,
    db_session: AsyncSession,
    configured_auth0: None,
    rsa_keypair: tuple[str, dict[str, object]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    private_pem, jwk = rsa_keypair
    me = await start_session(api_client, db_session)
    await grant_permissions(db_session, me, [MCP_ACCESS])

    # Another live user already holds the sub the callback will present.
    sub = "auth0|" + uuid.uuid4().hex
    other = await make_user(db_session, "auth0-owner")
    other.auth0_sub = sub
    await db_session.commit()

    _install_auth0_mock(monkeypatch, id_token=_id_token(private_pem, sub=sub), jwk=jwk)

    state = await _start_and_get_state(api_client)
    callback = await api_client.get(
        f"/v1/auth0/link/callback?code=auth-code&state={state}"
    )
    assert callback.status_code == 409, callback.text

    # The other user's binding is untouched, and I did not steal it.
    await db_session.refresh(other)
    await db_session.refresh(me)
    assert other.auth0_sub == sub
    assert me.auth0_sub is None


async def test_delete_clears_binding(
    api_client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, [MCP_ACCESS])
    user.auth0_sub = "auth0|" + uuid.uuid4().hex
    await db_session.commit()

    response = await api_client.delete("/v1/auth0/link")
    assert response.status_code == 200, response.text
    assert response.json() == {"linked": False}

    await db_session.refresh(user)
    assert user.auth0_sub is None

    # Idempotent: clearing an already-unlinked account is a clean no-op.
    again = await api_client.delete("/v1/auth0/link")
    assert again.status_code == 200, again.text
    assert again.json() == {"linked": False}


async def test_start_unconfigured_fails_cleanly(
    api_client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # No AUTH0_* env set — linking is unconfigured. Must be a clean 404, not 500.
    for name in (
        "AUTH0_DOMAIN",
        "AUTH0_LINK_CLIENT_ID",
        "AUTH0_LINK_CLIENT_SECRET",
        "AUTH0_LINK_REDIRECT_URI",
    ):
        monkeypatch.delenv(name, raising=False)
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, [MCP_ACCESS])

    response = await api_client.get("/v1/auth0/link/start")
    assert response.status_code == 404, response.text


async def test_callback_rejects_mismatched_state(
    api_client: httpx.AsyncClient,
    db_session: AsyncSession,
    configured_auth0: None,
    rsa_keypair: tuple[str, dict[str, object]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    private_pem, jwk = rsa_keypair
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, [MCP_ACCESS])
    _install_auth0_mock(
        monkeypatch,
        id_token=_id_token(private_pem, sub="auth0|" + uuid.uuid4().hex),
        jwk=jwk,
    )

    # Real start (issues the signed PKCE cookie) but a forged state on the callback.
    await _start_and_get_state(api_client)
    callback = await api_client.get(
        "/v1/auth0/link/callback?code=auth-code&state=not-the-issued-state"
    )
    assert callback.status_code == 400, callback.text

    await db_session.refresh(user)
    assert user.auth0_sub is None


async def test_callback_without_pkce_cookie_rejected(
    api_client: httpx.AsyncClient,
    db_session: AsyncSession,
    configured_auth0: None,
) -> None:
    # A callback that never went through ``start`` carries no PKCE cookie — reject
    # before touching Auth0, so no exchange is attempted.
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, [MCP_ACCESS])
    response = await api_client.get(
        "/v1/auth0/link/callback?code=auth-code&state=whatever"
    )
    assert response.status_code == 400, response.text


async def test_link_routes_require_a_session(
    api_client: httpx.AsyncClient,
    configured_auth0: None,
) -> None:
    # Cookieless client: every route is session-gated, so all three 401.
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=fastapi_app),
        base_url="https://testserver",
    ) as anon:
        assert (await anon.get("/v1/auth0/link")).status_code == 401
        assert (await anon.get("/v1/auth0/link/start")).status_code == 401
        assert (
            await anon.get("/v1/auth0/link/callback?code=c&state=s")
        ).status_code == 401


async def test_link_routes_require_mcp_access(
    api_client: httpx.AsyncClient,
    db_session: AsyncSession,
    configured_auth0: None,
) -> None:
    # A signed-in user who does NOT hold ``mcp.access`` is refused at every link
    # route with a 403 — binding an Auth0 identity is gated on the same permission
    # the MCP surface enforces, not merely on "is signed in".
    await start_session(api_client, db_session)

    assert (await api_client.get("/v1/auth0/link")).status_code == 403
    assert (await api_client.get("/v1/auth0/link/start")).status_code == 403
    assert (
        await api_client.get("/v1/auth0/link/callback?code=c&state=s")
    ).status_code == 403


async def test_link_status_admits_user_with_mcp_access(
    api_client: httpx.AsyncClient,
    db_session: AsyncSession,
    configured_auth0: None,
) -> None:
    # Granting ``mcp.access`` flips the 403 above to a normal 200 — the gate is the
    # permission, and a holder passes it.
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, [MCP_ACCESS])

    response = await api_client.get("/v1/auth0/link")
    assert response.status_code == 200, response.text
    assert response.json() == {"linked": False}


async def test_start_link_rate_limited(
    api_client: httpx.AsyncClient,
    db_session: AsyncSession,
    configured_auth0: None,
) -> None:
    # ``start`` shares a per-session bucket of 10/hr with ``callback``; the 11th hit
    # in the window 429s (the per-IP ceiling is looser, so the session cap trips
    # first for a single client).
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, [MCP_ACCESS])

    for i in range(10):
        response = await api_client.get("/v1/auth0/link/start")
        assert response.status_code == 302, (i, response.text)

    over = await api_client.get("/v1/auth0/link/start")
    assert over.status_code == 429, over.text
