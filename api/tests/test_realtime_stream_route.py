"""``GET /v1/stream`` — refusals over HTTP, framing by driving the generator.

**Why the streaming path is never tested through ``api_client``.**
``httpx.ASGITransport`` does not stream: it runs the app to completion,
accumulating every body chunk, and only then returns. Pointed at an endless SSE
generator it does not time out — it hangs the whole suite, forever. So the split
here is deliberate and load-bearing:

* every path that **refuses** (401, 429, 503) terminates by itself and is tested
  over HTTP, because the status code and body are the thing under test;
* every path that **streams** is driven either by calling the path-operation
  function directly with a fake event source, or through the raw ASGI interface
  with a harness that disconnects after N frames.

Every wait in this file is bounded by an explicit ``asyncio.timeout``. There is
no bare ``await`` on anything the stream produces — **including the refusals**.
A refusal test terminates only *because the refusal fires*; if the cap or the
limiter stops firing, the same request begins streaming and ``ASGITransport``
never returns. Unbounded, the regression these tests exist to catch would wedge
CI instead of reddening it, so every one of them goes through
:func:`refuse_stream`, which turns "it started streaming" into a named
assertion.
"""

import asyncio
import hashlib
from collections.abc import AsyncIterator, Callable, Iterable, Iterator
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

import pytest
from fastapi.routing import APIRoute
from fastapi.sse import ServerSentEvent
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.routing import BaseRoute

from app.db import get_session
from app.main import app as fastapi_app
from app.realtime import EventKind, RealtimeBroker, RealtimeEvent, publish_event
from app.realtime.broker import DEFAULT_MAX_CONNECTIONS_PER_USER
from app.sessions import SESSION_COOKIE_NAME
from app.stream import (
    SessionFactory,
    _reconnect_delay_ms,
    _stream_ip_rate_limit_key,
    _stream_rate_limit_key,
    get_stream_broker,
    get_stream_session_factory,
    stream,
    stream_connect_rate_limit,
)
from tests._helpers import start_session

# Every wait on a stream in this file is bounded by this. Generous enough that a
# loaded CI box doesn't flake, small enough that a genuine hang is a red test in
# seconds rather than a wedged run.
STREAM_TIMEOUT_S = 10.0


# ---------------------------------------------------------------------------
# fake event sources


async def _never() -> AsyncIterator[RealtimeEvent]:
    """An attachment that never delivers — the idle stream."""
    await asyncio.Event().wait()
    yield RealtimeEvent(kind=EventKind.dashboard_changed)  # pragma: no cover


async def _detached_immediately() -> AsyncIterator[RealtimeEvent]:
    """An attachment the broker has already torn down (shutdown, detach)."""
    return
    yield RealtimeEvent(kind=EventKind.dashboard_changed)  # pragma: no cover


async def _hints(count: int) -> AsyncIterator[RealtimeEvent]:
    for _ in range(count):
        yield RealtimeEvent(kind=EventKind.dashboard_changed)
    await asyncio.Event().wait()


async def _steady_hints(interval: float) -> AsyncIterator[RealtimeEvent]:
    """A busy attachment: a hint every ``interval`` seconds, forever.

    The event source that tells a **total lifetime** apart from an **idle
    timeout**. Under an idle timeout, a stream fed faster than the timeout never
    closes at all — which is a connection that outlives its own auth.
    """
    while True:
        await asyncio.sleep(interval)
        yield RealtimeEvent(kind=EventKind.dashboard_changed)


async def _take(
    events: AsyncIterator[RealtimeEvent], count: int
) -> list[ServerSentEvent]:
    """Pull exactly ``count`` frames off the route generator, then close it."""
    gen = stream(events=events)
    frames: list[ServerSentEvent] = []
    try:
        async with asyncio.timeout(STREAM_TIMEOUT_S):
            for _ in range(count):
                frames.append(await anext(gen))
    except TimeoutError:
        raise AssertionError(
            f"the stream produced {len(frames)} of {count} frames in "
            f"{STREAM_TIMEOUT_S}s and then stalled"
        ) from None
    finally:
        await gen.aclose()
    return frames


