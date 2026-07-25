"""The realtime core: envelope, publisher, and the per-process multiplexer.

Every wait in here is bounded (``asyncio.timeout`` / ``asyncio.wait_for``). A
bare ``await`` on a stream would turn a regression into a CI job that hangs
until the runner is killed, which reads as infrastructure flake rather than as
the failure it is.
"""

import asyncio
import contextlib
import logging
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Any

import fakeredis
import fakeredis.aioredis
import pytest
from pydantic import ValidationError
from redis.exceptions import ConnectionError as RedisConnectionError

from app.realtime import publisher as publisher_module
from app.realtime.broker import RealtimeBroker
from app.realtime.events import EventKind, RealtimeEvent, user_channel
from app.realtime.publisher import publish_event

# Generous enough that a loaded CI box doesn't flake, short enough that a real
# hang fails the test rather than the job.
WAIT_TIMEOUT_S = 5.0
# How long "and nothing more arrived" waits before it counts as proof.
QUIET_S = 0.3


class Collector:
    """Drains one stream into a list in the background.

    A background drainer rather than ``await anext(...)`` per assertion,
    because ``wait_for`` cancelling an ``__anext__`` throws ``CancelledError``
    into the generator and finishes it — which would make every "should NOT
    receive" assertion destroy the very iterator the next assertion needs.
    """

    def __init__(self, events: AsyncIterator[RealtimeEvent]) -> None:
        self.received: list[RealtimeEvent] = []
        self.task = asyncio.create_task(self._drain(events))

    async def _drain(self, events: AsyncIterator[RealtimeEvent]) -> None:
        async for event in events:
            self.received.append(event)

    async def wait_for_count(self, count: int, timeout: float = WAIT_TIMEOUT_S) -> None:
        async with asyncio.timeout(timeout):
            while len(self.received) < count:
                await asyncio.sleep(0.005)

    @property
    def kinds(self) -> list[EventKind]:
        return [event.kind for event in self.received]

    async def aclose(self) -> None:
        self.task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self.task


async def wait_until(predicate: Any, timeout: float = WAIT_TIMEOUT_S) -> None:
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.005)


@asynccontextmanager
async def running_broker(redis: Any, **kwargs: Any) -> AsyncIterator[RealtimeBroker]:
    kwargs.setdefault("poll_interval", 0.01)
    kwargs.setdefault("reconnect_delay", 0.02)
    kwargs.setdefault("coalesce_delay", 0.0)
    broker = RealtimeBroker(redis, **kwargs)
    await broker.start()
    try:
        yield broker
    finally:
        await broker.close()


class RecordingPubSub:
    """A pub/sub object that remembers its (un)subscribes and can be broken.

    ``fail_next`` arms exactly one ``get_message`` to raise a connection error,
    which is how the reconnect test simulates Redis going away without needing
    a real one to kill.
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.subscribed: list[str] = []
        self.unsubscribed: list[str] = []
        self.fail_next = False

    @property
    def connection(self) -> Any:
        return self._inner.connection

    async def subscribe(self, *channels: str) -> Any:
        self.subscribed.extend(channels)
        return await self._inner.subscribe(*channels)

    async def unsubscribe(self, *channels: str) -> Any:
        self.unsubscribed.extend(channels)
        return await self._inner.unsubscribe(*channels)

    async def get_message(self, **kwargs: Any) -> Any:
        if self.fail_next:
            self.fail_next = False
            raise RedisConnectionError("simulated pub/sub drop")
        return await self._inner.get_message(**kwargs)

    async def aclose(self) -> None:
        await self._inner.aclose()


class RecordingRedis:
    """Wraps a Redis client, handing out (and keeping) ``RecordingPubSub``s."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.pubsubs: list[RecordingPubSub] = []

    def pubsub(self) -> Any:
        pubsub = RecordingPubSub(self._inner.pubsub())
        self.pubsubs.append(pubsub)
        return pubsub


@pytest.fixture
def async_fake(realtime_redis_server: fakeredis.FakeServer) -> Any:
    return fakeredis.aioredis.FakeRedis(server=realtime_redis_server, encoding="utf-8")


# --- the envelope ---------------------------------------------------------


