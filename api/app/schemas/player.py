import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.models import MatchStatus


class PlayerRead(BaseModel):
    """A user the current player can pick as a match opponent.

    Used by the typeahead/opponent picker. ``rating`` is the player's current
    ``rating_value`` in the league the request was scoped to (defaulting to
    the default league) — None if they haven't yet played a rated match in
    that league or, for manual-strategy leagues, haven't been imported.
    """

    id: uuid.UUID
    username: str
    rating: float | None = None


class PlayerSummary(BaseModel):
    """Pre-shaped for the `/players` list and the profile-page hero.

    Carries everything those surfaces render: the username + the default-
    league rating + a career W-L from completed matches + a 5-character form
    string (newest first) so the UI can render the form-dots without a
    follow-up query.
    """

    id: uuid.UUID
    username: str
    rating: float | None = None
    wins: int = 0
    losses: int = 0
    # Newest-first 0..5 character string of `W`/`L`. Empty when the player
    # has no completed matches yet.
    form: str = ""


class PlayerListResponse(BaseModel):
    """Paginated `/v1/players` response backing the `/players` list page."""

    items: list[PlayerSummary]
    page: int
    page_size: int
    total: int


class PlayerMatchOpponent(BaseModel):
    """Compact opponent shape for a per-player match row. ``id`` and
    ``username`` are both ``None`` for the player-less sentinel side
    ("No opponent" matches)."""

    id: uuid.UUID | None = None
    username: str | None = None


class PlayerMatchSet(BaseModel):
    """A single game's score from the headline player's perspective."""

    mine: int
    theirs: int


class PlayerMatchRow(BaseModel):
    """A single row in the per-player match list. Pre-shaped so the FE doesn't
    have to join sides + games + flip perspective."""

    id: uuid.UUID
    status: MatchStatus
    created_at: datetime
    opponent: PlayerMatchOpponent
    # Newest-first list of per-game scores. Empty when no games have been
    # scored (e.g. status=pending).
    sets: list[PlayerMatchSet]
    # The headline player's outcome: ``W`` / ``L`` for decided matches,
    # ``None`` while the match is still pending / in_progress / disputed /
    # voided. The FE keys the WIN/LOSS/LIVE/UP NEXT chip off `status` + this.
    result: Literal["W", "L"] | None = None


class PlayerMatchListResponse(BaseModel):
    """Paginated per-player match list backing the profile page's match
    table."""

    items: list[PlayerMatchRow]
    page: int
    page_size: int
    total: int
