"""WHO THE LEAGUE ACTUALLY RATES — the one predicate behind "Unrated".

Joining a league SEEDS a rating row: ``seed_user_league_rating`` writes
``rating_value = 1500`` (the strategy's ``initial_rating_value``) and an
``initial`` rating-history event the moment a user joins — which, for the default
league, is when their session is minted, before they have played a thing. That
seed is a PRIOR, not a rating they have earned, and every read-side surface that
mistook "has a rating row" for "has a rating" told the same lie: a brand-new guest
rendered at 1500, peaked at 1500, ranked #2 of 5 above real players, and was
offered a confidence interval about a number they had never played for.

So "rated" cannot mean ``rating_value IS NOT NULL`` — that is true of every member
of a glicko2 league. It means the rating row HAS BEEN MOVED BY SOMETHING REAL:

    a ``rating_history`` row for this (user, league) whose source is not ``initial``

which is exactly CONTEXT.md's "a player who has never finished a rated match has
no rating". Completing a rated match writes a ``match`` row (``result_acceptance``
returns early for an unrated match, and voiding DELETES the rows, so a player whose
only rated match was voided correctly falls back to Unrated). ``manual`` / ``import``
rows count too, and deliberately: a rating supplied by an admin override, or an
imported USATT number on a manual-strategy ladder, is a real rating even though no
match on this ladder produced it. (This is why the predicate is written against
``source``, not against ``match_id IS NOT NULL`` — the latter is the same answer
today, and the wrong one the day an import lands.)

It lives in its own leaf module because BOTH halves of the read side need it and
must not disagree: ``app.player_summary`` (the roster's + hero's ``rating`` and
``rank``) and ``app.ratings.stats`` (``rank_of``, ``percentile``, ``confidence``),
neither of which may import the other. One predicate, so no field can call a player
rated while another calls them Unrated.

THE WRITE SIDE IS UNCHANGED. The seed row and its ``initial`` event stay exactly as
they are — per-match views read a player's pre-match rating out of ``rating_history``
and the recompute replays from the seeded state. This module is how the READ side
declines to present that prior as an achievement.
"""

from sqlalchemy import ColumnElement, and_, select
from sqlalchemy.orm import aliased

from app.models import RatingHistory, RatingHistorySource, User, UserLeagueRating


def is_rating_change(row: type[RatingHistory] = RatingHistory) -> ColumnElement[bool]:
    """A ``rating_history`` row that records a real rating CHANGE, rather than the
    prior a member is seeded with when they join.

    Filters ``initial`` rows out of any read of the table: they are the strategy's
    starting point, not a rating the player ever held (they were Unrated), so a
    chart must not plot one as a point and a peak must not report one as a high.

    ``row`` takes an ``aliased(RatingHistory)`` when the table appears twice in one
    statement (``had_rating_before`` compares a row against the player's earlier
    ones), so both copies are filtered by THE SAME definition of "a change".
    """
    return row.source != RatingHistorySource.initial


def had_rating_before() -> ColumnElement[bool]:
    """Was the player ALREADY RATED when this ``rating_history`` row landed? — the
    point-in-time form of ``is_rated_member``, correlated to the row itself.

    This is what a rating change needs in order to be reported honestly. A row's
    stored ``previous_rating_value`` is the state the Glicko-2 computation started
    from, and for a player's FIRST rated match that state is the 1500 the league
    seeded them with on joining. The number is not wrong — the maths genuinely
    starts there — but presenting it as a ``before`` is: "1500 → 1268, −232" tells a
    player they lost 232 points of a rating they never held, one widget away from
    the pre-match snapshot correctly calling them **Unrated** (#952). A first rated
    match does not move you. It ESTABLISHES you (see ``RatingChange``).

    "Already rated" is therefore the same question ``app.ratings.rated`` asks
    everywhere else — has anything real MOVED this rating? — asked as of this row:
    an earlier non-``initial`` row for the same ``(user, league)``. Not merely "an
    earlier row": the seed IS an earlier row, and counting it would reintroduce the
    phantom 1500 this predicate exists to remove.

    EARLIER means ``created_at`` on the audit row, which for a match row IS the
    match's ``completed_at`` (ADR-0012: the live path writes it in the same
    transaction as ``mark_completed``, and the recompute stamps it explicitly). So
    this reads the same completion order the ratings were COMPUTED in — the order
    ``previous_rating_value`` itself came from — and survives a recompute rewriting
    the rows.
    """
    prior = aliased(RatingHistory)
    return (
        select(prior.id)
        .where(
            prior.user_id == RatingHistory.user_id,
            prior.league_id == RatingHistory.league_id,
            prior.created_at < RatingHistory.created_at,
            is_rating_change(prior),
        )
        .correlate(RatingHistory)
        .exists()
    )