async def _drain(events: AsyncIterator[RealtimeEvent]) -> list[ServerSentEvent]:
    """Run the route generator to *completion*, bounded. Only safe for event
    sources / configurations that make the stream finite.

    A timeout here is turned into a named assertion rather than left as a bare
    ``TimeoutError``: the whole point of these tests is that the stream ends by
    itself, so "it did not end" is the finding, and it should read that way in
    the failure rather than as an inscrutable harness timeout.
    """
    frames: list[ServerSentEvent] = []
    try:
        async with asyncio.timeout(STREAM_TIMEOUT_S):
            async for frame in stream(events=events):
                frames.append(frame)
    except TimeoutError:
        raise AssertionError(
            f"the stream was still open after {STREAM_TIMEOUT_S}s — it is not "
            "honouring REALTIME_MAX_STREAM_SECONDS"
        ) from None
    return frames


async def refuse_stream(client: AsyncClient, *, because: str) -> Response:
    """``GET /v1/stream`` expecting a **refusal**, bounded so that a regression
    reddens instead of hanging.

    ``httpx.ASGITransport`` accumulates the whole body before it returns, so a
    request that is *not* refused begins an endless stream and this call never
    comes back — no timeout, no failure, just a wedged run. That is exactly what
    happens when the thing under test breaks: disable the per-user cap and the
    cap test stops refusing, so it stops terminating. Bounding it here converts
    the regression into an assertion that names it, which is the only form in
    which a CI failure is useful.

    ``because`` names the gate the test is exercising, so the message says which
    one stopped firing.
    """
    try:
        async with asyncio.timeout(STREAM_TIMEOUT_S):
            return await client.get("/v1/stream")
    except TimeoutError:
        raise AssertionError(
            f"GET /v1/stream did not refuse within {STREAM_TIMEOUT_S}s — it "
            f"began streaming instead, which means {because} is not firing. "
            "(An unrefused request over ASGITransport never returns.)"
        ) from None


# ---------------------------------------------------------------------------
# raw-ASGI harness


@dataclass
class DrivenStream:
    """One SSE request driven over raw ASGI and cut off after N body chunks."""

    status: int = 0
    headers: dict[str, str] = field(default_factory=dict)
    frames: list[bytes] = field(default_factory=list)


async def drive_stream(cookie: str, *, take: int, timeline: list[str]) -> DrivenStream:
    """Run one ``GET /v1/stream`` against the real ASGI app, take ``take`` body
    chunks, then hang up like a browser closing the tab.

    This is the only end-to-end exercise of the streaming path, and it exists
    because the connection-pinning regression it guards lives in FastAPI's
    *dependency solving* — calling the path-operation function directly would
    skip exactly the machinery under test. It is safe where ``api_client`` is
    not because it controls ``receive``: the moment it has the frames it wants
    it answers ``http.disconnect``, which Starlette turns into a cancellation of
    the response, so the request always ends.
    """
    result = DrivenStream()
    hung_up = asyncio.Event()
    requested = False

    async def receive() -> dict[str, Any]:
        nonlocal requested
        if not requested:
            requested = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await hung_up.wait()
        return {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        if message["type"] == "http.response.start":
            result.status = message["status"]
            result.headers = {
                key.decode(): value.decode() for key, value in message["headers"]
            }
        elif message["type"] == "http.response.body":
            body = message.get("body", b"")
            if body:
                timeline.append(f"frame:{len(result.frames)}")
                result.frames.append(body)
                if len(result.frames) >= take:
                    hung_up.set()

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "https",
        "path": "/v1/stream",
        "raw_path": b"/v1/stream",
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"host", b"testserver"),
            (b"cookie", f"{SESSION_COOKIE_NAME}={cookie}".encode()),
        ],
        "client": ("127.0.0.1", 54321),
        "server": ("testserver", 443),
    }
    async with asyncio.timeout(STREAM_TIMEOUT_S):
        await fastapi_app(scope, receive, send)
    return result


