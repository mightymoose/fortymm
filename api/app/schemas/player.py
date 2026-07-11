import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.models import MatchStatus
from app.schemas.rating import RatingChange


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
    # Global position on the league's rating ladder (rank 1 = highest-rated),
    # by standard competition ranking — a *global* fact, invariant under the
    # roster's search/pagination. `None` for a player with no rating (never
    # finished a rated match): no rating, no rank. See CONTEXT.md ("Rank") and
    # docs/adr/0008. Never the player's row index on the current page (#841).
    rank: int | None = None


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


class PlayerMatchGame(BaseModel):
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
    # The match's per-game scores. Empty when no games have been scored (e.g.
    # status=pending). A match is a best-of-N run of *games* — never "sets"
    # (CONTEXT.md, "Game"): table tennis has games, tennis has sets.
    games: list[PlayerMatchGame]
    # The headline player's outcome: ``W`` / ``L`` for decided matches,
    # ``None`` while the match is still pending / in_progress / voided.
    # The FE keys the WIN/LOSS/LIVE/UP NEXT chip off `status` + this.
    result: Literal["W", "L"] | None = None
    # True when a result has been proposed but not yet accepted by the
    # opponent — i.e. ``status`` is still ``in_progress`` *and* the match has a
    # standing proposed result. This is the same "Awaiting acceptance" bucket
    # matches.py derives via ``_status_label``; it's surfaced as a boolean here
    # so the profile chip can distinguish a posted-but-unaccepted result from a
    # genuinely-live match (both sit at ``in_progress``) without the FE having
    # to re-derive the negotiation state (#364).
    awaiting_acceptance: bool = False
    # The rating this match moved for the headline player, read from the
    # match's ``rating_history`` row — the row's Δ column. ``None`` (rendered
    # ``—``, never ``+0``) for any row that is undecided (pending / in progress
    # / awaiting acceptance / voided) *or* unrated (``affects_rating`` false):
    # those matches moved no rating at all, and a zero is a claim that they
    # moved it by nothing.
    rating_change: RatingChange | None = None


class PlayerMatchListResponse(BaseModel):
    """Paginated per-player match list backing the profile page's match
    table."""

    items: list[PlayerMatchRow]
    page: int
    page_size: int
    total: int


class PlayerDetail(PlayerSummary):
    """Profile-page bundle: the hero (`PlayerSummary` fields) plus the player's
    six most recent matches inline. Saves a round trip on initial load —
    `GET /v1/players/{id}` returns this so the profile overview paints with one
    request.

    The profile is an *overview*: it shows a Recent-matches card, not the whole
    table. The full paginated history lives at its own route, backed by
    `GET /v1/players/{id}/matches` (ADR-0915).
    """

    # The six most recent matches. ``matches.total`` is the same all-inclusive
    # count as ``match_total`` below — the envelope is a window onto the full
    # history, not a page of it.
    matches: PlayerMatchListResponse
    # Every match this player is a side of: any status, rated or not, including
    # solo "No opponent" matches and matches still in play. Backs the "View all
    # N matches" link.
    #
    # DELIBERATELY NOT ``wins + losses``. Career counts only *decided* matches;
    # this counts everything, so a player with 47 decided matches and 3 in play
    # reports ``match_total == 50``. The two numbers appear on the same page and
    # they differ on purpose — reconciling them reintroduces the bug ADR-0915
    # and ADR-0008 exist to prevent.
    match_total: int
