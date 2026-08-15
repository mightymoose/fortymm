"""Data access for the tournament read path.

The one thing worth stating up front: an event's registration count is **not a
stored column** (ADR-0016). It is derived from the event's live *active* entries,
which are the same rows the read model lists as its entrants — so the count and
the list are read together, once, and cannot disagree.

The tournament LIST endpoint returns every tournament with all of its events, so
the loader below is batched over **all** the event ids at once: one statement,
regardless of how many events there are. A per-event count would be an N+1, and
``tests/test_tournaments.py`` pins the statement count to keep it that way.
"""

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy import ColumnElement, and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.expression import ScalarSelect

from app.models import (
    DrawTypeOption,
    Match,
    MatchGame,
    MatchGameScore,
    MatchStatus,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentEventPool,
    TournamentEventStage,
    TournamentFixture,
    TournamentStatus,
    User,
    UserLeagueRating,
)
from app.ratings.rated import is_rated_member
from app.schemas.tournament import (
    DrawTypeRead,
    FixtureTimeRead,
    TournamentEntrantRead,
    TournamentFixtureRead,
)
from app.venue_time import venue_local

# The statuses in which a tournament has been ANNOUNCED to the world. Publishing
# is the act that makes a tournament public (ADR-0017), and nothing walks
# backwards out of it, so everything from ``published`` onward is announced and
# ``draft`` is not.
#
# An allow-list, deliberately, rather than "anything but draft": a status added
# to the enum tomorrow is invisible to non-owners until somebody puts it in this
# set on purpose. The inverse spelling would silently publish a future
# pre-publish status (a ``pending_review``, a ``scheduled``) the moment it was
# added, which is exactly the leak this predicate exists to close.
ANNOUNCED_STATUSES: frozenset[TournamentStatus] = frozenset(
    {
        TournamentStatus.published,
        TournamentStatus.live,
        TournamentStatus.archived,
    }
)


def visible_to(user_id: uuid.UUID) -> ColumnElement[bool]:
    """Which tournaments ``user_id`` may see at all: the announced ones, plus
    their own — whatever status their own is in.

    A draft is not announced, so it is owner-only. The read routes push this into
    the WHERE clause rather than filtering after the fact, so a hidden draft is
    *not selected* and the detail route's existing "Tournament not found." 404
    answers for it. 404 and not 403: a 403 would confirm that a tournament with
    that id exists, which is precisely what an unannounced tournament must not
    admit. A draft the caller cannot see is indistinguishable from one that was
    never created.

    ``tournament.view`` is a separate question, and it is asked first — the HTTP
    route hangs it off a dependency and the MCP adapter checks it before this
    predicate is ever built, so a caller without the permission is refused (403 /
    a ``ToolError``) first. Permission says "may you read tournaments at all";
    this says "which ones are there for you to read".

    One predicate, shared by the list route, the detail route, and the MCP
    ``get_tournament`` tool, because two copies of this rule would eventually
    disagree — and the way they disagree is that one hides a draft another still
    serves.
    """
    return or_(
        Tournament.status.in_(ANNOUNCED_STATUSES),
        Tournament.created_by_user_id == user_id,
    )


def completed_match_ids(
    fixtures_by_event: dict[uuid.UUID, list[TournamentFixtureRead]],
) -> list[uuid.UUID]:
    """The ids of the matches of every **completed** fixture across the page.

    The one list ``game_counts_by_match`` is batched over, gathered before any event is
    serialized so the standings of every event are projected from a single game load
    (ADR-0788) rather than a query per event. Only ``completed`` fixtures contribute: an
    in-progress match's part-scored board is not a result and must not reach a standings
    table."""
    return [
        f.match_id
        for fixtures in fixtures_by_event.values()
        for f in fixtures
        if f.match_status is MatchStatus.completed and f.match_id is not None
    ]


