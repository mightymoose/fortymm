"""The realtime wire envelope and the one topic scheme there is.

The stream carries **invalidation hints, never payloads** (ADR "the dashboard is
kept fresh by pushed invalidation hints, not payloads"), so an envelope names a
*kind of staleness* and nothing else — no resource id, no domain state, no
sequence number. There are exactly two kinds and adding a third is a wire-format
decision, which is why they live in a closed :class:`EventKind` rather than as
free strings at the publish sites.

:class:`RealtimeEvent` is the parse boundary in **both** directions. It is what a
publisher serializes onto Redis and what the broker's dispatcher validates coming
back off it — so during a rolling deploy, a message published by a replica running
newer code is a caught ``ValidationError`` in one place, not a ``KeyError`` deep
inside a connection's writer. ``extra="forbid"`` is what makes that true: without
it an unknown field would parse silently and the dispatcher would happily forward
an envelope it does not actually understand.

Topics are per-user and only per-user (ADR "realtime topics are per-user, and the
server resolves who is affected"): :func:`user_channel` is the only channel-name
constructor, so there is no way to express a subscription a client could have
asked for.
"""

import uuid
from datetime import UTC, datetime
from enum import StrEnum
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

#: Namespace prefix for every realtime channel. The Redis instance is shared with
#: the five RQ queues (``app.queue``), which own their own key space, so realtime
#: channels are fenced off under ``rt:`` rather than sitting at the root.
CHANNEL_PREFIX = "rt"


class EventKind(StrEnum):
    """The closed set of hints the stream can carry.

    ``dashboard_changed`` means "refetch ``GET /v1/dashboard``". ``resync`` means
    the same thing plus "you may have missed events" — it is emitted on connect
    and after any pub/sub reconnect, which is what lets a client recover without
    a replay log or a cursor.
    """

    dashboard_changed = "dashboard.changed"
    resync = "resync"


class RealtimeEvent(BaseModel):
    """One hint on the wire: ``{"v": 1, "kind": ..., "ts": <aware ISO8601>}``.

    Frozen because an envelope is a value: the same instance fans out to every
    attached connection, and a mutable one would let a writer scribble on a
    sibling's copy. ``v`` is a ``Literal[1]`` so a future v2 envelope fails
    validation loudly at the dispatcher instead of being half-understood.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    v: Literal[1] = 1
    kind: EventKind
    #: Aware, always — a naive timestamp read back in another process's session
    #: timezone is the failure mode ``api/CLAUDE.md`` bans at every other boundary.
    ts: AwareDatetime = Field(default_factory=lambda: datetime.now(UTC))


def user_channel(user_id: uuid.UUID) -> str:
    """The Redis channel a user's hints are published to.

    The *only* topic constructor. A client never names a topic — ``GET /v1/stream``
    takes no parameters and the server resolves the affected users at each write
    site — so there is nothing here to authorize.
    """
    return f"{CHANNEL_PREFIX}:user:{user_id}"
