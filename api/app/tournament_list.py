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
``get_tournament`` tool composed the identical six-statement batched read inline,
a hairline apart, and a second copy is the drift this module exists to prevent.

Both sit a layer above ``tournament_queries`` (pure data access) because they also
compose the shared ``serialize_detail`` serializer; keeping them out of
``tournament_queries`` keeps that module import-free of the serializer.
"""

import uuid

from sqlalchemy import ColumnElement, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Tournament, TournamentEvent, User
from app.schedule_solves import latest_solve
from app.schemas.tournament import TournamentDetailRead
from app.tournament_queries import (
    active_entrants_by_event,
    completed_match_ids,
    entrant_rating,
    entrant_ratings_by_league,
    fixtures_by_event,
    game_counts_by_match,
)
from app.tournament_serialization import serialize_detail


async def list_tournament_details(
    db: AsyncSession,
    *,
    where: ColumnElement[bool],
    current_user_id: uuid.UUID,
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
    """
    rows = (
        await db.execute(
            select(Tournament, User.username)
            .join(User, User.id == Tournament.created_by_user_id)
            .where(where)
            .order_by(Tournament.created_at.desc())
        )
    ).all()
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
    SIX statements, no N+1 whatever the number of events, entrants, fixtures or
    solves:

    1. the tournament's events, in creation order;
    2. those events' active entrants (one batch);
    3. those events' fixtures — their draws (one batch, ADR-0786);
    4. the games of every **completed** match on the page — the standings' raw
       material (one batch; **no statement at all** until something is played, so an
       unplayed tournament costs five here, a played one six);
    5. the caller's rating on the tournament's one league (ADR-0783);
    6. the newest row of the solve ledger (the Schedule tab's solve strip).

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
    )
