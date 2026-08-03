"""The dashboard's tournament panel (``DashboardResponse.tournaments``).

While a player is *in* a live tournament, that is the only thing on the dashboard
they care about, so it sits above everything else. This module projects it: for every
tournament with status ``live`` that the caller holds an **active entry** in, one
panel — a tab per event they entered, and inside each tab the one match to look at,
where they stand, and their remaining schedule.

Three rules shape everything below.

**Everything is stated from the caller's side.** A tournament fixture seats
``entry_a`` on side 1 and ``entry_b`` on side 2 (the fixed materialization convention,
#788), so "which side am I?" is answered by comparing the caller's entry id against
the fixture — never by walking the match's sides. Game scores, game counts and
win/loss are all flipped once, here, so no client has to know it was ever side-shaped.

**Standings come from the same projection the tournament page uses** (``event_results``,
ADR-0788) rather than a second count of the same matches. A player whose panel says
"2nd of 4" and whose event page says "3rd of 4" has been told two things, and the panel
is the one they will act on.

**A ``None`` is a fact.** ``position: None`` means the event has no standings to stand
in (no draw cut, or a draw type with no results strategy — only round-robin has one
today); ``match_id: None`` on a scheduled row means the fixture has not materialized;
``opponent_username: None`` means the other side is still TBD. None of them are missing
values to be filled in later, and none may be flattened to a zero or an empty string.
"""

import logging
import uuid
from collections import defaultdict
from collections.abc import Sequence
from datetime import date
from typing import assert_never

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.attention import list_attention_kind
from app.match_queries import current_game_number, match_eager_options
from app.models import (
    Match,
    MatchStatus,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentStatus,
)
from app.models.tournament import DrawType
from app.result_acceptance import side_win_counts
from app.schemas.dashboard import (
    DashboardTournament,
    DashboardTournamentEvent,
    DashboardTournamentFixtureRow,
    DashboardTournamentGame,
    DashboardTournamentMatch,
    TournamentFixtureState,
    TournamentMatchState,
)
from app.schemas.tournament import (
    Address,
    MatchSettings,
    StandingsResultsRead,
    StandingsThenFinishesResultsRead,
    TournamentEntrantRead,
    TournamentFixtureRead,
    TournamentTable,
)
from app.tournament_draws import event_pools
from app.tournament_queries import (
    active_entrants_by_event,
    completed_match_ids,
    fixtures_by_event,
    game_counts_by_match,
)
from app.tournament_serialization import event_results

log = logging.getLogger(__name__)


