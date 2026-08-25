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
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime
from typing import assert_never

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.attention import list_attention_kind
from app.draws import group_label, seats_both_sides_at_cut
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
from app.models.draw_type import StageDrawType
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
    FixtureTimeRead,
    MatchSettings,
    StandingsResultsRead,
    StandingsThenFinishesResultsRead,
    SwissStandingsResultsRead,
    TournamentEntrantRead,
    TournamentFixtureRead,
    TournamentTable,
)
from app.tournament_draws import event_groups
from app.tournament_queries import (
    active_entrants_by_event,
    completed_match_ids,
    fixtures_by_event,
    game_counts_by_match,
)
from app.tournament_serialization import event_results

log = logging.getLogger(__name__)

# Sort key for a fixture with no effective time (:func:`_effective_fixture_time`) in
# :func:`_sorted_by_effective_time` — larger than any real instant, so untimed
# fixtures always sort after every timed one.
_UNTIMED_SORTS_LAST = datetime.max.replace(tzinfo=UTC)


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
    # Every stage id on this page mapped to that stage's OWN draw type (ADR 20260815)
    # — what ``_round_label`` and ``event_results`` read a fixture's ``stage_id``
    # against to tell an un-grouped block's vocabulary (bracket vs swiss rounds) apart,
    # in place of inferring it from the EVENT's overall draw type plus ``group_id IS
    # NULL``. Read off each event's eager (``lazy="selectin"``) stages collection —
    # already loaded with the entities above, so this costs the panel no statement of
    # its own.
    #
    # Flat, not nested by event id: a stage id is already globally unique (it is the
    # table's own surrogate key), so an ``{event_id: {stage_id: draw_type}}`` map
    # bought nothing a caller couldn't get by reading straight off the stage id it
    # already has in hand — every reader here (``_build_event``, ``_build_match``)
    # holds a fixture or a focus match, never an event, when it needs this.
    stage_draw_types: Mapping[uuid.UUID, StageDrawType] = {
        stage.id: stage.draw_type for event in events for stage in event.stages
    }

    # The caller's own fixtures, per event — the path list, and the group the focus
    # match is chosen out of. Sorted chronologically (#1297): a player reading the
    # path top-to-bottom must meet their matches in the order they are actually
    # played, not in draw order (group -> round -> position, ADR-0786), which can
    # and does run out of time order once fixtures are called onto real tables.
    my_fixtures = {
        event_id: _sorted_by_effective_time(
            [
                fixture
                for fixture in fixtures[event_id]
                if _my_side(fixture, my_entry_id_by_event[event_id]) is not None
            ]
        )
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
                stage_draw_types=stage_draw_types,
            )
        )
    # ONE batched aggregate for every tournament shown, however many that is — the
    # panel's own entries/events above are the caller's ENTERED events only (a
    # tournament's date range spans ALL of its events, #1511), so this cannot reuse
    # them and has to be its own query. Grouped by tournament id rather than one
    # query per tournament in the loop below, which the statement-count tripwire in
    # ``tests/test_dashboard_tournaments.py`` would catch.
    date_ranges = await _date_ranges(db, list(tournaments.keys()))
    return [
        DashboardTournament(
            id=tournament_id,
            name=tournaments[tournament_id].name,
            subtitle=_subtitle(
                tournaments[tournament_id], date_ranges.get(tournament_id)
            ),
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

    Among the not-yet-played, the earliest by effective time (``pinned_at or
    scheduled_start``) wins, untimed fixtures falling back to draw order (group ->
    round -> position, ADR-0786) among themselves — the same chronological ordering
    the path list itself now uses (#1297), so the focus match is always the top row
    of "Your matches". Among the finished, the latest by that same ordering. ``None``
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
    stage_draw_types: Mapping[uuid.UUID, StageDrawType],
) -> DashboardTournamentEvent:
    username_by_entry = {entrant.id: entrant.username for entrant in entrants}
    group_positions = {g.id: g.position for g in event_groups(event)}
    settings = MatchSettings.model_validate(event.match_settings)
    # The draw type off the event's ``draw_settings`` row — its one home (ADR "an
    # event's draw configuration is a row, not a column"). Read once here and passed
    # down: the row rides along with the event on the panel's single entries query
    # (``lazy="joined"``), so the round and stage wording below costs no extra
    # statement per event on this endpoint's hot path. ``stage_draw_types`` is the
    # per-fixture counterpart (ADR 20260815): ``draw_type`` names the event's overall
    # shape (what ``_stage_label`` and the results strategy read), ``stage_draw_types``
    # names each individual STAGE's own shape (what ``_round_label`` below reads, per
    # fixture, via ``stage_id``) — the two answer different questions and neither
    # substitutes for the other.
    draw_type = event.draw_settings.draw_type

    results = event_results(
        event,
        entrants=entrants,
        fixtures=all_fixtures,
        game_counts=game_counts,
        stage_draw_types=stage_draw_types,
    )
    # The caller's group — but only a **group stage's** group. Asked of the fixture's
    # own stage (:func:`~app.draws.seats_both_sides_at_cut`), never of whether it names
    # a group at all: every fixture names one now (#1484), and a bracket's / swiss
    # round's own group is not a group the player is "in" — a bracket has no standings
    # table to sit in and no group field to place in, so labelling the panel "Group A"
    # would name both. This one pick feeds both readers below (the standings row the
    # record is taken from, and the ``group_label`` rendered on the panel), so there is
    # exactly one place the rule lives.
    my_group_id = next(
        (
            f.group_id
            for f in my_fixtures
            if _seats_both_sides_at_cut(stage_draw_types, f.stage_id)
        ),
        None,
    )
    my_standing = None
    field_size = 0
    group_complete = False
    # The two shapes that carry a per-group table with the caller's row in it: the
    # round-robin **standings**, and the group stage of an rr-then-ko event's
    # **standings_then_finishes** (ADR 20260727 — the same ``GroupStandingsRead`` model,
    # which is why one branch reads both). A single-elim **finishes** block has no such
    # table, so it falls through to the fixture-counted record below.
    if isinstance(results, StandingsResultsRead | StandingsThenFinishesResultsRead):
        for group_standings in results.groups:
            if my_group_id is not None and group_standings.group_id != my_group_id:
                continue
            for row in group_standings.rows:
                if row.entry_id == my_entry_id:
                    my_standing = row
                    field_size = len(group_standings.rows)
                    group_complete = group_standings.complete
                    break
            if my_standing is not None:
                break
    elif isinstance(results, SwissStandingsResultsRead):
        # The third shape that carries the caller's row — swiss, which is GROUP-LESS
        # (ADR "swiss pre-cuts every round and pairs each one on advance"): one table
        # over the whole field, so there is no group to filter by and the field size is
        # that table's own length. Without this arm a swiss player's panel would show
        # no rank at all while the table holding their row rode along on the same
        # payload, and ``stage_complete`` below could never be true for them.
        for row in results.rows:
            if row.entry_id == my_entry_id:
                my_standing = row
                field_size = len(results.rows)
                break
    # What ``stage_label`` is judged on, and it is NOT always the group's completeness.
    # For a round-robin the two coincide — the group finishing IS the event finishing,
    # and "Group complete" is the right thing to say. For a two-stage event they come
    # apart badly: the caller's group finishes early and the bracket it seeds them into
    # runs for hours afterwards, so reading the group's flag would announce "Complete"
    # over an event still being played. The two-stage shape's own ``complete`` is both
    # stages decided (ADR 20260727) — the only honest answer this minimal label can
    # give.
    # Swiss joins the two-stage shape on the left of this: it has no group whose
    # completeness could stand in, and its own ``complete`` is every round decided —
    # which is exactly what "is this event over" means for a format that eliminates
    # nobody. Reading ``group_complete`` for it would leave the label stuck on "In play"
    # through the final round and past it.
    stage_complete = (
        results.complete
        if isinstance(
            results, StandingsThenFinishesResultsRead | SwissStandingsResultsRead
        )
        else group_complete
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
            # ``.get``, not ``[...]``: ``stage_draw_types`` and ``fixtures`` are two
            # separate loads a beat apart, so a stage a director's re-mint deleted
            # between them (an event's draw type changed, remint_stages_in_place,
            # ADR 20260815) can leave ``focus.stage_id`` naming a stage this map no
            # longer has. That is read skew on a background dashboard refresh, not a
            # broken invariant worth 500ing the whole panel over — ``_build_match``
            # degrades the one label that needs the vocabulary rather than raising.
            stage_draw_type=stage_draw_types.get(focus.stage_id),
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
        # a **finishes** block with no per-group standings row (ADR-0785), and
        # ``event_results`` answers ``None`` for an event with no draw cut yet, so
        # hard-coding a zero here would show ``0–0`` to every player of a bracket event,
        # however many matches they had actually won — and nothing would catch it.
        wins=my_standing.wins if my_standing is not None else record_wins,
        losses=my_standing.losses if my_standing is not None else record_losses,
        position=my_standing.rank if my_standing is not None else None,
        field_size=field_size,
        stage_label=_stage_label(draw_type, complete=stage_complete),
        group_label=(
            group_label(group_positions[my_group_id])
            if my_group_id is not None and my_group_id in group_positions
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
    stage_draw_type: StageDrawType | None,
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
        # ``round_label`` is NOT NULL on the wire (``DashboardTournamentMatch``), so a
        # missing stage draw type (the read-skew ``stage_draw_type`` is ``None`` for
        # — see the focus-match call site) degrades to a neutral ordinal rather than
        # omitting the field: still true (this IS round ``fixture.round``), just
        # without the draw type's own word for it.
        round_label=(
            _round_label(stage_draw_type, fixture.round)
            if stage_draw_type is not None
            else f"Round {fixture.round}"
        ),
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


def _round_label(stage_draw_type: StageDrawType, round_number: int) -> str:
    """A round number in its draw type's own vocabulary, composed here so no client
    maps an integer to a word.

    It takes the fixture's OWN STAGE's draw type (ADR 20260815), not the event's overall
    one, and no longer takes ``group_id`` at all. A two-stage event's vocabulary used to
    be chosen by ``group_id IS NULL`` standing in for "which stage is this" — the same
    two-fact inference (event draw type + un-grouped-ness) that once rendered a swiss
    draw's rounds as a knockout bracket, because both are un-grouped and
    indistinguishable that way. Every stage a fixture can actually belong to is one of
    the three single-stage kinds, so this needs nothing else to decide the word.

    An exhaustive ``match`` with no catch-all: ``stage_draw_type`` is
    :data:`~app.models.draw_type.StageDrawType`, not the full ``DrawType``, so a new
    stage-runnable draw type is a type error here until it says what it calls a round
    (api/CLAUDE.md) — and ``rr_then_ko`` needs no arm at all, below, because the type
    already says it cannot arrive."""
    match stage_draw_type:
        case DrawType.round_robin:
            return f"Group match {round_number}"
        case DrawType.single_elim:
            # A neutral ordinal rather than a bracket word ("Quarter-final"), which
            # cannot be composed from the round number alone — it needs the bracket's
            # depth, which this helper is not given.
            return f"Round {round_number}"
        case DrawType.swiss:
            # A swiss round IS the vocabulary — "round 3" is what a director and a
            # player both call it — and it needs none of the bracket's caveats, because
            # the number is not a distance from a final.
            return f"Round {round_number}"
        case _:
            assert_never(stage_draw_type)


def _seats_both_sides_at_cut(
    stage_draw_types: Mapping[uuid.UUID, StageDrawType], stage_id: uuid.UUID
) -> bool:
    """Whether this fixture's own stage seats both sides at the cut
    (:func:`~app.draws.seats_both_sides_at_cut`) — the panel's one question about a
    fixture's stage, asked through the map the caller already loaded.

    ``.get``, not ``[...]``, for the reason ``_build_event``'s focus match already
    states: ``stage_draw_types`` and the fixtures are two loads a beat apart, so a
    stage a director's re-mint deleted between them (ADR 20260815) leaves a fixture
    naming a stage this map no longer has. That is read skew on a background
    dashboard refresh, and the honest answer for a stage nobody can describe is
    "not a group stage".

    It is a local consistency, not a promise that the endpoint survives that skew:
    ``_build_event`` calls ``event_results`` fourteen lines above this pick, and for
    ``round_robin`` and ``rr_then_ko`` that path runs every fixture through
    ``app.tournament_serialization._stage_draw_type_of``, which raises on exactly the
    same missing stage id. So the skew already 500s before this ``.get`` is reached,
    wherever a group label was going to exist at all. What ``.get`` buys is that this
    pick is not a SECOND, differently-worded way to fail — the loud one lives at the
    seam that decided to be loud.
    """
    draw_type = stage_draw_types.get(stage_id)
    return draw_type is not None and seats_both_sides_at_cut(draw_type)


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
        case DrawType.swiss:
            # Not the round-robin wording: a swiss event has no group to complete, and
            # "Group complete" over a group-less field would name a stage it never had.
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


def _effective_fixture_time(fixture: TournamentFixtureRead) -> FixtureTimeRead | None:
    """The one time a fixture is judged by, everywhere the panel needs a single
    instant rather than the two raw columns: display (:func:`_time_label`) and the
    path list's chronological sort (:func:`_sorted_by_effective_time`).

    The **pinned** time wins over the predicted one when there is one: a pinned
    placement is a promise the players were notified of, and a panel that showed the
    solver's newer estimate instead would contradict the call they were sent. ``None``
    when the fixture carries neither — unplaced, or placed with no time yet."""
    return fixture.pinned_at or fixture.scheduled_start


def _time_label(fixture: TournamentFixtureRead) -> str | None:
    """The fixture's start as one display string in the venue's timezone (e.g.
    ``"4:30 PM CDT"``), already rendered server-side — clients do no timezone math (ADR
    "tournament times are timezone-aware instants")."""
    time = _effective_fixture_time(fixture)
    if time is None:
        return None
    return f"{time.local_label} {time.tz_abbrev}"


def _sorted_by_effective_time(
    fixtures: list[TournamentFixtureRead],
) -> list[TournamentFixtureRead]:
    """The caller's path list, ordered by :func:`_effective_fixture_time` ascending
    (#1297) rather than the draw order it arrives in.

    A player reading "Your matches" top-to-bottom must meet their matches in the
    order they are actually played — a fixture called for 9:00 AM has to outrank one
    called for noon regardless of which round or group it belongs to. Fixtures with no
    time at all (not yet placed) sort LAST, after every timed one, via a
    ``datetime.max`` sentinel key, and keep their relative draw order (group -> round
    -> position, ADR-0786) among themselves — :func:`sorted` is stable, so that
    fallback needs no extra code, only an equal sort key for every untimed fixture."""

    def key(fixture: TournamentFixtureRead) -> datetime:
        time = _effective_fixture_time(fixture)
        return time.instant if time is not None else _UNTIMED_SORTS_LAST

    return sorted(fixtures, key=key)


def _subtitle(tournament: Tournament, date_range: tuple[date, date] | None) -> str:
    """The panel's second line: the venue and the dates, e.g.
    ``"Riverside TTC · Jul 24–25"``.

    Composed here rather than on the client because it is three optional facts folded
    into one sentence, and every client that folded them itself would fold them
    slightly differently.

    ``date_range`` is the tournament's derived span (#1511) — the caller's own batched
    aggregate, since this tournament's row carries no dates of its own to read.

    Every part is optional, including the venue (:func:`_venue`), so this degrades all
    the way down: a dated tournament with no venue is ``"Jul 24–25"``, and one with
    neither is the empty string."""
    parts = [
        part for part in (_venue(tournament), _format_date_range(date_range)) if part
    ]
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


def _format_date_range(date_range: tuple[date, date] | None) -> str | None:
    """``date_range`` rendered as the subtitle's date segment, or ``None`` for an
    event-less tournament (#1511) — ``date_range`` is ``None`` in that case, and only
    that case, since :func:`_date_ranges` is a min/max over a tournament's events."""
    if date_range is None:
        return None
    start, end = date_range
    if end == start:
        return _short_date(start)
    if (start.year, start.month) == (end.year, end.month):
        return f"{_short_date(start)}–{end.day}"
    return f"{_short_date(start)}–{_short_date(end)}"


async def _date_ranges(
    db: AsyncSession, tournament_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, tuple[date, date]]:
    """Every one of ``tournament_ids``' derived date spans (#1511), in ONE statement
    regardless of how many tournaments are asked for — the panel's own entries/events
    are the caller's ENTERED events only, so they cannot stand in for "every event of
    this tournament" the way the tournament-detail page's own event list can
    (``app.tournament_serialization._events_date_range``); this is the panel's own
    batched read of every SHOWN tournament's full event set.

    A tournament with no events at all is simply absent from the returned dict — the
    caller reads that as ``None`` via ``.get(tournament_id)``, matching
    :func:`_format_date_range`'s reading of ``None``.

    Reduced to a min/max in PYTHON, per tournament, rather than asked of Postgres as
    ``MIN``/``MAX(slot->>'date')`` grouped by tournament id. Both read the same rows,
    but only the Python reduction can apply the SAME per-row exclusion
    ``app.tournament_serialization._events_date_range`` does: a stored ``slot.date``
    that a legacy or hand-written row holds and ``date.fromisoformat`` refuses is
    dropped and logged ONE EVENT AT A TIME, so the tournament's range still comes
    from whichever of its other events parse. A SQL aggregate cannot do that —
    comparing ``slot->>'date'`` as TEXT means one garbled value can become the
    ``MIN`` or the ``MAX`` outright (an empty string sorts before every real date;
    most letters sort after), which would silently drop the WHOLE tournament's range
    over the one bad row rather than just that row — and whether it does depends on
    where the garbage happens to sort, not on whether it parses."""
    if not tournament_ids:
        return {}
    rows = (
        await db.execute(
            select(
                TournamentEvent.id,
                TournamentEvent.tournament_id,
                TournamentEvent.slot["date"].astext,
            ).where(TournamentEvent.tournament_id.in_(tournament_ids))
        )
    ).all()
    dates_by_tournament: dict[uuid.UUID, list[date]] = defaultdict(list)
    for event_id, tournament_id, raw in rows:
        # Parsed BEFORE the defaultdict is touched: `dict[key].append(...)` would
        # evaluate the subscript first, planting an EMPTY list for a tournament
        # whose every event fails to parse — the closing `min()`/`max()` below
        # would then 500 on that empty list instead of leaving the tournament
        # absent, exactly the "only event has an unparseable date" corner the
        # Implementation Notes named as unreachable through the write boundary
        # but real once a row is corrupted directly.
        try:
            parsed = date.fromisoformat(raw)
        except (TypeError, ValueError):
            log.error(
                "Tournament event %s has a slot.date that does not parse (%r); "
                "excluded from tournament %s's dashboard date range",
                event_id,
                raw,
                tournament_id,
            )
            continue
        dates_by_tournament[tournament_id].append(parsed)
    return {
        tournament_id: (min(dates), max(dates))
        for tournament_id, dates in dates_by_tournament.items()
    }


def _short_date(value: date) -> str:
    """``Jul 24`` — no leading zero on the day, matching the app's other date chips."""
    return f"{value.strftime('%b')} {value.day}"
