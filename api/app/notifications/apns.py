"""Apple Push Notification service (APNs) sender.

Token-based (JWT) auth over HTTP/2. The interior of the app depends on the
``PushSender`` protocol, not the concrete client, so handlers and tests can
substitute a fake (mirrors the ``RatingCalculator`` protocol seam).

Configuration comes from the environment (the ``os.environ.get`` pattern used
by ``app/captcha.py`` / ``app/email.py``). When unset, ``push_sender_from_env``
returns a ``NoopSender`` whose ``is_configured`` is ``False`` — the service
turns that into a clean ``503`` rather than crashing, exactly as ``app/email.py``
no-ops without ``SMTP_HOST``.
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from typing import Literal, Protocol

import httpx
import jwt

log = logging.getLogger(__name__)

Environment = Literal["sandbox", "production"]

# Category identifier shared with the iOS client (see
# ``PushNotificationManager`` in the iOS app). A push carrying this category
# renders the Accept / Suggest-correction action buttons the app registered
# for it. The identifier string is a wire contract with the client and is kept
# stable even though the buttons' user-facing verbs moved to accept/counter.
MATCH_RESULT_CONFIRMATION_CATEGORY = "MATCH_RESULT_CONFIRMATION"

_APNS_HOSTS: dict[str, str] = {
    "sandbox": "https://api.sandbox.push.apple.com",
    "production": "https://api.push.apple.com",
}

# APNs accepts a provider JWT for up to 1 hour and rejects tokens younger than
# ~20 minutes when refreshed too eagerly. Refresh well inside the window.
_JWT_TTL_SECONDS = 50 * 60

# APNs reasons that mean "this device token is dead — stop sending to it".
_GONE_REASONS = {"BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"}


class SendOutcome(Enum):
    SUCCESS = "success"
    # The token is permanently invalid (uninstalled app, wrong environment) and
    # should be pruned from the database.
    GONE = "gone"
    # A transient or configuration failure — left in place to retry later.
    FAILED = "failed"


@dataclass(frozen=True)
class SendResult:
    outcome: SendOutcome
    detail: str | None = None


class PushSender(Protocol):
    """The seam the service depends on. Real implementation talks to APNs;
    tests inject a recording fake.

    ``category`` selects an APNs notification category (the iOS app registers
    one per set of action buttons); ``data`` is merged into the push payload
    alongside ``aps`` so the device can route the tap (e.g. a ``match_id``)."""

    @property
    def is_configured(self) -> bool: ...

    async def send(
        self,
        token: str,
        *,
        environment: Environment,
        title: str,
        body: str,
        category: str | None = None,
        data: Mapping[str, str] | None = None,
    ) -> SendResult: ...


class NoopSender:
    """Stand-in used when APNs credentials aren't configured. The service
    checks ``is_configured`` and returns 503 before ever calling ``send``."""

    is_configured = False

    async def send(
        self,
        token: str,
        *,
        environment: Environment,
        title: str,
        body: str,
        category: str | None = None,
        data: Mapping[str, str] | None = None,
    ) -> SendResult:
        return SendResult(SendOutcome.FAILED, "push not configured")


@dataclass(frozen=True)
class APNsConfig:
    key_id: str
    team_id: str
    bundle_id: str
    auth_key_pem: str

    @staticmethod
    def from_env() -> APNsConfig | None:
        """Build config from the environment, or ``None`` if the required
        pieces are missing. ``APNS_AUTH_KEY`` holds the .p8 PEM contents
        directly; ``APNS_AUTH_KEY_PATH`` points at the .p8 file on disk."""
        key_id = os.environ.get("APNS_KEY_ID")
        team_id = os.environ.get("APNS_TEAM_ID")
        bundle_id = os.environ.get("APNS_BUNDLE_ID", "com.fortymm.ios-client")
        auth_key_pem = _read_auth_key()
        if not (key_id and team_id and auth_key_pem):
            return None
        return APNsConfig(
            key_id=key_id,
            team_id=team_id,
            bundle_id=bundle_id,
            auth_key_pem=auth_key_pem,
        )


def _read_auth_key() -> str | None:
    inline = os.environ.get("APNS_AUTH_KEY")
    if inline:
        return inline
    path = os.environ.get("APNS_AUTH_KEY_PATH")
    if path:
        try:
            with open(path, encoding="utf-8") as handle:
                return handle.read()
        except OSError as exc:
            log.warning("APNS_AUTH_KEY_PATH set but unreadable: %s", exc)
            return None
    return None


class APNsClient:
    """Sends a single alert push per ``send`` call. Reuses one HTTP/2 client
    (connection pooling) and caches the provider JWT for ~50 minutes."""

    is_configured = True

    def __init__(
        self,
        config: APNsConfig,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._config = config
        self._client = client or httpx.AsyncClient(http2=True, timeout=10.0)
        self._cached_jwt: str | None = None
        self._jwt_minted_at: float = 0.0

    def _provider_jwt(self) -> str:
        now = time.monotonic()
        age = now - self._jwt_minted_at
        if self._cached_jwt is not None and age < _JWT_TTL_SECONDS:
            return self._cached_jwt
        token = jwt.encode(
            {"iss": self._config.team_id, "iat": int(time.time())},
            self._config.auth_key_pem,
            algorithm="ES256",
            headers={"kid": self._config.key_id},
        )
        self._cached_jwt = token
        self._jwt_minted_at = now
        return token

    async def send(
        self,
        token: str,
        *,
        environment: Environment,
        title: str,
        body: str,
        category: str | None = None,
        data: Mapping[str, str] | None = None,
    ) -> SendResult:
        url = f"{_APNS_HOSTS[environment]}/3/device/{token}"
        try:
            provider_jwt = self._provider_jwt()
        except (jwt.PyJWTError, ValueError) as exc:
            # A malformed/expired ``auth_key_pem`` surfaces as a bare
            # ``ValueError`` from cryptography's PEM loader (via PyJWT's
            # ``ECAlgorithm.prepare_key``), not a ``PyJWTError`` — catch both
            # so a bad key can't raise out of `send` (#753).
            log.warning("APNs provider JWT minting failed: %s", exc)
            return SendResult(SendOutcome.FAILED, str(exc) or exc.__class__.__name__)
        headers = {
            "authorization": f"bearer {provider_jwt}",
            "apns-topic": self._config.bundle_id,
            "apns-push-type": "alert",
        }
        # ``object`` (not ``Any``) so the heterogeneous JSON payload still
        # type-checks under mypy --strict without loosening the interior.
        aps: dict[str, object] = {
            "alert": {"title": title, "body": body},
            "sound": "default",
        }
        if category is not None:
            aps["category"] = category
        payload: dict[str, object] = {"aps": aps}
        if data:
            payload.update(data)
        try:
            response = await self._client.post(url, headers=headers, json=payload)
        except httpx.HTTPError as exc:
            log.warning("APNs request failed: %s", exc)
            return SendResult(SendOutcome.FAILED, str(exc) or exc.__class__.__name__)
        return _classify(response)


def _classify(response: httpx.Response) -> SendResult:
    if response.status_code == 200:
        return SendResult(SendOutcome.SUCCESS)
    try:
        body = response.json()
    except ValueError:
        body = None
    raw = body.get("reason") if isinstance(body, dict) else None
    reason = raw if isinstance(raw, str) else None
    if response.status_code == 410 or reason in _GONE_REASONS:
        return SendResult(SendOutcome.GONE, reason)
    log.warning("APNs rejected push: %s %s", response.status_code, reason)
    return SendResult(SendOutcome.FAILED, reason)


def push_sender_from_env() -> PushSender:
    """The single construction point for the process-wide sender: a real
    ``APNsClient`` when configured, else a ``NoopSender``."""
    config = APNsConfig.from_env()
    if config is None:
        log.info("APNs not configured — push notifications will return 503")
        return NoopSender()
    return APNsClient(config)
