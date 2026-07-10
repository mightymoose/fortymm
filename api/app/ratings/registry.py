from app.ratings.base import RatingCalculator, RatingStrategyKey
from app.ratings.glicko2 import CALCULATOR as GLICKO2_CALCULATOR

# Only automatic strategies register a calculator. ``manual`` is a valid
# ``RatingStrategyKey`` but has no entry here — callers guard on
# ``strategy.is_automatic`` before reaching ``get_calculator``, so it never
# needs one.
STRATEGIES: dict[RatingStrategyKey, RatingCalculator] = {
    GLICKO2_CALCULATOR.key: GLICKO2_CALCULATOR,
}


def parse_strategy_key(key: str) -> RatingStrategyKey | None:
    """Parse a raw ``str`` (e.g. ``RatingStrategy.key`` off the DB) into a
    known ``RatingStrategyKey``, or ``None`` if it names no member.

    This is the boundary between untrusted stringly-typed data and the closed
    enum the rest of the ratings code uses. An unrecognised key must not crash
    a match view — it returns ``None`` and the caller treats it as "no
    strategy" (no rating update), exactly as an unregistered key does today.
    """
    try:
        return RatingStrategyKey(key)
    except ValueError:
        return None


def get_calculator(key: RatingStrategyKey) -> RatingCalculator | None:
    return STRATEGIES.get(key)
