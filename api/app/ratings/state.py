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

from app.ratings.base import RatingStrategyKey, state_rating_value
from app.ratings.registry import parse_strategy_key


class RatingStateValueMismatchError(ValueError):
    """A parsed ``rating_state`` blob whose own rating disagrees with the
    ``rating_value`` stored alongside it on the same row.

    Every write sets ``rating_value`` from ``state_rating_value(state)``, so the
    stored column and the blob's ``rating`` are two copies of one number: the
    hero renders the column while the confidence card centres its interval on the
    blob. If they drift (a bad write, an import, a manual DB fix) the two disagree
    silently. This turns that drift into a loud failure at the parse boundary,
    naming both numbers so the corrupt row is obvious.
    """

    def __init__(self, rating_value: float, state_rating: float) -> None:
        self.rating_value = rating_value
        self.state_rating = state_rating
        super().__init__(
            "rating_state is inconsistent with its stored rating_value: "
            f"rating_value={rating_value!r} but the parsed state's rating is "
            f"{state_rating!r} (they must be equal — every write sets "
            "rating_value from state_rating_value(state))."
        )


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
    strategy_key: str,
    raw: Mapping[str, Any] | None,
    rating_value: float | None = None,
) -> RatingState | None:
    """Decode a ``rating_state`` blob into the model for its strategy.

    ``None`` when there is no state at all (a manual-league member awaiting an
    import) or when the key names no strategy this build knows — the same "no
    strategy, no rating behaviour" the rest of the ratings code takes for an
    unrecognised key (``parse_strategy_key``). Raises on a blob that is present
    but malformed for its strategy.

    ``rating_value`` is the row's own ``rating_value`` column, threaded in so the
    boundary can assert the invariant that binds the two: every write sets
    ``rating_value`` from ``state_rating_value(state)``, so a non-null
    ``rating_value`` MUST equal the parsed state's ``rating``. When it does not,
    the row is corrupt (a bad write, an import, a manual DB fix) and the hero
    would show one number while the confidence card centres its interval on
    another — so this raises ``RatingStateValueMismatchError`` naming both rather
    than handing back a state that silently disagrees with the column beside it.

    The check is skipped when ``rating_value`` is ``None`` — the legitimate
    unrated case (a player seeded into a league who has not completed a rated
    match yet) — and when there is no parsed state to compare it against.
    """
    if raw is None:
        return None
    match parse_strategy_key(strategy_key):
        case RatingStrategyKey.glicko2:
            state: RatingState | None = Glicko2State.model_validate(raw)
        case RatingStrategyKey.manual:
            state = ManualState.model_validate(raw)
        case None:
            state = None
    if state is not None and rating_value is not None:
        state_rating = state_rating_value(dict(raw))
        if rating_value != state_rating:
            raise RatingStateValueMismatchError(rating_value, state_rating)
    return state
