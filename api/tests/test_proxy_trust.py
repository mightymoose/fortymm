"""Pins the proxy-trust logic (Uvicorn's ProxyHeadersMiddleware) and the
public match-details limiter's per-IP bucketing.

Both behaviours are load-bearing for anti-scrape rate limiting: if the edge
stops trusting our private-network proxies, X-Forwarded-For is ignored and
every caller collapses onto the proxy's IP (one shared bucket). See
docs/adr/0008-trust-client-ip-at-the-uvicorn-edge.md.
"""

from typing import Any

from starlette.requests import Request
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.matches import _match_details_ip_key
from app.tournaments import _preview_ip_rate_limit_key

# Intentionally duplicated from the deploy manifests (docker-compose.dev/qa.yml,
# deploy/uat/values.yaml) — YAML can't import a Python constant. Narrowing this
# must fail CI. See docs/adr/0008-trust-client-ip-at-the-uvicorn-edge.md
TRUST = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8"


async def _client_seen_by_app(
    xff: bytes,
    *,
    peer: tuple[str, int],
) -> str:
    """Drive one request through ProxyHeadersMiddleware(trusted_hosts=TRUST)
    and return the client host the wrapped app ends up seeing.

    `peer` is the *immediate* ASGI peer (scope["client"]) — the socket the
    request actually arrived on. ProxyHeadersMiddleware only rewrites the
    client from X-Forwarded-For when that peer is itself trusted; an untrusted
    peer makes it return early and the header is ignored. We therefore set a
    private, trusted peer so the rewrite path is actually exercised (otherwise
    the assertion would pass vacuously).
    """
    captured: list[str] = []

    async def inner(scope: dict[str, Any], receive: Any, send: Any) -> None:
        client = scope["client"]
        captured.append(client[0])

    app = ProxyHeadersMiddleware(inner, trusted_hosts=TRUST)

    scope: dict[str, Any] = {
        "type": "http",
        "client": peer,
        "headers": [(b"x-forwarded-for", xff)],
    }

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        return None

    await app(scope, receive, send)
    return captured[0]


async def test_forwarded_for_resolves_to_real_client_behind_trusted_proxy() -> None:
    # Peer 10.0.0.9 is private → trusted, so the middleware honours XFF.
    # C=203.0.113.9 (public TEST-NET-3, untrusted) is the real client;
    # S=10.0.0.5 (private, trusted) is our proxy.
    host = await _client_seen_by_app(
        b"203.0.113.9, 10.0.0.5",
        peer=("10.0.0.9", 12345),
    )
    assert host == "203.0.113.9"


async def test_forwarded_for_ignores_client_forged_public_hop() -> None:
    # A client can prepend a forged hop, but the right-to-left walk skips the
    # trusted proxy (10.0.0.5) and stops at the first *untrusted* address
    # (203.0.113.9), never reaching the forged 6.6.6.6.
    host = await _client_seen_by_app(
        b"6.6.6.6, 203.0.113.9, 10.0.0.5",
        peer=("10.0.0.9", 12345),
    )
    assert host == "203.0.113.9"


def _request_from(client_host: str) -> Request:
    scope: dict[str, Any] = {
        "type": "http",
        "client": (client_host, 0),
        "headers": [],
    }
    return Request(scope)


async def test_match_details_ip_key_buckets_distinct_clients() -> None:
    key_a = await _match_details_ip_key(_request_from("1.1.1.1"))
    key_b = await _match_details_ip_key(_request_from("2.2.2.2"))

    assert key_a == "match-details-ip:1.1.1.1"
    assert key_b == "match-details-ip:2.2.2.2"
    assert key_a != key_b


async def test_preview_ip_rate_limit_key_buckets_distinct_clients() -> None:
    # The per-IP ceiling on schedule-preview is what stops a caller cycling fresh
    # /v1/session cookies (each a new per-session bucket) to multiply the per-session
    # budget: only a stable, per-host key catches that, so two IPs must bucket apart
    # and one IP must bucket together regardless of session. (The looser 20/min rate
    # itself is declarative config; this pins the load-bearing key logic, like
    # ``test_match_details_ip_key_buckets_distinct_clients`` above.)
    key_a = await _preview_ip_rate_limit_key(_request_from("1.1.1.1"))
    key_b = await _preview_ip_rate_limit_key(_request_from("2.2.2.2"))
    key_a_again = await _preview_ip_rate_limit_key(_request_from("1.1.1.1"))

    assert key_a == "schedule-preview-ip:1.1.1.1"
    assert key_b == "schedule-preview-ip:2.2.2.2"
    # Two hosts land in different buckets; the same host always lands in one — so a
    # single host can't rotate sessions to escape the aggregate ceiling.
    assert key_a != key_b
    assert key_a == key_a_again
