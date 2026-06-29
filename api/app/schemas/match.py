import enum
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.attention import ListAttentionKind
from app.models.match import MatchStatus
from app.schemas.rating import RatingChange
from app.schemas.view.match_details import MatchDetails as MatchDetailsView


class MatchListFilter(enum.Enum):
    """The selectable buckets on the ``/matches`` list filter.

    Mostly a 1:1 echo of ``MatchStatus``, but ``awaiting_confirmation`` is a
    *derived* bucket with no DB status of its own — it's an ``in_progress``
    match that already carries at least one signature (a posted result waiting
    on the other side; see ``_status_label``). The ``live`` filter therefore
    means "``in_progress`` with **no** signature yet", so a posted-but-unconfirmed
    result no longer silently inflates the Live tab / count (issue #381)."""

    pending = "pending"
    live = "in_progress"
    awaiting_confirmation = "awaiting_confirmation"
    completed = "completed"
    disputed = "disputed"
    voided = "voided"


# Match lengths the client offers. All odd so one side can always reach a
# strict majority of games; the DB additionally enforces "odd and >= 1".
ALLOWED_BEST_OF = (1, 3, 5, 7)


class MatchCreate(BaseModel):
    """Request body for ``POST /v1/matches``.

    ``opponent_user_id`` is optional: a solo match (the client submits one
    when the user starts without picking an opponent) gets a player-less
    sentinel opponent side — so it's still scorable — and is always unrated,
    since the rating system needs two registered sides.

    ``league_id`` is optional: when omitted the server binds the match to the
    default league (see ``app.leagues.get_default_league``).
    """

    opponent_user_id: uuid.UUID | None = None
    league_id: uuid.UUID | None = None
    # ``strict`` rejects non-integer JSON (e.g. the string "5") with a 422
    # rather than coercing it before ``_best_of_allowed`` runs. The OpenAPI
    # contract still exposes this as a plain integer.
    best_of: int = Field(
        strict=True, description="Total games to play; one of 1, 3, 5, 7."
    )
    rated: bool = True

    @field_validator("best_of")
    @classmethod
    def _best_of_allowed(cls, value: int) -> int:
        if value not in ALLOWED_BEST_OF:
            allowed = ", ".join(str(n) for n in ALLOWED_BEST_OF)
            raise ValueError(f"best_of must be one of {allowed}")
        return value


# ----- details (BFF for /matches/$id and the scoring routes) ---------------


class MatchLeague(BaseModel):
    id: uuid.UUID
    name: str


class MatchDetailsPlayer(BaseModel):
    user_id: uuid.UUID
    username: str
    is_current_user: bool


class MatchDetailsSide(BaseModel):
    side_number: int
    players: list[MatchDetailsPlayer]
    games_won: int
    won: bool | None
    is_current_user_side: bool
    rating_change: RatingChange | None = None


class MatchDetailsScore(BaseModel):
    id: uuid.UUID
    side_1_points: int
    side_2_points: int
    winner_side_number: int
    # Optimistic-concurrency token. The score-entry page echoes this back as
    # ``expected_version`` on the conditional PUT; a write whose expected
    # version no longer matches the committed row is rejected (409) instead of
    # overwriting a concurrent participant's save. A freshly created score is
    # version 1.
    version: int


class MatchDetailsGame(BaseModel):
    id: uuid.UUID
    game_number: int
    score: MatchDetailsScore | None


class MatchDetailsCurrentGame(BaseModel):
    # The next game to score: lowest 1..best_of with no saved score. The row
    # may not exist in `match_games` yet — game rows are created lazily on the
    # first score write. Use ``game_number`` (not an id) for deeplinks.
    game_number: int


class MatchDetailsFormResult(BaseModel):
    """One past completed match for the Players & form recent-results list.

    Counts are framed from the cited *player's* perspective, not from a
    side number in the past match."""

    match_id: uuid.UUID
    is_win: bool
    player_games_won: int
    opponent_games_won: int
    opponent_username: str | None
    completed_at: datetime


class MatchDetailsPlayerForm(BaseModel):
    """A player's previous-5 results, attached by ``user_id`` so the FE can
    map it onto whichever side carries that user.

    All `*_before` fields are anchored to this match's `created_at` — they
    describe the player's rating + record going into this match, not after."""

    user_id: uuid.UUID
    recent_results: list[MatchDetailsFormResult]
    # Rating in this match's league as of just before this match. Null when
    # the player has no prior rating in the league.
    rating_before: float | None = None
    # Chronological rating values (oldest first) preceding this match in this
    # match's league. Capped at ~10 — enough for a sparkline, small enough
    # to keep the BFF cheap.
    rating_history: list[float] = Field(default_factory=list)
    career_matches_before: int = 0
    career_wins_before: int = 0


class MatchDetailsH2HMeeting(BaseModel):
    """One past meeting between the two players in *this* match. Game counts
    are aligned to this match's side numbers so the FE doesn't need to
    re-map per row."""

    match_id: uuid.UUID
    completed_at: datetime
    side_1_games_won: int
    side_2_games_won: int
    winner_side_number: int | None
    rated: bool