async def build_tournament_panels(
    db: AsyncSession, user_id: uuid.UUID
) -> list[DashboardTournament]:
    """Every live tournament ``user_id`` is playing in, newest tournament first.

    ``[]`` for the overwhelmingly common case — nobody is mid-tournament most days —
    and the dashboard renders no panel at all rather than an empty one.

    The whole projection is a fixed number of statements regardless of how many
    events or fixtures are involved: the entries in one, then the batched loaders the
    tournament-detail page already owns (entrants, fixtures, game counts) once each
    across every event, then one load of the handful of focus matches. Nothing here
    may become a query inside a loop — this runs on every dashboard load.
    """
    entries = await _my_live_entries(db, user_id)
    if not entries:
        return []
    events = [event for _, event, _ in entries]
    event_ids = [event.id for event in events]
    my_entry_id_by_event = {event.id: entry_id for entry_id, event, _ in entries}

    entrants = await active_entrants_by_event(db, event_ids)
    fixtures = await fixtures_by_event(db, event_ids)
    game_counts = await game_counts_by_match(db, completed_match_ids(fixtures))

    # The caller's own fixtures, in draw order, per event — the path list, and the
    # pool the focus match is chosen out of.
    my_fixtures = {
        event_id: [
            fixture
            for fixture in fixtures[event_id]
            if _my_side(fixture, my_entry_id_by_event[event_id]) is not None
        ]
        for event_id in event_ids
    }
    focus = {event_id: _focus_fixture(rows) for event_id, rows in my_fixtures.items()}
    focus_matches = await _load_matches(
        db,
        [
            fixture.match_id
            for fixture in focus.values()
            if fixture is not None and fixture.match_id is not None
        ],
    )

    by_tournament: dict[uuid.UUID, list[DashboardTournamentEvent]] = defaultdict(list)
    tournaments: dict[uuid.UUID, Tournament] = {}
    # The table catalogue is per-TOURNAMENT, so it is parsed once per tournament rather
    # than once per event — a caller entered in two events of one tournament (singles +
    # doubles) would otherwise re-decode the identical rows. Keyed by the id's *text*:
    # a fixture's ``table_id`` is still carried as a string ref (ADR 20260801 makes the
    # table a row; the foreign key on the placement is the step after).
    tables_by_tournament: dict[uuid.UUID, dict[str, TournamentTable]] = {}
    for entry_id, event, tournament in entries:
        tournaments[tournament.id] = tournament
        if tournament.id not in tables_by_tournament:
            tables_by_tournament[tournament.id] = {
                str(table.id): table
                for table in (
                    TournamentTable.model_validate(row) for row in tournament.tables
                )
            }
        by_tournament[tournament.id].append(
            _build_event(
                event,
                tables=tables_by_tournament[tournament.id],
                user_id=user_id,
                my_entry_id=entry_id,
                entrants=entrants[event.id],
                all_fixtures=fixtures[event.id],
                my_fixtures=my_fixtures[event.id],
                focus=focus[event.id],
                focus_matches=focus_matches,
                game_counts=game_counts,
            )
        )
    return [
        DashboardTournament(
            id=tournament_id,
            name=tournaments[tournament_id].name,
            subtitle=_subtitle(tournaments[tournament_id]),
            live_count=sum(1 for e in panel_events if e.is_live),
            events=panel_events,
        )
        for tournament_id, panel_events in by_tournament.items()
    ]


async def _my_live_entries(
    db: AsyncSession, user_id: uuid.UUID
) -> list[tuple[uuid.UUID, TournamentEvent, Tournament]]:
    """``(entry_id, event, tournament)`` for every ACTIVE entry this user holds in a
    LIVE tournament, newest tournament first then event creation order — the tab order
    the panel renders.

    ``live`` is the whole membership test. A ``published`` tournament has no draw being
    played yet and a ``archived`` one is over; neither is something to put at the top of
    a dashboard. Withdrawn entries are not entries (the soft-delete on
    ``TournamentEntry.status``), so a player who pulled out sees no panel."""
    rows = (
        await db.execute(
            select(TournamentEntry.id, TournamentEvent, Tournament)
            .join(TournamentEvent, TournamentEvent.id == TournamentEntry.event_id)
            .join(Tournament, Tournament.id == TournamentEvent.tournament_id)
            .where(
                TournamentEntry.user_id == user_id,
                TournamentEntry.status == TournamentEntryStatus.entered,
                Tournament.status == TournamentStatus.live,
            )
            .order_by(
                Tournament.created_at.desc(),
                TournamentEvent.created_at.asc(),
            )
        )
    ).all()
    return [(entry_id, event, tournament) for entry_id, event, tournament in rows]


async def _load_matches(
    db: AsyncSession, match_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, Match]:
    """The focus matches, keyed by id — at most one per event, so a bounded load.

    Fully eager-loaded because the card needs both the per-game scores and
    ``current_game_number`` (which reads settings, results and games), and a lazy load
    inside the per-event loop would be an N+1 on the dashboard's hot path."""
    if not match_ids:
        return {}
    rows = (
        (
            await db.execute(
                select(Match)
                .where(Match.id.in_(match_ids))
                .options(*match_eager_options())
            )
        )
        .scalars()
        .all()
    )
    return {match.id: match for match in rows}


