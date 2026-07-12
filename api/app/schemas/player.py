import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, computed_field

from app.models import MatchStatus
from app.schemas.rating import RatingChange, RatingConfidence, RatingHistoryWindow


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
    league rating + a career W-L from completed matches + a 10-character form
    string (newest first) so the UI can render the form-dots without a
    follow-up query.
    """

    id: uuid.UUID
    username: str
    rating: float | None = None
    wins: int = 0
    losses: int = 0
    # Newest-first 0..10 character string of `W`/`L`. Empty when the player has
    # no completed matches yet.
    #
    # The window is TEN because the profile is where a player is actually
    # studied. `form` is one shared field, so the roster receives the same ten
    # results and slices the first five for its dots column — a deliberate
    # trade, not an oversight. Do not add a second, narrower form field: two
    # form windows on one schema is exactly the kind of derivable-twin the
    # api/CLAUDE.md "don't carry a field and its own derivation" rule forbids.
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


class PlayerStreak(BaseModel):
    """A run of consecutive same-outcome decided matches: ``n`` wins (``W``) or
    ``n`` losses (``L``). Never zero-length — the absence of a streak is the
    field being ``null``, not ``n=0`` (CONTEXT.md, "Streak").

    Structurally identical to `DashboardStreak`, deliberately: merging them
    would rename a component the dashboard's generated clients already bind to,
    for no gain to either surface.
    """

    kind: Literal["W", "L"]
    n: int


class PlayerCareer(BaseModel):
    """A player's lifetime record ACROSS EVERY LEAGUE they play in (CONTEXT.md,
    "Career"; ADR-0915).

    Career is a fact about the *person*. It deliberately ignores the league the
    profile was requested for — unlike `rating`, `rank`, `peak` and `percentile`,
    which are facts about one *ladder*. Ask for the same player in two different
    leagues and the ratings differ while this block is identical.
    """

    # Matches with a win or a loss — the denominator of `win_rate`.
    #
    # DELIBERATELY NOT `PlayerDetail.match_total`, which counts the all-inclusive
    # history (matches still in play, voided ones, every status). A player with
    # 47 decided matches and 3 in play reports `decided == 47` and
    # `match_total == 50`; the two sit on the same page and they differ on
    # purpose.
    decided: int
    wins: int
    losses: int
    # `wins / decided`, as a SHARE in [0, 1] — 0.5, not 50 and not "50%". The
    # client formats it. ``None``, never 0.0, when nothing has been decided: a
    # zero would claim this player wins none of the matches they play.
    win_rate: float | None = None
    # The share of individual GAMES this player has taken across their decided
    # matches (CONTEXT.md, "Games won") — a finer read on dominance than wins and
    # losses, which only count whole matches: a 3-2 win and a 3-0 win are the same
    # in the W-L column and very different here.
    #
    # Like `win_rate`, a SHARE in [0, 1] despite the historical `_pct` name — 0.375,
    # never 37.5. ``None`` when no game of theirs has ever been scored.
    games_won_pct: float | None = None
    # The run ending at their most recent decided match — wins or losses,
    # whichever they are on. ``None`` when they have no decided matches.
    current_streak: PlayerStreak | None = None
    # The longest WINNING run they have ever put together — always `kind: "W"`,
    # and read over their whole history, not a recent window. ``None`` for a
    # player who has never won.
    best_streak: PlayerStreak | None = None
    # How many leagues this player belongs to. At least 1 — every player is a
    # member of the default league.
    league_count: int


class PlayerLeague(BaseModel):
    """One league this player belongs to, and the rating they carry ON IT — a row
    of the profile's Leagues card, which is also the page's league switcher
    (ADR-0915).

    A player's rating is a fact about a *ladder*: there is no such thing as their
    rating "in general" (CONTEXT.md, "League"). So the same player may read 1687
    here and 1642 in the next row, and the card is what makes that legible.

    The list itself is NOT scoped to the requested league — it is the same on
    every request for this player. Which row is *selected* is derived by the
    client from the league it asked for, and `is_default` is what lets it derive
    that when it asked for none (CONTEXT.md, "Default league").
    """

    id: uuid.UUID
    name: str
    # Exactly one league is the default — the one every player is joined to on
    # sign-up and the one a surface falls back to when the caller names none.
    is_default: bool
    # This player's `rating_value` IN THIS LEAGUE. ``None`` when they hold no
    # rating on it: they have never finished a rated match there, or the ladder
    # is a manual-strategy one still waiting for an import.
    rating: float | None = None


class HeadToHeadOpponent(BaseModel):
    """The other player in a head-to-head — a *named* player, always.

    Both fields are required, unlike `PlayerMatchOpponent`, whose `id` and
    `username` are nullable to model the player-less sentinel side of a solo
    match. That difference is the point: a solo match has nobody on the other
    side, so it can never be a **meeting** (CONTEXT.md), and a head-to-head
    against nobody is not a state this schema can represent.
    """

    id: uuid.UUID
    username: str


class HeadToHeadRecord(BaseModel):
    """One player's record of **meetings** against one named opponent, read
    from a stated side (CONTEXT.md, "Head-to-head"): `wins` and `losses` are the
    subject's, never the opponent's. `A 4-1 B` and `B 1-4 A` are the same record
    said two ways, so every consumer of this model has to know whose side it
    speaks for — the field it hangs off says which (`versus_viewer` is the
    *caller's*; `frequent_opponents` is the *profiled player's*).
    """

    opponent: HeadToHeadOpponent
    wins: int = 0
    losses: int = 0

    @computed_field  # type: ignore[prop-decorator]  # pydantic: decorate the property, not its getter
    @property
    def meetings(self) -> int:
        """How many times the pair have played. DERIVED, not stored: a meeting
        is a *decided* match (CONTEXT.md), and a decided match is a win for one
        side and a loss for the other — so `meetings` is exactly
        `wins + losses`, and carrying it as its own field would let the two
        drift (api/CLAUDE.md, "don't carry a field and its own derivation")."""
        return self.wins + self.losses


class ViewerHeadToHead(HeadToHeadRecord):
    """The CALLER's own record against the profiled player — "you are 1-4
    against them", not "they are 4-1 against you".

    Present with **zero meetings** for a caller who has never played them, which
    is the common case, not an error: a guest session is minted for anyone who
    lands on a profile link, and a guest has played nobody (ADR-0915). The card
    renders "You haven't played X yet" plus a Start-a-match CTA off exactly this
    state, and needs `opponent` populated to prefill it — so the empty record is
    a first-class value, and never `null` in place of one.
    """

    # The most recent meeting. ``None`` exactly when `meetings` is 0 — a pair
    # who have met have a date on which they last did.
    last_meeting: datetime | None = None


class PlayerHeadToHead(BaseModel):
    """The profile's head-to-head card, VIEWER-AWARE (ADR-0915): the same player
    returns a different block to two different callers.

    A **meeting** is a *decided* match between two named players — rated or not,
    in any league (CONTEXT.md). A match still in play is not a record, and a
    voided one has stopped being one.
    """

    # The caller's record against the profiled player. ``None`` — and ONLY —
    # when the caller *is* that player: there is no "you versus yourself", and
    # the card falls back to being just their frequent opponents. An empty record
    # (zero meetings) is a different thing entirely; see `ViewerHeadToHead`.
    versus_viewer: ViewerHeadToHead | None = None
    # The profiled player's most-met opponents, most meetings first (ties broken
    # by the most recent meeting) — secondary context on someone else's profile,
    # and the whole card on your own. Read from the PLAYER's side.
    frequent_opponents: list[HeadToHeadRecord] = []


class PlayerDetail(PlayerSummary):
    """Profile-page bundle: the hero (`PlayerSummary` fields + the standing
    block below) plus the player's six most recent matches inline. Saves a round
    trip on initial load — `GET /v1/players/{id}` returns this so the profile
    overview paints with one request.

    The profile is an *overview*: it shows a Recent-matches card, not the whole
    table. The full paginated history lives at its own route, backed by
    `GET /v1/players/{id}/matches` (ADR-0915).

    The standing fields (`peak`, `rank_of`, `percentile`, `rating_delta`) are
    league-scoped, like `rating` and `rank` — and profile-only: they deliberately
    do not ride on `PlayerSummary`, which the roster also serializes.
    """

    # When this player joined — the hero's "Member since March 2025" line.
    member_since: datetime
    # The rating change from this player's MOST RECENT RATED MATCH — the hero's
    # headline Δ chip. ``None`` (never ``+0``) for a player who has never
    # finished a rated match: a zero would claim a rated match moved their
    # rating by nothing.
    rating_delta: RatingChange | None = None
    # The highest rating this player has ever held in this league (CONTEXT.md,
    # "Peak rating"). Read off the rating timeline, so a voided match can lower
    # it retroactively. ``None`` for a player with no rating in the league.
    peak: float | None = None
    # The size of the rated population `rank` is drawn from — the denominator
    # that lets the hero say "#3 of 42" rather than a naked "#3" that flatters
    # in a tiny league. Same population the rank is computed over (non-merged,
    # rated members of this league), so `rank <= rank_of` always holds.
    # ``None`` exactly when `rank` is ``None``: no rank, no ladder to be on.
    rank_of: int | None = None
    # How settled this player's rating is IN THIS LEAGUE (CONTEXT.md, "Rating
    # confidence") — the level, the Glicko-2 internals behind it, and the 95%
    # interval the card puts on its face. League-scoped, like everything else in
    # the standing block: confidence describes one ladder's read on the player.
    #
    # ``None`` — and the card simply does not render — for a player with no
    # rating, and for a manual/externally-rated one: an imported USATT number
    # carries no deviation, so there is no confidence to report about it. Never a
    # confidence *percentage*; see `RatingConfidence`.
    confidence: RatingConfidence | None = None
    # "Top N%" within the league. WITHHELD (``None``) while the league is too
    # small for the number to mean anything — in a twelve-player league "top 8%"
    # is just "you are first" dressed up as a statistic. The floor lives in one
    # named constant (`ratings.stats.PERCENTILE_MIN_RATED_PLAYERS`). Also ``None`` for
    # a player with no rating.
    percentile: int | None = None

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

    # The lifetime record, CROSS-LEAGUE — the one block on this response that
    # ignores the requested league (ADR-0915). Always present: even a player who
    # has never finished a match has a league count.
    career: PlayerCareer

    # Every league this player belongs to, with their rating on each — the
    # Leagues card, which is the page's league SWITCHER (ADR-0915).
    #
    # Read from `league_memberships`, so it is exactly as long as
    # `career.league_count` — belonging to a ladder and having played on it are
    # different facts, and every real player is joined to the default league at
    # sign-up. One row today, for everyone; that is correct and not a reason to
    # hide the card. The rating half of this page follows whichever row the
    # client selects; `career` does not.
    leagues: list[PlayerLeague]

    # The ONE block on this response that depends on WHO IS ASKING (ADR-0915):
    # the caller's own record against this player, plus this player's most-met
    # opponents. Two callers get two different `head_to_head` blocks for the same
    # profile — so this response is not shareable across users by any cache in
    # front of it. Everything else here is a fact about the player alone.
    head_to_head: PlayerHeadToHead

    # The rating chart's data, for the calendar window the page loaded with — the
    # `range` query param, defaulting to 90 days. LEAGUE-SCOPED, like every other
    # rating fact here.
    #
    # Embedded so first paint costs ONE request: the client seeds the chart's own
    # cache entry from this and only calls `GET /v1/players/{id}/rating-history`
    # when the user *changes* range (ADR-0915). It is the same shape that endpoint
    # returns — including the carry-in `anchor`, a point from OUTSIDE the window,
    # without which the chart's headline change is a lie.
    rating_history: RatingHistoryWindow