async def draw_type_catalogue(db: AsyncSession) -> list[DrawTypeRead]:
    """Every selectable draw format, in ``display_order`` — the picker's options, read
    from the ``draw_types`` table.

    **From the table, not from the ``DrawType`` enum.** The two are the same set by
    construction (a migration test pins that), so iterating the enum would produce the
    same keys — and would be wrong anyway: the enum carries no ``name``, no
    ``description`` and no order, so the copy would have to be hardcoded somewhere,
    which is the drift the ADR ("a draw type is a seeded row, and the enum holds only
    what runs") moved the catalogue into the database to end. Reading the rows is what
    makes "the table gates what a director can pick" a fact about the running system
    rather than two lists that happen to agree.

    The order is total, not just ``display_order``: ties break on ``key`` so the picker
    cannot reorder itself between two requests. Postgres is free to return equal-ranked
    rows in any order, and a control whose options shuffle under the cursor is a defect
    the seed data alone must not be trusted to prevent.

    ONE statement, unconditional and independent of the page — this is global reference
    data, two rows today, so there is nothing to batch and nothing to key. The
    tournament-detail statement pin in ``tests/test_tournaments.py`` counts it.
    """
    rows = (
        await db.execute(
            select(DrawTypeOption).order_by(
                DrawTypeOption.display_order, DrawTypeOption.key
            )
        )
    ).scalars()
    return [DrawTypeRead.model_validate(row) for row in rows]


async def active_entrants_by_event(
    db: AsyncSession, event_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, list[TournamentEntrantRead]]:
    """The active entrants of every event in ``event_ids``, keyed by event id —
    each carrying their rating **on the tournament's ladder**, or ``None`` where they
    hold none.

    ONE statement for the whole batch (none at all when there are no events).
    Every id gets a key, so an event nobody has entered maps to ``[]`` — the
    caller never has to guess whether a missing key means "no entrants" or "not
    loaded". Withdrawn entries are filtered out here, at the only place that
    reads them, so they can reach neither the entrants list nor the count that is
    derived from it.

    **The rating rides along on that same statement**, and it has to. An unrated player
    passes every rating rule (ADR-0783 §3), which makes a rating cap **opt-out**: a
    sandbagger's optimal move is to never play a rated match and stay eligible for every
    capped event forever. The agreed mitigation is that the director can SEE who took
    that option — so the rating is a fact about *every entrant of every event on the
    page*, not about the caller, and fetching it per entrant would be an N+1 that grows
    with the field it is describing. The statement-count tripwires in
    ``tests/test_tournaments.py`` fail if one appears. Instead the entry's own event
    names its tournament, the tournament names the ladder (``league_id``, ADR-0783
    §2), and the rating LEFT-joins onto that — so the league is read from the rows
    rather than passed in by a caller who could pass the wrong one.

    An entrant who is not rated on that ladder joins to NULL rather than dropping out of
    the list: **belonging to an event and holding a rating in its league are different
    facts**, and the entrant this whole mitigation exists for is precisely the one with
    no rating. That NULL is ``is_rated_member()``'s — NOT ``rating_value IS NULL`` — for
    the reason spelled out on ``entrant_rating`` below: joining a league seeds a 1500
    row, so a brand-new player *has* a ``rating_value``, and keying off the column would
    print a phantom 1500 beside the very sandbagger the director is looking for. The
    entrants list, the ``entry_state`` and the entry route's 409 therefore all read the
    same one definition of Unrated, and cannot come to disagree about who is on the
    ladder.
    """
    entrants: dict[uuid.UUID, list[TournamentEntrantRead]] = {
        event_id: [] for event_id in event_ids
    }
    if not entrants:
        return entrants
    rows = (
        await db.execute(
            select(
                TournamentEntry.id,
                TournamentEntry.event_id,
                TournamentEntry.user_id,
                User.username,
                TournamentEntry.seed,
                UserLeagueRating.rating_value,
            )
            .join(User, User.id == TournamentEntry.user_id)
            # The two hops that answer "rated against WHAT?": the entry's event, and
            # that event's tournament, which is the thing that names the ladder.
            .join(TournamentEvent, TournamentEvent.id == TournamentEntry.event_id)
            .join(Tournament, Tournament.id == TournamentEvent.tournament_id)
            .outerjoin(
                UserLeagueRating,
                and_(
                    UserLeagueRating.user_id == TournamentEntry.user_id,
                    UserLeagueRating.league_id == Tournament.league_id,
                    # In the ON clause, not the WHERE: an unrated entrant must still be
                    # LISTED (with a NULL rating), and a WHERE would delete them from
                    # the entrants list — and from the derived ``entered`` count with it
                    # (ADR-0016), silently freeing a slot in a full event.
                    is_rated_member(),
                ),
            )
            .where(
                TournamentEntry.event_id.in_(entrants.keys()),
                TournamentEntry.status == TournamentEntryStatus.entered,
            )
            # Oldest entry first, matching the event's ``entries`` relationship,
            # so the list is stable across reads.
            .order_by(TournamentEntry.created_at, TournamentEntry.id)
        )
    ).all()
    for entry_id, event_id, user_id, username, seed, rating in rows:
        entrants[event_id].append(
            TournamentEntrantRead(
                id=entry_id,
                user_id=user_id,
                username=username,
                seed=seed,
                rating=rating,
            )
        )
    return entrants