def _my_side(fixture: TournamentFixtureRead, my_entry_id: uuid.UUID) -> int | None:
    """Which side of this fixture the caller is on — ``1`` for ``entry_a``, ``2`` for
    ``entry_b``, ``None`` when they are not in it at all.

    This is the whole "state it from the caller's side" mechanism, and it is the fixed
    materialization convention read backwards (#788): entry A seated side 1, entry B
    seated side 2, so the fixture answers the question without loading the match."""
    if fixture.entry_a_id == my_entry_id:
        return 1
    if fixture.entry_b_id == my_entry_id:
        return 2
    return None


def _focus_fixture(
    my_fixtures: Sequence[TournamentFixtureRead],
) -> TournamentFixtureRead | None:
    """The ONE fixture the card shows, out of the caller's own fixtures in this event.

    Priority is what the player is doing *right now*, in order: a match in progress,
    else the next one not yet played, else the last one finished. That order is the
    point of the panel — a player mid-match must never have to scroll past a result to
    find the game they are standing at a table for.

    Among the not-yet-played, the earliest in draw order wins (the list arrives in
    pool → round → position order, ADR-0786); among the finished, the latest. ``None``
    for an event whose draw has not been cut, which has no fixtures at all."""
    live = [f for f in my_fixtures if f.match_status is MatchStatus.in_progress]
    if live:
        return live[0]
    upcoming = [
        f
        for f in my_fixtures
        if f.match_status is None or f.match_status is MatchStatus.pending
    ]
    if upcoming:
        return upcoming[0]
    played = [f for f in my_fixtures if f.match_status is MatchStatus.completed]
    if played:
        return played[-1]
    return my_fixtures[-1] if my_fixtures else None


