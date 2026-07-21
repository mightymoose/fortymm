"""The two primitives that bridge a tournament's *venue wall-clock* and a real
*instant*, in one place (ADR "tournament times are timezone-aware instants").

The frame is anchored by an event's IANA ``timezone``, which is boundary-validated
(``EventTimezone``) — so ``ZoneInfo`` cannot raise on a stored value here. Keeping
the anchor/render in one module is what makes the ADR's "all timezone arithmetic is
resolved once, at the boundary" literally true: DST gap/fold semantics live here,
not re-asserted at every call site.
"""

from datetime import datetime
from zoneinfo import ZoneInfo


def anchor_wallclock(naive: datetime, timezone: str) -> datetime:
    """Anchor a naive **venue wall-clock** (what a director typed, e.g. "18:00")
    to a real instant in ``timezone`` — the inverse of :func:`venue_local`."""
    return naive.replace(tzinfo=ZoneInfo(timezone))


def venue_local(instant: datetime, timezone: str) -> datetime:
    """Render a real instant (asyncpg hands stored ``timestamptz`` back UTC-aware)
    into its wall-clock in ``timezone``, so a caller can label it in the venue's
    frame — not UTC (#1104)."""
    return instant.astimezone(ZoneInfo(timezone))