def reported_rating_before(
    row: RatingHistory, *, had_rating_before: bool
) -> float | None:
    """THE read of ``rating_history.previous_rating_value`` — the only one in ``app/``
    (``test_previous_rating_value_is_read_in_exactly_one_place`` is the fence around
    that, and it will fail the moment a second one appears).

    The stored column is the state the Glicko-2 update STARTED FROM, which is not
    the same thing as the rating the player HELD going in: for a first rated match
    it is the 1500 the league seeded them with on joining. Reported raw it says
    "1500 → 1268, −232" — 232 points lost from a rating that was never held. So the
    column is not readable on its own; it is only readable through this function,
    which demands the one fact it cannot know about itself.

    ``had_rating_before`` is ``had_rating_before()`` above, selected alongside the
    row. Keyword-only and with NO DEFAULT, deliberately: every caller must answer
    it, because defaulting it either way silently mis-narrates one of the two cases
    — and the wrong default IS the bug (#952).

    Both surfaces that report a rating change come through here — the wire schema
    ``app.schemas.rating.RatingChange.from_history`` (dashboard, profile, recent
    matches) and ``app.repositories.match_details_repository.rating_changes`` (the
    match-details extras) — so they cannot drift into disagreeing about the same
    player's ``before``, exactly as ``app.domain.rating.rating_delta`` keeps them
    from disagreeing about the ``delta`` derived from it.
    """
    return row.previous_rating_value if had_rating_before else None


def is_rated_member() -> ColumnElement[bool]:
    """A ``UserLeagueRating`` row that IS A RUNG ON THE LADDER — the WHERE-clause
    form of "not Unrated", and the single definition of the league's rated
    population.

    Three conjuncts, and every one of them is a player some read used to count who
    is not on the ladder:

    * ``rating_value IS NOT NULL`` — a manual-strategy league seeds a NULL rating
      awaiting its import. No rating, whatever its history says.
    * NOT TOMBSTONED — a merged-away ghost is not a player, so it may not inflate a
      real player's rank or pad a percentile's denominator. Folded in HERE rather
      than restated by each caller as a ``User`` join, because the one function that
      forgot to restate it (``league_percentile``, #944) drew "Top 8%" from a
      different population than the "#3 of 42" printed beside it.
    * A NON-``initial`` RATING-HISTORY ROW — something has actually MOVED this
      rating. This is the one that matters in practice: joining a league seeds a
      1500 row, so without it every guest who ever loaded the site is a rung.

    Correlates to ``UserLeagueRating``, so it drops into any query with the table in
    scope: a filter (``load_player_ratings``, the rank window,
    ``league_rated_population``, ``league_percentile``, ``player_confidence``) or an
    outer-join ON clause (the roster's sort, the profile's Leagues card), where a
    member who fails it joins to NULL instead of dropping out of the listing —
    belonging to a league and holding a rating in it are different facts.

    ONE predicate, ONE ladder: rating, rank, the "of N" behind it, the percentile
    and the confidence card are all read through this, so no two of them can
    disagree about who is on it.

    Both subqueries ``correlate(UserLeagueRating)`` EXPLICITLY — they correlate to
    the rating row and to nothing else. Left to auto-correlation, the ``User``
    subquery evaporates the moment this is used in a query that already selects
    from ``users`` (the roster does: ``SELECT users ... LEFT JOIN
    user_league_ratings ON ... is_rated_member()``), taking its own FROM clause with
    it — SQLAlchemy raises ``InvalidRequestError`` rather than emitting it, which is
    the good outcome, but only because it refuses to guess.
    """
    return and_(
        UserLeagueRating.rating_value.is_not(None),
        select(User.id)
        .where(
            User.id == UserLeagueRating.user_id,
            User.merged_into_user_id.is_(None),
        )
        .correlate(UserLeagueRating)
        .exists(),
        select(RatingHistory.id)
        .where(
            RatingHistory.user_id == UserLeagueRating.user_id,
            RatingHistory.league_id == UserLeagueRating.league_id,
            is_rating_change(),
        )
        .correlate(UserLeagueRating)
        .exists(),
    )
