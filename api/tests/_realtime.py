"""Observe realtime hints the way a real client does — at the broker.

**Never over the socket.** ``httpx.ASGITransport`` buffers an entire response
before returning, so ``api_client.stream("GET", "/v1/stream")`` against the
endless SSE generator does not time out — it wedges the suite forever. So the
mutation is driven through ``api_client`` normally (a POST terminates) and the
fan-out is asserted on broker attachments, which is the same fan-in a connected
stream reads from.

**Why a barrier rather than a sleep.** "User X was hinted zero times" cannot be
proved by waiting a little and finding nothing — that green is indistinguishable
from "the publish had not landed yet". :meth:`HintWatch.collect` instead
publishes a :attr:`~app.realtime.EventKind.resync` sentinel to *every* watched
user after the mutation has returned and drains each attachment up to it. Redis
pub/sub preserves per-channel order and the broker reads a single connection, so
any hint the mutation really published is delivered *before* the barrier: what
comes back before the sentinel is the exact, complete set of hints that write
produced. Zero is then an assertion, not a hope.

Every wait is bounded by :data:`HINT_TIMEOUT_S`; there is no bare ``await`` on a
stream anywhere in here.
"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager

from app.realtime import EventKind, RealtimeBroker, RealtimeEvent, publish_event

#: Generous enough that a loaded CI box doesn't flake, small enough that a
#: genuine hang reddens in seconds instead of wedging the run.
HINT_TIMEOUT_S = 10.0


class HintWatch:
    """Attached broker streams for a fixed set of users, drained on demand."""

    def __init__(self, streams: dict[uuid.UUID, AsyncIterator[RealtimeEvent]]) -> None:
        self._streams = streams

    async def collect(self) -> dict[uuid.UUID, list[EventKind]]:
        """Every hint each watched user received since attaching, in order.

        Call it *after* the write under test has returned. Publishes the barrier
        sentinel to each watched channel, then drains up to it.
        """
        for user_id in self._streams:
            publish_event(user_id, EventKind.resync)
        return {
            user_id: await _drain_to_barrier(stream)
            for user_id, stream in self._streams.items()
        }


async def _drain_to_barrier(stream: AsyncIterator[RealtimeEvent]) -> list[EventKind]:
    received: list[EventKind] = []
    async with asyncio.timeout(HINT_TIMEOUT_S):
        async for event in stream:
            if event.kind is EventKind.resync:
                return received
            received.append(event.kind)
    raise AssertionError("the broker stream ended before the barrier arrived")


@asynccontextmanager
async def watch_hints(
    broker: RealtimeBroker, *user_ids: uuid.UUID
) -> AsyncIterator[HintWatch]:
    """Attach one broker stream per user id for the body of the ``with``.

    Enter this *before* driving the write: a subscription established afterwards
    would miss the publish entirely and every assertion would read as "nobody was
    hinted".
    """
    async with AsyncExitStack() as stack:
        streams = {
            user_id: await stack.enter_async_context(broker.subscribe(user_id=user_id))
            for user_id in user_ids
        }
        yield HintWatch(streams)