class MatchDetailsH2H(BaseModel):
    """Head-to-head between this match's two singles players. Wins are
    counted against this match's side numbers (not the side numbers of the
    historical matches)."""

    total_meetings: int
    side_1_wins: int
    side_2_wins: int
    recent_meetings: list[MatchDetailsH2HMeeting]


class NegotiationGame(BaseModel):
    """One game in a result snapshot."""

    game_number: int
    side_1_points: int
    side_2_points: int


class NegotiationResult(BaseModel):
    """A posted result in the negotiation chain — the ``standing_result`` (the
    most recent posting, awaiting the other side) or the ``prior_result`` it
    supersedes."""

    id: uuid.UUID
    games: list[NegotiationGame]
    submitted_by: uuid.UUID
    submitted_at: datetime


class NegotiationDiffEntry(BaseModel):
    """One game's difference between the prior and standing result, so the FE
    can highlight what changed in a correction."""

    game_number: int
    # ``None`` if the game didn't exist in the baseline (prior) result.
    old: NegotiationGame | None
    new: NegotiationGame


# The viewer-relative phase of the result negotiation. ``live`` = no result
# posted yet; ``awaiting`` = the viewer's side posted and owes nothing;
# ``review`` = the opponent posted the standing result and the viewer has no
# prior proposal in the chain; ``corrected`` = the opponent posted the standing
# result and the viewer has their own prior proposal (the diff shows what
# changed vs the viewer's last proposal); ``final`` = a result has been accepted.
ViewerState = Literal["live", "awaiting", "review", "corrected", "final"]


class MatchNegotiation(BaseModel):
    """Viewer-relative result-negotiation block. Always present on
    ``MatchDetails`` / ``MatchListRow``; the FE reads ``viewer_state`` and
    ``your_turn`` to pick the CTA, and ``diff`` to highlight a correction."""

    viewer_state: ViewerState
    your_turn: bool
    standing_result: NegotiationResult | None
    prior_result: NegotiationResult | None
    diff: list[NegotiationDiffEntry] | None
    # Match-level (NOT viewer-relative, unlike the fields above — distinct from
    # the ``viewer_state == "corrected"`` case): true when the result chain holds
    # more than one proposal, i.e. at least one correction was posted before the
    # chain settled. The FE reads this on the ``final`` state to label a completed
    # match "Confirmed" (clean first-post→accept) vs "Agreed after corrections"
    # (a counter/self-edit preceded the agreement).
    had_corrections: bool


class MatchDetails(BaseModel):
    id: uuid.UUID
    status: MatchStatus
    status_label: str
    league: MatchLeague
    best_of: int
    games_to_win: int
    team_size: int
    affects_rating: bool
    created_at: datetime
    # Perspective-neutral so non-participants can read this payload; the FE
    # picks a viewing angle from each side's ``is_current_user_side``.
    sides: list[MatchDetailsSide]
    games: list[MatchDetailsGame]
    current_game: MatchDetailsCurrentGame | None
    can_score: bool
    # True when the saved games form a decided, validly-ordered match, the
    # current user is a participant on an in-progress match, AND no posted
    # result is currently awaiting confirmation. The FE uses this to swap
    # the scoring page's submit button between "save game" and "post result"
    # (the latter calls ``POST /v1/matches/{id}/results``).
    can_finalize: bool
    # Viewer-relative result-negotiation state (the posting/correction/accept
    # chain). Always populated; the FE reads it instead of the old
    # signature/dispute fields.
    negotiation: MatchNegotiation
    recent_form: list[MatchDetailsPlayerForm] = Field(default_factory=list)
    head_to_head: MatchDetailsH2H | None = None
    # In-progress replacement view model, exposed alongside the current fields
    # so the FE can adopt it incrementally. Always populated.
    data: MatchDetailsView


# ----- list (BFF for /matches) ---------------------------------------------


class MatchListRow(BaseModel):
    id: uuid.UUID
    status: MatchStatus
    status_label: str
    league: MatchLeague
    sides: list[MatchDetailsSide]
    best_of: int
    # Whether this match counts toward player ratings. The authoritative flag
    # (from match settings) so the list can label rated vs. friendly without
    # loading rating history — list rows don't carry ``rating_change``.
    affects_rating: bool
    created_at: datetime
    # Game rows are created lazily on the first score write, so the deeplink
    # target may not have an id yet. The list passes the game number; the FE
    # builds the route from (match_id, current_game_number).
    current_game_number: int | None
    can_score: bool
    # Viewer-relative result-negotiation state (same block as
    # ``MatchDetails.negotiation``) so the list can surface the right CTA
    # without re-deriving signature/dispute state. Always populated.
    negotiation: MatchNegotiation
    # The current-user-aware attention bucket this row falls in (see
    # ``app.attention``), or ``None`` when the row isn't an attention item for
    # the caller — a completed/voided match, or a match the caller only
    # spectates. The FE derives the row's current-user-aware status label and
    # primary/secondary CTA from this (plus ``current_game_number`` for the
    # scoring deep-link), falling back to ``status_label`` when it's ``None``.
    attention: ListAttentionKind | None


