"""The batched reads behind the tournament LIST and DETAIL surfaces.

The HTTP ``GET /v1/tournaments`` list and the MCP ``list_my_tournaments`` tool
return the *same* full aggregate — every tournament with all of its events, their
entrants and their draws — and differ only in **which tournaments** they select:
the HTTP list is VISIBILITY-scoped (``visible_to``), the MCP tool is OWNER-scoped
(``created_by_user_id == caller``). So the query shape lives here, once, taking a
WHERE predicate, and both surfaces call it — a second copy of this five-statement
batched read would be the N+1 waiting to happen that the statement-count
tripwires in ``tests/test_tournaments.py`` exist to catch.

The single-tournament DETAIL read (:func:`tournament_detail`) lives here for the
same reason: the HTTP ``GET /v1/tournaments/{id}`` route and the MCP
``get_tournament`` tool composed the identical seven-statement batched read inline,
a hairline apart, and a second copy is the drift this module exists to prevent.

Both sit a layer above ``tournament_queries`` (pure data access) because they also
compose the shared ``serialize_detail`` serializer; keeping them out of
``tournament_queries`` keeps that module import-free of the serializer.
"""

import math
import uuid

from pydantic import BaseModel, ConfigDict
from sqlalchemy import ColumnElement, Float, and_, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Tournament, TournamentEvent, User
from app.schedule_solves import latest_solve
from app.schemas.tournament import TournamentDetailRead
from app.tournament_queries import (
    active_entrants_by_event,
    completed_match_ids,
    draw_type_catalogue,
    entrant_rating,
    entrant_ratings_by_league,
    fixtures_by_event,
    game_counts_by_match,
)
from app.tournament_serialization import serialize_detail

# The Earth's mean radius in miles — the constant the haversine is scaled by, and the
# unit the ADR fixes (``radius_miles`` in, ``distance_miles`` out): "Distance is a
# haversine expression, not PostGIS ... it keeps the Postgres image unchanged".
_EARTH_RADIUS_MILES = 3958.8

# Miles per degree of latitude (``EARTH_RADIUS * pi / 180`` ≈ 69.09). Deliberately
# rounded *down* to 69.0: the bounding-box prefilter must be a SUPERSET of the true
# radius (the haversine ``WHERE`` below is what actually decides membership), and a
# smaller miles-per-degree makes the degree window it computes slightly *wider* — so
# the box can never exclude a venue the haversine would have kept.
_MILES_PER_DEGREE_LAT = 69.0


class NearMeFilter(BaseModel):
    """A parsed, all-three-present "near me" location filter for the tournament list.

    The HTTP list endpoint's ``lat``/``lng``/``radius_miles`` query triple, once it has
    passed the all-or-nothing boundary check (a partial triple is a 422, ADR "Distance
    is a haversine expression"). Its presence is what switches the list from "every
    visible tournament, ``distance_miles`` null" to "only those within ``radius_miles``
    of ``(lat, lng)``, each carrying its ``distance_miles``". The MCP list never
    constructs one, so its read is unaffected.
    """

    model_config = ConfigDict(frozen=True)

    lat: float
    lng: float
    radius_miles: float


def _venue_coordinate(key: str) -> ColumnElement[float]:
    """The venue's ``latitude``/``longitude`` lifted out of the ``address`` JSONB as a
    real ``float`` column, for the haversine and the bounding box to compute on.

    **The cast does meet a null, and that is the wanted behaviour.** A tournament may
    have no venue at all (CONTEXT.md, "Venue"), in which case ``address`` is SQL NULL,
    this expression is NULL, and every comparison against it is NULL — so the bounding
    box excludes the row and an address-less tournament is simply never a result of a
    proximity search. Nothing is defended against here because there is nothing to
    defend: the SQL degrades exactly the way the domain wants.

    What survives is the *inner* invariant: when an address IS present both keys are
    there and NOT NULL, geocoded server-side on every write, so there is no
    half-located venue whose latitude casts to NULL while its longitude does not. (This
    docstring used to assert the stronger "the cast never meets a null" — that was
    narrowed by the 2026-07-26 amendment to ADR "a venue's coordinates are geocoded
    server-side ... and are NOT NULL", which made ``tournaments.address`` nullable.)"""
    return cast(Tournament.address[key].astext, Float)


