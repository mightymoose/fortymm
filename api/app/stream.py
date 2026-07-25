"""``GET /v1/stream`` — the per-user Server-Sent Events connection.

The HTTP adapter over ``app.realtime``: it authenticates the caller, attaches
them to the process broker, and turns the coalesced hints that come back into
SSE frames. It holds no domain logic and publishes nothing — write paths do that
(ADR "realtime topics are per-user, and the server resolves who is affected").

Four things here are deliberate, and each of them is load-bearing.

**No query parameters.** The topic is always and only ``user:<caller>``. A client
cannot name a topic, so there is nothing to authorize beyond "are you signed in"
— no permission check, no ``visible_to`` predicate, no 403/404 distinction to
keep in agreement with ``GET /v1/tournaments/{id}``.

**The connection holds zero database connections.** This is the one rule that, if
broken, takes the pod down rather than the feature. FastAPI enters *yield*
dependencies on the request's ``AsyncExitStack``, which wraps ``await
response(...)`` — so a ``Depends(get_session)`` on a streaming route stays checked
out for the whole life of the stream. ``app.db`` builds its engine on asyncpg's
defaults (``pool_size=5, max_overflow=10``), so roughly fifteen open browser tabs
would exhaust the pool and every *other* request on that pod would start taking
the 503 path in ``app.main.db_pool_timeout_handler``. Instead the route injects a
session **factory** and :func:`get_stream_principal` opens a short-lived session
inside it, which is closed before the response even begins. ``tests/
test_realtime_stream_route.py`` guards both halves: that ``get_session`` is
absent from this route's dependency graph, and that exactly one session opens and
closes before the first byte.

**Refusals must be dependencies, never generator body.** An exception raised
inside an SSE generator surfaces *after* the 200 and its headers are on the wire;
FastAPI's SSE producer runs it in an anyio task group, so an ``HTTPException``
there is an unhandled ``ExceptionGroup``, not a 401. Every way this route can say
no — auth, realtime being unavailable — therefore resolves in a dependency,
before a byte is sent.

**The lifetime bound scopes to the wait, not the whole body.** ``asyncio.timeout``
cancels the *task* that entered it, and the task iterating this generator spends
half its life parked in the SSE producer's ``send_stream.send`` — outside the
generator frame — whenever the consumer applies back-pressure (a backgrounded
tab, a slow proxy). A timeout wrapping the whole body and firing in that window
raises ``CancelledError`` in the producer instead of ``TimeoutError`` inside the
scope, which the task group reports as a crash rather than a stream that ended.
So the deadline is monotonic and only ever wraps ``anext``, which is the only
place this generator waits.
"""

import asyncio
import hashlib
import random
import uuid
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from typing import Annotated, Protocol

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, status
from fastapi.sse import EventSourceResponse, ServerSentEvent
from pyrate_limiter import Duration, Rate
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_sessionmaker
from app.rate_limiting import RedisRateLimiter
from app.realtime import (
    EventKind,
    RealtimeBroker,
    RealtimeEvent,
    get_broker,
)
from app.sessions import SESSION_COOKIE_NAME, get_current_user

router = APIRouter(prefix="/v1")

#: ``Retry-After`` on the 503 we answer when this process has no broker. Short,
#: because the cause is a Redis blip or a pod that booted before Redis came up,
#: and the client's own ``retry:`` hint does not apply to a request that never
#: became a stream.
REALTIME_UNAVAILABLE_RETRY_AFTER_SECONDS = 30


@dataclass(frozen=True, slots=True)
class StreamPrincipal:
    """Who the stream belongs to — an id, deliberately not a ``User``.

    The authenticating session is closed before the stream starts, which leaves
    any ORM ``User`` detached: reading an attribute that was not already loaded
    raises ``MissingGreenlet`` somewhere deep in the writer, at whatever minute
    of a fifteen-minute connection it happens. Carrying the one field the stream
    actually needs makes that unrepresentable rather than merely avoided.
    """

    user_id: uuid.UUID


