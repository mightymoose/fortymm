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
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time
from typing import Any
from zoneinfo import ZoneInfo

from pydantic import ValidationError
from sqlalchemy import ColumnElement, Select, and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import contains_eager
from sqlalchemy.sql.expression import ScalarSelect

from app.models import (
    Account,
    DrawTypeOption,
    Match,
    MatchGame,
    MatchGameScore,
    MatchStatus,
    Player,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentEventGroupReservation,
    TournamentEventReservation,
    TournamentEventReservationTable,
    TournamentEventStage,
    TournamentEventStageGroup,
    TournamentFixture,
    TournamentStatus,
    UserLeagueRating,
)
from app.ratings.rated import is_rated_member
from app.schemas.tournament import (
    DrawTypeRead,
    FixtureTimeRead,
    Slot,
    TournamentEntrantRead,
    TournamentFixtureRead,
)
from app.venue_time import venue_local

#: A fixture whose linked match is in one of these statuses is history (ADR-0790's
#: write-side freeze, ``tournament_placement._enforce_fixture_placeable``): its
#: placement is no longer live, so neither ADR-0790 read-flag applies to it
#: (``_placement_flags`` below).
_DECIDED_MATCH_STATUSES = frozenset({MatchStatus.completed, MatchStatus.voided})

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

    No permission precedes this predicate: #1092 deleted ``tournament.view``, so
    every signed-in caller reaches it. It says only *which* tournaments are there
    for you to read — never *whether* you may read tournaments at all.

    One predicate, shared by the list route, the detail route, and the MCP
    ``get_tournament`` tool, because two copies of this rule would eventually
    disagree — and the way they disagree is that one hides a draft another still
    serves.
    """
    return or_(
        Tournament.status.in_(ANNOUNCED_STATUSES),
        Tournament.owner_account_id == user_id,
    )


def stage_ids_for_events(
    event_ids: Collection[uuid.UUID],
) -> Select[tuple[uuid.UUID]]:
    """Every stage id belonging to any of ``event_ids`` — the subquery a
    ``TournamentFixture`` read scoped to one or more events is filtered through now
    that a fixture names its stage, not its event (ADR 20260815 decision 5 drops
    ``tournament_fixtures.event_id`` outright).

    The one canonical copy: every caller still asks its question **about an event**
    (or several); this is only how that question reaches a table keyed on stage now.
    Used as a ``.in_(...)`` subquery, never awaited on its own — callers that already
    hold an ``AsyncSession`` fold it straight into their own statement.
    """
    return select(TournamentEventStage.id).where(
        TournamentEventStage.event_id.in_(event_ids)
    )


def stage_ids_for_tournament(tournament_id: uuid.UUID) -> Select[tuple[uuid.UUID]]:
    """Every stage id belonging to any event of ``tournament_id`` — the tournament-
    scoped sibling of :func:`stage_ids_for_events`, for a caller (a tournament-wide
    fixture read or write) that has no event id list to hand the other one and joins
    through ``tournament_events`` instead."""
    return (
        select(TournamentEventStage.id)
        .join(TournamentEvent, TournamentEvent.id == TournamentEventStage.event_id)
        .where(TournamentEvent.tournament_id == tournament_id)
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
                Player.username,
                TournamentEntry.seed,
                UserLeagueRating.rating_value,
            )
            .select_from(TournamentEntry)
            .join(Player, Player.id == TournamentEntry.user_id)
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


def _group_position() -> ScalarSelect[int | None]:
    """The ``position`` of a fixture's group within its own event — the correlated
    subquery the draw order below sorts on.

    A fixture holds its group's **id**, not its index, so "where does this fixture's
    group sit in the director's order?" is a join: find the
    ``tournament_event_stage_groups`` row this fixture's ``(stage_id, group_id)`` names
    — the same pair the composite foreign key matches on (ADR 20260801, parented on the
    stage by ADR 20260815) — and read its ``position``
    (:data:`app.schemas.tournament.ReservationPosition` — 0-based, stamped by the server
    from the order the groups were sent in). Scalar by construction, since ``(stage_id,
    id)`` is unique, rather than by a ``LIMIT`` papering over duplicates.

    It should never actually be ``NULL`` now: every stage a draw type's template mints
    holds a group (#1484), and ``tournament_fixtures.group_id`` is ``NOT NULL``, so
    ``(stage_id, group_id)`` always names a real row via the composite foreign key. The
    ``.nulls_last()`` at the call site is kept as defense, not because a NULL case is
    reachable through any write path today — the same floor that closed this
    subquery's other former NULL case, a group stored before ``position`` existed.

    This position is scoped to the fixture's own **stage**: two groups of *different*
    stages of one widened event can share the same ``position`` (a knockout group and
    the group stage's own group 1 are both ``position: 0``), so a caller ordering on
    this value alone must also order on the fixture's stage first — which
    :func:`fixtures_by_event` does (see its docstring for why).

    Correlated on ``TournamentFixture`` alone. ``stage_id`` comes off the fixture
    directly now — simpler than before this ADR, which correlated on ``event_id``
    because that was the fixture's own column too; the fixture's identity key moved
    from ``event_id`` to ``stage_id`` (decision 5), and so does this join.
    """
    return (
        select(TournamentEventStageGroup.position)
        .where(
            TournamentEventStageGroup.stage_id == TournamentFixture.stage_id,
            TournamentEventStageGroup.id == TournamentFixture.group_id,
        )
        .correlate(TournamentFixture)
        .scalar_subquery()
    )


async def fixtures_by_event(
    db: AsyncSession, event_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, list[TournamentFixtureRead]]:
    """The draw of every event in ``event_ids`` — its fixtures (ADR-0786) — keyed by
    event id, each event's in **stage → group → round → position** order.

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

    **The ordering is the query's, not the caller's**, and it is a total order: stage,
    then group, then round, then position — over columns that ``UNIQUE (stage_id,
    group_id, round, position)`` already guarantees are unique together, so the
    sequence is the same on every read and a client can render a bracket without
    sorting it first. ``TournamentEventStage.position`` leads the order (#1484): a
    group's own ``position`` is unique only within its stage, not across the event's
    whole, widened ``groups`` (ADR "every stage holds groups") — an ``rr-then-ko``
    event's knockout group and the group stage's own group 1 are both ``position: 0``,
    so without the stage key first, the tiebreak (the group's random uuid) would sort
    the knockout stage arbitrarily among the pool groups instead of strictly after
    them, which is what put the #1348 sighting's screenshot on the wire in the first
    place.

    "Group" here (below the stage key) means the group's **position within its own
    stage's group order** (:func:`_group_position`), not its id. The id used to be a
    client-minted string — ``p-1-…``, ``p-2-…``, ``p-10-…`` — and *lexicographically*
    ``p-10-`` fell between ``p-1-`` and ``p-2-``, so a ten-group event rendered its
    draw as group 1, group 10, group 2. Sorting on the stored ``position`` (ADR
    20260801, "Groups carry an explicit ``position``") is also the only key that
    survives groups becoming rows with random UUID primary keys, under which an id
    sort is not merely wrong but *arbitrary*. The id stays on as a secondary key so
    the order is still total when two groups of one stage's own group set somehow tie
    on position — which the stage's own unique constraint on
    ``(stage_id, position)`` should already prevent, but costs nothing to also handle
    here.

    ``TournamentFixture.id`` closes the order out as a final tiebreaker, the one
    column guaranteed unique platform-wide, so the order is total regardless of the
    template shape or any tie above it.

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

    **ADR-0790's two deferred read-side flags** (``table_off_reservation`` /
    ``start_outside_reservation_window``, #1537 — see ``TournamentFixtureRead``'s own
    docstring for the field-level contract) cost **at most ONE additional batched
    statement**, never one per event or per fixture:
    :func:`_reservation_windows_by_group` runs once, over every group named by an
    *evaluable* fixture across the WHOLE batch (placed on at least one axis, match not
    yet decided — ``_DECIDED_MATCH_STATUSES``), and is skipped entirely when nothing in
    the batch is evaluable (an un-cut, un-placed, or fully-decided page pays nothing —
    mirrors the ``if not fixtures: return fixtures`` guard above). The event's own
    ``slot`` — the event-wide reservation's window (ADR 20260807) — rides on THIS
    statement (a plain extra column off the join already here), not a second one.
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
                TournamentEvent.timezone,
                TournamentEvent.slot,
                Match.status,
                Match.completed_at,
            )
            # ``event_id`` no longer lives on the fixture (ADR 20260815 decision 5), so
            # this joins ``tournament_event_stages`` for it — the event is reachable
            # through the stage — rather than reading ``TournamentFixture.event_id``.
            # ``contains_eager(TournamentFixture.stage)`` tells the ORM this explicit
            # join IS the eager load ``TournamentFixture.stage`` (``lazy="joined"``)
            # would otherwise add a SECOND, aliased join for — so the fixture's
            # ``event_id`` property (which reads ``self.stage.event_id``) is free below,
            # off the one join already here, rather than a separately-selected column.
            # ``TournamentEventStage.groups`` is deliberately NOT eager (see that
            # relationship's docstring), so attaching a stage here costs nothing extra
            # — no ``.noload(...)`` needed to suppress a cascade that doesn't exist.
            .join(
                TournamentEventStage,
                TournamentEventStage.id == TournamentFixture.stage_id,
            )
            .join(TournamentEvent, TournamentEvent.id == TournamentEventStage.event_id)
            .outerjoin(Match, Match.id == TournamentFixture.match_id)
            .where(TournamentEventStage.event_id.in_(fixtures.keys()))
            .options(contains_eager(TournamentFixture.stage))
            .order_by(
                TournamentEventStage.position,
                _group_position().asc().nulls_last(),
                TournamentFixture.group_id.asc().nulls_last(),
                TournamentFixture.round,
                TournamentFixture.position,
                TournamentFixture.id,
            )
        )
    ).all()

    evaluable_group_ids = {
        fixture.group_id
        for fixture, _tz, _slot, match_status, _completed_at in rows
        if match_status not in _DECIDED_MATCH_STATUSES
        and (fixture.table_id is not None or fixture.scheduled_start is not None)
    }
    reservation_windows = (
        await _reservation_windows_by_group(db, evaluable_group_ids)
        if evaluable_group_ids
        else {}
    )

    for fixture, event_timezone, event_slot, match_status, match_completed_at in rows:
        table_off_reservation, start_outside_window = _placement_flags(
            fixture, match_status, event_timezone, event_slot, reservation_windows
        )
        fixtures[fixture.event_id].append(
            TournamentFixtureRead(
                id=fixture.id,
                stage_id=fixture.stage_id,
                group_id=fixture.group_id,
                round=fixture.round,
                position=fixture.position,
                entry_a_id=fixture.entry_a_id,
                entry_b_id=fixture.entry_b_id,
                winner_entry_id=fixture.winner_entry_id,
                match_id=fixture.match_id,
                match_status=match_status,
                table_id=fixture.table_id,
                scheduled_start=_fixture_time(fixture.scheduled_start, event_timezone),
                table_off_reservation=table_off_reservation,
                start_outside_reservation_window=start_outside_window,
                pinned_at=_fixture_time(fixture.pinned_at, event_timezone),
                call_notified_count=fixture.call_notified_count,
                completed_at=_fixture_time(match_completed_at, event_timezone),
            )
        )
    return fixtures


