"""Auth0, or the mock OpenID Connect provider that stands in for it in dev and
the tests. The API finds the provider's endpoints through its discovery
document, because the two serve them on different paths.
"""

import base64
import hashlib
import hmac
import http.client
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import cached_property
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import jwt

from fortymm_api.accounts import Email

TIMEOUT_SECONDS = 10
# Tolerates this much clock difference between the provider and the API.
LEEWAY_SECONDS = 60


@dataclass(frozen=True)
class IdToken:
    """The claims of a verified ID token that sign-in reads."""

    sub: str
    email: Email | None
    email_verified: bool
    # When the provider last authenticated the person. None if the token has
    # no usable auth_time claim. Sign-in refuses such a token.
    auth_time: datetime | None


class ExchangeFailed(Exception):
    """The code exchange failed, or its ID token failed verification."""


class IdentityProvider:
    def __init__(
        self,
        domain: str,
        client_id: str,
        client_secret: str,
        authorize_url: str | None = None,
    ) -> None:
        """`domain` is Auth0's, such as `fortymm.us.auth0.com`, or a base URL
        with a scheme, such as the mock's `http://oidc:8080/default`.

        `authorize_url` replaces the discovered authorization endpoint, for a
        browser that can't reach the provider at the API's address.
        """
        self.base_url = (domain if "://" in domain else f"https://{domain}").rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret
        self.authorize_url_override = authorize_url

    @cached_property
    def _discovery(self) -> dict[str, Any]:
        url = f"{self.base_url}/.well-known/openid-configuration"
        with urlopen(url, timeout=TIMEOUT_SECONDS) as response:
            document: dict[str, Any] = json.load(response)
        return document

    @cached_property
    def _signing_keys(self) -> jwt.PyJWKClient:
        return jwt.PyJWKClient(self._discovery["jwks_uri"], timeout=TIMEOUT_SECONDS)

    def authorize_url(
        self,
        *,
        state: str,
        nonce: str,
        code_verifier: str,
        redirect_uri: str,
    ) -> str:
        """The provider's sign-in page for one login attempt.

        response_mode=query, because the SameSite=Lax cookie rides the
        provider's redirect back only as a top-level GET.

        Every attempt asks the provider to authenticate the person again, so
        a provider session left over from an unfinished sign-out can't sign
        the next person in as the last one. prompt=login is only a hint that
        anyone can strip from this URL. max_age=0 makes the provider put
        auth_time in the ID token, which sign-in checks.
        """
        challenge = hashlib.sha256(code_verifier.encode()).digest()
        params = {
            "response_type": "code",
            "response_mode": "query",
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "scope": "openid email",
            "state": state,
            "nonce": nonce,
            "code_challenge": base64.urlsafe_b64encode(challenge).rstrip(b"=").decode(),
            "code_challenge_method": "S256",
            "prompt": "login",
            "max_age": "0",
        }
        endpoint = (
            self.authorize_url_override or self._discovery["authorization_endpoint"]
        )
        return f"{endpoint}?{urlencode(params)}"

    def exchange(
        self, code: str, code_verifier: str, redirect_uri: str, nonce: str
    ) -> IdToken:
        """Exchange the callback's code for its verified ID token.

        Raises ExchangeFailed if the provider refuses the code, or if the ID
        token's signature, issuer, audience, expiry or nonce is wrong.
        """
        try:
            request = Request(
                self._discovery["token_endpoint"],
                data=urlencode(
                    {
                        "grant_type": "authorization_code",
                        "code": code,
                        "redirect_uri": redirect_uri,
                        "client_id": self.client_id,
                        "client_secret": self.client_secret,
                        "code_verifier": code_verifier,
                    }
                ).encode(),
            )
            with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                id_token: str = json.load(response)["id_token"]
            key = self._signing_keys.get_signing_key_from_jwt(id_token)
            claims = jwt.decode(
                id_token,
                key,
                algorithms=["RS256"],
                audience=self.client_id,
                issuer=self._discovery["issuer"],
                leeway=LEEWAY_SECONDS,
                options={"require": ["sub", "iss", "aud", "exp", "iat"]},
            )
        # OSError covers URLError and a timeout or reset while reading.
        except (
            OSError,
            http.client.HTTPException,
            ValueError,
            KeyError,
            TypeError,
            jwt.PyJWTError,
        ) as error:
            raise ExchangeFailed from error
        if not hmac.compare_digest(str(claims.get("nonce", "")), nonce):
            raise ExchangeFailed("The ID token's nonce doesn't match")
        email = claims.get("email")
        return IdToken(
            sub=claims["sub"],
            # Lowercased here, once. accounts.email refuses any other case.
            email=Email(email.lower()) if isinstance(email, str) else None,
            email_verified=claims.get("email_verified") is True,
            auth_time=_timestamp(claims.get("auth_time")),
        )

    def logout_url(self, return_to: str) -> str:
        """Auth0's logout page, which ends Auth0's own session too."""
        params = urlencode({"client_id": self.client_id, "returnTo": return_to})
        return f"{self.base_url}/v2/logout?{params}"


def _timestamp(value: object) -> datetime | None:
    """A claim in seconds since the epoch, or None if it isn't one."""
    # bool is an int, but no timestamp.
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    try:
        return datetime.fromtimestamp(value, UTC)
    except OverflowError, OSError, ValueError:
        return None
