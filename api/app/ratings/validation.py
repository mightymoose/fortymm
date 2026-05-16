from typing import Any

import jsonschema

from app.models import RatingStrategy


def validate_state(state: dict[str, Any], strategy: RatingStrategy) -> None:
    """Validate a ``rating_state`` dict against its strategy's stored JSON Schema.

    Raises :class:`jsonschema.ValidationError` on mismatch.
    """
    jsonschema.validate(instance=state, schema=strategy.state_schema)