def _pool_position() -> ScalarSelect[int | None]:
    """The ``position`` of a fixture's pool within its own event — the correlated
    subquery the draw order below sorts on.

    A fixture holds its pool's **id**, not its index, so "where does this fixture's pool
    sit in the director's order?" is a join: find the ``tournament_event_pools`` row
    this fixture's ``(stage_id, pool_id)`` names — the same pair the composite foreign
    key matches on (ADR 20260801, re-parented onto the stage by ADR 20260815) — and
    read its ``position`` (:data:`app.schemas.tournament.PoolPosition` — 0-based,
    stamped by the server from the order the pools were sent in). Scalar by
    construction, since ``(stage_id, id)`` is unique, rather than by a ``LIMIT``
    papering over duplicates.

    It is ``NULL`` in exactly one case now, and that case wants to sort at the end of
    the pooled group: an **un-pooled** fixture (``pool_id IS NULL`` — single-elim,
    swiss, or the KO stage of an rr-then-ko draw) matches no row. It used to have a
    second — a pool stored before ``position`` existed — which the ``NOT NULL`` column
    has closed; the id stays on as a secondary sort key below because the *order* still
    has to be total when this is NULL for every row of an un-pooled draw.

    Correlated on ``TournamentFixture`` alone. ``stage_id`` comes off the fixture
    directly now — simpler than before this ADR, which correlated on ``event_id``
    because that was the fixture's own column too; the fixture's identity key moved
    from ``event_id`` to ``stage_id`` (decision 5), and so does this join.
    """
    return (
        select(TournamentEventPool.position)
        .where(
            TournamentEventPool.stage_id == TournamentFixture.stage_id,
            TournamentEventPool.id == TournamentFixture.pool_id,
        )
        .correlate(TournamentFixture)
        .scalar_subquery()
    )