def test_envelope_wire_shape() -> None:
    event = RealtimeEvent(kind=EventKind.dashboard_changed)
    payload = event.model_dump(mode="json")
    assert payload["v"] == 1
    assert payload["kind"] == "dashboard.changed"
    assert event.ts.tzinfo is not None
    assert RealtimeEvent.model_validate_json(event.model_dump_json()) == event


def test_envelope_refuses_unknown_fields_and_versions() -> None:
    """The parse boundary in both directions: a newer replica's message during
    a rolling deploy must be a caught ``ValidationError`` here, not a surprise
    key somewhere downstream."""
    good = '{"v":1,"kind":"resync","ts":"2026-07-24T18:02:11Z"}'
    assert RealtimeEvent.model_validate_json(good).kind is EventKind.resync

    for bad in (
        '{"v":2,"kind":"resync","ts":"2026-07-24T18:02:11Z"}',
        '{"v":1,"kind":"resync","ts":"2026-07-24T18:02:11Z","tournament_id":"x"}',
        '{"v":1,"kind":"tournament.changed","ts":"2026-07-24T18:02:11Z"}',
    ):
        with pytest.raises(ValidationError):
            RealtimeEvent.model_validate_json(bad)


def test_topics_are_per_user() -> None:
    user_id = uuid.uuid4()
    assert user_channel(user_id) == f"rt:user:{user_id}"


# --- the publisher --------------------------------------------------------


def test_publish_event_swallows_redis_failure(monkeypatch, caplog) -> None:
    """Fire-and-forget: a Redis outage degrades freshness, it does not fail the
    write that triggered the hint."""

    def _boom() -> Any:
        raise RedisConnectionError("redis is down")

    monkeypatch.setattr(publisher_module, "_connection", _boom)
    with caplog.at_level(logging.ERROR, logger="uvicorn.error"):
        assert publish_event(uuid.uuid4(), EventKind.dashboard_changed) is False
    assert "Failed to publish realtime" in caplog.text


def test_publish_event_swallows_a_raw_socket_failure(monkeypatch, caplog) -> None:
    """``redis.exceptions.RedisError`` does **not** derive from the builtin
    ``OSError``, so naming only the former would let a socket/DNS failure that
    reaches us before redis-py wraps it fail the write that triggered the hint."""

    def _boom() -> Any:
        raise ConnectionError("connection refused")  # the builtin, i.e. an OSError

    monkeypatch.setattr(publisher_module, "_connection", _boom)
    with caplog.at_level(logging.ERROR, logger="uvicorn.error"):
        assert publish_event(uuid.uuid4(), EventKind.dashboard_changed) is False
    assert "Failed to publish realtime" in caplog.text


def test_publish_event_lets_a_programming_error_propagate(monkeypatch, caplog) -> None:
    """The other half of fire-and-forget: only the *transport* is swallowed.

    A blanket catch here reports a ``TypeError`` from a malformed hint — or an
    ``AttributeError`` from a mis-wired client — as "Failed to publish realtime
    hints" and returns ``False``, which is indistinguishable from a Redis blip
    and which nothing branches on. That bug would be invisible forever, so it
    has to come out. (Post-commit, ``app.realtime.outbox`` still stops it from
    failing an already-committed write — under its own distinct message.)
    """

    class _NotAClient:
        def pipeline(self, transaction: bool = True) -> Any:
            raise TypeError("'NoneType' object is not iterable")

    monkeypatch.setattr(publisher_module, "_connection", _NotAClient)
    with caplog.at_level(logging.ERROR, logger="uvicorn.error"):
        with pytest.raises(TypeError):
            publish_event(uuid.uuid4(), EventKind.dashboard_changed)
    assert "Failed to publish realtime" not in caplog.text


# --- proves 1: per-user isolation ----------------------------------------


async def test_a_hint_reaches_only_its_own_user(async_fake: Any) -> None:
    alice, bob = uuid.uuid4(), uuid.uuid4()
    async with running_broker(async_fake) as broker:
        async with broker.subscribe(user_id=alice) as alice_events:
            async with broker.subscribe(user_id=bob) as bob_events:
                alice_stream = Collector(alice_events)
                bob_stream = Collector(bob_events)
                await wait_until(lambda: len(broker.attached_channels) == 2)

                assert publish_event(alice, EventKind.dashboard_changed) is True

                await alice_stream.wait_for_count(1)
                await asyncio.sleep(QUIET_S)

                assert alice_stream.kinds == [EventKind.dashboard_changed]
                assert bob_stream.received == []

                await alice_stream.aclose()
                await bob_stream.aclose()


