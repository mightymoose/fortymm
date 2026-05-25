"""Redis-backed rate limiting on pyrate-limiter.

fastapi-limiter 0.2 dropped the global ``FastAPILimiter.init/close`` lifecycle
and switched its backend to ``pyrate_limiter``. Each ``RateLimiter`` now takes
a ``pyrate_limiter.Limiter`` whose bucket has to be built via an async Redis
round-trip (``SCRIPT LOAD``) — but FastAPI routes reference the dependencies
at import time, before the lifespan runs.

We bridge that gap here. ``RedisRateLimiter`` is a callable dependency that
holds its rate spec at construction time and lazily builds a ``RedisBucket``
**per identifier** on first request, using the Redis client published via
``init_rate_limit_redis``.

The per-identifier dispatch matters: ``pyrate_limiter.Limiter`` with a single
bucket collapses every ``try_acquire(name=...)`` call into one shared ZSET —
i.e. all identifiers compete for the same N requests. To get the v0.1.6
semantics where "20 sends per IP" really meant "20 per IP, independently of
other IPs", each distinct identifier gets its own ``RedisBucket`` namespaced
by ``f"{bucket_key}:{rate_key}"``. We don't subclass the upstream
``RateLimiter`` since each of our limiters maps to exactly one route — the
upstream route/dep-index keying buys us nothing.

Caveat: the per-process ``Limiter`` cache below grows with the identifier
cardinality (one entry per distinct IP / hashed session cookie) and is never
evicted, so this is appropriate for the current single-instance deployment;
a long-running production process would want an LRU on ``_limiters`` and a
TTL on the underlying ZSETs.
"""

from collections.abc import Awaitable, Callable

import redis.asyncio as redis_asyncio
from fastapi import HTTPException, Request, Response, status
from pyrate_limiter import Limiter, Rate, RedisBucket

_redis: redis_asyncio.Redis | None = None
_instances: list["RedisRateLimiter"] = []


def init_rate_limit_redis(connection: redis_asyncio.Redis) -> None:
    """Publish the Redis client all ``RedisRateLimiter`` dependencies share.

    Called from the FastAPI lifespan and from the test conftest. Resets any
    cached per-identifier ``Limiter``s so a re-init (e.g. between test
    sessions on a fresh event loop) builds fresh script handles."""
    global _redis
    _redis = connection
    for instance in _instances:
        instance._reset()


def shutdown_rate_limit_redis() -> None:
    """Drop the Redis client and any cached buckets. The cached buckets pin
    the previous event loop's connection, so the next init has to rebuild."""
    global _redis
    _redis = None
    for instance in _instances:
        instance._reset()


class RedisRateLimiter:
    """A FastAPI dependency enforcing a per-identifier pyrate-limiter rate.

    ``bucket_key`` is the Redis namespace prefix shared by every identifier's
    bucket — pick a distinct one per limiter so independent limits don't
    collide. The ``identifier`` is called per-request and its result becomes
    the per-bucket suffix (typically per-user or per-IP).

    If no Redis connection is published (e.g. offline tooling, Redis down at
    startup), the limiter falls open and the request proceeds — matching the
    pre-0.2 behaviour where a missing ``FastAPILimiter.init`` left protected
    routes responding normally rather than 500ing.
    """

    def __init__(
        self,
        *,
        rates: list[Rate],
        bucket_key: str,
        identifier: Callable[[Request], Awaitable[str]],
    ):
        self._rates = rates
        self._bucket_key = bucket_key
        self._identifier = identifier
        self._limiters: dict[str, Limiter] = {}
        _instances.append(self)

    def _reset(self) -> None:
        self._limiters.clear()

    async def __call__(self, request: Request, response: Response) -> None:
        if _redis is None:
            return

        rate_key = await self._identifier(request)
        limiter = self._limiters.get(rate_key)
        if limiter is None:
            bucket = await RedisBucket.init(
                self._rates, _redis, f"{self._bucket_key}:{rate_key}"
            )
            limiter = Limiter(bucket)
            self._limiters[rate_key] = limiter

        success = await limiter.try_acquire_async(rate_key, blocking=False)
        if not success:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too Many Requests",
            )
