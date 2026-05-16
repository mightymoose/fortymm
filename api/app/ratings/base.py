from typing import Any, Protocol


class RatingCalculator(Protocol):
    """A strategy that knows how to update player ratings after a singles match.

    The hook in ``app.matches`` only calls singles for v1 — doubles is unwired
    on the match-creation side (team_size hardcoded to 1). Add a doubles method
    when that opens up.
    """

    key: str

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
