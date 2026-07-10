import enum
from typing import Any, Protocol


class RatingStrategyKey(enum.StrEnum):
    """The closed set of rating-strategy keys the codebase knows by name.

    One definition shared by every in-code site that names a strategy — the
    registry, the league seeder, and the dashboard's stats branch — so a typo
    in any one is a type error, not a silent no-op. Members are ``str`` (via
    ``StrEnum``), so equality and dict lookup against the plain ``str`` stored
    in ``RatingStrategy.key`` keep working.

    ``manual`` is a real seeded strategy row but intentionally has no registry
    entry: callers short-circuit on ``strategy.is_automatic`` before ever
    reaching ``get_calculator``, so it never needs a calculator.
    """

    glicko2 = "glicko2"
    manual = "manual"


class RatingCalculator(Protocol):
    """A strategy that knows how to update player ratings after a singles match.

    The hook in ``app.matches`` only calls singles for v1 — doubles is unwired
    on the match-creation side (team_size hardcoded to 1). A runtime guard in
    ``_apply_rating_update`` raises ``NotImplementedError`` if a doubles match
    ever reaches the rating hook (see issue #183); add a doubles method here
    when that opens up.
    """

    key: RatingStrategyKey

    def update_singles(
        self,
        winner_state: dict[str, Any],
        loser_state: dict[str, Any],
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """Return ``(new_winner_state, new_loser_state)``."""
        ...


def state_rating_value(state: dict[str, Any]) -> float:
    """Every strategy's ``rating_state`` stores its sortable numeric rating
    under the ``rating`` key — Glicko-2 stores ``{rating, rd, volatility}``,
    manual stores ``{rating}``. This is the column we use for leaderboards."""
    return float(state["rating"])
