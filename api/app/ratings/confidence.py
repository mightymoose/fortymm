"""Rating confidence — how settled a player's rating is (CONTEXT.md, "Rating
confidence").

A read-side derivation, like ``app.ratings.stats``: it changes nothing about how
ratings are *computed*, it only says how much the next match could move one.
Three levels — **provisional** (a new or long-idle player; the rating is a guess
and will swing hard), **firming up**, and **settled** (matches move it only a
little) — plus the interval that is confidence's one honest, rigorous statement:
"we think this player is somewhere between 1551 and 1823".

There is deliberately NO confidence *percentage*. An "86%" is an arbitrary
rescaling of RD onto a 0-100 axis and says nothing the level and the interval do
not say better; do not add one back.

This module is a LEAF — pure functions over floats, no schema and no model
imports — so ``app.schemas.rating`` can call ``confidence_level`` from a
``@computed_field`` without an import cycle.
"""

from typing import Literal

ConfidenceLevel = Literal["provisional", "firming_up", "settled"]

# The level is keyed off the Glicko-2 rating deviation (RD): a big RD means the
# system does not yet know where this player belongs, so the next result can
# move them a long way.
#
# These two numbers are the whole definition of the three levels, which is why
# they are named constants and not inline literals — the *shape* (a monotone
# ladder in RD, provisional at the top) is what is settled; the exact cut points
# are a judgement call and are meant to be moved. Both are INCLUSIVE floors: an
# RD of exactly 160 is provisional, an RD of exactly 90 is still firming up.
#
# For scale: a brand-new player seeds at RD 350 (deep in provisional) and a
# player with a steady match habit settles into the low double digits.
PROVISIONAL_RD_FLOOR = 160.0
FIRMING_UP_RD_FLOOR = 90.0

# The two-sided 95% normal interval multiplier. The interval is
# ``rating ± Z * RD``, and it is the number the card puts on its face — so this
# is the one constant here whose value is not a matter of taste.
INTERVAL_Z = 1.96


def confidence_level(deviation: float) -> ConfidenceLevel:
    """Which of the three confidence levels an RD lands in.

    Total over the reals: every RD maps to exactly one level, so there is no
    "unknown" case to represent.
    """
    if deviation >= PROVISIONAL_RD_FLOOR:
        return "provisional"
    if deviation >= FIRMING_UP_RD_FLOOR:
        return "firming_up"
    return "settled"


def rating_interval(rating: float, deviation: float) -> tuple[float, float]:
    """The 95% interval around a rating: ``rating ± 1.96 * RD``, as
    ``(low, high)``.

    Rounded to whole rating points because that is how the card reads it out
    ("somewhere between 1551 and 1823") — a BFF shaping its number for the page
    it serves, not the client re-deriving it. Not clamped at zero: a wide
    interval on a provisional rating genuinely can reach below the bottom of the
    scale, and pretending otherwise would narrow the claim we are making.
    """
    half_width = INTERVAL_Z * deviation
    return float(round(rating - half_width)), float(round(rating + half_width))