class SessionFactory(Protocol):
    """Opens a database session the caller owns the lifetime of.

    ``async_sessionmaker[AsyncSession]`` satisfies this, and so does a test
    double handing back the suite's shared session. Typed as a ``Protocol``
    rather than the concrete sessionmaker so the seam is substitutable and the
    checker verifies the wiring (``api/CLAUDE.md``, "Service layer and
    dependency injection").
    """

    def __call__(self) -> AbstractAsyncContextManager[AsyncSession]: ...


async def get_stream_session_factory() -> SessionFactory:
    """The process-wide session factory, as a dependency.

    A *factory*, not a session: injecting ``Depends(get_session)`` here would
    pin a pooled connection for the life of the stream (see the module
    docstring). This is the override point tests use to hand the route an
    instrumented factory.
    """
    return get_sessionmaker()


async def get_stream_broker() -> RealtimeBroker | None:
    """The process broker, or ``None`` when realtime is unavailable.

    A thin async wrapper over ``app.realtime.get_broker`` so it resolves on the
    event loop rather than in FastAPI's threadpool, and so tests have a
    per-route override point.
    """
    return get_broker()


async def get_stream_principal(
    session_cookie: Annotated[str | None, Cookie(alias=SESSION_COOKIE_NAME)] = None,
    make_session: SessionFactory = Depends(get_stream_session_factory),
) -> StreamPrincipal:
    """Authenticate the caller on a session that closes before the stream opens.

    ``get_current_user`` is called as the ordinary ``async def`` it is rather
    than declared as ``Depends``, because declaring it would drag its own
    ``Depends(get_session)`` into this route's dependency graph — the exact
    connection pin this route exists to avoid. The refusals are identical: the
    structured ``session_ended`` / ``session_merged`` 401s, raised here where
    they can still become a response.
    """
    async with make_session() as db:
        user = await get_current_user(session_cookie=session_cookie, db=db)
        return StreamPrincipal(user_id=user.id)


async def get_stream_events(
    principal: StreamPrincipal = Depends(get_stream_principal),
    broker: RealtimeBroker | None = Depends(get_stream_broker),
) -> AsyncIterator[AsyncIterator[RealtimeEvent]]:
    """Attach to the caller's topic for the life of the request.

    A *yield* dependency on purpose — the opposite call from the session above.
    The broker attachment is exactly the thing that should live as long as the
    stream, and the request exit stack is what guarantees it is detached when
    the client goes away, however it goes away — the ``http.disconnect`` a
    navigating tab produces unwinds this stack within a second, which is what
    keeps a user's slots from accumulating as they move around the app.

    The one refusal left — realtime being unavailable — happens in
    ``__aenter__``, before the response starts, so it is a real status code
    rather than a truncated ``text/event-stream``. The per-user cap used to
    refuse here too; it now displaces the caller's own oldest stream instead
    (``RealtimeBroker._attach``), because the slot it was refusing over may be
    held by a client that is *gone but still connected* — suspended, frozen,
    asleep — which no amount of disconnect detection can see.
    """
    if broker is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Realtime updates are unavailable. Please retry.",
            headers={"Retry-After": str(REALTIME_UNAVAILABLE_RETRY_AFTER_SECONDS)},
        )
    async with broker.subscribe(user_id=principal.user_id) as events:
        yield events


async def _stream_rate_limit_key(request: Request) -> str:
    """Key the connect limiter by hashed session cookie, so the budget is per
    **session** and independent of other players. The raw cookie is a bearer
    credential, so it is sha256-hashed before it becomes a Redis key (matching
    the email and schedule-preview limiters). A cookie-less request falls back to
    client IP — it will 401 downstream anyway, but the attempt still counts."""
    cookie = request.cookies.get(SESSION_COOKIE_NAME)
    if cookie:
        return f"session:{hashlib.sha256(cookie.encode('utf-8')).hexdigest()}"
    client = request.client
    return f"ip:{client.host if client else 'unknown'}"


async def _stream_ip_rate_limit_key(request: Request) -> str:
    """Per-IP key for the looser ceiling that catches a caller cycling fresh
    ``/v1/session`` cookies to bypass the per-session limit (each ``GET
    /v1/session`` mints one for free), so the per-session budget cannot simply be
    multiplied by rotating sessions from one host."""
    client = request.client
    return f"stream-ip:{client.host if client else 'unknown'}"


