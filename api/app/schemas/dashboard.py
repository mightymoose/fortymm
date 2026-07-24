import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.models.tournament import DrawType
from app.schemas.rating import RatingChange

# The actionable bucket a match falls in for the current user, in priority
# order: a rated result the opponent proposed that is awaiting our review
# (``review``) outranks a match we still need to score (``score``). Passive
# states — a result we proposed awaiting the opponent, or a pending/scheduled
# match — are never rows; they only feed ``waiting_count``.
AttentionKind = Literal["review", "score"]


class DashboardAttentionItem(BaseModel):
    """One actionable row in the dashboard's "Needs your attention" panel,
    classified server-side and current-user-aware (see ``dashboard.py``). Rows
    carry only routing data — opponent handle and the action — never scores."""

    match_id: uuid.UUID
    opponent_username: str | None
    kind: AttentionKind
    # ``score`` rows split rated-above-unrated by this flag (the FE derives the
    # primary-button priority from ``kind`` + ``affects_rating``). It is always
    # True for ``review`` (only arises on rated matches).
    affects_rating: bool
    # The next un-scored game for a ``score`` row, used to deep-link straight to
    # the scoring page. ``None`` when the board is already decided but unposted
    # (the FE routes to match detail to post the result instead), and always
    # ``None`` for ``review`` rows (which route to match detail).
    current_game_number: int | None
    # The absolute instant the standing result auto-finalizes if the opponent
    # never acts (``submitted_at`` + the settings' retirement window). ``None``
    # when there's no standing result or the window is unset — so it's populated
    # on ``review``/``dispute`` rows (a result is standing) and ``None`` on
    # ``score`` rows (nothing posted yet). The FE shows a countdown when present.
    retirement_deadline: datetime | None = None


class DashboardRecentResult(BaseModel):
    match_id: uuid.UUID
    opponent_username: str | None
    is_win: bool
    my_games_won: int
    opponent_games_won: int
    completed_at: datetime
    my_rating_change: RatingChange | None = None


class DashboardStreak(BaseModel):
    kind: Literal["W", "L"]
    n: int


class DashboardRatingStat(BaseModel):
    """Strategy-specific tile in the rating card's stats grid.

    Pre-formatted server-side so the frontend doesn't need to know which
    fields a strategy emits (Glicko-2's ``rd``/``volatility`` vs whatever a
    future Elo/TrueSkill row carries)."""

    label: str
    value: str


class DashboardRating(BaseModel):
    """Per-league rating snapshot for the dashboard RatingCard.

    Emitted only when the user has a rated row in an automatic-strategy league
    (Glicko-2 today). Manual leagues and unrated users get ``rating: None``.
    """

    league_id: uuid.UUID
    league_name: str
    strategy_key: str
    current: float
    # What the player's last rated match DID to them — the "+12 last match" chip.
    #
    # ``None`` means THERE IS NO MOVE TO REPORT, and the client must render nothing
    # (no chip, no arrow, no tone) rather than a zero. Two ways to get there, and
    # neither is "unknown":
    #
    # * their last rated match was their FIRST — it ESTABLISHED this rating instead
    #   of moving it. They were Unrated going in, so there is no earlier number to
    #   measure from. Reporting the 1500 their league-join seeded them with as a
    #   ``before`` is what told a brand-new player they had just LOST 232 points of
    #   a rating they never held (#952).
    # * no rated match at all lies behind the current value (an admin ``manual``
    #   override or an ``import`` moved it).
    #
    # Sourced from ``latest_rated_match_change`` → ``RatingChange.delta``, a computed
    # field: the number cannot be stored next to a ``before`` that contradicts it.
    # Do not "simplify" this back to a ``float`` with a ``0.0`` default — a zero
    # claims a rated match moved the rating by nothing, which is a different (and
    # false) statement.
    delta: float | None
    peak: float
    percentile: int | None
    # The rating changes of the last 30 days, oldest-first — and NOT the ``initial``
    # seed row, which is the prior the league hands out on join, not a rating anyone
    # held. So a player one rated match old has a ONE-POINT spark (their result), not
    # a two-point line sloping out of 1500.
    spark_data: list[float]
    streak: DashboardStreak | None
    stats: list[DashboardRatingStat]