async def fixtures_by_event(
    db: AsyncSession, event_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, list[TournamentFixtureRead]]:
    """The draw of every event in ``event_ids`` — its fixtures (ADR-0786) — keyed by
    event id, each event's in **pool → round → position** order.

    ONE statement for the whole batch (none at all when there are no events), which is
    the whole reason this is a loader and not a ``selectinload`` of the event's
    ``fixtures`` relationship or, worse, a read of ``event.fixtures`` inside the
    serializer's per-event loop. The tournament LIST endpoint returns every tournament
    with all of its events, so a per-event fetch would be a query per *event on the
    page*, and it would arrive invisibly: nothing about the response would look wrong.
    The statement-count tripwires in ``tests/test_tournaments.py`` fail if one appears.
    Same shape, and the same reasoning, as ``active_entrants_by_event`` above.

    **Every id gets a key**, so an event whose draw has not been cut maps to ``[]``. The
    caller never has to tell "no draw" apart from "not loaded", and the read model can
    make empty a designed state rather than a null to branch on — which matters more
    here than it does for entrants, because an un-cut draw is the *normal* condition of
    an event (cutting is an explicit act, ADR-0786), not an edge case.

    **The ordering is the query's, not the caller's**, and it is a total order: pool,
    then round, then position — over columns that ``UNIQUE (event_id, pool_id, round,
    position)`` already guarantees are unique together, so the sequence is the same on
    every read and a client can render a bracket without sorting it first. A NULL
    ``pool_id`` sorts LAST, which puts a pools-then-knockout draw type's KO stage
    after the pools it is fed from (and costs an un-pooled draw nothing — every row is
    NULL there, so round and position decide it alone).

    "Pool" here means the pool's **position in the event's own pool order**
    (:func:`_pool_position`), not its id. The id used to be a client-minted string —
    ``p-1-…``, ``p-2-…``, ``p-10-…`` — and *lexicographically* ``p-10-`` fell between
    ``p-1-`` and ``p-2-``, so a ten-pool event rendered its draw as pool 1, pool 10,
    pool 2. Sorting on the stored ``position`` (ADR 20260801, "Pools carry an explicit
    ``position``") is also the only key that survives pools becoming rows with random
    UUID primary keys, under which an id sort is not merely wrong but *arbitrary*.
    The id stays on as a secondary key so the order is still total when the positions
    cannot decide it — every fixture of an un-pooled draw resolves a ``NULL`` position.

    Sorted in Postgres rather than in Python because a NULL is not comparable to an
    ``int`` (nor, before it, to a string): ``sorted(key=lambda f: (f.pool_position,
    ...))`` is a ``TypeError`` the moment an un-pooled fixture meets a pooled one, and
    the defensive coalesce that usually follows (``f.pool_position or 0``) would
    quietly sort the KO stage FIRST — in front of the pools that feed it. The position
    is also not a column on the fixture at all: it lives on the fixture's *pool* row, so
    resolving it in Python would mean loading every event's pools per read.

    A materialized fixture carries its match's **live status** (``match_status``), read
    by LEFT-joining ``matches`` on ``fixture.match_id`` (#788) — still ONE statement,
    still one row per fixture (a fixture links to at most one match). It is read on
    every load rather than snapshotted, so a slot reflects its match as played; an
    un-materialized fixture joins to ``NULL`` and reports a ``None`` status.

    The same join also carries the match's **actual completion time**
    (``completed_at``) — the Gantt chart's real end anchor once a slot is played,
    as opposed to ``scheduled_start``, which stays the solver's *predicted* one
    forever. All three displayed times (``scheduled_start``, ``pinned_at``,
    ``completed_at``) are shaped into a :class:`FixtureTimeRead` here, at the loader,
    by ``_fixture_time`` below — a venue-local label + tz abbreviation composed in the
    **event's timezone** with ``zoneinfo`` (so no client does timezone math, ADR
    "tournament times are timezone-aware instants"), alongside the raw UTC instant for
    tz-agnostic geometry. The event's ``timezone`` rides on this same statement (the
    ``TournamentEvent`` join), so the label is composed from a fact the query holds,
    not one the serializer has to fetch per row.

    The rows are validated into read models here, at the loader — the same boundary the
    entrants cross — so no ORM instance and no lazily-loadable relationship escapes into
    the serializer.
    """
    fixtures: dict[uuid.UUID, list[TournamentFixtureRead]] = {
        event_id: [] for event_id in event_ids
    }
    if not fixtures:
        return fixtures
    rows = (
        await db.execute(
            select(
                TournamentFixture,
                TournamentEventStage.event_id,
                TournamentEvent.timezone,
                Match.status,
                Match.completed_at,
            )
            # ``event_id`` no longer lives on the fixture (ADR 20260815 decision 5), so
            # this joins ``tournament_event_stages`` for it — the event is reachable
            # through the stage — rather than reading ``TournamentFixture.event_id``.
            .join(
                TournamentEventStage,
                TournamentEventStage.id == TournamentFixture.stage_id,
            )
            .join(TournamentEvent, TournamentEvent.id == TournamentEventStage.event_id)
            .outerjoin(Match, Match.id == TournamentFixture.match_id)
            .where(TournamentEventStage.event_id.in_(fixtures.keys()))
            .order_by(
                _pool_position().asc().nulls_last(),
                TournamentFixture.pool_id.asc().nulls_last(),
                TournamentFixture.round,
                TournamentFixture.position,
            )
        )
    ).all()
    for fixture, event_id, event_timezone, match_status, match_completed_at in rows:
        fixtures[event_id].append(
            TournamentFixtureRead(
                id=fixture.id,
                stage_id=fixture.stage_id,
                pool_id=fixture.pool_id,
                round=fixture.round,
                position=fixture.position,
                entry_a_id=fixture.entry_a_id,
                entry_b_id=fixture.entry_b_id,
                winner_entry_id=fixture.winner_entry_id,
                match_id=fixture.match_id,
                match_status=match_status,
                table_id=fixture.table_id,
                scheduled_start=_fixture_time(fixture.scheduled_start, event_timezone),
                pinned_at=_fixture_time(fixture.pinned_at, event_timezone),
                call_notified_count=fixture.call_notified_count,
                completed_at=_fixture_time(match_completed_at, event_timezone),
            )
        )
    return fixtures


