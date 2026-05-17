"""Cloudflare Turnstile verification.

Defaults to Cloudflare's documented "always passes" test secret key in
dev/test, so the local loop works without any setup. In any other
``APP_ENV`` (``staging``, ``production``, etc.) ``TURNSTILE_SECRET_KEY``
must be set explicitly — otherwise verification raises at startup-equivalent
time (first call) rather than silently fail-opening on every request. The
matching site key for the dev test secret is ``1x00000000000000000000AA``.
"""

import os

import httpx

TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
TURNSTILE_TEST_SECRET_ALWAYS_PASSES = "1x0000000000000000000000000000000AA"
DEV_ENVS = frozenset({"dev", "development", "test", "testing", "local"})


def _app_env() -> str:
    return os.environ.get("APP_ENV", "dev").lower()


def _secret_key() -> str:
    key = os.environ.get("TURNSTILE_SECRET_KEY")
    if key:
        return key
    if _app_env() in DEV_ENVS:
        return TURNSTILE_TEST_SECRET_ALWAYS_PASSES
    raise RuntimeError(
        "TURNSTILE_SECRET_KEY must be set when APP_ENV is not dev/test — "
        "refusing to fall back to the always-passes test key in a non-dev "
        "environment."
    )


async def verify_captcha(token: str | None) -> bool:
    if not token:
        return False
    try:
        secret = _secret_key()
    except RuntimeError:
        # Fail closed rather than silently disabling abuse protection.
        return False
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                TURNSTILE_VERIFY_URL,
                data={"secret": secret, "response": token},
            )
        if resp.status_code != 200:
            return False
        body = resp.json()
    except (httpx.HTTPError, ValueError):
        return False
    return bool(body.get("success"))
