from app.ratings.base import RatingCalculator
from app.ratings.glicko2 import CALCULATOR as GLICKO2_CALCULATOR

STRATEGIES: dict[str, RatingCalculator] = {
    GLICKO2_CALCULATOR.key: GLICKO2_CALCULATOR,
}


def get_calculator(key: str) -> RatingCalculator | None:
    return STRATEGIES.get(key)
