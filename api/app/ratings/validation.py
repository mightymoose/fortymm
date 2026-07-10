import uuid
from typing import Any

import jsonschema

from app.models import RatingStrategy


class RatingStrategyMismatchError(Exception):
    """Raised when an *existing* ``user_league_ratings`` row is about to be used
    for a rating write but the strategy snapshotted on the row
    (``rating_strategy_id``) is no longer the strategy its league runs.

    Its ``rating_state`` is still shaped for the *old* strategy, so
    reinterpreting it under the *new* strategy's calculator / JSON Schema would
    silently corrupt the rating (issue #184). The write refuses loudly instead.

    The remedy is to **migrate or reset** the row (re-stamp its snapshot and
    overwrite ``rating_state`` from the new strategy's ``initial_state`` — see
    ``app.ratings.recompute._reset_users_to_initial_state``), **not** to retry:
    the same stale snapshot will fail the same way every time.
    """

    def __init__(
        self,
        *,
        league_id: uuid.UUID,
        user_id: uuid.UUID,
        row_strategy_id: uuid.UUID,
        league_strategy_id: uuid.UUID,
    ) -> None:
        self.league_id = league_id
        self.user_id = user_id
        self.row_strategy_id = row_strategy_id
        self.league_strategy_id = league_strategy_id
        super().__init__(
            f"user_league_ratings row for user {user_id} in league {league_id} "
            f"was snapshotted under rating strategy {row_strategy_id}, but the "
            f"league now runs strategy {league_strategy_id}. The row's "
            f"rating_state is still in the old strategy's shape and must not be "
            f"reinterpreted under the new strategy. Migrate or reset the row "
            f"(re-stamp the snapshot and overwrite rating_state from the new "
            f"strategy's initial_state) before it can take a rating update; "
            f"retrying this write will not help."
        )


def validate_state(state: dict[str, Any], strategy: RatingStrategy) -> None:
    """Validate a ``rating_state`` dict against its strategy's stored JSON Schema.

    Raises :class:`jsonschema.ValidationError` on mismatch.
    """
    jsonschema.validate(instance=state, schema=strategy.state_schema)