TournamentMatchState = Literal["live", "scheduled", "completed", "voided"]
"""The state of the ONE match the tournament panel puts in front of the player: the
one being played now, the next one due, the last one finished, or one that was
voided. Closed set — the panel's card renders a different shape per arm, so a fifth
state must be a type error here rather than a card that renders nothing.

``voided`` is its own arm and NOT a flavour of ``completed``, because a voided match
has **no winner** (``app.match_voiding`` — "any surface that derives a result must
see *no winner*, not a stale W/L"). Folding it into ``completed`` makes the panel
derive an outcome from a 0–0 board and announce a loss the player never took."""

TournamentFixtureState = Literal["completed", "live", "upcoming", "voided"]
"""A row's state in the panel's "Your matches" path. Deliberately NOT
``MatchStatus``: a fixture that has not materialized into a match yet has no match
status at all, and that is the ``upcoming`` case the path exists to show. ``voided``
is its own arm here for the same reason it is on the match state above."""


class DashboardTournamentGame(BaseModel):
    """One completed game of the panel's focus match, scored from the CURRENT USER's
    side — ``your_points`` is always the caller's, never side 1's.

    The panel prints these as chips ("Game 3 · 11–9"), and a chip that silently means
    "side 1 first" would read backwards for whichever player happens to be entry B.
    The flip happens once, here, where the caller's side is known."""

    number: int
    your_points: int
    opponent_points: int


class DashboardTournamentMatch(BaseModel):
    """The one match the tournament panel's card shows for an event, already resolved
    server-side to the single most relevant one: the live match if there is one, else
    the next scheduled fixture, else the last completed match (see
    ``app.dashboard_tournaments``).

    Everything is stated from the CALLER's side. ``your_games``/``opponent_games`` are
    games won (not points) — the score the card's big numerals print — and
    ``games`` carries the per-game points behind them.
    """

    state: TournamentMatchState
    # ``None`` for a ``scheduled`` fixture that has not materialized into a match yet
    # — the panel then has nothing to deep-link, which is exactly what an un-called
    # fixture is. Never ``None`` for ``live``/``completed``.
    match_id: uuid.UUID | None
    # ``None`` means the opposing side is still TBD (an undecided feeding fixture),
    # the same fact ``TournamentFixtureRead.entry_b_id is None`` carries.
    opponent_username: str | None
    your_games: int
    opponent_games: int
    best_of: int
    games: list[DashboardTournamentGame]
    # e.g. ``"Group match 2"`` — composed from the fixture's round in the vocabulary
    # of its draw type, so the client never maps a round number to a word.
    round_label: str
    # The venue table this fixture is placed on (``TournamentTable.label``), or
    # ``None`` when unplaced (ADR-0790).
    table_label: str | None
    # The scheduled start, already rendered in the event's venue timezone with its
    # abbreviation (e.g. ``"4:30 PM CDT"``) — clients stay timezone-math-free (ADR
    # "tournament times are timezone-aware instants"). ``None`` when unscheduled.
    start_label: str | None
    # The next un-scored game, for the card's "Enter Game N result" deep link. Mirrors
    # ``DashboardAttentionItem.current_game_number``: ``None`` when the board is
    # already decided but unposted, or the match is not in progress.
    next_game_number: int | None
    # ``None`` unless ``state`` is ``completed`` — a live, scheduled or VOIDED match
    # has no outcome, and a ``False`` there would claim the caller lost a match still
    # being played, or one that was struck from the record entirely.
    you_won: bool | None
    # WHAT THE CALLER OWES on this match, from the very classifier the attention
    # panel is built on (``app.attention.list_attention_kind``) — so the two panels
    # on one dashboard cannot label the same match differently.
    #
    # ``next_game_number is None`` is NOT enough to decide this, and reading it that
    # way is a bug the panel shipped once: ``current_game_number`` answers ``None``
    # both when the board is decided-but-unposted AND when a result is already
    # posted and awaiting acceptance. Those owe opposite things — post it vs review
    # it — and the poster of a standing result owes nothing at all.
    #
    # ``None`` means there is nothing to do (a completed/voided match, or one this
    # user does not play in).
    owed_action: AttentionKind | Literal["waiting_opponent", "waiting_others"] | None


