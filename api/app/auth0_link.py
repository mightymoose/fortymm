"""Account-link lifecycle routes: bind / read / clear a fortymm user's Auth0 identity.

A logged-in fortymm user links their account to an Auth0 identity **once** via a
server-side authorization-code + PKCE flow, so the MCP OAuth Resource Server can
later map a verified Auth0 token's ``sub`` back to this user (see
``docs/adr/20260722-the-mcp-server-is-an-oauth-resource-server-trusting-auth0.md``).
This module owns only the *link* side — the four HTTP routes and the token
exchange / id_token verification that binds an Auth0 ``sub`` to
``users.auth0_sub``. The MCP-time ``sub`` → ``User`` resolution lives in
``app/auth0_identity.py`` (the shared resolver both surfaces call).

**PKCE / CSRF state survives the redirect in a short-lived signed cookie**, not
Redis or a server-side store. The ``code_verifier`` and CSRF ``state`` are packed
into an HS256 JWT signed with the Auth0 web app's ``client_secret`` (a secret we
already hold whenever linking is configured), set as an httponly cookie for the
few minutes the round-trip lasts, and verified on the callback. This keeps the
flow **stateless** — it needs no shared store and survives round-robin across the
two UAT api replicas with no session affinity — matching the stateless-http
stance the ADR takes for the MCP surface itself.

The interior never traffics in ``dict[str, Any]``: the Auth0 token response and
the verified id_token claims are parsed into Pydantic models at the boundary, and
only specific exceptions (``httpx.HTTPError``, ``jwt.PyJWTError``,
``ValidationError``) are caught — a programmer error still crashes loudly.
"""

import base64
import hashlib
import os
import secrets
import time
from dataclasses import dataclass
from typing import Annotated, Any
from urllib.parse import urlencode

import httpx
import jwt
from fastapi import APIRouter, Cookie, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, ConfigDict, ValidationError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth0_identity import resolve_linked_user
from app.config import Settings, get_settings
from app.db import get_session
from app.models import User
from app.sessions import get_current_user

router = APIRouter(prefix="/v1")

# Cookie the PKCE ``code_verifier`` + CSRF ``state`` ride in across the Auth0
# round-trip. Signed (HS256) with the Auth0 web app's ``client_secret`` and set
# httponly for the few minutes the flow lasts; SameSite=Lax so it survives the
# top-level GET navigation back from Auth0 to our callback.
PKCE_COOKIE_NAME = "auth0_link_pkce"
# The link handshake is a browser round-trip through Auth0's login — a few
# minutes at most. Short-lived so a leaked cookie can't be replayed later.
PKCE_TTL_SECONDS = 10 * 60
# Where the callback sends the browser once the link is bound. Relative so it
# resolves against the public origin the callback was reached on (behind nginx's
# ``/api`` strip on UAT), landing back on the web client's settings page.
LINK_SUCCESS_REDIRECT = "/settings?linked=1"


class LinkStatus(BaseModel):
    """Whether the current user has an Auth0 identity bound. The GET status body
    and the DELETE (now-cleared) body both use it, so a client updates the same
    shape either way."""

    linked: bool


class Auth0TokenResponse(BaseModel):
    """The subset of Auth0's ``/oauth/token`` response we consume. Auth0 also
    returns ``access_token`` / ``token_type`` / ``expires_in`` etc.; we only need
    the id_token (identity is authentication-only here), so extra keys are
    ignored rather than rejected."""

    model_config = ConfigDict(extra="ignore")

    id_token: str


class Auth0IdClaims(BaseModel):
    """The one claim we bind from a verified id_token. ``jwt.decode`` already
    checked the signature / ``aud`` / ``iss`` / ``exp`` before we parse; this
    turns the surviving claim blob into a typed value so the interior never holds
    a stringly-keyed ``dict``."""

    model_config = ConfigDict(extra="ignore")

    sub: str


@dataclass(frozen=True)
class LinkConfig:
    """The four Auth0 settings the confidential code flow needs, proven non-empty.
    Built by :func:`_link_config`, which returns ``None`` when linking is
    unconfigured so callers fail closed rather than 500 on a blank domain."""

    domain: str
    client_id: str
    client_secret: str
    redirect_uri: str


