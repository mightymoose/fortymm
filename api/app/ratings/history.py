"""A player's rating over a CALENDAR window — the read behind the profile's
rating chart (ADR-0915).

The chart plots rating against calendar time (30d / 90d / 1y), and that is a
question ``rating_history`` cannot answer by filtering itself. The table holds a
row only where a match *completed*, so the left edge of a calendar window is
almost never a match: a player whose last match before the window was in February
has NO ROW at "90 days ago". A window read by clipping strictly to its own bounds
therefore starts at whatever the first in-window match happened to be, and the
headline "+127 over 90 days" it produces is wrong.

So every read here returns a **carry-in anchor**: the player's rating as of the
window start, taken from the last change AT OR BEFORE it — a point from *outside*
the requested window. It is the one thing on the response that makes the net
change true, and it is why this module exists at all rather than being a
``where created_at >= start`` on the router.

Two consequences worth stating once:

* An EMPTY WINDOW is a first-class state, not an error. A rated player who has not
  played in ninety days gets their anchor and zero points; the chart draws a flat
  line at their current rating and suppresses the delta chip (never ``+0``).
* A VOIDED MATCH is ABSENT, not skipped. Voiding deletes its rating-history rows
  (CONTEXT.md, "Voided match"), so it disappears from the timeline — which this
  module gets for free by reading the table, and must never reintroduce by
  re-deriving points from ``matches``.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import assert_never

from sqlalchemy import ColumnElement, Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Match, RatingHistory
from app.ratings.rated import is_rating_change
from app.schemas.rating import RatingHistoryWindow, RatingPoint, RatingWindow

# The most points one window will draw with. A chart is under a thousand pixels
# wide, so a point per pixel is already more resolution than a screen can show;
# beyond this we sample the line down rather than ship a 90 KB payload — which
# would ride on the PROFILE BUNDLE's first paint, not just on a range flip.
#
# Only a player with more rated matches in one window than this ever notices, and
# what they lose is invisible: ``peak`` and ``change`` are folded from the FULL
# set BEFORE the sample, so every number the page quotes stays exact and only the
# drawn line is thinned. (The refinement, if a real chart ever looks jagged, is
# LTTB rather than a uniform stride.)
MAX_POINTS = 400


def window_start(now: datetime, window: RatingWindow) -> datetime:
    """The left edge of the requested calendar window.

    An exhaustive ``match`` with no catch-all (api/CLAUDE.md): adding a range to
    ``RatingWindow`` is a type error here until it is handled, rather than a
    silently-wrong window.
    """
    match window:
        case "30d":
            return now - timedelta(days=30)
        case "90d":
            return now - timedelta(days=90)
        case "1y":
            return now - timedelta(days=365)
        case _ as unreachable:
            assert_never(unreachable)


def _at() -> ColumnElement[datetime]:
    """The instant a rating change happened — the axis the timeline is ordered on.

    ``Match.completed_at`` (ADR-0012): the completion instant is stamped once and
    never moved by a later edit, unlike ``Match.updated_at``. Manual / import
    changes have no match, and keep their own wall-clock ``created_at`` — the same
    axis, just recorded rather than played (ADR-0012 again), which is why this is a
    COALESCE and the join below is an OUTER one.

    Including those match-less rows is load-bearing, not generosity: they are real
    rating changes, and dropping them would let a manual override applied after the
    player's last match vanish from the line — leaving ``points[-1]`` no longer at
    the player's current rating, and so ``change`` quietly wrong. The ``initial``
    seed row is the one match-less kind that is NOT a change, and ``_timeline``
    excludes it.
    """
    return func.coalesce(Match.completed_at, RatingHistory.created_at)


def _timeline(
    user_id: uuid.UUID, league_id: uuid.UUID
) -> Select[tuple[float, uuid.UUID | None, datetime]]:
    """This player's rating CHANGES ON THIS LADDER, as (rating, match, instant).

    League-scoped: a rating is a fact about one ladder (CONTEXT.md, "League"), so
    a chart of the FortyMM ladder must never plot a point earned on a USATT one.

    THE SEED IS NOT A POINT. ``is_rating_change()`` drops the ``initial`` row the
    league writes when a player JOINS it (``seed_user_league_rating``): 1500 is the
    strategy's prior, not a rating the player ever held — at that instant they were
    Unrated, by CONTEXT.md's own definition ("a player who has never finished a
    rated match has no rating"). Plotted, it drew a brand-new guest a one-dot
    "Rating over time" chart of a rating they had never played for; carried in as an
    anchor, it made a first-timer's window read "+134 over 90 days" measured from a
    number they were simply handed. Excluding it is what makes ``_anchor_point``'s
    ``None`` case ("they held no rating at that instant") actually true, and it means
    a player with nothing but the seed gets an EMPTY window — no anchor, no points,
    no peak, no change — which is the honest shape for someone with no rating.

    The other match-less rows (``manual``, ``import``) STAY, and the join stays an
    OUTER one for them: those are real rating changes — an admin override, an
    imported USATT baseline — and dropping one would leave ``points[-1]`` no longer
    at the player's current rating, and so ``change`` quietly wrong.
    """
    at = _at()
    return (
        select(RatingHistory.rating_value, RatingHistory.match_id, at.label("at"))
        .outerjoin(Match, Match.id == RatingHistory.match_id)
        .where(
            RatingHistory.user_id == user_id,
            RatingHistory.league_id == league_id,
            is_rating_change(),
        )
    )


async def _anchor_point(
    db: AsyncSession, user_id: uuid.UUID, league_id: uuid.UUID, start: datetime
) -> RatingPoint | None:
    """The carry-in anchor: the player's rating as of ``start``, read from their
    last change at or before it — a point from OUTSIDE the window.

    ``None`` when they had no rating at that instant (they had not finished a
    rated match yet), which is the only honest answer: there is nothing to carry
    in. That case is REACHED, not hypothetical — the seed a player joins with is
    not a rating change (see ``_timeline``), so a player whose first rated match
    landed inside the window has no anchor, and ``_fold`` measures their ``change``
    from their first in-window point instead of from a 1500 they never earned.
    """
    at = _at()
    row = (
        await db.execute(
            _timeline(user_id, league_id)
            .where(at < start)
            # Ties on the instant (two changes stamped at the same moment) fall
            # back to write order, so the anchor is the LAST of them.
            .order_by(at.desc(), RatingHistory.created_at.desc())
            .limit(1)
        )
    ).first()
    if row is None:
        return None
    rating, match_id, when = row
    return RatingPoint(at=when, rating=rating, match_id=match_id)


async def _window_points(
    db: AsyncSession, user_id: uuid.UUID, league_id: uuid.UUID, start: datetime
) -> list[RatingPoint]:
    """Every rating change inside the window, oldest first."""
    at = _at()
    rows = (
        await db.execute(
            _timeline(user_id, league_id)
            .where(at >= start)
            .order_by(at.asc(), RatingHistory.created_at.asc())
        )
    ).all()
    return [
        RatingPoint(at=when, rating=rating, match_id=match_id)
        for rating, match_id, when in rows
    ]


def downsample(points: list[RatingPoint], cap: int = MAX_POINTS) -> list[RatingPoint]:
    """Thin ``points`` to at most ``cap`` of them, keeping the FIRST and the LAST.

    A uniform stride over the original order, so the result is a subsequence: the
    line keeps its shape and, crucially, its endpoints — the window's first and
    latest ratings are the two the chart's axis and its tooltip are read from.

    A no-op below the cap, which is every real player.
    """
    if len(points) <= cap:
        return points
    # `cap - 1` gaps across `len - 1` gaps of the original, so index 0 maps to the
    # first point and index `cap - 1` to the last.
    stride = (len(points) - 1) / (cap - 1)
    return [points[round(i * stride)] for i in range(cap)]


def _fold(anchor: RatingPoint | None, points: list[RatingPoint]) -> RatingHistoryWindow:
    """Assemble the window: the anchor, the (possibly sampled) line, the in-window
    peak, and the net change.

    ``change`` is measured FROM THE ANCHOR — that is the entire point of having
    one. Measured from ``points[0]`` instead, a window whose first match landed on
    day forty would report only the movement since day forty and call it the
    ninety-day change. The anchor-less case (the player had no rating when the
    window opened) is the only one where ``points[0]`` is the honest baseline,
    because there is nothing earlier to carry in.

    ``peak`` is the highest point IN THE WINDOW, and is not the profile's
    all-time ``peak``. The two are different numbers and neither may be read for
    the other.

    Both ``peak`` and ``change`` are folded over the FULL point list, before any
    downsampling — so thinning the drawn line can never move a number the page
    quotes.
    """
    if not points:
        # An idle window: the anchor alone, a flat line, and NO change. A `0.0`
        # here would claim the player played and moved nothing.
        return RatingHistoryWindow(anchor=anchor, points=[], peak=None, change=None)
    baseline = anchor.rating if anchor is not None else points[0].rating
    return RatingHistoryWindow(
        anchor=anchor,
        points=downsample(points),
        peak=max(points, key=lambda point: point.rating),
        change=points[-1].rating - baseline,
    )


async def player_rating_history(
    db: AsyncSession,
    user_id: uuid.UUID,
    league_id: uuid.UUID,
    window: RatingWindow,
    *,
    now: datetime | None = None,
) -> RatingHistoryWindow:
    """This player's rating over the requested calendar window, on this ladder.

    TWO round trips whatever the size of the history — the anchor and the
    in-window points — never one query per point, and never a fetch of the whole
    timeline to find one number client-side (the option ADR-0915 rejects).

    ``now`` is computed ONCE and bound to both reads, so a row sitting exactly on
    the window's edge cannot fall between two clocks and end up in both halves or
    neither.
    """
    start = window_start(now or datetime.now(UTC), window)
    return _fold(
        await _anchor_point(db, user_id, league_id, start),
        await _window_points(db, user_id, league_id, start),
    )
