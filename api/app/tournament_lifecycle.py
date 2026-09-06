"""The transport-neutral tournament-lifecycle write verbs.

The orchestration behind ``POST /v1/tournaments`` (create),
``DELETE /v1/tournaments/{id}`` (delete), and
``POST /v1/tournaments/{id}/transitions`` (move along the lifecycle — publish / go
live / archive), extracted out of the router so each can run without FastAPI: from
the HTTP adapters (``app.tournaments.create_tournament`` /
``app.tournaments.delete_tournament`` /
``app.tournaments.create_tournament_transition``)
and from the MCP ``create_tournament`` / ``delete_tournament`` /
``transition_tournament`` tools alike, and be constructed in a plain REPL with a raw
session.

Per the tournament-verbs ADR (mirroring ``tournament_edit``), each verb signals
every refusal with a **domain exception** from ``app.tournament_errors`` — never
an ``HTTPException`` — and each adapter maps it back to the exact response it
produced before. In particular the league resolution does NOT reuse
``resolve_league`` (``app.leagues``), which raises an ``HTTPException`` a
FastAPI-free verb must not let escape: it resolves through the FastAPI-free
``_load_league`` / ``get_default_league`` and raises :class:`LeagueNotFoundError`
on a named-but-missing id and :class:`NoDefaultLeagueError` when no default league
is configured — the transport-neutral equivalents of that resolver's strict 404
and its 500.
"""

