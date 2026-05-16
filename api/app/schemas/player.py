import uuid

from pydantic import BaseModel


class PlayerRead(BaseModel):
    """A user the current player can pick as a match opponent.

    ``rating`` is the player's current ``rating_value`` in the league the
    request was scoped to (defaulting to the default league) — None if they
    haven't yet played a rated match in that league or, for manual-strategy
    leagues, haven't been imported."""

    id: uuid.UUID
    username: str
    rating: float | None = None