def _distance_miles_column(near: NearMeFilter) -> ColumnElement[float]:
    """The haversine great-circle distance, in miles, from ``near`` to each row's venue.

    Computed in SQL with stdlib-equivalent trig (``postgres`` ``radians``/``sin``/
    ``cos``/``asin``/``sqrt``) rather than PostGIS, which the stack does not ship
    (ADR "Distance is a haversine expression, not PostGIS"). The query point is a
    Python constant, so only the venue coordinates are columns."""
    venue_lat = _venue_coordinate("latitude")
    venue_lng = _venue_coordinate("longitude")
    d_lat = func.radians(venue_lat - near.lat)
    d_lng = func.radians(venue_lng - near.lng)
    sin_half_lat = func.sin(d_lat / 2)
    sin_half_lng = func.sin(d_lng / 2)
    a = (
        sin_half_lat * sin_half_lat
        + func.cos(func.radians(near.lat))
        * func.cos(func.radians(venue_lat))
        * sin_half_lng
        * sin_half_lng
    )
    return 2 * _EARTH_RADIUS_MILES * func.asin(func.sqrt(a))


def _bounding_box(near: NearMeFilter) -> ColumnElement[bool]:
    """A cheap lat/lng rectangle around ``near`` that contains its whole radius — the
    prefilter that runs before (and alongside) the haversine so the query can discard
    the far-away rows on plain range comparisons rather than trig on every row.

    The window half-widths are Python constants (the query point and radius are known
    off the wire), so the box is a pair of literal ``BETWEEN``s, not an expression over
    the row. It is deliberately a SUPERSET of the true circle — see
    ``_MILES_PER_DEGREE_LAT`` — so it never drops a venue the haversine would keep; the
    haversine ``<= radius`` is the exact membership test. Longitude degrees shrink with
    latitude (``cos``); near the poles ``cos`` collapses, so the longitude bound falls
    back to the whole ``[-180, 180]`` span rather than dividing by ~0."""
    lat_delta = near.radius_miles / _MILES_PER_DEGREE_LAT
    cos_lat = math.cos(math.radians(near.lat))
    if abs(cos_lat) < 1e-9:
        lng_delta = 360.0
    else:
        lng_delta = near.radius_miles / (_MILES_PER_DEGREE_LAT * cos_lat)
    venue_lat = _venue_coordinate("latitude")
    venue_lng = _venue_coordinate("longitude")
    return and_(
        venue_lat >= near.lat - lat_delta,
        venue_lat <= near.lat + lat_delta,
        venue_lng >= near.lng - lng_delta,
        venue_lng <= near.lng + lng_delta,
    )