class DashboardTournamentFixtureRow(BaseModel):
    """One line of the panel's "Your matches" path — every fixture in this event the
    caller is a side of, in draw order.

    ``detail`` is the row's right-hand text, composed server-side because what belongs
    there changes with ``state`` (a result, "In progress", or a time and table). The
    client prints it verbatim rather than reassembling three optional fields into a
    sentence."""

    # e.g. ``"M2"`` — the fixture's ordinal within the caller's own schedule.
    label: str
    opponent_username: str | None
    state: TournamentFixtureState
    detail: str
    # ``None`` for anything not yet decided, for the same reason as on the match above.
    you_won: bool | None
    match_id: uuid.UUID | None


class DashboardTournamentEvent(BaseModel):
    """One event of a live tournament that the caller holds an active entry in — one
    tab of the panel.

    The record, position and stage are the panel's stats strip; they are derived here
    from the same live standings projection the tournament-detail page uses
    (ADR-0788), so the two surfaces cannot disagree about where a player stands."""

    id: uuid.UUID
    name: str
    draw_type: DrawType
    # Whether this event holds the caller's currently-live match — what puts the
    # "Live" marker on the tab.
    is_live: bool
    wins: int
    losses: int
    # The caller's 1-based rank in their pool, and how many players are in it.
    # ``position`` is ``None`` when the event has no standings yet (no draw cut, or a
    # draw type with no results strategy — only round-robin has one today), which is
    # a fact, not a zero.
    position: int | None
    field_size: int
    # e.g. ``"Group play"`` / ``"Group complete"``.
    stage_label: str
    # The caller's pool name, or ``None`` for an un-pooled draw.
    pool_label: str | None
    match: DashboardTournamentMatch | None
    fixtures: list[DashboardTournamentFixtureRow]


class DashboardTournament(BaseModel):
    """A live tournament the caller is playing in — the whole panel, one per
    tournament, with one tab per event they entered."""

    id: uuid.UUID
    name: str
    # e.g. ``"Riverside TTC · Jul 24"`` — venue and dates, composed server-side.
    subtitle: str
    # How many of the caller's matches in this tournament are being played right now.
    # Drives the header's "N live now" pill; ``0`` hides it.
    live_count: int
    events: list[DashboardTournamentEvent]


class DashboardResponse(BaseModel):
    # The current user's most-urgent actionable matches, pre-ranked by attention
    # priority (§5 of the PRD), capped server-side (``ATTENTION_BANNERS_LIMIT``)
    # since the panel only renders the top few as rows. Not the full set — use
    # ``attention_total_count`` for the true total and the footer overflow.
    attention: list[DashboardAttentionItem]
    # Total actionable matches for the current user (in_progress the user hasn't
    # accepted), counted independently of the ``attention`` cap so the footer's
    # "+N more need attention" stays accurate however many there are.
    attention_total_count: int
    # Count of matches that need *someone else's* move (a result we proposed
    # awaiting the opponent's acceptance, plus pending/scheduled matches). Shown
    # as footer text only — never a row.
    waiting_count: int
    recent_results: list[DashboardRecentResult]
    rating: DashboardRating | None = None
    # Total completed matches the current user participated in. The guest
    # persistence banner uses this to reference history concretely ("Your N
    # matches…") and to stay hidden until the user has any history at all.
    completed_match_count: int
    # Every LIVE tournament the caller holds an active entry in, newest first — the
    # panel that sits at the very top of the dashboard while they are playing one.
    # Empty (and the panel absent) the rest of the time, which is almost always: a
    # tournament is only ``live`` for the day or two it is being run.
    #
    # It rides on this payload rather than on a ``GET /v1/dashboard/tournaments`` of
    # its own because the panel loads with the page, not in response to a click — the
    # BFF rule's test for "one endpoint per page" (root CLAUDE.md). Its tabs switch
    # between events that are all already here; no tab costs a round-trip.
    tournaments: list[DashboardTournament] = []