def _link_config(settings: Settings) -> LinkConfig | None:
    """The Auth0 link configuration, or ``None`` when any required piece is unset.

    Linking needs all four to run the confidential code exchange; with any empty
    the feature is simply not configured (local / qa / e2e), and the routes fail
    closed with a clean 404 instead of attempting a request against a blank host.
    """
    if not (
        settings.auth0_domain
        and settings.auth0_link_client_id
        and settings.auth0_link_client_secret
        and settings.auth0_link_redirect_uri
    ):
        return None
    return LinkConfig(
        domain=settings.auth0_domain,
        client_id=settings.auth0_link_client_id,
        client_secret=settings.auth0_link_client_secret,
        redirect_uri=settings.auth0_link_redirect_uri,
    )


def _require_link_config(settings: Settings) -> LinkConfig:
    """``_link_config`` or a clean 404 — never a 500 on an unconfigured tenant."""
    config = _link_config(settings)
    if config is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Auth0 account linking is not configured.",
        )
    return config


def _cookie_secure() -> bool:
    """Mirror the session cookie's Secure attribute (``SESSION_COOKIE_SECURE``),
    so local non-HTTPS dev can drop it exactly as the session flow does."""
    return os.environ.get("SESSION_COOKIE_SECURE", "true").lower() != "false"