def _fixture_time(instant: datetime | None, timezone: str) -> FixtureTimeRead | None:
    """Shape one displayed fixture time into a :class:`FixtureTimeRead`, or ``None``
    when the time is unassigned.

    The stored value is a ``timestamptz`` instant (asyncpg hands it back UTC-aware; a
    just-written venue-offset value is the same instant in a different offset). We
    render it in the **event's** timezone (:func:`app.venue_time.venue_local`) for
    the human-readable label + abbreviation, and normalize the raw ``instant`` to
    UTC (``+00:00``) so every read path emits one string for one moment.
    """
    if instant is None:
        return None
    local = venue_local(instant, timezone)
    return FixtureTimeRead(
        instant=instant.astimezone(UTC),
        local_label=_local_label(local),
        tz_abbrev=local.strftime("%Z"),
    )


def _local_label(local: datetime) -> str:
    """A 12-hour venue wall-clock label with no leading zero: ``"6:00 PM"``,
    ``"12:05 AM"``. ``%-I`` is a glibc-only extension, so strip the zero pad by hand
    for portability across the dev (macOS) and CI (Linux) platforms."""
    return local.strftime("%I:%M %p").lstrip("0")


async def game_counts_by_match(
    db: AsyncSession, match_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, tuple[int, int]]:
    """For each match in ``match_ids``, the games each **side** won — ``(side_1_games,
    side_2_games)`` — read off its scored games. Keyed by match id.

    The raw material the round-robin standings are projected from (ADR-0788): a fixture
    seats ``entry_a`` on side 1 and ``entry_b`` on side 2 (#788), so a side's game count
    *is* that entry's, and the winner is the side that took more. Derived live from the
    match's games rather than the fixture's ``winner_entry_id``, so a correction to a
    completed match re-shapes the standings the instant it lands (ADR-0788 —
    round-robin reads never read the written-back winner).

    ONE statement for the whole batch (none at all when there are no matches to count),
    and every id gets a key — a completed match whose games somehow carry no scores maps
    to ``(0, 0)`` rather than dropping out, so the caller never tells "no scores" apart
    from "not loaded". Batched over **every** completed tournament match on the page for
    the same reason the entrants and fixtures are: a per-match count would be an N+1
    that grows with the field the page describes.

    Only **completed** matches should be passed — an in-progress match's part-scored
    board is not a result and must not reach the standings; the caller filters on
    ``match_status`` before it collects the ids.

    A tie in a single game cannot happen (``MatchGameScoreWrite`` forbids it), so a
    scored game always moves exactly one side's counter; the ``==`` arm is unreachable
    and simply counts nothing, keeping the projection total rather than guessing a
    winner.
    """
    counts: dict[uuid.UUID, list[int]] = {match_id: [0, 0] for match_id in match_ids}
    if not counts:
        return {}
    rows = (
        await db.execute(
            select(
                MatchGame.match_id,
                MatchGameScore.side_1_points,
                MatchGameScore.side_2_points,
            )
            .join(MatchGameScore, MatchGameScore.match_game_id == MatchGame.id)
            .where(MatchGame.match_id.in_(counts.keys()))
        )
    ).all()
    for match_id, side_1_points, side_2_points in rows:
        if side_1_points > side_2_points:
            counts[match_id][0] += 1
        elif side_2_points > side_1_points:
            counts[match_id][1] += 1
    return {match_id: (side_1, side_2) for match_id, (side_1, side_2) in counts.items()}


async def active_entry_count(db: AsyncSession, event_id: uuid.UUID) -> int:
    """How many players hold an **active** entry in this event, right now.

    The number ``max_players`` is compared against (ADR-0783). Withdrawn entries are
    not entrants (ADR-0016), so they are filtered out here exactly as they are in
    ``active_entrants_by_event`` — a withdrawal genuinely frees a slot, and a count
    that included the withdrawn rows would seal an event that still has room.

    A fresh ``COUNT(*)`` against the database, not ``len(event.entries)``: this is
    read inside the entry route's tournament row lock, and it must see what the last
    committed writer wrote, not whatever the caller's identity map happens to hold.
    The count is deliberately **not** derived from ``active_entrants_by_event`` —
    loading every entrant to measure the length of the list would make the capacity
    guard's cost grow with the field it is guarding, for a number Postgres will hand
    us in one row.
    """
    return (
        await db.execute(
            select(func.count())
            .select_from(TournamentEntry)
            .where(
                TournamentEntry.event_id == event_id,
                TournamentEntry.status == TournamentEntryStatus.entered,
            )
        )
    ).scalar_one()