def _build_event(
    event: TournamentEvent,
    *,
    tables: dict[str, TournamentTable],
    user_id: uuid.UUID,
    my_entry_id: uuid.UUID,
    entrants: Sequence[TournamentEntrantRead],
    all_fixtures: list[TournamentFixtureRead],
    my_fixtures: Sequence[TournamentFixtureRead],
    focus: TournamentFixtureRead | None,
    focus_matches: dict[uuid.UUID, Match],
    game_counts: dict[uuid.UUID, tuple[int, int]],
) -> DashboardTournamentEvent:
    username_by_entry = {entrant.id: entrant.username for entrant in entrants}
    pools = {pool.id: pool for pool in event_pools(event)}
    settings = MatchSettings.model_validate(event.match_settings)
    # The draw type off the event's ``draw_settings`` row — its one home (ADR "an
    # event's draw configuration is a row, not a column"). Read once here and passed
    # down: the row rides along with the event on the panel's single entries query
    # (``lazy="joined"``), so the round and stage wording below costs no extra
    # statement per event on this endpoint's hot path.
    draw_type = event.draw_settings.draw_type

    results = event_results(
        event,
        fixtures=all_fixtures,
        game_counts=game_counts,
    )
    my_pool_id = next(
        (f.pool_id for f in my_fixtures if f.pool_id is not None),
        None,
    )
    my_standing = None
    field_size = 0
    pool_complete = False
    # The two shapes that carry a per-pool table with the caller's row in it: the
    # round-robin **standings**, and the pool stage of an rr-then-ko event's
    # **standings_then_finishes** (ADR 20260727 — the same ``PoolStandingsRead`` model,
    # which is why one branch reads both). A single-elim **finishes** block has no such
    # table, so it falls through to the fixture-counted record below.
    if isinstance(results, StandingsResultsRead | StandingsThenFinishesResultsRead):
        for pool_standings in results.pools:
            if my_pool_id is not None and pool_standings.pool_id != my_pool_id:
                continue
            for row in pool_standings.rows:
                if row.entry_id == my_entry_id:
                    my_standing = row
                    field_size = len(pool_standings.rows)
                    pool_complete = pool_standings.complete
                    break
            if my_standing is not None:
                break
    # What ``stage_label`` is judged on, and it is NOT always the pool's completeness.
    # For a round-robin the two coincide — the pool finishing IS the event finishing,
    # and "Group complete" is the right thing to say. For a two-stage event they come
    # apart badly: the caller's pool finishes early and the bracket it seeds them into
    # runs for hours afterwards, so reading the pool's flag would announce "Complete"
    # over an event still being played. The two-stage shape's own ``complete`` is both
    # stages decided (ADR 20260727) — the only honest answer this minimal label can
    # give.
    stage_complete = (
        results.complete
        if isinstance(results, StandingsThenFinishesResultsRead)
        else pool_complete
    )

    # The caller's own decided fixtures, counted directly — draw-type-agnostic, so it
    # stands in wherever there is no standings row to read (see the record below).
    record_wins, record_losses = 0, 0
    for fixture in my_fixtures:
        if fixture.match_status is not MatchStatus.completed:
            continue
        mine, theirs = _games_won(
            fixture,
            side=_my_side(fixture, my_entry_id),
            match=None,
            game_counts=game_counts,
        )
        if mine > theirs:
            record_wins += 1
        elif theirs > mine:
            record_losses += 1

    focus_match = (
        None
        if focus is None
        else _build_match(
            focus,
            user_id=user_id,
            my_entry_id=my_entry_id,
            username_by_entry=username_by_entry,
            match=(
                focus_matches.get(focus.match_id)
                if focus.match_id is not None
                else None
            ),
            best_of=settings.length_games,
            draw_type=draw_type,
            tables=tables,
            game_counts=game_counts,
        )
    )
    return DashboardTournamentEvent(
        id=event.id,
        name=event.name,
        draw_type=draw_type,
        is_live=any(f.match_status is MatchStatus.in_progress for f in my_fixtures),
        # Taken from the standings row when there IS one, so the record agrees with
        # the table it sits beside; counted from the caller's own decided fixtures
        # otherwise. The fallback is not decoration: a single-elim event's results are
        # a **finishes** block with no per-pool standings row (ADR-0785), and
        # ``event_results`` answers ``None`` for an event with no draw cut yet, so
        # hard-coding a zero here would show ``0–0`` to every player of a bracket event,
        # however many matches they had actually won — and nothing would catch it.
        wins=my_standing.wins if my_standing is not None else record_wins,
        losses=my_standing.losses if my_standing is not None else record_losses,
        position=my_standing.rank if my_standing is not None else None,
        field_size=field_size,
        stage_label=_stage_label(draw_type, complete=stage_complete),
        pool_label=(
            pools[my_pool_id].name
            if my_pool_id is not None and my_pool_id in pools
            else None
        ),
        match=focus_match,
        fixtures=[
            _build_fixture_row(
                fixture,
                ordinal=index + 1,
                my_entry_id=my_entry_id,
                username_by_entry=username_by_entry,
                tables=tables,
                game_counts=game_counts,
            )
            for index, fixture in enumerate(my_fixtures)
        ],
    )


def _opponent_username(
    fixture: TournamentFixtureRead,
    side: int | None,
    username_by_entry: dict[uuid.UUID, str],
) -> str | None:
    """Who the caller is playing in this fixture, or ``None`` when that side is still
    TBD.

    The entry ids on a fixture are just ids — the names live on the event's entrants
    list (a fixture deliberately carries no copy that could drift, ADR-0786) — so the
    join happens here, once, for both the card and the path row.
    """
    opponent_entry_id = fixture.entry_b_id if side == 1 else fixture.entry_a_id
    if opponent_entry_id is None:
        return None
    return username_by_entry.get(opponent_entry_id)


def _build_match(
    fixture: TournamentFixtureRead,
    *,
    user_id: uuid.UUID,
    my_entry_id: uuid.UUID,
    username_by_entry: dict[uuid.UUID, str],
    match: Match | None,
    best_of: int,
    draw_type: DrawType,
    tables: dict[str, TournamentTable],
    game_counts: dict[uuid.UUID, tuple[int, int]],
) -> DashboardTournamentMatch:
    side = _my_side(fixture, my_entry_id)
    state = _match_state(fixture.match_status)
    your_games, opponent_games = _games_won(
        fixture, side=side, match=match, game_counts=game_counts
    )
    return DashboardTournamentMatch(
        state=state,
        match_id=fixture.match_id,
        opponent_username=_opponent_username(fixture, side, username_by_entry),
        your_games=your_games,
        opponent_games=opponent_games,
        best_of=best_of,
        games=_games(match, side=side),
        round_label=_round_label(draw_type, fixture.pool_id, fixture.round),
        table_label=_table_label(fixture.table_id, tables),
        start_label=_time_label(fixture),
        next_game_number=(current_game_number(match) if match is not None else None),
        you_won=(None if state != "completed" else your_games > opponent_games),
        owed_action=(
            list_attention_kind(match, user_id) if match is not None else None
        ),
    )


