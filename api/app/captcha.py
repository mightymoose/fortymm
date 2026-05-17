"""Cloudflare Turnstile verification.

Defaults to Cloudflare's documented "always passes" test secret key, so dev
and tests work without any setup. Set ``TURNSTILE_SECRET_KEY`` to a real key
in production. The matching site key for tests/dev is ``1x00000000000000000000AA``.
"""

import os

import httpx

TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
TURNSTILE_TEST_SECRET_ALWAYS_PASSES = "1x0000000000000000000000000000000AA"


def _secret_key() -> str:
    return os.environ.get("TURNSTILE_SECRET_KEY", TURNSTILE_TEST_SECRET_ALWAYS_PASSES)


async def verify_captcha(token: str | None) -> bool:
    if not token:
        return False
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                TURNSTILE_VERIFY_URL,
                data={"secret": _secret_key(), "response": token},
            )
        if resp.status_code != 200:
            return False
        body = resp.json()
    except (httpx.HTTPError, ValueError):
        return False
    return bool(body.get("success"))