# Connect limiting, two-tier like the schedule-preview limiters. This is the
# **soft** limit: ``RedisRateLimiter`` falls open when Redis is unpublished or
# errors mid-call, so the hard ceiling on what one user can pin in a process
# stays the broker's in-process per-user connection cap
# (``REALTIME_MAX_CONNECTIONS_PER_USER``), which holds by *displacing* that
# user's oldest stream rather than by refusing the new one. What these limiters
# buy is the other bound, the one the concurrency cap cannot see: *connect
# churn* — a client stuck in a reconnect loop, a script opening and dropping
# streams, or a user running more tabs than the cap, whose displaced streams
# reconnect in rotation.
#
# The budget is sized against the worst *legitimate* burst, not the steady state:
# a stream lives 15 minutes, so four healthy tabs connect ~4 times per quarter
# hour, but a proxy killing connections leaves those same four tabs reconnecting
# on the jittered 3–8s ``retry:`` hint, which is ~45 connects a minute.
stream_connect_rate_limit = RedisRateLimiter(
    rates=[Rate(60, Duration.MINUTE)],
    bucket_key="realtime-stream",
    identifier=_stream_rate_limit_key,
)
stream_connect_ip_rate_limit = RedisRateLimiter(
    rates=[Rate(240, Duration.MINUTE)],
    bucket_key="realtime-stream-ip",
    identifier=_stream_ip_rate_limit_key,
)


def _reconnect_delay_ms() -> int:
    """The jittered ``retry:`` hint, in milliseconds.

    The jitter is the whole point. Every stream is finite by design, and the
    events that end them are correlated — a rolling deploy drops all of them in
    the same second, and the max-lifetime expiries of a cohort that connected
    together fall due together. A fixed delay turns either into a synchronized
    thundering herd against a pod that has just started.
    """
    settings = get_settings()
    return settings.realtime_retry_base_ms + random.randint(
        0, settings.realtime_retry_spread_ms
    )


@router.get(
    "/stream",
    response_class=EventSourceResponse,
    dependencies=[
        Depends(stream_connect_ip_rate_limit),
        Depends(stream_connect_rate_limit),
    ],
)
async def stream(
    events: AsyncIterator[RealtimeEvent] = Depends(get_stream_events),
) -> AsyncGenerator[ServerSentEvent]:
    """Live dashboard invalidation hints for the signed-in caller, over
    Server-Sent Events.

    Takes no parameters: the topic is always the caller's own user, resolved from
    the session cookie. A client cannot subscribe to anything else.

    The stream never carries domain data — only a hint that something the
    caller's dashboard shows has changed, which the client answers by refetching
    `GET /v1/dashboard` through its normal authenticated read. Frames are one
    unnamed `message` stream (no `event:` field), so a client needs exactly one
    parser; the kind lives in the JSON payload.

    On connect the server sends a reconnection-delay directive, then a single
    `resync` hint — a reconnecting client may have missed events while it was
    away, and refetching once on connect is what makes that recoverable without a
    replay log or a cursor. Live hints follow as they happen, coalesced over a
    short window so a burst of writes is one refetch rather than many.

    The connection is deliberately finite and ends on its own after
    `REALTIME_MAX_STREAM_SECONDS`; `EventSource` reconnects for free, which
    re-runs authentication. A user may hold only a few concurrent streams: past
    that, opening a new one ends their oldest, which that client answers with its
    ordinary reconnect. A process with no realtime backend answers 503, and the
    dashboard simply falls back to its existing refetch-on-navigation freshness.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + get_settings().realtime_max_stream_seconds

    yield ServerSentEvent(retry=_reconnect_delay_ms())
    yield ServerSentEvent(data=RealtimeEvent(kind=EventKind.resync))

    while True:
        remaining = deadline - loop.time()
        if remaining <= 0:
            # The lifetime elapsed while the consumer held the previous frame.
            return
        try:
            async with asyncio.timeout(remaining):
                event = await anext(events)
        except TimeoutError:
            # Max lifetime reached. Not an error path: the client reconnects.
            return
        except StopAsyncIteration:
            # The broker detached us — shutdown, or the attachment was dropped.
            return
        yield ServerSentEvent(data=event)