class RecordingSessionFactory:
    """A session factory that logs each open and close onto a shared timeline.

    Hands back the suite's shared session (so the request sees the test's rows)
    but records the *lifecycle* the route drives, which is the thing under test:
    how many sessions the stream opens, and whether they are closed before the
    first byte reaches the client.
    """

    def __init__(self, session: AsyncSession, timeline: list[str]) -> None:
        self._session = session
        self._timeline = timeline
        self.opened = 0
        self.closed = 0

    @asynccontextmanager
    async def _open(self) -> AsyncIterator[AsyncSession]:
        self.opened += 1
        self._timeline.append("session.open")
        try:
            yield self._session
        finally:
            self.closed += 1
            self._timeline.append("session.close")

    def __call__(self) -> Any:
        return self._open()


# ---------------------------------------------------------------------------
# refusals — these terminate *because they refuse*, so each one is bounded


async def test_unauthenticated_stream_is_refused_with_the_structured_401(
    api_client: AsyncClient, realtime_broker: RealtimeBroker
) -> None:
    """No session cookie is the same structured 401 every other route returns —
    ``session_ended``, so a client redirects to sign in rather than treating a
    dead stream as an ordinary transport failure."""
    response = await refuse_stream(api_client, because="the authentication gate")

    assert response.status_code == 401
    assert response.json()["detail"] == {
        "code": "session_ended",
        "message": "You've been signed out. Sign in to continue.",
    }
    # And it never became a stream: no SSE content type, no frames.
    assert response.headers["content-type"] == "application/json"


async def test_a_dead_session_cookie_is_refused_before_the_stream_opens(
    api_client: AsyncClient, db_session: AsyncSession, realtime_broker: RealtimeBroker
) -> None:
    """A cookie that resolves to nobody is refused by the *dependency*, so the
    caller gets a 401 body rather than a 200 that dies mid-``text/event-stream``."""
    api_client.cookies.set(SESSION_COOKIE_NAME, "not-a-real-token", domain="testserver")

    response = await refuse_stream(api_client, because="the authentication gate")

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "session_ended"
    assert realtime_broker.attached_channels == frozenset()


