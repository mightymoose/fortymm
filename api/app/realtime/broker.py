"""One Redis pub/sub connection per API process, multiplexed to many streams.

The naive shape — a ``redis.asyncio`` pub/sub connection per open stream — does
not survive contact with the deployment: UAT's Redis runs capped at 128Mi under
Guaranteed QoS, and a connection per browser tab makes tab count a memory
liability. So a process holds **one** :class:`~redis.asyncio.client.PubSub` and
**one** dispatch task, ref-counts channel subscriptions across the streams that
want them, and fans each message out in-process.

Three things in here are less obvious than they look.

**Coalescing, not bounding.** Each attached stream holds a ``set`` of pending
hint kinds plus an :class:`asyncio.Event`. Its iterator wakes on the event,
sleeps the coalesce window, then drains the set. A bounded queue with a drop
policy would be the reflex, and it would be strictly worse: every hint is an
idempotent invalidation, so collapsing fifty into one is **lossless**, while
``set.add`` cannot raise and so there is no overflow policy to get subtly wrong.
This is what keeps a burst of tournament completions from becoming a refetch
storm.

**Resync on reconnect, or the drop is invisible.** If the pub/sub connection dies
and we merely re-subscribe, every attached client sits there believing it is live
while messages vanish — the worst failure mode available, because it looks
exactly like "nothing happened". So a re-established connection re-subscribes
every live channel *and* pushes :attr:`EventKind.resync` to every attached
stream, which the client turns into the same refetch it does on connect.

**One lock over the pub/sub object.** ``redis.asyncio.PubSub`` shares a single
connection between ``subscribe``/``unsubscribe`` and the reader; mutating the
subscription set from one task while another sits in ``get_message()`` is the
classic corruption bug in this design. The dispatcher therefore polls under the
same :class:`asyncio.Lock` that guards attach/detach, with a short poll timeout
so a subscribe waits milliseconds rather than for traffic.

**The per-user cap evicts, it does not refuse.** See :meth:`RealtimeBroker._attach`.
"""

import asyncio
import contextlib
import logging
import uuid
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Protocol

from pydantic import ValidationError
from redis.asyncio.client import PubSub
from redis.exceptions import RedisError

from app.realtime.events import EventKind, RealtimeEvent, user_channel

log = logging.getLogger("uvicorn.error")

#: How long the dispatcher blocks in ``get_message`` per poll. It holds the
#: pub/sub lock for that long, so this doubles as the worst-case latency of an
#: attach/detach — hence "short" rather than "as long as possible".
POLL_INTERVAL_S = 0.05

#: Backoff after the dispatch loop falls over (Redis restart, network blip).
RECONNECT_DELAY_S = 1.0

DEFAULT_COALESCE_DELAY_S = 0.25
DEFAULT_MAX_CONNECTIONS_PER_USER = 4


class PubSubFactory(Protocol):
    """The whole of what the broker needs from a Redis client.

    ``Redis.pubsub()`` takes its own dedicated connection out of the client's
    pool, which is exactly what pub/sub requires and why the lifespan hands the
    broker the client it already built rather than opening a second one.
    """

    def pubsub(self) -> PubSub: ...


@dataclass
class _Attachment:
    """One attached stream's mailbox: coalesced pending kinds plus a doorbell.

    Keyed by ``channel``, not by user: the channel is what the fan-out matches
    on, and carrying the user id alongside it would be the same fact stored
    twice, in two fields free to disagree. :func:`user_channel` maps one to the
    other wherever the user id is what's actually in hand.
    """

    channel: str
    pending: set[EventKind] = field(default_factory=set)
    doorbell: asyncio.Event = field(default_factory=asyncio.Event)
    detached: bool = False

    def push(self, kind: EventKind) -> None:
        self.pending.add(kind)
        self.doorbell.set()

    def drain(self) -> list[EventKind]:
        """Take everything pending, atomically w.r.t. the event loop.

        No ``await`` between the swap and the clear, so a hint pushed after this
        returns lands in a fresh set behind a re-set doorbell — there is no
        window in which a hint is both un-drained and un-signalled.
        """
        pending = self.pending
        self.pending = set()
        self.doorbell.clear()
        return sorted(pending)