def _build_fixture_row(
    fixture: TournamentFixtureRead,
    *,
    ordinal: int,
    my_entry_id: uuid.UUID,
    username_by_entry: dict[uuid.UUID, str],
    tables: dict[str, TournamentTable],
    game_counts: dict[uuid.UUID, tuple[int, int]],
) -> DashboardTournamentFixtureRow:
    side = _my_side(fixture, my_entry_id)
    state = _fixture_state(fixture.match_status)
    you_won: bool | None = None
    if state == "completed":
        your_games, opponent_games = _games_won(
            fixture, side=side, match=None, game_counts=game_counts
        )
        you_won = your_games > opponent_games
        detail = f"{'Won' if you_won else 'Lost'} {your_games}–{opponent_games}"
    elif state == "voided":
        # No score, and ``you_won`` stays ``None``: a voided match contributes
        # nothing (ADR-0013), so the row states the fact and derives no outcome.
        detail = "Voided"
    elif state == "live":
        detail = "In progress"
    else:
        parts = [
            part
            for part in (_time_label(fixture), _table_label(fixture.table_id, tables))
            if part
        ]
        detail = " · ".join(parts) if parts else "Not scheduled"
    return DashboardTournamentFixtureRow(
        label=f"M{ordinal}",
        opponent_username=_opponent_username(fixture, side, username_by_entry),
        state=state,
        detail=detail,
        you_won=you_won,
        match_id=fixture.match_id,
    )


def _games_won(
    fixture: TournamentFixtureRead,
    *,
    side: int | None,
    match: Match | None,
    game_counts: dict[uuid.UUID, tuple[int, int]],
) -> tuple[int, int]:
    """``(yours, theirs)`` games won, flipped onto the caller's side.

    A **completed** fixture reads the page's one batched game count, so the card and
    the standings beside it are the same number. A **live** one cannot — ``game_counts``
    is only loaded for completed matches (an in-progress board is not a result and must
    never reach a standings table, ADR-0788) — so it counts the loaded match's own
    scored games through ``side_win_counts``, the same helper the result-acceptance
    and recent-results paths count with. Counting it inline here instead would be a
    second implementation of "who won this game", and the two would drift the first
    time either is edited."""
    if match is not None and fixture.match_status is not MatchStatus.completed:
        counts = side_win_counts(match)
        side_1, side_2 = counts.get(1, 0), counts.get(2, 0)
    elif fixture.match_id is not None and fixture.match_id in game_counts:
        side_1, side_2 = game_counts[fixture.match_id]
    else:
        side_1, side_2 = 0, 0
    return (side_1, side_2) if side != 2 else (side_2, side_1)


def _games(match: Match | None, *, side: int | None) -> list[DashboardTournamentGame]:
    """The scored games of the focus match, in play order, points flipped onto the
    caller's side. Un-scored game rows are not games yet and are skipped."""
    if match is None:
        return []
    games = []
    for game in sorted(match.games, key=lambda g: g.game_number):
        if game.score is None:
            continue
        mine, theirs = game.score.side_1_points, game.score.side_2_points
        if side == 2:
            mine, theirs = theirs, mine
        games.append(
            DashboardTournamentGame(
                number=game.game_number, your_points=mine, opponent_points=theirs
            )
        )
    return games