# --- proves 2: ref-counted subscriptions ---------------------------------


async def test_two_streams_for_one_user_subscribe_once(async_fake: Any) -> None:
    user_id = uuid.uuid4()
    channel = user_channel(user_id)
    redis = RecordingRedis(async_fake)
    async with running_broker(redis) as broker:
        await wait_until(lambda: bool(redis.pubsubs))
        pubsub = redis.pubsubs[0]

        async with broker.subscribe(user_id=user_id):
            await wait_until(lambda: pubsub.subscribed == [channel])
            async with broker.subscribe(user_id=user_id):
                await asyncio.sleep(QUIET_S)
                # The second stream rides the first stream's subscription.
                assert pubsub.subscribed == [channel]
            # ...and the first stream still holds it after the second leaves.
            await asyncio.sleep(QUIET_S)
            assert pubsub.unsubscribed == []

        await wait_until(lambda: pubsub.unsubscribed == [channel])
        assert len(redis.pubsubs) == 1


async def _ended(events: AsyncIterator[RealtimeEvent]) -> bool:
    """Whether ``events`` has finished, without hanging if it hasn't.

    An evicted stream ends by being woken with its ``detached`` flag set, so
    ``anext`` returns immediately either way — but only bounded, because the
    regression this guards *is* a stream that never ends.
    """
    try:
        async with asyncio.timeout(WAIT_TIMEOUT_S):
            await anext(events)
    except StopAsyncIteration:
        return True
    except TimeoutError:
        raise AssertionError(
            f"the stream was still open {WAIT_TIMEOUT_S}s after it should have "
            "been displaced"
        ) from None
    return False


async def test_a_stream_over_the_cap_displaces_the_users_oldest_one(
    async_fake: Any,
) -> None:
    """The cap chooses who leaves; it does not turn the newcomer away.

    The slot being competed for may be held by a client that is **gone but still
    connected** — an app the OS suspended, a frozen tab, a sleeping laptop.
    Nothing in a socket that is open and still ACKing says so, so refusing the
    new connection leaves a live client silently deaf for up to the full stream
    lifetime (measured against the QA stack: four connected-but-silent clients
    held all four slots for 120s, and the fifth connect took a 429 it could only
    retry into). Displacing the oldest makes that slot self-healing on the very
    next connect.
    """
    user_id = uuid.uuid4()
    async with running_broker(async_fake, max_connections_per_user=2) as broker:
        async with (
            broker.subscribe(user_id=user_id) as oldest,
            broker.subscribe(user_id=user_id) as second,
        ):
            # The third attaches rather than raising...
            async with broker.subscribe(user_id=user_id) as newest:
                # ...the oldest is the one that ends...
                assert await _ended(oldest)
                # ...the cap still holds: two attachments, not three.
                assert broker.attachment_count(user_id) == 2

                # ...and the survivors are genuinely live afterwards: the
                # eviction must not have taken the channel's subscription (or
                # the doorbell) with it.
                second_stream, newest_stream = Collector(second), Collector(newest)
                await asyncio.sleep(QUIET_S)
                publish_event(user_id, EventKind.dashboard_changed)
                await second_stream.wait_for_count(1)
                await newest_stream.wait_for_count(1)
                await second_stream.aclose()
                await newest_stream.aclose()