async def entrant_rating(
    db: AsyncSession, league_id: uuid.UUID, user_id: uuid.UUID
) -> float | None:
    """A player's rating **on the tournament's ladder** — the number every eligibility
    rule is decided against (ADR-0783) — or ``None`` when they hold none.

    The league is the tournament's own ``league_id``, not a default picked here: an
    eligibility decision that could not say *which* ladder it judged on would not be a
    decision at all.

    **"Unrated" is NOT ``rating_value IS NULL``, and this is the trap.** Joining a
    league SEEDS a rating row at 1500 (the strategy's ``initial_rating_value``) — for
    the default league, that happens when a guest's session is minted, before they have
    played a thing. So a brand-new player *does* have a ``rating_value``, and it is
    1500. Key eligibility off that column alone and the "Under 1500" beginners' event
    refuses every beginner on the platform — a 1500 seed fails ``rating < 1500`` — which
    is the precise harm ADR-0783 §3 exists to prevent, arriving through the back door.
    (ADR-0783 §3 says "``rating_value`` is nullable, so an unrated player has none". The
    *rule* it states is right and is honoured here; the mechanism it names is not how
    this codebase spells "Unrated", and coding to the mechanism would have inverted the
    rule.)

    The one definition of "not Unrated" is ``app.ratings.rated.is_rated_member`` — the
    rating row has been MOVED by something real (a non-``initial`` ``rating_history``
    row: a completed rated match, an admin override, an import), the value is not NULL,
    and the user is not a merged-away tombstone. It is the same predicate the profile,
    the roster, the rank and the percentile are drawn through, so an entrant the
    tournament calls Unrated is exactly the one their profile calls Unrated. Eligibility
    does not get a second opinion about who is on the ladder.

    Everything else is ``None``: no row, a NULL value (a manual league awaiting its
    import), or a seed nothing has moved. All three mean "we hold no rating for this
    player here", they are worth no distinction, and each one passes every rule
    (ADR-0783 §3).

    ONE query, one column: the entry guard runs it inside the tournament's row lock,
    and loading the whole ``UserLeagueRating`` row to read one float off it would drag
    a JSONB ``rating_state`` along for nothing.

    It is the one-league case of ``entrant_ratings_by_league`` rather than a second
    query of its own, so the guard that refuses an entry and the reads that explain it
    cannot come to differ about who is Unrated — the trap above is exactly the kind
    that a second, subtly-different copy of this ``WHERE`` clause would walk into.
    """
    return (await entrant_ratings_by_league(db, [league_id], user_id))[league_id]


async def entrant_ratings_by_league(
    db: AsyncSession, league_ids: Sequence[uuid.UUID], user_id: uuid.UUID
) -> dict[uuid.UUID, float | None]:
    """One player's rating on each of ``league_ids``, keyed by league id — ``None``
    wherever they hold none (which is most players, on most ladders).

    ONE statement for the whole batch (none at all when there are no leagues), and
    every id gets a key, so a caller never has to tell "no rating" apart from "not
    loaded" — the same shape, and the same reasoning, as ``active_entrants_by_event``.

    This is what keeps the tournament reads free of a per-event rating query: a
    tournament's eligibility is judged on ONE ladder (its ``league_id``, ADR-0783), so
    every event of it needs the *same* number, and the list endpoint needs one number
    per distinct league however many tournaments and events it is returning. A
    ``rating`` fetched inside the per-event loop would be an N+1 that grows with the
    field the page is describing; the statement-count tripwires in
    ``tests/test_tournaments.py`` fail if one comes back.

    Who counts as rated is ``is_rated_member`` — see ``entrant_rating`` above for why
    that is emphatically not ``rating_value IS NOT NULL``.
    """
    ratings: dict[uuid.UUID, float | None] = {
        league_id: None for league_id in league_ids
    }
    if not ratings:
        return ratings
    rows = (
        await db.execute(
            select(UserLeagueRating.league_id, UserLeagueRating.rating_value).where(
                UserLeagueRating.league_id.in_(ratings.keys()),
                UserLeagueRating.user_id == user_id,
                is_rated_member(),
            )
        )
    ).all()
    for league_id, rating_value in rows:
        ratings[league_id] = rating_value
    return ratings