def _match_state(status: MatchStatus | None) -> TournamentMatchState:
    """A fixture's match status as the card's state.

    ``None`` (not materialized) and ``pending`` are both ``scheduled`` — from the
    player's chair they are the same thing: a match they have not started.

    ``voided`` is its OWN state, not a flavour of ``completed``. A voided match has no
    winner (``app.match_voiding``: "any surface that derives a result must see *no
    winner*, not a stale W/L"), and it is not true that it carries no games — an
    account-merge self-play collision (ADR-0013) voids a match that may have been
    played out in full. Folded into ``completed``, the card would read the void's
    empty game count as a 0–0 board and announce a loss the player never took."""
    match status:
        case None | MatchStatus.pending:
            return "scheduled"
        case MatchStatus.in_progress:
            return "live"
        case MatchStatus.completed:
            return "completed"
        case MatchStatus.voided:
            return "voided"
        case _:
            assert_never(status)


def _fixture_state(status: MatchStatus | None) -> TournamentFixtureState:
    """The same four-way split as ``_match_state``, in the path list's vocabulary —
    ``voided`` kept separate for the same reason (see it)."""
    match status:
        case None | MatchStatus.pending:
            return "upcoming"
        case MatchStatus.in_progress:
            return "live"
        case MatchStatus.completed:
            return "completed"
        case MatchStatus.voided:
            return "voided"
        case _:
            assert_never(status)


def _round_label(draw_type: DrawType, pool_id: str | None, round_number: int) -> str:
    """A round number in its draw type's own vocabulary, composed here so no client
    maps an integer to a word.

    It takes the fixture's ``pool_id`` because for a two-stage draw the vocabulary is a
    property of the **stage**, not of the event: ``pool_id IS NULL`` is already how the
    knockout stage is spelled everywhere else (ADR-0786), so there is nothing new to
    carry — the discriminator is on the row. The one-stage draw types ignore it; their
    fixtures are all pooled or all un-pooled anyway.

    An exhaustive ``match`` with no catch-all: a new ``DrawType`` is a type error until
    it says what it calls a round (api/CLAUDE.md)."""
    match draw_type:
        case DrawType.round_robin:
            return f"Group match {round_number}"
        case DrawType.single_elim:
            # A neutral ordinal rather than a bracket word ("Quarter-final"), which
            # cannot be composed from the round number alone — it needs the bracket's
            # depth, which this helper is not given.
            return f"Round {round_number}"
        case DrawType.rr_then_ko:
            # Both existing vocabularies, verbatim, chosen by the stage the fixture is
            # in (ADR 20260727). Inventing a third — "Group match 3" becoming "Pool
            # match 3" because the event also has a bracket — would make the same match
            # read differently in two events for no reason a player could name.
            return (
                f"Group match {round_number}"
                if pool_id is not None
                else f"Round {round_number}"
            )
        case _:
            assert_never(draw_type)


def _stage_label(draw_type: DrawType, *, complete: bool) -> str:
    match draw_type:
        case DrawType.round_robin:
            return "Group complete" if complete else "Group play"
        case DrawType.single_elim:
            return "Complete" if complete else "In play"
        case DrawType.rr_then_ko:
            # Deliberately minimal, and deliberately not the round-robin wording:
            # "Group complete" on a two-stage event would announce the event over while
            # its knockout stage is still being played. Naming *which* stage is live
            # needs more plumbing than this ticket buys (ADR 20260727), so the label
            # says only whether the event has finished.
            return "Complete" if complete else "In play"
        case _:
            assert_never(draw_type)


def _table_label(
    table_id: str | None, tables: dict[str, TournamentTable]
) -> str | None:
    """The placement's table label, or ``None`` when the fixture is unplaced.

    A ``table_id`` that names nothing in the catalogue also answers ``None`` rather
    than echoing the raw id: a string ref is not a label, and printing one would put an
    opaque slug where a player expects "Table 4"."""
    if table_id is None:
        return None
    table = tables.get(table_id)
    return table.label if table is not None else None