async def test_an_evicted_streams_own_teardown_leaves_the_survivors_subscribed(
    async_fake: Any,
) -> None:
    """The displaced connection still unwinds its own ``subscribe`` block, some
    scheduler ticks later. That detach must be a no-op: its slot already belongs
    to whoever displaced it, so unsubscribing the channel there would take the
    survivor's delivery down with it — the silent-drop failure, arrived at from
    the other end."""
    user_id = uuid.uuid4()
    channel = user_channel(user_id)
    redis = RecordingRedis(async_fake)
    async with running_broker(redis, max_connections_per_user=1) as broker:
        await wait_until(lambda: bool(redis.pubsubs))
        pubsub = redis.pubsubs[0]

        async with AsyncExitStack() as survivors:
            async with AsyncExitStack() as doomed:
                evicted = await doomed.enter_async_context(
                    broker.subscribe(user_id=user_id)
                )
                await wait_until(lambda: pubsub.subscribed == [channel])
                survivor = await survivors.enter_async_context(
                    broker.subscribe(user_id=user_id)
                )
                assert await _ended(evicted)
            # The evicted stream's own teardown has now run.

            await asyncio.sleep(QUIET_S)
            assert pubsub.unsubscribed == []
            assert broker.attachment_count(user_id) == 1

            stream = Collector(survivor)
            publish_event(user_id, EventKind.dashboard_changed)
            await stream.wait_for_count(1)
            await stream.aclose()


async def test_the_cap_is_concurrency_not_a_quota(async_fake: Any) -> None:
    """Leaving frees a slot, so a user who closes a tab and opens another
    displaces nothing."""
    user_id = uuid.uuid4()
    async with running_broker(async_fake, max_connections_per_user=2) as broker:
        async with broker.subscribe(user_id=user_id) as first:
            async with broker.subscribe(user_id=user_id):
                pass
            async with broker.subscribe(user_id=user_id):
                pass
            async with broker.subscribe(user_id=user_id):
                pass
            # The long-lived first stream was never displaced by any of them.
            stream = Collector(first)
            publish_event(user_id, EventKind.dashboard_changed)
            await stream.wait_for_count(1)
            await stream.aclose()


# --- proves 3: coalescing -------------------------------------------------


PUBLISHES = 50
#: Publish this many hints between yields to the event loop. The yields are the
#: load-bearing part: they let the dispatcher deliver into the attachment
#: *separately*, which is what makes the window (rather than the ``set``) the
#: thing being tested. Ten batches is plenty of separate deliveries and costs
#: ten scheduler round-trips instead of fifty.
PUBLISH_BATCH = 5


async def _coalesce_attempt(redis: Any, window: float) -> tuple[list[EventKind], float]:
    """Publish :data:`PUBLISHES` hints spread across ``window`` and collect.

    Returns the delivered kinds and how long the publish loop actually took, so
    the caller can tell "coalescing is broken" apart from "this machine outran
    the window", which are opposite conclusions from the same red.
    """
    user_id = uuid.uuid4()
    async with running_broker(redis, coalesce_delay=window) as broker:
        async with broker.subscribe(user_id=user_id) as events:
            stream = Collector(events)
            await wait_until(lambda: bool(broker.attached_channels))

            started = time.monotonic()
            for index in range(PUBLISHES):
                publish_event(user_id, EventKind.dashboard_changed)
                if index % PUBLISH_BATCH == PUBLISH_BATCH - 1:
                    await asyncio.sleep(0.002)
            spread = time.monotonic() - started

            await stream.wait_for_count(1)
            # A further full window: anything that failed to coalesce emits one
            # window later, so a shorter wait could not tell the difference.
            await asyncio.sleep(window)
            kinds = list(stream.kinds)
            await stream.aclose()
    return kinds, spread


async def test_fifty_publishes_in_the_window_are_one_event(async_fake: Any) -> None:
    """The publishes are deliberately *spread* (yields between batches), not
    fired in one synchronous burst.

    A burst would prove far less than it looks: every message would already be
    sitting in the connection buffer, so the ``set`` alone would dedupe them and
    the test would stay green with the coalesce window removed entirely. Spread
    across the window, each batch reaches the attachment as its own delivery, so
    only the window can collapse them.

    Hence the window ladder. The whole proof rests on the publish loop finishing
    *inside* the window, and a fixed window is something a loaded box can outrun
    (measured: 1.38s for this loop under heavy parallel load) — at which point
    the test proves nothing and, worse, says so by going red. Retrying on a
    wider window fixes only the harness's own premise; the assertion about
    coalescing is unchanged and is never retried away.
    """
    for window in (1.0, 4.0, 16.0):
        kinds, spread = await _coalesce_attempt(async_fake, window)
        if spread < window:
            break
    else:
        pytest.skip(
            f"the publish loop took {spread:.2f}s — this machine outran even a "
            "16s coalesce window, so the test's premise cannot hold here"
        )

    assert kinds == [EventKind.dashboard_changed], (
        "fifty idempotent hints inside one coalesce window must collapse "
        "to a single refetch, not fan out into a refetch storm"
    )