@dataclass(frozen=True, slots=True)
class _GroupReservationWindow:
    """One group's **mapped** reservation, as much as the ADR-0790 read-flags need
    (#1537): the tables it holds (``frozenset`` — empty is a real, valid answer,
    the ``ReservationHasNoTables`` state ``app.scheduling`` also names), and its
    wall-clock window's raw ``date``/``time`` components exactly as
    ``TournamentEventReservation`` stores them — not yet anchored to an instant,
    because that needs the event's own timezone, which the caller already holds
    per-fixture from the main statement and applies at use (``_placement_flags``),
    not here.

    Carries no ``reservation_id``: ``_placement_flags`` only ever needs to know
    "does this group have a mapped reservation" (this dict's own membership),
    never which one — see that function's own docstring for why a round-trip
    through ``app.schedule_solves.restricting_reservation_key`` would be
    redundant with that membership test."""

    table_ids: frozenset[str]
    slot_date: date
    slot_start: time
    slot_end: time


async def _reservation_windows_by_group(
    db: AsyncSession, group_ids: Collection[uuid.UUID]
) -> dict[uuid.UUID, _GroupReservationWindow]:
    """The **one** additional batched statement the ADR-0790 read-flags cost
    (#1537, see ``fixtures_by_event``'s own docstring): every group in
    ``group_ids`` that has a **mapped** reservation, joined out to that
    reservation's own window and LEFT-joined to its tables.

    A group missing from the mapping table (``TournamentEventGroupReservation`` —
    the row's ABSENCE means "no reservation", never a null ``reservation_id`` on
    one present, see that model's own docstring) simply does not appear in the
    returned dict — the caller (``_placement_flags``) reads that absence as
    "judge this fixture against the event-wide reservation instead" (ADR 20260807),
    never as an empty-tables stand-in: that would be indistinguishable from a real
    reservation that resolved with zero tables reserved.

    Batched over every evaluable group of the WHOLE page in one statement — not
    keyed by event, not one call per event — which is what keeps this loader's
    total statement count independent of how many events or fixtures are on the
    page (the tripwires in ``tests/test_tournaments.py``). The caller only invokes
    this when ``group_ids`` is non-empty.
    """
    rows = (
        await db.execute(
            select(
                TournamentEventGroupReservation.group_id,
                TournamentEventReservation.slot_date,
                TournamentEventReservation.slot_start,
                TournamentEventReservation.slot_end,
                TournamentEventReservationTable.table_id,
            )
            # "My reservation is my own event's reservation" — the same leg
            # ``TournamentEventGroupReservation`` itself foreign-keys on.
            .join(
                TournamentEventReservation,
                and_(
                    TournamentEventReservation.event_id
                    == TournamentEventGroupReservation.event_id,
                    TournamentEventReservation.id
                    == TournamentEventGroupReservation.reservation_id,
                ),
            )
            # LEFT: a reservation with zero tables reserved joins to no row here,
            # and its group's ``table_ids`` comes back the empty set below — the
            # ``ReservationHasNoTables`` state, not a miss.
            .outerjoin(
                TournamentEventReservationTable,
                and_(
                    TournamentEventReservationTable.event_id
                    == TournamentEventGroupReservation.event_id,
                    TournamentEventReservationTable.reservation_id
                    == TournamentEventGroupReservation.reservation_id,
                ),
            )
            .where(TournamentEventGroupReservation.group_id.in_(group_ids))
        )
    ).all()
    windows: dict[uuid.UUID, tuple[date, time, time, set[str]]] = {}
    for group_id, slot_date, slot_start, slot_end, table_id in rows:
        _, _, _, table_ids = windows.setdefault(
            group_id, (slot_date, slot_start, slot_end, set())
        )
        if table_id is not None:
            table_ids.add(table_id)
    return {
        group_id: _GroupReservationWindow(
            table_ids=frozenset(table_ids),
            slot_date=slot_date,
            slot_start=slot_start,
            slot_end=slot_end,
        )
        for group_id, (slot_date, slot_start, slot_end, table_ids) in windows.items()
    }


