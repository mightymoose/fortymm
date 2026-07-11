"""Typed decoding of the ``rating_state`` JSONB blob.

``user_league_ratings.rating_state`` / ``rating_history.rating_state`` are JSONB
columns whose shape depends on the strategy the row was written under: Glicko-2
stores ``{rating, rd, volatility}``, manual stores ``{rating}`` alone. Read as a
raw ``dict[str, Any]`` — ``state["rating"]``, ``state.get("rd")`` — a malformed
or wrong-shaped row only blows up deep in whatever call stack happened to touch
it (api/CLAUDE.md, "Parse, don't validate").

So parse it HERE, once, at the read boundary, and hand the rest of the code a
``Glicko2State`` / ``ManualState`` with real fields. A ``KeyError`` on
``rating_state`` is then unrepresentable, and "manual has no RD" becomes a case
the type checker makes you handle rather than a runtime surprise.

**The discriminator is external.** Nothing inside the blob names its own
strategy, so this is not a Pydantic discriminated union: the caller supplies the
key off the row that owns the state — ``UserLeagueRating.rating_strategy.key``
(the ULR carries its own ``rating_strategy_id``, and a row written under a
superseded strategy still holds state in *that* strategy's shape, so the ULR's
own strategy — never the league's current one — is the right key to parse with).

A blob that does not validate RAISES (``pydantic.ValidationError``): every write
path validates ``rating_state`` against the strategy's stored JSON Schema
(``app.ratings.validation``), so a bad blob is corruption, and quietly returning
``None`` for it would let corruption read as the benign "this player has no
rating".
"""

from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel

from app.ratings.base import RatingStrategyKey
from app.ratings.registry import parse_strategy_key


class Glicko2State(BaseModel):
    """A Glicko-2 rating state: the rating itself plus the two uncertainty
    numbers the "rating confidence" card is derived from — ``rd`` (rating
    deviation: how far off the rating could be) and ``volatility`` (sigma: how
    erratic their results have been)."""

    rating: float
    rd: float
    volatility: float


class ManualState(BaseModel):
    """An externally-supplied (USATT, admin-entered) rating. Carries a rating
    and NOTHING else — no RD, no volatility, so a manual rating has no
    confidence to report at all. That absence is the point of this class: it
    makes "there is no RD here" a state the caller must handle."""

    rating: float


RatingState = Glicko2State | ManualState


def parse_rating_state(
    strategy_key: str, raw: Mapping[str, Any] | None
) -> RatingState | None:
    """Decode a ``rating_state`` blob into the model for its strategy.

    ``None`` when there is no state at all (a manual-league member awaiting an
    import) or when the key names no strategy this build knows — the same "no
    strategy, no rating behaviour" the rest of the ratings code takes for an
    unrecognised key (``parse_strategy_key``). Raises on a blob that is present
    but malformed for its strategy.
    """
    if raw is None:
        return None
    match parse_strategy_key(strategy_key):
        case RatingStrategyKey.glicko2:
            return Glicko2State.model_validate(raw)
        case RatingStrategyKey.manual:
            return ManualState.model_validate(raw)
        case None:
            return None