async def test_stream_is_503_when_the_process_has_no_broker(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Realtime unavailable (Redis down at boot, offline tooling) is an honest
    503 with a ``Retry-After``, so the client falls back to its existing
    refetch-on-navigation freshness instead of looping on a broken stream."""
    await start_session(api_client, db_session)

    async def _no_broker() -> RealtimeBroker | None:
        return None

    fastapi_app.dependency_overrides[get_stream_broker] = _no_broker
    try:
        response = await refuse_stream(api_client, because="the missing-broker guard")
    finally:
        del fastapi_app.dependency_overrides[get_stream_broker]

    assert response.status_code == 503
    assert response.headers["Retry-After"] == "30"


async def test_connect_rate_limit_refuses_a_reconnect_loop(
    api_client: AsyncClient, db_session: AsyncSession, realtime_broker: RealtimeBroker
) -> None:
    """The per-session connect limiter 429s once its budget is spent.

    The budget is drained through the limiter's own ``check`` rather than by
    making the requests: each of those requests would have opened a stream that
    ``ASGITransport`` can never finish reading.
    """
    await start_session(api_client, db_session)
    cookie = api_client.cookies[SESSION_COOKIE_NAME]
    key = f"session:{hashlib.sha256(cookie.encode('utf-8')).hexdigest()}"

    while await stream_connect_rate_limit.check(key):
        pass

    response = await refuse_stream(
        api_client, because="the per-session connect rate limiter"
    )

    assert response.status_code == 429
    assert response.json()["detail"] == "Too Many Requests"


async def test_rate_limit_keys_never_carry_the_raw_session_cookie() -> None:
    """The session cookie is a bearer credential, so it is hashed before it
    becomes a Redis key (the schedule-preview limiter's rule)."""

    class _FakeRequest:
        cookies = {SESSION_COOKIE_NAME: "super-secret-token"}
        client = None

    request = _FakeRequest()

    session_key = await _stream_rate_limit_key(request)  # type: ignore[arg-type]
    ip_key = await _stream_ip_rate_limit_key(request)  # type: ignore[arg-type]

    assert "super-secret-token" not in session_key
    assert session_key.startswith("session:")
    assert ip_key == "stream-ip:unknown"


# ---------------------------------------------------------------------------
# framing — the generator, driven directly


async def test_first_frame_is_a_jittered_retry_directive_then_one_resync(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Frame order: a reconnect-delay directive, then exactly one ``resync``,
    both before any live hint — even when a hint is already waiting."""
    monkeypatch.setenv("REALTIME_RETRY_BASE_MS", "3000")
    monkeypatch.setenv("REALTIME_RETRY_SPREAD_MS", "5000")

    # The event source has a hint ready from the first `anext`, so if the
    # preamble were ordered wrong this would catch it.
    frames = await _take(_hints(1), 3)

    retry, resync, live = frames
    assert 3000 <= retry.retry <= 8000
    assert retry.data is None and retry.raw_data is None
    # No `event:` field on any frame: one unnamed `message` stream, one parser.
    assert [frame.event for frame in frames] == [None, None, None]
    assert isinstance(resync.data, RealtimeEvent)
    assert resync.data.kind is EventKind.resync
    assert isinstance(live.data, RealtimeEvent)
    assert live.data.kind is EventKind.dashboard_changed


async def test_the_reconnect_delay_is_actually_jittered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A fixed delay would resynchronise every dropped stream onto the same
    millisecond after a rollout, which is the herd the spread exists to break."""
    monkeypatch.setenv("REALTIME_RETRY_BASE_MS", "3000")
    monkeypatch.setenv("REALTIME_RETRY_SPREAD_MS", "5000")

    samples = {_reconnect_delay_ms() for _ in range(64)}

    assert len(samples) > 1
    assert all(3000 <= sample <= 8000 for sample in samples)


async def test_zero_spread_pins_the_delay_to_the_base(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("REALTIME_RETRY_BASE_MS", "1200")
    monkeypatch.setenv("REALTIME_RETRY_SPREAD_MS", "0")

    assert {_reconnect_delay_ms() for _ in range(8)} == {1200}


async def test_live_hints_follow_the_preamble_in_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("REALTIME_MAX_STREAM_SECONDS", "30")

    frames = await _take(_hints(3), 5)

    kinds = [frame.data.kind for frame in frames[1:]]
    assert kinds == [
        EventKind.resync,
        EventKind.dashboard_changed,
        EventKind.dashboard_changed,
        EventKind.dashboard_changed,
    ]


async def test_stream_ends_cleanly_at_the_configured_max_lifetime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The lifetime bound fires while the stream is idle and ends it — no
    exception, no half-frame. The client reconnects and re-authenticates."""
    monkeypatch.setenv("REALTIME_MAX_STREAM_SECONDS", "1")

    started = asyncio.get_running_loop().time()
    frames = await _drain(_never())
    elapsed = asyncio.get_running_loop().time() - started

    assert len(frames) == 2
    assert frames[0].retry is not None
    assert frames[1].retry is None
    assert frames[1].data.kind is EventKind.resync
    # It waited out the configured second rather than falling out early...
    assert elapsed >= 1.0
    # ...and it ended on its own well inside the harness bound.
    assert elapsed < STREAM_TIMEOUT_S


async def test_a_busy_stream_still_closes_at_the_total_lifetime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The bound is a **total lifetime**, not an idle timeout.

    The distinction is the whole point of the setting. An idle timeout only ever
    fires on a quiet connection, so a stream fed hints faster than the timeout
    would never close — and never re-run authentication either, which is what
    the finite lifetime buys (a signed-out user's connection must not outlive
    their session). This is the only test that can tell the two apart: hints
    arrive every 100ms against a 1s lifetime, so a per-wait timeout would keep
    resetting and the stream would run until the harness bound.
    """
    monkeypatch.setenv("REALTIME_MAX_STREAM_SECONDS", "1")

    started = asyncio.get_running_loop().time()
    frames = await _drain(_steady_hints(0.1))
    elapsed = asyncio.get_running_loop().time() - started

    # Hints really were flowing throughout — otherwise this is just the idle
    # test again and proves nothing about which kind of bound is in force.
    live = [frame for frame in frames if frame.retry is None][1:]
    assert len(live) >= 3, frames
    assert all(frame.data.kind is EventKind.dashboard_changed for frame in live)
    # ...and it still closed on schedule rather than being fed forever.
    assert elapsed >= 1.0
    assert elapsed < 2.0


async def test_an_elapsed_lifetime_ends_the_stream_without_waiting_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The other half of the bound: when the deadline passed while the consumer
    was holding the previous frame, the loop must not start a fresh wait."""
    monkeypatch.setenv("REALTIME_MAX_STREAM_SECONDS", "0")

    frames = await _drain(_hints(5))

    assert len(frames) == 2
    assert frames[1].data.kind is EventKind.resync


async def test_a_detached_attachment_ends_the_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Broker shutdown ends the iterator; the route must finish rather than
    raise ``StopAsyncIteration`` out of an async generator (a ``RuntimeError``)."""
    monkeypatch.setenv("REALTIME_MAX_STREAM_SECONDS", "900")

    frames = await _drain(_detached_immediately())

    assert len(frames) == 2
    assert frames[1].data.kind is EventKind.resync


async def test_a_published_hint_reaches_the_stream_through_the_broker(
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end over the real broker: publish to a user's topic, and that
    user's stream emits a ``dashboard.changed`` frame after its preamble."""
    monkeypatch.setenv("REALTIME_MAX_STREAM_SECONDS", "30")
    from tests._helpers import make_user

    user = await make_user(db_session, "stream-subscriber")

    async with realtime_broker.subscribe(user_id=user.id) as events:
        gen = stream(events=events)
        try:
            async with asyncio.timeout(STREAM_TIMEOUT_S):
                await anext(gen)  # retry
                await anext(gen)  # resync
                # Publish only once the attachment is live, or the hint lands on
                # a channel nobody is subscribed to yet.
                assert publish_event(user.id, EventKind.dashboard_changed)
                live = await anext(gen)
        finally:
            await gen.aclose()

    assert live.data.kind is EventKind.dashboard_changed


# ---------------------------------------------------------------------------
# the P0 regression guard: the stream must hold no database connection


def _api_routes(routes: Iterable[BaseRoute]) -> Iterator[APIRoute]:
    """Every ``APIRoute`` reachable from ``routes``, whatever shape the installed
    FastAPI keeps them in.

    Up to FastAPI 0.139, ``include_router`` **copied** each route into the
    parent's ``app.routes``, so every route was one flat iteration away. 0.140
    changed that: an include now contributes a single opaque ``_IncludedRouter``
    node that holds the original router and resolves through it at request time,
    so the parent's ``routes`` no longer contains the ``APIRoute`` at all.

    That difference is not cosmetic for a guard like the one below — a top-level
    scan simply stops finding the route it is supposed to be checking, and a
    scan written as ``next(...)`` turns that into
    ``RuntimeError: coroutine raised StopIteration`` rather than anything that
    names the problem. (It did exactly that: green locally on 0.136, red on CI,
    which floats to the newest release.) So the walk descends through includes,
    and :func:`_route_for` makes "no such route" an assertion.
    """
    for route in routes:
        if isinstance(route, APIRoute):
            yield route
            continue
        # FastAPI >= 0.140: an ``_IncludedRouter`` standing in for one
        # ``include_router`` call, holding the router whose routes it serves.
        included = getattr(route, "original_router", None)
        if included is not None:
            yield from _api_routes(included.routes)


def _route_for(path: str) -> APIRoute:
    """The one route serving ``path``, or a failure that says so.

    Deliberately not ``next(genexp)``: inside a coroutine a missing match raises
    ``StopIteration``, which PEP 479 converts into an inscrutable
    ``RuntimeError`` about a coroutine, naming neither the route nor the lookup.
    """
    matches = [route for route in _api_routes(fastapi_app.routes) if route.path == path]

    assert len(matches) == 1, (
        f"expected exactly one route serving {path}, found {len(matches)}. "
        "If it is zero, the route moved or FastAPI changed how it stores "
        "included routes again — fix the walk in _api_routes, because a guard "
        "that cannot find its route is not guarding anything."
    )
    return matches[0]


async def test_get_session_is_not_in_the_stream_route_dependency_graph() -> None:
    """``Depends(get_session)`` anywhere in this route's graph would pin a pooled
    connection for the *life of the stream* — FastAPI enters yield dependencies
    on the request exit stack, which wraps ``await response(...)``. The engine's
    defaults give 15 connections per pod, so ~15 open tabs would exhaust the pool
    and every other request on that pod would start taking the 503 path in
    ``app.main.db_pool_timeout_handler``. A self-inflicted outage, so it is
    asserted structurally as well as at runtime."""
    route = _route_for("/v1/stream")

    seen: list[Callable[..., Any] | None] = []
    stack = list(route.dependant.dependencies)
    while stack:
        dependant = stack.pop()
        seen.append(dependant.call)
        stack.extend(dependant.dependencies)

    # The walk reached the leaves. Asserted because every interesting way this
    # guard can rot — a route that isn't found, a dependency tree read off the
    # wrong object, a walk that stops at depth one — ends with an empty-ish
    # ``seen``, in which "get_session is absent" is true of nothing at all.
    # ``get_stream_session_factory`` is the deepest node and is precisely what
    # stands in for ``get_session`` here, so its presence is the positive half
    # of the same statement.
    assert get_stream_session_factory in seen, (
        "the dependency walk did not reach get_stream_session_factory, so it "
        f"never got near the leaves — it saw only {seen}. The absence of "
        "get_session below proves nothing until this holds."
    )
    assert get_session not in seen, (
        "GET /v1/stream must not depend on get_session — it would pin a pooled "
        "database connection for the whole life of the stream."
    )


async def test_the_stream_opens_one_session_and_closes_it_before_the_first_frame(
    api_client: AsyncClient, db_session: AsyncSession, realtime_broker: RealtimeBroker
) -> None:
    """The runtime half of the guard above, over the real ASGI app so FastAPI's
    dependency solving is genuinely in the picture.

    One timeline records both the authenticating session's lifecycle and the
    body chunks as they go out, so the assertion is about *ordering* and not
    merely about counts: the session must be closed before the client is sent
    anything at all. The instrumented ``get_session`` never appearing on that
    timeline is what fails if someone reintroduces the yield dependency.
    """
    await start_session(api_client, db_session)
    cookie = api_client.cookies[SESSION_COOKIE_NAME]

    timeline: list[str] = []
    factory = RecordingSessionFactory(db_session, timeline)

    async def _override_factory() -> SessionFactory:
        return factory

    async def _recording_get_session() -> AsyncIterator[AsyncSession]:
        timeline.append("request-session.open")
        try:
            yield db_session
        finally:
            timeline.append("request-session.close")

    fastapi_app.dependency_overrides[get_stream_session_factory] = _override_factory
    fastapi_app.dependency_overrides[get_session] = _recording_get_session
    try:
        driven = await drive_stream(cookie, take=2, timeline=timeline)
    finally:
        fastapi_app.dependency_overrides.pop(get_stream_session_factory, None)

    assert driven.status == 200
    assert driven.headers["content-type"] == "text/event-stream; charset=utf-8"
    # FastAPI's SSE response sets these for us; nginx buffering would defeat the
    # whole feature, so they are asserted rather than assumed.
    assert driven.headers["cache-control"] == "no-cache"
    assert driven.headers["x-accel-buffering"] == "no"

    # Exactly one session, opened and closed, and both before any byte went out.
    assert (factory.opened, factory.closed) == (1, 1)
    assert timeline == ["session.open", "session.close", "frame:0", "frame:1"]

    # ...and the frames themselves are the documented preamble, on the wire.
    assert driven.frames[0].startswith(b"retry: ")
    assert driven.frames[0].endswith(b"\n\n")
    assert driven.frames[1].startswith(b'data: {"v":1,"kind":"resync"')

    # The attachment is released when the client hangs up.
    assert realtime_broker.attached_channels == frozenset()


# ---------------------------------------------------------------------------
# the per-user cap: a slot is released by a hang-up, and taken back by a
# newcomer when it is not


async def test_repeated_connect_and_hang_up_never_accumulates_attachments(
    api_client: AsyncClient, db_session: AsyncSession, realtime_broker: RealtimeBroker
) -> None:
    """A user moving around the app must not accumulate slots.

    This is the QA report's shape — ``/dashboard`` → ``/matches`` → … six times
    over, each navigation opening a stream and the previous one going away — run
    through the real ASGI app, twice as many times as the cap allows. The
    hang-up is the *disconnect* path (``http.disconnect``, what Starlette gets
    from the server when a socket closes), not a polite generator close.

    It passes on both sides of the eviction change, and that is the finding it
    records: the disconnect path was never where slots leaked. Measured the same
    way against the QA stack — four streams, clients hard-killed, a fifth connect
    succeeds about a second later. What does hold a slot is a client that stops
    reading *without* closing (a suspended app, a frozen tab), which no
    disconnect detection can see and which the test below is about.
    """
    await start_session(api_client, db_session)
    cookie = api_client.cookies[SESSION_COOKIE_NAME]

    for _ in range(DEFAULT_MAX_CONNECTIONS_PER_USER * 2):
        driven = await drive_stream(cookie, take=2, timeline=[])
        assert driven.status == 200
        # Released by the time the request has finished unwinding — not "soon",
        # not at the 900s lifetime.
        assert realtime_broker.attached_channels == frozenset()


async def test_a_connect_at_the_cap_displaces_the_oldest_instead_of_429ing(
    api_client: AsyncClient, db_session: AsyncSession, realtime_broker: RealtimeBroker
) -> None:
    """A user at the cap still gets a live stream.

    The four slots are held by attachments that never end on their own — the
    stand-in for the case the server cannot detect: a client whose socket is open
    and still ACKing but whose process is suspended, frozen or asleep. Refusing
    the newcomer over one of those left a *live* client silently non-live for up
    to the full stream lifetime, with no banner and no stale indicator, which is
    what QA saw. So the newcomer connects and the oldest is displaced instead.

    Held by attaching directly to the broker rather than by opening four real
    streams: four live SSE responses through ``ASGITransport`` would never
    return. The connect itself goes through the real ASGI app, because the 429
    it used to take came from the route's dependency graph.
    """
    user = await start_session(api_client, db_session)
    cookie = api_client.cookies[SESSION_COOKIE_NAME]

    async with AsyncExitStack() as stack:
        held = [
            await stack.enter_async_context(realtime_broker.subscribe(user_id=user.id))
            for _ in range(DEFAULT_MAX_CONNECTIONS_PER_USER)
        ]
        assert realtime_broker.attachment_count(user.id) == (
            DEFAULT_MAX_CONNECTIONS_PER_USER
        )

        driven = await drive_stream(cookie, take=2, timeline=[])

        # It streamed — a real 200 with the documented preamble, not a refusal.
        assert driven.status == 200
        assert driven.headers["content-type"] == "text/event-stream; charset=utf-8"
        assert driven.frames[1].startswith(b'data: {"v":1,"kind":"resync"')

        # The oldest held stream is the one that ended, and the cap still holds:
        # the newcomer took its slot rather than adding a fifth.
        with pytest.raises(StopAsyncIteration):
            async with asyncio.timeout(STREAM_TIMEOUT_S):
                await anext(held[0])
        assert realtime_broker.attachment_count(user.id) == (
            DEFAULT_MAX_CONNECTIONS_PER_USER - 1
        )