import uuid
from typing import assert_never

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.draws import DrawError, NonSinglesDraw, draw_error_detail, order_entrants
from app.geocoding import Geocoder
from app.leagues import _load_league, get_default_league
from app.models import (
    EventFormat,
    League,
    ScheduleSolveTrigger,
    Tournament,
    TournamentEvent,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.schedule_solves import request_solve
from app.schemas.tournament import TournamentCreate, named_list
from app.tournament_draw_settings import (
    draw_settings_ids_for_tournament,
    reap_draw_settings,
)
from app.tournament_draws import (
    DrawCurrency,
    active_draw_entrants_by_event,
    draw_config,
    draw_currency_by_event,
    strategy_for_event,
)
from app.tournament_edit import _load_owned_tournament_for_update
from app.tournament_errors import (
    IllegalTournamentTransitionError,
    LeagueNotFoundError,
    NoDefaultLeagueError,
    TournamentAlreadyInStatusError,
    TournamentNotReadyToGoLiveError,
)
from app.tournament_geocoding import geocode_address
from app.tournament_materialization import materialize_live_draw
from app.tournament_queries import stage_ids_for_tournament
from app.tournament_realtime import stage_tournament_entrant_hints
from app.tournament_retention import require_no_recorded_play
from app.tournament_tables import stored_tables

# The lifecycle runs forward only, and exactly three transitions exist (ADR-0017):
# ``draft`` → ``published`` (publish), ``published`` → ``live`` (go live), and
# ``live`` → ``archived`` (archive). Everything else — walking backwards, skipping a
# stage, moving out of the terminal ``archived``, and re-asserting the status a
# tournament already holds — is a conflict, judged by :func:`transition_tournament`
# against this table. It lives with the verb (not the router) so the one HTTP adapter
# and the one MCP tool judge the same edges.
LEGAL_TRANSITIONS: frozenset[tuple[TournamentStatus, TournamentStatus]] = frozenset(
    {
        (TournamentStatus.draft, TournamentStatus.published),
        (TournamentStatus.published, TournamentStatus.live),
        (TournamentStatus.live, TournamentStatus.archived),
    }
)


async def _resolve_league_strict(
    db: AsyncSession, league_id: uuid.UUID | None
) -> League:
    """Resolve the tournament's league the way the create route did — the STRICT
    resolution — but FastAPI-free.

    The transport-neutral twin of ``resolve_league`` (``app.leagues``), which raises
    an ``HTTPException`` this verb must not let escape. A named ``league_id`` that
    resolves to no league raises :class:`LeagueNotFoundError` (the strict 404 — a
    director's typo must not silently swap to the default, ADR-0783); an omitted
    ``league_id`` falls back to the default league, and a deployment with no default
    raises :class:`NoDefaultLeagueError` (the 500). NOT the degrading
    ``resolve_league_or_default``: a tournament's league is a persisted fact that
    decides who may enter, not a view-preference lens.
    """
    if league_id is not None:
        league = await _load_league(db, league_id)
        if league is None:
            raise LeagueNotFoundError()
        return league
    default = await get_default_league(db)
    if default is None:
        raise NoDefaultLeagueError()
    return default


async def create_tournament(
    db: AsyncSession,
    *,
    actor: User,
    payload: TournamentCreate,
    geocoder: Geocoder,
) -> Tournament:
    """Create a tournament owned by ``actor`` from ``payload``, and return the
    refreshed :class:`Tournament`.

    Runs the same orchestration the HTTP handler used to run inline:

    * The venue ``address`` is **geocoded on write** (:func:`geocode_address`, via the
      injected ``geocoder``): the client sends the six free-text components
      (:class:`~app.schemas.tournament.AddressInput`, no coordinates) and this verb
      persists the stored :class:`~app.schemas.tournament.Address` that carries the
      resolved ``latitude`` / ``longitude`` (the ADR's narrowed invariant: an address,
      *when present*, has NOT NULL coordinates). An unresolvable address raises
      :class:`~app.geocoding.AddressNotGeocodableError` **before** anything is written,
      so a write that cannot produce coordinates commits nothing; the caller maps it to
      a coded ``409`` (:data:`~app.tournament_geocoding.ADDRESS_NOT_GEOCODABLE_CODE`).
    * The ``address`` is **optional**: omitted — or sent with all six components blank,
      which :data:`~app.schemas.tournament.SubmittedAddress` normalizes to ``None`` at
      the boundary — creates a tournament with **no venue**, storing SQL ``NULL`` and
      **never calling the geocoder** (#1206). Announcing before the venue is booked, and
      a private tournament that withholds its address, are both ordinary; requiring one
      here made them impossible through every write path. The geocode is skipped rather
      than attempted-and-forgiven precisely because a blank address composes to ``""``,
      which resolves to zero candidates — an organizer with no venue would otherwise be
      told their nonexistent venue could not be found.
    * The ``address`` value-object persists as plain JSONB; the dict ``model_dump``
      produces doesn't propagate beyond this write boundary. The ``table_catalogue``
      does **not**: it becomes ``tournament_tables`` rows (ADR 20260801), each carrying
      a server-minted UUID id and the ``position`` of its place in the submitted list.
    * **No** ``status`` is set: it isn't on the create schema (ADR-0017), so a
      tournament is born ``draft`` from the column's server default — one source for
      the starting status — and the ``refresh`` below reads it back.
    * The league is resolved STRICTLY (:func:`_resolve_league_strict`): an omitted
      ``league_id`` binds the default league (the column is NOT NULL — a tournament
      must name the ladder its eligibility is judged on, ADR-0783), a named id that
      resolves to no league raises :class:`LeagueNotFoundError`, and a missing
      default raises :class:`NoDefaultLeagueError`.

    Commits and refreshes before returning. Never raises ``HTTPException`` — the
    caller adapts each domain exception (league misses, an unresolvable address) to its
    transport.
    """
    league = await _resolve_league_strict(db, payload.league_id)
    # Geocode before constructing the row, so an unresolvable address fails at the edge
    # and never reaches ``db.add``/``commit`` — the write is atomic (writes nothing).
    #
    # ``payload.address`` is ``None`` when the caller sent no venue, or sent one whose
    # six components were all blank (``SubmittedAddress`` normalizes that at the
    # boundary). There is nothing to geocode then, and the column stores SQL ``NULL`` —
    # the single representation of "this tournament has no venue" (#1206).
    address = (
        await geocode_address(geocoder, payload.address)
        if payload.address is not None
        else None
    )
    tournament = Tournament(
        name=payload.name,
        description=payload.description,
        address=address.model_dump() if address is not None else None,
        # The catalogue is child ROWS now (ADR 20260801), not a JSONB column, and the
        # ids on them are the database's — ``stored_tables`` sets no id, only the
        # ``position`` each table's index in the submitted list gives it.
        tables=stored_tables(payload.table_catalogue),
        league_id=league.id,
        created_by_user_id=actor.id,
    )
    db.add(tournament)
    await db.commit()
    await db.refresh(tournament)
    return tournament


async def delete_tournament(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    actor: User,
) -> None:
    """Delete the tournament ``actor`` owns.

    Loads through the shared :func:`_load_owned_tournament_for_update` (the tournament
    row lock, then the owner gate) so the refusals are judged in the order the delete
    route kept — the 404 before the 403, so a caller who is not the owner never learns
    whether an absent id existed:

    * **404** — an absent tournament id raises :class:`TournamentNotFoundError`.
    * **403** — a caller who is not the tournament's creator raises
      :class:`NotTournamentOwnerError`. Tournament mutations are owner-gated
      (``created_by_user_id == actor.id``), not RBAC-gated.

    Issues the ``DELETE`` and commits it. Never raises ``HTTPException`` — the caller
    adapts each domain exception to its transport.

    The delete also reaps the events' draw-settings rows, which nothing else would.
    ``tournament_events.tournament_id`` is ``ON DELETE CASCADE``, so the events go
    with the tournament in one statement — but a *database* cascade does not run the
    ORM's ``TournamentEvent.draw_settings`` ``delete-orphan``, and the settings rows
    have no ``tournament_id`` of their own to cascade along. So their ids are read
    off the events **before** the delete (afterwards nothing names them), and only
    then are the now-unreferenced rows removed — in that order, because the event's
    FK is ``ON DELETE RESTRICT`` and would refuse the reverse.

    The explicit ``flush`` is belt-and-braces, not the mechanism: ``reap_draw_settings``
    issues an ORM-enabled ``delete()``, so ``Session.execute`` would autoflush the
    pending tournament delete ahead of it anyway. It is spelled out so the ordering
    survives a session with autoflush disabled — and, measured, removing it alone
    leaves the suite green, so nothing here would catch its loss.

    It also **unplaces every fixture first**, and that one IS the mechanism. A
    fixture's ``table_id`` is a foreign key with ``ON DELETE RESTRICT`` (ADR 20260801),
    ``Tournament.tables`` is loaded, so SQLAlchemy issues the child ``DELETE`` of
    ``tournament_tables`` **itself** — as its own statement, ahead of the
    ``tournaments`` row whose cascade takes the fixtures. RESTRICT is checked
    immediately and cannot be deferred, so at that moment the fixtures are still
    there, still pointing at the tables, and the whole delete dies on a foreign-key
    violation. Dropping the references first is not a policy decision sneaking in:
    RESTRICT exists so a placement is not destroyed as a side effect of editing the
    **venue**, and this is not a venue edit — the fixture is being deleted too, one
    statement later, along with everything else the director asked to be rid of. The
    refusal that ADR belongs to is the tournament PATCH's, over a table removed out
    from under a fixture that survives it.
    """
    tournament = await _load_owned_tournament_for_update(db, tournament_id, actor)
    await require_no_recorded_play(db, tournament_id=tournament.id)
    settings_ids = await draw_settings_ids_for_tournament(db, tournament.id)
    # ``event_id`` no longer lives on the fixture (ADR 20260815 decision 5); the event
    # is reachable through the stage.
    await db.execute(
        update(TournamentFixture)
        .where(TournamentFixture.stage_id.in_(stage_ids_for_tournament(tournament.id)))
        .values(table_id=None)
    )
    await db.delete(tournament)
    await db.flush()
    await reap_draw_settings(db, settings_ids)
    await db.commit()


# The one thing a tournament with no events can never do. Publishing one stays legal
# — announcing a tournament before its events are written up is ordinary — but
# *starting* it is not: there is nothing to run, no draw to have, and (without this)
# nothing for the per-event checks below to fail on, so an empty tournament would sail
# through a precondition that is vacuously true of it and land in ``live`` (ADR-0786;
# the hole the #782 hand-off flagged).
_NOTHING_TO_START = (
    "This tournament has no events, so there is nothing to start. Add an event and cut "
    "its draw, then start the tournament."
)


def _go_live_refusal_message(
    *, undrawable: list[str], uncut: list[str], stale: list[str]
) -> str:
    """The director-facing sentence for a tournament whose draws are not ready to be
    played (ADR-0786), naming the at-fault events **by name**.

    **It names the events**, because a refusal a director cannot act on is barely
    better than a 500: "some event has no draw" leaves them clicking through a
    ten-event tournament looking for it. Names, not ids (``named_list``) — the ids
    are what the guard compared, but they are not what the director is looking at.

    Two bodies, built independently and joined with a space, because they answer two
    different questions (#1300). **``undrawable`` comes first, and the order is
    load-bearing** — see below.

    * **``undrawable``** — already-composed, one-sentence-per-event refusals (each
      carrying its own reason and its own fix, or no fix when the message states its
      own), for events no cut could ever fix as they stand: a field under two
      entrants, or a non-singles event. Not run through ``named_list`` — unlike
      ``uncut``/``stale``, which share one trailing clause across every name, each
      undrawable event has its own distinct reason, so there is no shared clause to
      fold them into.
    * **``uncut``/``stale``** — events a cut (or re-cut) would actually fix. The two
      failures are kept apart within this body, because they are two different jobs.
      An **uncut** event needs a first cut. A **stale** one has a draw the director may
      well have reviewed and approved — it is simply older than the field, because
      somebody entered or withdrew after it was cut — and needs re-cutting, which will
      move players around inside it. Collapsing the two into "cut the draws" would
      tell the director of a stale event that nothing they did was kept. This body is
      built only when ``uncut`` or ``stale`` is non-empty, and it is
      **byte-identical** to what this function produced before ``undrawable`` existed
      — the regression this guarantees for every tournament with no undrawable event.
      (Byte-identity does not depend on the order: when ``undrawable`` is empty this is
      the only segment either way.)

    **Why ``undrawable`` is first.** The ``uncut``/``stale`` body ends in "so cut the
    draw for each event named …, then start the tournament". Put that body first and
    the undrawable sentences trail *after* the instruction — so "each event named"
    reads as covering the undrawable events named just below it, and a director who
    follows it clicks **Generate draw** on an event the cut refuses. QA walked exactly
    that circle. Emitting ``undrawable`` first keeps the instruction adjacent to the
    only names it is true of, and leaves "then start the tournament" as the sentence
    the refusal ends on.

    When ``undrawable`` is non-empty and ``uncut``/``stale`` are both empty, the
    "cut the draw for each event named" instruction never appears — a director cannot
    be sent to cut a draw that will never succeed (the acceptance criterion this
    guards).
    """
    segments: list[str] = []
    if undrawable:
        segments.append(" ".join(undrawable))
    if uncut or stale:
        segments.append(_uncut_stale_body(uncut, stale))
    return "This tournament cannot start yet: " + " ".join(segments)


def _uncut_stale_body(uncut: list[str], stale: list[str]) -> str:
    """The "cut the draw" body of the go-live refusal — the clauses naming every
    ``uncut``/``stale`` event plus the trailing instruction, unchanged from before
    ``undrawable`` existed. Called only when ``uncut`` or ``stale`` is non-empty.
    """
    clauses = []
    if uncut:
        no_draw = "has" if len(uncut) == 1 else "have"
        clauses.append(f"{named_list(uncut)} {no_draw} no draw yet")
    if stale:
        mismatch = (
            "has a draw that no longer matches its entrants"
            if len(stale) == 1
            else "have draws that no longer match their entrants"
        )
        clauses.append(f"{named_list(stale)} {mismatch}")
    return (
        "; and ".join(clauses)
        + ". A draw is cut from the field as it stands at the time, and "
        "registration stays open right up to the moment a tournament goes live — "
        "so cut the draw for each event named (again, if somebody entered or "
        "withdrew since it was last cut), then start the tournament."
    )


def _undrawable_sentence(name: str, reason: str, fix: str | None) -> str:
    """One event's undrawable refusal, composed from its own reason and its own fix.

    ``reason`` is :func:`~app.draws.draw_error_detail`'s composed sentence, which
    always ends with a sentence-final period — so a ``fix``, when there is one, is
    joined with a leading space (kept *inside* the conditional) rather than the
    sentence gaining a second period or a double space when there is none.
    """
    return f"“{name}”: {reason}" + (f" {fix}" if fix else "")


async def _enforce_ready_to_go_live(db: AsyncSession, tournament: Tournament) -> None:
    """Raise :class:`TournamentNotReadyToGoLiveError` unless every event of this
    tournament has a draw, every one of those draws still describes the field it will
    be played by (ADR-0786), and every event that still needs a cut is one a cut could
    actually produce (#1300).

    **The** ``published → live`` **precondition** — the per-target rule ADR-0017 left
    room for at its single dispatch point, and the reason that room was left. Going
    live is what seals the field (registration closes with it) and, from #788, what
    turns every ready fixture into a real match. Both are irreversible in practice and
    both are computed from the draw — so the draw has to be *right* at the instant the
    tournament starts, not merely to have existed at some point before it.

    Four ways it is not, and each is refused:

    * **No events at all.** ``_NOTHING_TO_START``. It has to be checked, and checked
      first, because the per-event rules below say nothing about a tournament with no
      events: "every event has a current draw" is *true* of a tournament with none.
    * **An event with no draw** (``uncut``) — nothing to play, but a cut would fix it.
    * **An event whose draw is stale** — its fixtures no longer seat exactly its
      active entrants. Registration stays open all the way to go-live, so a draw cut
      on Tuesday is a plan for Tuesday's field: a player who entered on Wednesday is
      in no fixture (they would sit out the tournament they paid for), and a player
      who withdrew is still seated in one (their opponents get a match nobody plays).
      A re-cut would fix it.
    * **An event a cut can never fix** (``undrawable``) — a field under two entrants
      (of any implemented draw type), or a non-singles event (a doubles/teams event
      is refused at the cut, ``NonSinglesDraw``, and can never gain entrants: entry
      itself is refused for it). Telling the director to "cut the draw" for one of
      these is unfollowable — the fix instruction the ``uncut``/``stale`` refusal
      carries is precisely the one that cannot work here, which is the defect #1300
      closes: **every** ``uncut``/``stale`` event now gets a dry-run cut before the
      refusal is composed, so the sentence never sends a director to an action the
      system will refuse a second time.

    **Read under the tournament's row lock, which the transition verb has already
    taken** — this function does not take a second one, and must not. That lock is the
    whole mechanism: every writer of the entrant field (the entry route, the withdraw
    route) queues on that same row first, so an entry cannot land between this check
    and the ``UPDATE`` that follows it. Postgres runs READ COMMITTED, so unlocked, the
    currency this reads would be the currency of *its own statement's snapshot* — and
    a tournament could go live, on a draw this function had just certified as current,
    into a field with one more player in it than the draw seats. The check would have
    been true when it was made and false by the time it mattered, which is the only
    kind of guard worse than none. The dry run below is a pure, in-memory
    ``plan_initial`` call — it plans fixtures and discards them, taking no lock and
    writing nothing — so it adds no second lock and no window for the field to move
    under it.

    Reads stay batched at **three** reads for the whole tournament, whatever the number
    of events: the whole-tournament event read, ``draw_currency_by_event`` (itself
    batched), and — only for at-fault **singles** events, since a non-singles event is
    judged by format alone and never needs a strategy call —
    :func:`~app.tournament_draws.active_draw_entrants_by_event`.

    **Reads, not statements**, and the distinction is the whole point of counting them:
    each of the three is a fixed number of statements rather than one, so the total is
    around seven (``draw_currency_by_event`` alone is three, and the event read pulls
    ``groups`` and ``stages`` through their ``selectin`` loaders). What is constant is
    that **none of the three grows with the number of events** — which is the property
    the row lock cares about, and the reason a per-event query is forbidden here.
    """
    events = (
        (
            await db.execute(
                select(TournamentEvent)
                .where(TournamentEvent.tournament_id == tournament.id)
                # The page's order, so the refusal names the events in the order the
                # director is looking at them.
                .order_by(TournamentEvent.created_at)
            )
        )
        .scalars()
        .all()
    )
    if not events:
        raise TournamentNotReadyToGoLiveError(
            _NOTHING_TO_START, uncut=[], stale=[], undrawable=[], no_events=True
        )
    # ONE batched read for the whole tournament (three statements, whatever the number
    # of events — entries, fixtures, and the draw types the bye allowance turns on):
    # this runs with the row lock held, and a per-event query would hold it for a time
    # that grows with the tournament.
    currency = await draw_currency_by_event(db, [event.id for event in events])
    # The events this precondition refuses at all — everything NOT ``current`` — in
    # the events' own order. A ``match`` with ``assert_never`` over the closed
    # ``DrawCurrency`` set here, not an ``if``: a fourth thing that can be true of a
    # draw (a fixture pointing at a group the event no longer has, say) is a type error
    # until somebody decides whether it may go live, rather than silently joining
    # ``current`` and sailing through.
    at_fault: list[tuple[TournamentEvent, DrawCurrency]] = []
    for event in events:
        state = currency[event.id]
        match state:
            case DrawCurrency.current:
                continue
            case DrawCurrency.uncut | DrawCurrency.stale:
                at_fault.append((event, state))
            case _:
                assert_never(state)
    if not at_fault:
        return
    # The batched field read, scoped to SINGLES at-fault events only — a non-singles
    # event is undrawable by format alone (mirroring ``cut_draw``'s own ordering,
    # format judged before the strategy runs) and never needs its entrants.
    entrants_by_event = await active_draw_entrants_by_event(
        db,
        [event.id for event, _ in at_fault if event.format is EventFormat.singles],
    )
    uncut: list[str] = []
    stale: list[str] = []
    undrawable: list[str] = []
    undrawable_names: list[str] = []
    for event, state in at_fault:
        # Format judged FIRST, before any strategy runs — mirrors ``cut_draw``'s own
        # ordering. A non-singles event is undrawable on this fact alone: entry is
        # refused for it entirely (``app.tournament_entries``), so its field can never
        # reach two and a strategy call would have nothing new to fail on.
        if event.format is not EventFormat.singles:
            undrawable.append(
                _undrawable_sentence(
                    event.name,
                    draw_error_detail(NonSinglesDraw(event.format)),
                    "Remove the event.",
                )
            )
            undrawable_names.append(event.name)
            continue
        entrants = entrants_by_event[event.id]
        try:
            strategy_for_event(event).plan_initial(
                draw_config(event), order_entrants(entrants)
            )
        except DrawError as exc:
            # A field under two entrants is fixed by adding entrants, or by removing
            # an event nobody can fill. Every OTHER ``DegenerateDraw`` (no groups, too
            # many qualifiers, too many rounds) already names its own fix inside the
            # message, so nothing is appended for those.
            fix = "Add entrants, or remove the event." if len(entrants) < 2 else None
            undrawable.append(
                _undrawable_sentence(event.name, draw_error_detail(exc), fix)
            )
            undrawable_names.append(event.name)
            continue
        # The dry run planned successfully: this event just needs a cut (or re-cut),
        # nothing more — it stays in the bucket its currency already put it in.
        if state is DrawCurrency.uncut:
            uncut.append(event.name)
        else:
            stale.append(event.name)
    raise TournamentNotReadyToGoLiveError(
        _go_live_refusal_message(undrawable=undrawable, uncut=uncut, stale=stale),
        uncut=uncut,
        stale=stale,
        undrawable=undrawable_names,
        no_events=False,
    )


async def transition_tournament(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    actor: User,
    to: TournamentStatus,
) -> Tournament:
    """Move the tournament ``actor`` owns to the ``to`` status, and return the
    refreshed :class:`Tournament`.

    Runs the same orchestration the HTTP handler used to run inline, in the same
    order and under the same lock:

    * Loads under the tournament row lock via
      :func:`_load_owned_tournament_for_update` (the ``FOR UPDATE`` load, then the
      owner gate), so the refusals are judged **404 → 403 → 409**: an absent id raises
      :class:`TournamentNotFoundError` before ownership is even considered, and a
      caller who is not the creator raises :class:`NotTournamentOwnerError` before the
      edge is judged — so the response never leaks what status a tournament they
      cannot touch is in. The lock is essential: two identical requests racing here
      would otherwise both read the same ``from``, both find a legal edge, and both
      succeed, turning the "already in that status" conflict into a silent no-op. The
      loser now blocks, re-reads the committed status, and gets the 409 it is owed.
    * **409** — the forward-only :data:`LEGAL_TRANSITIONS` table judges the edge. A
      re-asserted status raises :class:`TournamentAlreadyInStatusError` (its own
      single-ended sentence); any other illegal edge raises
      :class:`IllegalTournamentTransitionError` (naming both ends).
    * **409** — only the ``published → live`` edge has a precondition
      (:func:`_enforce_ready_to_go_live`, ADR-0786), run INSIDE the held row lock:
      every event must have a current draw, else
      :class:`TournamentNotReadyToGoLiveError` names the at-fault events. Publishing
      an empty tournament is unaffected; archiving asks nothing of the draws it puts
      away.
    * On the ``published → live`` edge, and only there, the go-live side effects run
      in this same transaction under the same lock: :func:`materialize_live_draw`
      turns every ready fixture into a real ``pending`` match (idempotent on
      ``fixture.match_id``), then ``request_solve`` queues the day's first full plan
      with trigger ``go_live`` — the lock order (tournament → schedule_solves)
      ``request_solve`` requires. A ``None`` return from ``request_solve`` (Redis
      down) is **deliberately ignored**: the transition is what the director asked
      for, and the missing solve is recovered by the 1-minute pin tick and the
      owner's Run-scheduler button, so failing the go-live would trade a self-healing
      gap for a hard error.
    * On **every** edge, a ``dashboard.changed`` hint is staged for each active
      entrant of each of the tournament's events
      (:func:`app.tournament_realtime.stage_tournament_entrant_hints`) — going live
      is what makes the dashboard's tournament panel appear, and archiving is what
      takes it away. Staged, not published, so a refused/rolled-back transition
      tells nobody.

    Commits and refreshes before returning. Never raises ``HTTPException`` — the
    caller adapts each domain exception to its transport.
    """
    tournament = await _load_owned_tournament_for_update(db, tournament_id, actor)

    if (tournament.status, to) not in LEGAL_TRANSITIONS:
        # The self-transition gets its own single-ended sentence; every other illegal
        # edge names both ends. Two exception types, so the distinction survives to
        # the adapter (the two-ended phrasing degenerates into tautology on a
        # self-transition — "this tournament is live; it cannot be moved to live").
        if tournament.status == to:
            raise TournamentAlreadyInStatusError(tournament.status.value)
        raise IllegalTournamentTransitionError(tournament.status.value, to.value)

    # THE per-target precondition, inside the row lock this verb already holds and
    # must stay inside: the currency it checks is a fact about the entrant field, and
    # every writer of that field queues on this same row — so an entry cannot land
    # between the check and the ``UPDATE`` below. Only ``live`` has one (ADR-0786).
    if to is TournamentStatus.live:
        await _enforce_ready_to_go_live(db, tournament)

    tournament.status = to
    # Materialization + the go-live solve, as the transition's final acts — only on
    # the ``published → live`` edge, only after the precondition above (which
    # guarantees a complete, current draw to work from), and in the SAME transaction
    # under the SAME lock, so a tournament is never seen ``live`` without the matches
    # its go-live created.
    if to is TournamentStatus.live:
        await materialize_live_draw(db, tournament)
        await request_solve(db, tournament.id, ScheduleSolveTrigger.go_live)

    # The realtime audience of a lifecycle move: every active entrant of every
    # event of this tournament. Going live is the write that makes the dashboard's
    # tournament panel *appear at all* — a player who missed this hint would not
    # learn their tournament had started until they navigated — and archiving is
    # the one that takes it away again, so every edge hints, not just ``live``.
    # Staged, not published: it is true only if the status write below commits.
    await stage_tournament_entrant_hints(db, tournament.id)
    await db.commit()
    await db.refresh(tournament)
    return tournament