async def list_tournament_details(
    db: AsyncSession,
    *,
    where: ColumnElement[bool],
    current_user_id: uuid.UUID,
    near_me: NearMeFilter | None = None,
) -> list[TournamentDetailRead]:
    """Every tournament matching ``where``, newest first, as the full
    ``TournamentDetailRead`` aggregate the list cards render.

    FIVE queries, no N+1, whatever the number of tournaments or events: the
    tournaments+usernames join (scoped by ``where``), then all their events, then
    all those events' active entrants in one batch, then all those events'
    fixtures in one batch (ADR-0786), then the caller's rating on every distinct
    league those tournaments run on (which every event's ``entry_state`` is judged
    against, ADR-0783). A per-event entry count, a per-event draw, or a
    per-tournament rating would be the N+1 this shape exists to avoid, and a
    statement-count tripwire in ``tests/test_tournaments.py`` fails if one comes
    back.

    ``where`` scopes the FIRST query, so the events and entrants queries are keyed
    off the surviving ids and cannot leak a hidden tournament's contents either.
    The HTTP list passes ``visible_to(caller)`` (a draft that is not the caller's
    is not theirs to see); the MCP ``list_my_tournaments`` tool passes
    ``Tournament.created_by_user_id == caller`` (owner-scoped). A predicate costs
    no extra statement, so the tripwire still reads the same count.

    ``current_user_id`` is the perspective the aggregate is projected from — the
    ``can_edit`` flag, the per-event ``entry_state``, and the ladder ``rating``.

    ``near_me`` is the HTTP list's optional "near me" filter (ADR "Distance is a
    haversine expression, not PostGIS"). When present, the FIRST query gains a WHERE —
    a cheap bounding-box prefilter plus the exact ``haversine <= radius_miles`` — so
    only tournaments within ``radius_miles`` of ``(lat, lng)`` survive, and each
    carries its computed ``distance_miles``. Both the predicate and the computed
    column ride on that one existing query, so the statement count is unchanged and
    the tripwire still reads five. When ``near_me`` is ``None`` (the unfiltered list,
    and the MCP owner-scoped list, which never passes it) the query, the row set and
    every ``distance_miles`` are exactly as before — the latter all null.
    """
    stmt = (
        select(Tournament, User.username)
        .join(User, User.id == Tournament.created_by_user_id)
        .where(where)
        .order_by(Tournament.created_at.desc())
    )
    distance_by_id: dict[uuid.UUID, float] = {}
    rows: list[tuple[Tournament, str]]
    if near_me is not None:
        # The distance column and the radius filter both ride on this ONE query — a
        # computed column and a WHERE predicate, not a per-row follow-up — so the
        # five-statement batched read stays five (the tripwire in test_tournaments.py).
        # The bounding box discards the far rows cheaply; the haversine is the exact
        # membership test and the number a card shows.
        distance = _distance_miles_column(near_me)
        stmt = stmt.add_columns(distance.label("distance_miles")).where(
            _bounding_box(near_me), distance <= near_me.radius_miles
        )
        rows = []
        for row in (await db.execute(stmt)).all():
            tournament, username, distance_miles = row[0], row[1], row[2]
            rows.append((tournament, username))
            # Round to one decimal — a card shows "12.3 mi away"; the raw float would
            # print a spurious-precision tail. Still a float, per the response schema.
            distance_by_id[tournament.id] = round(distance_miles, 1)
    else:
        rows = [(row[0], row[1]) for row in (await db.execute(stmt)).all()]
    tournament_ids = [tournament.id for tournament, _ in rows]
    events_by_tournament: dict[uuid.UUID, list[TournamentEvent]] = {
        tid: [] for tid in tournament_ids
    }
    events: list[TournamentEvent] = []
    if tournament_ids:
        events = list(
            (
                await db.execute(
                    select(TournamentEvent)
                    .where(TournamentEvent.tournament_id.in_(tournament_ids))
                    .order_by(TournamentEvent.created_at)
                )
            )
            .scalars()
            .all()
        )
        for event in events:
            events_by_tournament[event.tournament_id].append(event)
    event_ids = [e.id for e in events]
    entrants_by_event = await active_entrants_by_event(db, event_ids)
    # And ONE batch for every one of those events' fixtures — its draw (ADR-0786).
    # Batched for the same reason the entrants are: the list returns every event of
    # every tournament, so reading ``event.fixtures`` in the loop would be a SELECT
    # per event. Uncut draws come back as ``[]``, so an event nobody has cut a draw
    # for costs nothing and answers with an empty list rather than a null.
    event_fixtures = await fixtures_by_event(db, event_ids)
    # The list deliberately does NOT project standings: its cards render only event
    # and table counts, never a results table, so it skips the game-count query and
    # the per-event tabulation a results object would need (``game_counts=None``
    # below). Standings are a detail-BFF concern (ADR-0788); computing them here
    # would be work a page throws away — the same shape as #1051 for
    # fixtures/entrants.
    # ONE batch for the caller's ratings, keyed by league — deduplicated, because
    # every tournament on the default league shares the one number, and because the
    # ladders a page happens to list is not a reason to ask the same question twice.
    ratings = await entrant_ratings_by_league(
        db, list({tournament.league_id for tournament, _ in rows}), current_user_id
    )
    return [
        serialize_detail(
            tournament,
            created_by_username=username,
            current_user_id=current_user_id,
            events=events_by_tournament[tournament.id],
            entrants_by_event=entrants_by_event,
            fixtures_by_event=event_fixtures,
            game_counts=None,
            rating=ratings[tournament.league_id],
            # The list projects no solve strip, for the same reason it projects no
            # standings (``game_counts=None`` above): its cards never render one, so
            # it skips the ledger read rather than paying a query for a field every
            # card throws away. The solve strip is a detail-BFF concern.
            latest_schedule_solve=None,
            # No draw-type catalogue either, for the third time and the same reason: a
            # card has no event form, so the list does not pay a query to repeat one
            # global two-row catalogue on every tournament it returns. The picker is a
            # detail-BFF concern.
            draw_type_catalogue=None,
            # The near-me distance, or ``None`` when the list was not location-filtered
            # (``distance_by_id`` is empty then, so every card carries a null distance).
            distance_miles=distance_by_id.get(tournament.id),
        )
        for tournament, username in rows
    ]