class RealtimeBroker:
    """Fan-in from one Redis pub/sub connection to many per-user streams."""

    def __init__(
        self,
        redis: PubSubFactory,
        *,
        coalesce_delay: float = DEFAULT_COALESCE_DELAY_S,
        max_connections_per_user: int = DEFAULT_MAX_CONNECTIONS_PER_USER,
        reconnect_delay: float = RECONNECT_DELAY_S,
        poll_interval: float = POLL_INTERVAL_S,
    ) -> None:
        self._redis = redis
        self._coalesce_delay = coalesce_delay
        self._max_connections_per_user = max_connections_per_user
        self._reconnect_delay = reconnect_delay
        self._poll_interval = poll_interval
        #: channel -> the attachments ref-counting it. The list *is* the ref
        #: count; the channel is SUBSCRIBEd when it appears and UNSUBSCRIBEd
        #: when it empties.
        self._attachments: dict[str, list[_Attachment]] = {}
        self._pubsub: PubSub | None = None
        self._lock = asyncio.Lock()
        self._task: asyncio.Task[None] | None = None
        self._closed = False
        #: Set once a pub/sub connection has been torn down, so the *next*
        #: successful connect knows it is a reconnect and owes everyone a
        #: resync. False on first connect, when nobody has missed anything.
        self._resync_on_connect = False

    # -- lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        """Connect, then spawn the single dispatch task. Idempotent.

        The connect is done *here* rather than left to the loop's first
        iteration so that a stream attached immediately after ``start()`` is
        genuinely subscribed before it is told it is attached — otherwise there
        is a scheduling-width window in which hints for it are published into a
        channel nobody is listening on yet. Best-effort: if Redis is down at
        boot the loop's backoff picks it up (and everyone attached by then gets
        a resync when it comes back).

        "Best-effort" means *Redis being unreachable*, and only that: a
        ``RedisError`` (redis-py's root, covering the SUBSCRIBE round trip) or a
        raw ``OSError`` from the socket. A boot that fails for any other reason —
        a client that is not a client, a broken ``pubsub()`` — is a wiring bug
        that would otherwise start a dispatch loop doomed to log the same
        exception once a second forever, so it is left to crash the lifespan."""
        if self._task is not None:
            return
        with contextlib.suppress(RedisError, OSError):
            await self._connect()
        self._task = asyncio.create_task(self._dispatch_loop())

    async def close(self) -> None:
        """Stop dispatching, drop the pub/sub connection, wake every stream.

        Attached iterators end rather than hang: each is woken with
        ``detached`` set, so a shutdown closes streams instead of leaving the
        server waiting on tasks that will never be signalled again.
        """
        self._closed = True
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await self._discard_pubsub()
        for attachments in self._attachments.values():
            for attachment in attachments:
                attachment.detached = True
                attachment.doorbell.set()

    @property
    def attached_channels(self) -> frozenset[str]:
        """Channels currently ref-counted by at least one attached stream."""
        return frozenset(self._attachments)

    def attachment_count(self, user_id: uuid.UUID) -> int:
        """How many streams ``user_id`` currently holds in this process.

        The quantity the per-user cap bounds, exposed so that "the cap held" is
        assertable without reaching into ``_attachments`` — and so an operator
        can ask the question in a console.
        """
        return len(self._attachments.get(user_channel(user_id), ()))

    # -- subscription ------------------------------------------------------

    @asynccontextmanager
    async def subscribe(
        self, *, user_id: uuid.UUID
    ) -> AsyncIterator[AsyncIterator[RealtimeEvent]]:
        """Attach a stream for ``user_id`` and yield its coalesced hint iterator.

        Always succeeds: a caller already at the per-user cap displaces their own
        oldest stream rather than being turned away (see :meth:`_attach`). The
        channel is subscribed on the first attachment for this user and
        unsubscribed when the last one leaves.
        """
        attachment = await self._attach(user_id)
        events = self._iterate(attachment)
        try:
            yield events
        finally:
            # Detach *first*: it flags the attachment and rings the doorbell, so
            # an iterator parked in ``__anext__`` wakes and ends by itself.
            await self._detach(attachment)
            with contextlib.suppress(RuntimeError):
                # "asynchronous generator is already running" — some other task
                # is mid-``__anext__``. The detach above has already unblocked
                # it, and closing a generator out from under a running task is
                # neither possible nor necessary.
                await events.aclose()

    async def _attach(self, user_id: uuid.UUID) -> _Attachment:
        """Attach a stream, displacing this user's oldest one if they're at the cap.

        **Why the cap evicts instead of refusing.** A slot is released the moment
        the client's socket closes — a tab navigating away, a reload, a killed
        process are all detected within a second, because Starlette hands the
        response an ``http.disconnect`` and the request's exit stack unwinds
        through :meth:`subscribe`'s ``finally`` (measured against the QA stack:
        four streams, hard-killed clients, a fifth connect succeeds ~1s later).
        What is *not* detectable is a client that stops reading without closing:
        an app the OS suspended on backgrounding, a frozen/discarded browser tab,
        a laptop that slept, a NAT that dropped the flow. Its socket stays open
        and its kernel keeps ACKing, so no write fails and no disconnect arrives
        — the server has nothing to observe. Measured the same way: four
        connected-but-silent clients held all four slots for the whole 120s of
        the probe (and would have held them to the 900s lifetime), and the fifth
        connect took a 429 that the client could only retry into.

        That is the shape of the bug worth fixing: the *refusal* turned an
        undetectable stale slot into a live client that is silently deaf — it
        retries, gets 429, and shows no sign of not being live. Evicting instead
        makes the stale slot self-healing on the very next connect, and picks the
        right victim by default: the newest stream is the tab the user is looking
        at, the oldest is the likeliest ghost.

        The bound itself is unchanged — a user still holds at most
        ``max_connections_per_user`` attachments; the cap only chooses *who
        leaves* rather than turning the newcomer away. Eviction frees the slot
        synchronously here, independent of whether the doomed connection can
        still be flushed to its client. What bounds a user who genuinely runs
        more tabs than the cap is not this number but the connect rate limiters
        on the route, plus each client's own escalating backoff after a
        short-lived connection: they rotate slowly rather than hammering.

        An evicted stream ends exactly the way the 15-minute lifetime ends one —
        flagged and woken, so its iterator returns and its client reconnects.
        Its later :meth:`_detach` is then a no-op, since it is already out of the
        list.
        """
        if self._closed:
            raise RuntimeError("realtime broker is closed")
        channel = user_channel(user_id)
        async with self._lock:
            # Read, don't ``setdefault``: a channel is only ever in the map with
            # at least one attachment, so "present" is exactly "not the first
            # attachment" — which is also what decides whether to SUBSCRIBE.
            attachments = self._attachments.get(channel)
            attachment = _Attachment(channel=channel)
            if attachments is not None:
                # ``while``, not ``if``: the cap can be lowered under a process
                # that already holds more than the new number.
                while len(attachments) >= self._max_connections_per_user:
                    self._evict(attachments.pop(0))
                attachments.append(attachment)
            else:
                self._attachments[channel] = [attachment]
                if self._pubsub is not None:
                    # pubsub is None means a reconnect is in flight; _connect
                    # re-subscribes everything in _attachments, so this channel
                    # is picked up there.
                    await self._pubsub.subscribe(channel)
        return attachment

    def _evict(self, attachment: _Attachment) -> None:
        """End a displaced stream. Caller holds the lock and has already removed
        it from its channel's list, so the slot is free before this returns.

        Synchronous, and deliberately so: it must not await anything while the
        lock is held, and there is nothing to await — flagging and ringing the
        doorbell is the whole of ending a stream. The evicted client's own
        request teardown then runs :meth:`_detach`, which finds it already gone.
        """
        attachment.detached = True
        attachment.doorbell.set()

    async def _detach(self, attachment: _Attachment) -> None:
        async with self._lock:
            attachments = self._attachments.get(attachment.channel)
            if attachments is None:
                return
            attachment.detached = True
            attachment.doorbell.set()
            # ``ValueError`` is the ordinary path for an attachment that was
            # *evicted* (``_attach``): it is already out of the list, and the
            # entry now belongs to whoever displaced it — so the early return
            # below must not unsubscribe the channel out from under them.
            with contextlib.suppress(ValueError):
                attachments.remove(attachment)
            if attachments:
                return
            del self._attachments[attachment.channel]
            if self._pubsub is not None:
                await self._pubsub.unsubscribe(attachment.channel)

    async def _iterate(self, attachment: _Attachment) -> AsyncGenerator[RealtimeEvent]:
        """Wait, coalesce, drain, emit — one iterator per attached stream."""
        while not attachment.detached:
            await attachment.doorbell.wait()
            if attachment.detached:
                return
            if self._coalesce_delay:
                await asyncio.sleep(self._coalesce_delay)
            for kind in attachment.drain():
                yield RealtimeEvent(kind=kind)

    # -- dispatch ----------------------------------------------------------

    async def _dispatch_loop(self) -> None:
        """The process's single reader. Survives Redis going away.

        Same shape as ``app.match_calls.pin_tick_loop`` (``app/match_calls.py``,
        the ``except Exception`` at line 1249): a broad guard around the body with
        a log and a backoff, and ``CancelledError`` (not an ``Exception``) left to
        propagate so shutdown is clean.

        This is the one place in the module where broad is the point rather than
        laziness. The narrow set — ``RedisError``/``OSError`` — is what we *expect*,
        but an unhandled anything here does not fail one hint: it ends the
        process's only reader, and every attached stream then sits believing it is
        live while messages vanish, which is the exact silent-drop failure the
        module docstring is built to avoid. So the loop absorbs a programming
        error too; the difference from a swallow is that ``log.exception`` prints
        the whole traceback and the loop keeps announcing it every
        ``reconnect_delay`` until someone fixes it.
        """
        while True:
            try:
                await self._connect()
                await self._pump()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 -- the loop's boundary; see the docstring
                log.exception(
                    "Realtime dispatch failed; reconnecting in %.1fs",
                    self._reconnect_delay,
                )
                await self._discard_pubsub()
                await asyncio.sleep(self._reconnect_delay)

    async def _connect(self) -> None:
        """(Re-)establish the pub/sub connection and make everyone whole."""
        async with self._lock:
            if self._pubsub is not None:
                return
            pubsub = self._redis.pubsub()
            channels = list(self._attachments)
            if channels:
                await pubsub.subscribe(*channels)
            self._pubsub = pubsub
            if not self._resync_on_connect:
                return
            self._resync_on_connect = False
        # Outside the lock: pushing is synchronous and touches no pub/sub state.
        self._broadcast(EventKind.resync)

    async def _pump(self) -> None:
        while True:
            async with self._lock:
                pubsub = self._pubsub
                if pubsub is None:
                    return
                # ``parse_response`` raises when no channel has ever been
                # subscribed on this pub/sub object ("pubsub connection not
                # set"), which is the normal state of a process with no open
                # streams — idle at the poll cadence rather than reconnecting.
                idle = pubsub.connection is None
                message = (
                    None
                    if idle
                    else await pubsub.get_message(
                        ignore_subscribe_messages=True, timeout=self._poll_interval
                    )
                )
            if idle:
                await asyncio.sleep(self._poll_interval)
                continue
            if message is None:
                # Yield the loop so an attach/detach waiting on the lock runs.
                await asyncio.sleep(0)
                continue
            self._deliver(message)

    def _deliver(self, message: dict[str, object]) -> None:
        if message.get("type") != "message":
            return
        channel = _as_text(message.get("channel"))
        try:
            event = RealtimeEvent.model_validate_json(_as_bytes(message.get("data")))
        except ValidationError:
            # A replica on newer code, or a stray publisher on our namespace.
            # Named and dropped here so it cannot reach a connection's writer.
            log.warning("Discarding unparseable realtime message on %s", channel)
            return
        for attachment in self._attachments.get(channel, ()):
            attachment.push(event.kind)

    def _broadcast(self, kind: EventKind) -> None:
        for attachments in self._attachments.values():
            for attachment in attachments:
                attachment.push(kind)

    async def _discard_pubsub(self) -> None:
        """Throw the pub/sub connection away. Total by contract — see below."""
        async with self._lock:
            pubsub, self._pubsub = self._pubsub, None
            if pubsub is None:
                return
            self._resync_on_connect = True
        # Deliberately broad, and it has to be: this runs *inside* the dispatch
        # loop's own recovery handler (``_dispatch_loop``, above), so anything
        # escaping here escapes the loop's guard entirely and kills the reader —
        # the silent-drop failure that guard exists to prevent. The other caller
        # is ``close()``, where an escape aborts a lifespan shutdown.
        #
        # Named expectations: ``RedisError`` (redis-py's ``TimeoutError`` when
        # the socket won't close in time) and ``OSError``. Beyond those,
        # ``PubSub.aclose`` reaches ``asyncio.timeout`` and the writer, which on
        # a loop being torn down raise ``RuntimeError`` ("Event loop is closed",
        # redis-py#3856) — not nameable as one family. Swallowing even a genuine
        # bug is still right here because the object is being *discarded*: its
        # state after a failed close cannot matter, we already dropped the only
        # reference.
        with contextlib.suppress(Exception):
            # redis-py's PubSub.aclose carries no annotations.
            await pubsub.aclose()  # type: ignore[no-untyped-call]


def _as_text(value: object) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


def _as_bytes(value: object) -> bytes:
    if isinstance(value, bytes):
        return value
    if isinstance(value, str):
        return value.encode("utf-8")
    return repr(value).encode("utf-8")


_broker: RealtimeBroker | None = None


def init_broker(broker: RealtimeBroker) -> None:
    """Publish the process-wide broker.

    Called from the FastAPI lifespan and from the test conftest — the same shape
    as ``app.rate_limiting.init_rate_limit_redis``, and for the same reason:
    ``httpx.ASGITransport`` never runs the app lifespan, so tests have to be able
    to install one themselves.
    """
    global _broker
    _broker = broker


def get_broker() -> RealtimeBroker | None:
    """The published broker, or ``None`` when realtime is unavailable.

    Optional rather than raising so offline tooling (``regen-api-types``, ad-hoc
    local runs) and a Redis-less boot keep working — the same fail-open stance
    ``RedisRateLimiter`` takes. The stream route decides what a missing broker
    means to a client.
    """
    return _broker


async def shutdown_broker() -> None:
    """Drop the published broker and stop its dispatch task."""
    global _broker
    broker, _broker = _broker, None
    if broker is not None:
        await broker.close()