async def test_coalescing_dedupes_by_kind_it_does_not_drop_kinds(
    async_fake: Any,
) -> None:
    """The other half of the window: it collapses *repeats*, not the set.

    Two different kinds pending at once must both come out — a drain that
    emitted "the" pending hint would look identical in the fifty-publish test
    above (one kind) and would silently swallow a resync that arrived in the
    same window as a change."""
    window = 0.3
    user_id = uuid.uuid4()
    async with running_broker(async_fake, coalesce_delay=window) as broker:
        async with broker.subscribe(user_id=user_id) as events:
            stream = Collector(events)
            await wait_until(lambda: bool(broker.attached_channels))

            publish_event(user_id, EventKind.dashboard_changed)
            publish_event(user_id, EventKind.resync)
            publish_event(user_id, EventKind.dashboard_changed)

            await stream.wait_for_count(2)
            await asyncio.sleep(window)

            assert stream.kinds == [EventKind.dashboard_changed, EventKind.resync]
            await stream.aclose()


# --- proves 4: reconnect re-subscribes and resyncs ------------------------


async def test_reconnect_resubscribes_and_pushes_resync(async_fake: Any) -> None:
    """A silent pub/sub drop is the worst failure available — the client sits
    there believing it is live. So a reconnect owes every attached stream a
    ``resync``, on top of re-subscribing every live channel."""
    user_id = uuid.uuid4()
    channel = user_channel(user_id)
    redis = RecordingRedis(async_fake)
    async with running_broker(redis) as broker:
        await wait_until(lambda: bool(redis.pubsubs))
        async with broker.subscribe(user_id=user_id) as events:
            stream = Collector(events)
            await wait_until(lambda: redis.pubsubs[0].subscribed == [channel])

            redis.pubsubs[0].fail_next = True

            await wait_until(lambda: len(redis.pubsubs) == 2)
            assert redis.pubsubs[1].subscribed == [channel]

            await stream.wait_for_count(1)
            assert stream.kinds == [EventKind.resync]

            # And the replacement connection genuinely carries traffic.
            publish_event(user_id, EventKind.dashboard_changed)
            await stream.wait_for_count(2)
            assert stream.kinds == [EventKind.resync, EventKind.dashboard_changed]
            await stream.aclose()


# --- proves 5: a malformed message does not take the dispatcher down ------


async def test_malformed_message_is_logged_and_survived(
    async_fake: Any, realtime_redis_server: fakeredis.FakeServer, caplog
) -> None:
    user_id = uuid.uuid4()
    channel = user_channel(user_id)
    sync = fakeredis.FakeStrictRedis(server=realtime_redis_server)
    async with running_broker(async_fake) as broker:
        async with broker.subscribe(user_id=user_id) as events:
            stream = Collector(events)
            await wait_until(lambda: bool(broker.attached_channels))

            with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
                sync.publish(channel, "definitely not an envelope")
                sync.publish(channel, '{"v":9,"kind":"resync","ts":"nope"}')
                await asyncio.sleep(QUIET_S)
                assert stream.received == []
                assert "Discarding unparseable realtime message" in caplog.text

                # The dispatcher is still alive and still subscribed.
                publish_event(user_id, EventKind.dashboard_changed)
                await stream.wait_for_count(1)
                assert stream.kinds == [EventKind.dashboard_changed]
            await stream.aclose()


# --- teardown -------------------------------------------------------------


async def test_close_ends_attached_streams(async_fake: Any) -> None:
    """Shutdown wakes every attached iterator instead of leaving it parked on a
    doorbell nobody will ring again."""
    user_id = uuid.uuid4()
    broker = RealtimeBroker(async_fake, coalesce_delay=0.0, poll_interval=0.01)
    await broker.start()
    async with broker.subscribe(user_id=user_id) as events:
        stream = Collector(events)
        await wait_until(lambda: bool(broker.attached_channels))
        await broker.close()
        async with asyncio.timeout(WAIT_TIMEOUT_S):
            await stream.task
        assert stream.received == []