async def tournament_detail(
    db: AsyncSession,
    tournament: Tournament,
    *,
    created_by_username: str,
    current_user_id: uuid.UUID,
) -> TournamentDetailRead:
    """The single-tournament DETAIL aggregate the tournament page renders, for an
    already-loaded, already-visibility-checked ``tournament``.

    The caller loads the row (scoping it by ``visible_to`` and answering the
    not-found itself, since the HTTP route and the MCP tool 404/refuse
    differently) and hands it in with its creator's ``created_by_username``; this
    reader runs the shared batched composition both surfaces used to run inline —
    SEVEN statements, no N+1 whatever the number of events, entrants, fixtures or
    solves:

    1. the tournament's events, in creation order;
    2. those events' active entrants (one batch);
    3. those events' fixtures — their draws (one batch, ADR-0786);
    4. the games of every **completed** match on the page — the standings' raw
       material (one batch; **no statement at all** until something is played, so an
       unplayed tournament costs six here, a played one seven);
    5. the caller's rating on the tournament's one league (ADR-0783);
    6. the newest row of the solve ledger (the Schedule tab's solve strip);
    7. the selectable draw formats (the event form's picker, ADR "a draw type is a
       seeded row, and the enum holds only what runs") — global reference data, so
       it is one flat read with nothing to key or batch.

    Then the shared ``serialize_detail`` projects it from ``current_user_id``'s
    perspective (``can_edit``, per-event ``entry_state``, ladder ``rating``). The
    statement-count is exactly the shape ``tests/test_tournaments.py`` pins for the
    HTTP route, because that route composes this reader; the MCP ``get_tournament``
    tool composes the *same* reader, so the two surfaces can never drift.
    """
    events = list(
        (
            await db.execute(
                select(TournamentEvent)
                .where(TournamentEvent.tournament_id == tournament.id)
                .order_by(TournamentEvent.created_at)
            )
        )
        .scalars()
        .all()
    )
    event_ids = [e.id for e in events]
    entrants_by_event = await active_entrants_by_event(db, event_ids)
    event_fixtures = await fixtures_by_event(db, event_ids)
    game_counts = await game_counts_by_match(db, completed_match_ids(event_fixtures))
    rating = await entrant_rating(db, tournament.league_id, current_user_id)
    latest_schedule_solve = await latest_solve(db, tournament.id)
    catalogue = await draw_type_catalogue(db)
    return serialize_detail(
        tournament,
        created_by_username=created_by_username,
        current_user_id=current_user_id,
        events=events,
        entrants_by_event=entrants_by_event,
        fixtures_by_event=event_fixtures,
        game_counts=game_counts,
        rating=rating,
        latest_schedule_solve=latest_schedule_solve,
        draw_type_catalogue=catalogue,
    )