def _time_label(fixture: TournamentFixtureRead) -> str | None:
    """The fixture's start as one display string in the venue's timezone (e.g.
    ``"4:30 PM CDT"``), already rendered server-side — clients do no timezone math (ADR
    "tournament times are timezone-aware instants").

    The **pinned** time wins over the predicted one when there is one: a pinned
    placement is a promise the players were notified of, and a panel that showed the
    solver's newer estimate instead would contradict the call they were sent."""
    time = fixture.pinned_at or fixture.scheduled_start
    if time is None:
        return None
    return f"{time.local_label} {time.tz_abbrev}"


def _subtitle(tournament: Tournament) -> str:
    """The panel's second line: the venue and the dates, e.g.
    ``"Riverside TTC · Jul 24–25"``.

    Composed here rather than on the client because it is three optional facts folded
    into one sentence, and every client that folded them itself would fold them
    slightly differently.

    Every part is optional, including the venue (:func:`_venue`), so this degrades all
    the way down: a dated tournament with no venue is ``"Jul 24–25"``, and one with
    neither is the empty string."""
    parts = [part for part in (_venue(tournament), _date_range(tournament)) if part]
    return " · ".join(parts)


def _venue(tournament: Tournament) -> str | None:
    """The venue's display name for the subtitle, or ``None`` when there is none to
    show.

    Two quite different situations answer ``None`` here, and only one of them is a
    problem — which is why they are separate branches rather than one ``try``.

    **No address is a normal, expected state.** A tournament may have no venue at all,
    at every status from draft to archived: announced before the room is booked, or
    deliberately withheld (CONTEXT.md, "Venue"; the 2026-07-26 amendment to ADR "a
    venue's coordinates are geocoded server-side ..."). Nothing is logged — it is a
    first-class state, not missing data, and a line per dashboard load would teach the
    reader to tune this logger out, which is exactly the attention the *other* branch
    needs.

    **An address that does not parse is data corruption**, and is logged at ERROR
    against the tournament id. It is contained rather than raised because the blast
    radius is wildly disproportionate: this runs while building ONE panel, but the
    exception escapes the whole ``GET /v1/dashboard`` — one bad venue string would deny
    the caller their matches, their rating chart and their notifications, panels with
    nothing to do with tournaments. Contained, that tournament shows its dates and the
    page renders.

    **The log line is what keeps containment from becoming silence.** A quiet fallback
    would swallow a serialization bug of *ours* just as happily as a corrupt row: were
    the nullable-address encoding subtly wrong somewhere, every dashboard would render
    no venue, all tests green, and nothing would say so.

    **This containment is deliberately NOT applied to the other readers**, and the
    asymmetry is the point rather than an oversight. ``TournamentRead`` validates the
    same column on the list and detail endpoints with no equivalent guard, so a corrupt
    row still fails those loudly. That is wanted: those endpoints are *about*
    tournaments, so failing on an unreadable tournament is on-topic, and
    ``.claude/rules/parse-at-boundaries.md`` asks a malformed value to fail at the edge
    rather than be quietly rendered as absent everywhere. What makes the dashboard
    different is not that its blast radius is bigger but that it is **off-topic**: it
    folds unrelated panels into one response, so a venue string can deny a caller their
    matches and their rating chart. Widening this to every reader would trade a loud,
    localized failure for silent partial data across the app — a different decision,
    with a different trade-off, not a tidy-up of this one."""
    stored = tournament.address
    if stored is None:
        return None
    try:
        return Address.model_validate(stored).venue
    except ValidationError:
        log.exception(
            "Tournament %s has an address that does not parse; its dashboard panel "
            "falls back to dates alone",
            tournament.id,
        )
        return None


def _date_range(tournament: Tournament) -> str | None:
    start, end = tournament.start_date, tournament.end_date
    if start is None:
        return None
    if end is None or end == start:
        return _short_date(start)
    if (start.year, start.month) == (end.year, end.month):
        return f"{_short_date(start)}–{end.day}"
    return f"{_short_date(start)}–{_short_date(end)}"


def _short_date(value: date) -> str:
    """``Jul 24`` — no leading zero on the day, matching the app's other date chips."""
    return f"{value.strftime('%b')} {value.day}"