def _pkce_challenge(code_verifier: str) -> str:
    """The S256 code challenge for ``code_verifier`` — base64url(sha256(verifier))
    with padding stripped, per RFC 7636."""
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _sign_pkce_cookie(secret: str, *, state: str, code_verifier: str) -> str:
    """Pack the CSRF ``state`` and PKCE ``code_verifier`` into a short-lived HS256
    JWT signed with the Auth0 ``client_secret``. The signature makes the cookie
    tamper-evident, and the ``exp`` bounds the replay window — no server-side
    store needed."""
    now = int(time.time())
    payload = {
        "state": state,
        "cv": code_verifier,
        "iat": now,
        "exp": now + PKCE_TTL_SECONDS,
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def _read_pkce_cookie(secret: str, cookie: str) -> tuple[str, str] | None:
    """Verify + decode the PKCE cookie, returning ``(state, code_verifier)`` or
    ``None`` when it's missing a claim, tampered, or expired (``jwt.decode``
    enforces ``exp``). ``None`` — not a raise — so the caller shapes the rejection."""
    try:
        payload = jwt.decode(cookie, secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    state = payload.get("state")
    code_verifier = payload.get("cv")
    if not isinstance(state, str) or not isinstance(code_verifier, str):
        return None
    return state, code_verifier


def _authorize_url(config: LinkConfig, *, state: str, code_challenge: str) -> str:
    """The Auth0 ``/authorize`` URL for an authorization-code + PKCE login,
    requesting only ``openid`` (we bind ``sub``, no profile/PII)."""
    query = urlencode(
        {
            "response_type": "code",
            "client_id": config.client_id,
            "redirect_uri": config.redirect_uri,
            "scope": "openid",
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            "state": state,
        }
    )
    return f"https://{config.domain}/authorize?{query}"


def _http_client() -> httpx.AsyncClient:
    """The outbound client for the Auth0 token + JWKS calls. A named seam so tests
    substitute an ``httpx.MockTransport`` and no real network call happens."""
    return httpx.AsyncClient(timeout=10.0)


async def _exchange_code(config: LinkConfig, *, code: str, code_verifier: str) -> str:
    """Exchange the authorization ``code`` (+ PKCE verifier) for the raw id_token
    JWT at Auth0's ``/oauth/token``. Raises ``httpx.HTTPError`` on a transport /
    non-2xx failure and ``ValidationError`` when the body lacks an ``id_token`` —
    both caught by the handler and turned into a clean 400."""
    async with _http_client() as client:
        response = await client.post(
            f"https://{config.domain}/oauth/token",
            data={
                "grant_type": "authorization_code",
                "client_id": config.client_id,
                "client_secret": config.client_secret,
                "code": code,
                "redirect_uri": config.redirect_uri,
                "code_verifier": code_verifier,
            },
        )
        response.raise_for_status()
        return Auth0TokenResponse.model_validate(response.json()).id_token


async def _fetch_jwks(config: LinkConfig) -> dict[str, Any]:
    """Fetch the tenant's public JWKS. Raises ``httpx.HTTPError`` on failure.

    The JWKS URL comes from ``settings.auth0_jwks_uri`` (built from the same
    ``auth0_domain`` this ``config`` was derived from) so the tenant URL topology
    lives in exactly one place (``app.config``)."""
    async with _http_client() as client:
        response = await client.get(get_settings().auth0_jwks_uri)
        response.raise_for_status()
        data: dict[str, Any] = response.json()
        return data


def _verify_id_token(config: LinkConfig, id_token: str, jwks: dict[str, Any]) -> str:
    """Verify the id_token (RS256 against the tenant JWKS, ``aud`` = the link
    client id, ``iss`` = ``https://{domain}/``) and return its ``sub``.

    Raises ``jwt.PyJWTError`` on any verification failure (bad signature, wrong
    audience/issuer, expiry, or no JWKS key matching the token's ``kid``) and
    ``ValidationError`` when the verified claims carry no ``sub`` — the handler
    catches both."""
    kid = jwt.get_unverified_header(id_token).get("kid")
    key_set = jwt.PyJWKSet.from_dict(jwks)
    signing_key = next((k.key for k in key_set.keys if k.key_id == kid), None)
    if signing_key is None:
        raise jwt.InvalidKeyError("no JWKS key matches the id_token kid")
    claims = jwt.decode(
        id_token,
        signing_key,
        algorithms=["RS256"],
        audience=config.client_id,
        # ``iss`` from ``settings.auth0_issuer`` — the same single-source tenant URL
        # construction the MCP verifier uses (``app.config``), built from the
        # ``auth0_domain`` this ``config`` was derived from.
        issuer=get_settings().auth0_issuer,
    )
    return Auth0IdClaims.model_validate(claims).sub


async def _resolve_auth0_sub(
    config: LinkConfig, *, code: str, code_verifier: str
) -> str:
    """The full callback exchange: code → id_token → verified ``sub``. Its raised
    exceptions (``httpx.HTTPError`` / ``jwt.PyJWTError`` / ``ValidationError``)
    are the boundary failures the handler maps to a 400."""
    id_token = await _exchange_code(config, code=code, code_verifier=code_verifier)
    jwks = await _fetch_jwks(config)
    return _verify_id_token(config, id_token, jwks)


@router.get("/auth0/link/start", response_class=RedirectResponse)
async def start_link(
    settings: Settings = Depends(get_settings),
    _current_user: User = Depends(get_current_user),
) -> RedirectResponse:
    """Begin linking the signed-in user's account to an Auth0 identity.

    Generates a PKCE ``code_verifier`` + CSRF ``state``, stashes them in a
    short-lived signed httponly cookie (no server-side store, so the flow is
    stateless across replicas), and 302-redirects the browser to Auth0's
    ``/authorize`` for an authorization-code + PKCE login requesting only the
    ``openid`` scope. The matching callback completes the bind.

    Requires an established fortymm session (the link is bound to *you*). Returns
    a clean ``404`` when Auth0 linking is not configured for this deployment,
    never a ``500``.
    """
    config = _require_link_config(settings)
    state = secrets.token_urlsafe(32)
    code_verifier = secrets.token_urlsafe(64)
    cookie = _sign_pkce_cookie(
        config.client_secret, state=state, code_verifier=code_verifier
    )
    redirect = RedirectResponse(
        url=_authorize_url(
            config, state=state, code_challenge=_pkce_challenge(code_verifier)
        ),
        status_code=status.HTTP_302_FOUND,
    )
    redirect.set_cookie(
        key=PKCE_COOKIE_NAME,
        value=cookie,
        max_age=PKCE_TTL_SECONDS,
        path="/",
        httponly=True,
        secure=_cookie_secure(),
        samesite="lax",
    )
    return redirect


def _clear_pkce_cookie(response: RedirectResponse) -> None:
    """Drop the PKCE cookie once the callback consumes it (single-use), mirroring
    the attributes it was set with so the browser actually matches and clears it."""
    response.delete_cookie(
        key=PKCE_COOKIE_NAME,
        path="/",
        httponly=True,
        secure=_cookie_secure(),
        samesite="lax",
    )


async def _bind_auth0_sub(db: AsyncSession, current_user: User, sub: str) -> None:
    """Bind ``sub`` to ``current_user``, enforcing the one-to-one link invariant.

    If a *different* live (non-tombstoned) user already holds this ``sub`` →
    ``409`` and nothing moves (no silent takeover). If the current user already
    holds a different ``sub`` this overwrites it (their own re-link); a repeat of
    the same ``sub`` is an idempotent no-op. The unique constraint on
    ``users.auth0_sub`` is the backstop: a race that slips past the pre-check
    surfaces as ``IntegrityError`` → the same ``409``.
    """
    existing = await resolve_linked_user(db, sub)
    if existing is not None and existing.id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That Auth0 identity is already linked to another account.",
        )
    current_user.auth0_sub = sub
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That Auth0 identity is already linked to another account.",
        ) from exc