def _placement_flags(
    fixture: TournamentFixture,
    match_status: MatchStatus | None,
    event_timezone: str,
    event_slot: dict[str, Any],
    reservation_windows: Mapping[uuid.UUID, _GroupReservationWindow],
) -> tuple[bool | None, bool | None]:
    """The two ADR-0790 read-flags for one fixture (#1537) — see
    ``TournamentFixtureRead``'s own docstring for the field-level contract this
    implements.

    ``None`` (never ``false``) is "not applicable": a fixture whose linked match is
    decided (``_DECIDED_MATCH_STATUSES`` — ADR-0790's write-side placement freeze,
    the placement is history) is never flagged on either axis, and each flag is
    independently ``None`` when its own half of the placement (``table_id`` /
    ``scheduled_start``) is unset — a half-placement can still flag its OTHER half.

    Judged against the fixture's group's **mapped** reservation
    (``reservation_windows``, see :func:`_reservation_windows_by_group`) when one
    exists, the event-wide reservation otherwise. ``reservation_windows`` is total
    over "has a mapped reservation" (that function's own docstring: a missing group
    means "no reservation"), so ``resolved is None`` **is** the same branch
    ``app.schedule_solves.restricting_reservation_key`` decides — its body reduces to
    exactly this same "does ``group_id`` have an entry" test (#1484: a stored
    fixture's ``group_id`` is NOT NULL, so its own separate ``group_id is None`` arm
    never fires here either way). Calling it would add an import and a round-trip
    through a single-entry map built to ask a question this function already holds
    the direct fact for.

    The event-wide **table** check is provably always satisfied, so it costs no
    lookup at all: a placement's ``table_id`` is a real foreign key (ADR 20260801)
    that every writer of it — the placement route
    (``app.tournament_placement._enforce_table_exists``), the solver's apply
    (``app.schedule_solves``), and the removed-table unplace path
    (``app.tournament_tables``) — only ever sets to a table of the fixture's OWN
    tournament, or clears to ``None``. The event-wide reservation's own table set
    IS that tournament's whole catalogue (ADR 20260807), so a placed table is
    always a member of it by construction. There is no live drift on this axis the
    way there is on the event's own *window* (``event_slot``), which a director may
    freely re-edit after the cut (``app.tournament_events``) — only the window
    check is a real lookup in the event-wide branch.

    The window is judged a **closed interval**, a start landing exactly on either
    edge counting as *inside* — see ``TournamentFixtureRead``'s own
    ``start_outside_reservation_window`` docstring for the rule and its rationale
    (a deliberate booking-semantics choice, deliberately divergent from
    ``app.scheduling``'s solver-grid ``Window``, which is a different, half-open
    thing for a different purpose).

    ``event_slot`` is raw ``TournamentEvent.slot`` JSONB, read through the SAME
    "no environment holds a malformed row today, but a read boundary should not
    depend on that staying true" contract ``TournamentEventRead.slot`` and
    :class:`~app.tournament_events._stored_event_window` state explicitly for this
    identical column — so a value that fails to parse degrades the window flag to
    ``None`` (unjudgeable) rather than 500ing the whole read. This risk is
    EVENT-WIDE-branch only: the mapped-reservation branch builds its ``Slot`` from
    typed ``date``/``time`` DB columns (:class:`_GroupReservationWindow`), which
    cannot fail to format.
    """
    if match_status in _DECIDED_MATCH_STATUSES:
        return None, None

    # Imported lazily: ``app.schedule_solves`` imports ``stage_ids_for_events`` from
    # THIS module at its top, so a module-level import here would be a cycle. By
    # request time both modules are already fully loaded, so this costs a
    # sys.modules lookup, not a fresh import.
    from app.schedule_solves import _slot_bounds

    resolved = reservation_windows.get(fixture.group_id)

    if resolved is not None:
        table_off_reservation = (
            None
            if fixture.table_id is None
            else fixture.table_id not in resolved.table_ids
        )
        slot: Slot | None = Slot(
            date=resolved.slot_date.isoformat(),
            start=resolved.slot_start.strftime("%H:%M"),
            end=resolved.slot_end.strftime("%H:%M"),
        )
    else:
        # Event-wide (ADR 20260807): no mapped reservation, so the fixture is
        # judged against the event's own window and the tournament's whole
        # catalogue. The table half is always satisfied — see the docstring
        # above — only the window can actually drift.
        table_off_reservation = None if fixture.table_id is None else False
        try:
            slot = Slot.model_validate(event_slot)
        except ValidationError:
            # See the docstring above: a legacy-shaped row means this axis
            # cannot be judged, not a 500 out of a flag whose whole job is to
            # inform.
            slot = None

    start_outside_window = None
    if fixture.scheduled_start is not None and slot is not None:
        window_bounds: tuple[datetime, datetime] | None
        try:
            window_bounds = _slot_bounds(slot, ZoneInfo(event_timezone))
        except ValueError:
            # `Slot.model_validate` above only checks SHAPE (three strings); a
            # value that parses as a `Slot` can still fail `_slot_bounds`'
            # `strptime` if its strings aren't real dates/times — same
            # unjudgeable-window contract as the `ValidationError` case.
            window_bounds = None
        if window_bounds is not None:
            window_start, window_end = window_bounds
            # Closed interval — see the docstring above for the rule and why
            # it does not (and need not) mirror the solver's own half-open
            # grid window.
            start_outside_window = not (
                window_start <= fixture.scheduled_start <= window_end
            )

    return table_off_reservation, start_outside_window


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
    db: AsyncSession, league_id: uuid.UUID, user_id: uuid.UUID | ScalarSelect[uuid.UUID]
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
    db: AsyncSession,
    league_ids: Sequence[uuid.UUID],
    user_id: uuid.UUID | ScalarSelect[uuid.UUID],
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


async def creator_username(db: AsyncSession, tournament: Tournament) -> str:
    """Resolve historical authorship independently of current ownership."""
    return (
        await db.execute(
            select(Account.username).where(Account.id == tournament.created_by_user_id)
        )
    ).scalar_one()