class MatchListResponse(BaseModel):
    items: list[MatchListRow]
    page: int
    page_size: int
    total: int
    # Per-status counts (honoring ``q``, ignoring the status filter). The
    # ``in_progress`` count here is *true-live only* — posted-but-unconfirmed
    # results are split out into ``awaiting_confirmation_count`` so the Live tab
    # / count can't silently fold them in (issue #381). ``in_progress`` +
    # ``awaiting_confirmation_count`` is the total of all ``in_progress`` rows.
    status_counts: dict[MatchStatus, int]
    # Count of the caller's *open* matches (any attention bucket) under the
    # active search, independent of which status tab is selected — powers the
    # Attention tab's badge even while another tab is showing. Always present.
    attention_count: int
    # Count of ``in_progress`` matches with at least one signature — a posted
    # result waiting on the other side ("Awaiting confirmation"). Its own bucket
    # so it neither inflates Live nor needs the FE to re-derive it.
    awaiting_confirmation_count: int


# ----- score write (POST/PUT body) -----------------------------------------


def validate_game_score(side_1_points: int, side_2_points: int) -> None:
    """Table-tennis rules for a single completed game. Raises ``ValueError`` —
    callers wrap as needed for Pydantic (`model_validator`) or as the
    422 detail on a route handler.

    Used both by the per-game score-write schema (one row at a time) and the
    finalize-payload validator (per-game inside a full match)."""
    a, b = side_1_points, side_2_points
    winner, loser = max(a, b), min(a, b)
    if winner < 11:
        raise ValueError("The winning side must reach at least 11 points.")
    if a == b:
        raise ValueError("A game cannot end in a tie.")
    if winner == 11 and loser > 9:
        raise ValueError(
            f"At 10–10 the game enters deuce; the winner must lead by 2. "
            f"{winner}–{loser} is not a legal final score."
        )
    if winner > 11:
        if loser < 10:
            raise ValueError(
                f"A game can only go past 11 points after both sides reach 10. "
                f"{winner}–{loser} is not a legal final score."
            )
        if winner - loser != 2:
            raise ValueError(
                f"In a deuce game the winner leads by exactly 2 points. "
                f"{winner}–{loser} is not a legal final score."
            )


class MatchGameScoreWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    side_1_points: int = Field(ge=0, le=99)
    side_2_points: int = Field(ge=0, le=99)

    @model_validator(mode="after")
    def _table_tennis_rules(self) -> "MatchGameScoreWrite":
        validate_game_score(self.side_1_points, self.side_2_points)
        return self


class MatchGameScoreUpdate(MatchGameScoreWrite):
    """Conditional update body for ``PUT .../games/{n}/scores``.

    Carries the optimistic-concurrency token the caller last read for this
    game's score (``MatchDetailsScore.version``). The handler updates only if
    the committed row is still at that version; otherwise a concurrent
    participant has since saved this game, so the write is rejected with a 409
    rather than silently overwriting their result. (Create — ``POST
    .../scores/new`` — needs no token: the unique constraint already asserts no
    prior score exists.)"""

    # ``ge=0`` so a client that somehow holds a pre-create view can still send
    # ``0``; in practice the FE only PUTs once it has a real version (>= 1).
    expected_version: int = Field(ge=0)


class MatchGameScoreConflict(BaseModel):
    """409 body for a rejected conditional score write. ``committed_score`` is
    the row as it actually stands now, so the client can show the user "your
    stale entry vs. what's saved" before they re-decide."""

    message: str
    committed_score: MatchDetailsScore | None


# ----- finalize body (POST /v1/matches/{id}/results) -----------------------


class MatchResultsGameWrite(BaseModel):
    """One game inside a finalize-the-match payload. Per-game point legality
    is checked here; cross-game checks (contiguous numbering, decided result,
    no scores past the decider) live in the handler against the full list."""

    model_config = ConfigDict(extra="forbid")

    # Best-of caps at 7 (see ``ALLOWED_BEST_OF``); the handler additionally
    # rejects any number greater than the match's own ``best_of``.
    game_number: int = Field(ge=1, le=7)
    side_1_points: int = Field(ge=0, le=99)
    side_2_points: int = Field(ge=0, le=99)

    @model_validator(mode="after")
    def _table_tennis_rules(self) -> "MatchResultsGameWrite":
        validate_game_score(self.side_1_points, self.side_2_points)
        return self


class MatchResultsWrite(BaseModel):
    """Request body for ``POST /v1/matches/{match_id}/results``. The list is
    canon: the handler deletes every existing game + score on the match and
    re-inserts these rows. No merge."""

    model_config = ConfigDict(extra="forbid")

    games: list[MatchResultsGameWrite] = Field(min_length=1)
    # The result this posting supersedes (a correction). ``None`` on the first
    # posting; otherwise must equal the current standing result's id (the
    # handler 409s on a stale or mismatched value).
    supersedes_result_id: uuid.UUID | None = None