@router.get("/auth0/link/callback", response_class=RedirectResponse)
async def link_callback(
    code: Annotated[str, Query()],
    state: Annotated[str, Query()],
    pkce_cookie: Annotated[str | None, Cookie(alias=PKCE_COOKIE_NAME)] = None,
    settings: Settings = Depends(get_settings),
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> RedirectResponse:
    """Complete the Auth0 account link and redirect back to settings.

    Validates the returned ``state`` against the signed PKCE cookie, exchanges the
    ``code`` for an id_token at Auth0, verifies it (RS256 via the tenant JWKS,
    ``aud`` = the link client id, ``iss`` = the tenant), and binds its ``sub`` to
    the **current session user** (one-to-one; a ``sub`` already held by a
    different live user is rejected ``409`` and left in place — see
    ``_bind_auth0_sub``). On success it 302-redirects to ``/settings?linked=1``.

    Requires an established fortymm session. Rejects a missing / mismatched /
    expired ``state`` with ``400``, an exchange or id_token-verification failure
    with ``400``, and returns ``404`` when linking is unconfigured.
    """
    config = _require_link_config(settings)

    stored = (
        _read_pkce_cookie(config.client_secret, pkce_cookie)
        if pkce_cookie is not None
        else None
    )
    if stored is None or not secrets.compare_digest(stored[0], state):
        # Missing/tampered/expired cookie, or a state that doesn't match what we
        # issued — a forged or stale callback. Refuse before touching Auth0.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The account-link request is invalid or has expired. Try again.",
        )
    _, code_verifier = stored

    try:
        sub = await _resolve_auth0_sub(config, code=code, code_verifier=code_verifier)
    except (httpx.HTTPError, jwt.PyJWTError, ValidationError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not verify the Auth0 sign-in. Try linking again.",
        ) from exc

    await _bind_auth0_sub(db, current_user, sub)

    redirect = RedirectResponse(
        url=LINK_SUCCESS_REDIRECT, status_code=status.HTTP_302_FOUND
    )
    _clear_pkce_cookie(redirect)
    return redirect


@router.get("/auth0/link", response_model=LinkStatus)
async def link_status(
    current_user: User = Depends(get_current_user),
) -> LinkStatus:
    """Whether the signed-in user has an Auth0 identity bound.

    ``linked`` is true once the user has completed the link flow (their
    ``users.auth0_sub`` is set). Requires an established fortymm session; needs no
    Auth0 configuration (it only reads local state)."""
    return LinkStatus(linked=current_user.auth0_sub is not None)


@router.delete("/auth0/link", response_model=LinkStatus)
async def unlink(
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> LinkStatus:
    """Clear the signed-in user's Auth0 binding.

    Drops ``users.auth0_sub`` so the identity can be re-linked (here or to a
    different account) and any agent authenticating as that ``sub`` stops
    resolving to this user. Idempotent — clearing an already-unlinked account is a
    no-op ``linked=false``. Requires an established fortymm session; needs no Auth0
    configuration."""
    if current_user.auth0_sub is not None:
        current_user.auth0_sub = None
        await db.commit()
    return LinkStatus(linked=False)
