"""Persisting a draw: the cut, the un-cut, and the guard that protects them
(ADR-0786).

``app.draws`` is the *pure* half of this — it plans fixtures from an ordered field and
knows nothing about a session. This module is the half that touches the database: it
reads the event's field, hands it to the strategy, and writes what comes back. The
split is what lets every rule about *what a draw looks like* be tested with literals,
and leaves this module with only the three things a database is actually needed for:

- **the strategy** (``strategy_for_event``) — the one door onto ``app.draws``'
  dispatch, because picking a strategy now takes the event's whole draw configuration
  (its type *and*, for ``rr-then-ko``, its qualifier count) rather than a bare enum.
- **the field** (``active_draw_entrants``) — the *active* entries, in the shape
  ``order_entrants`` wants. Withdrawal is a soft-delete, so a withdrawn entry is not an
  entrant (ADR-0016) and has no place in a draw.
- **the guard** (``draw_has_play``) — whether this draw shows any evidence of play.
- **the freeze** (``event_has_draw`` / ``event_pools``) — whether a draw exists at
  all, and the pools it was cut across. The two facts the event ``PATCH`` needs to
  refuse a pools payload that would orphan the fixtures (there is no FK to stop it).
- **the currency** (``draw_currency_by_event``) — whether each event's draw still
  describes the field it was cut from. The fact the ``published → live`` precondition
  is decided on (ADR-0786).
- **the write** (``cut_draw`` / ``uncut_draw``).

Neither write commits. The caller owns the transaction, because a cut is only safe
inside the tournament's row lock: the field it reads and the fixtures it derives from
that field must not be separated by another writer's entry (see the route).
"""

import enum
import uuid
from collections.abc import Collection, Mapping, Sequence

from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.draws import (
    DrawConfig,
    DrawStrategy,
    Entrant,
    EntryId,
    FixtureGames,
    FixtureId,
    FixtureState,
    MatchId,
    NonSinglesDraw,
    PoolId,
    order_entrants,
    strategy_for,
)
from app.models import (
    EventFormat,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentFixture,
)
from app.schemas.tournament import Pool
from app.tournament_pools import pool_read


async def active_draw_entrants(db: AsyncSession, event_id: uuid.UUID) -> list[Entrant]:
    """The event's field, as the draw domain needs to see it: one :class:`Entrant` per
    **active** entry.

    Withdrawn entries are filtered out here, at the one place the cut reads them, for
    the same reason the entrants list filters them (ADR-0016): a withdrawn player is not
    an entrant, and a draw cut from a field that included them would seat a person who
    has left the event — and every pool's size would be computed against a field that
    does not exist.

    Only the three columns the ordering rule reads (``order_entrants``: seed ascending
    where set, then registration order, then the id as the final tie-break). The row
    itself deliberately does not cross into the domain — ``app.draws`` is constructible
    from literals, which is what makes every rule about the shape of a draw testable
    without a database.
    """
    rows = (
        await db.execute(
            select(
                TournamentEntry.id,
                TournamentEntry.seed,
                TournamentEntry.created_at,
            ).where(
                TournamentEntry.event_id == event_id,
                TournamentEntry.status == TournamentEntryStatus.entered,
            )
        )
    ).all()
    return [
        Entrant(entry_id=EntryId(entry_id), seed=seed, created_at=created_at)
        for entry_id, seed, created_at in rows
    ]


def pool_order(event: TournamentEvent) -> dict[PoolId, int]:
    """Each of this event's pool ids mapped to its **0-based place in the event's pool
    order** — the lookup :func:`fixture_state` resolves a fixture's ``pool_id`` through.

    Computed once per event rather than per fixture: a fixture carries its pool's *id*,
    not its index, so somebody has to do the join and a 200-fixture round-robin should
    not project the pools 200 times.

    The rank is the pool's index *after* sorting on ``Pool.position`` (ADR 20260801),
    not the stored ``position`` read straight off: it is then the same sequence
    :func:`draw_config` hands the snake, by construction and not by two functions
    agreeing — including on an event whose pools predate the field, where every stored
    position is ``0`` and the stable sort leaves the array order standing.
    """
    return {PoolId(pool.id): index for index, pool in enumerate(_ordered_pools(event))}


def _ordered_pools(event: TournamentEvent) -> list[Pool]:
    """This event's pools, projected, in the director's order — ascending ``position``.

    One definition of "the event's pool order", shared by :func:`draw_config` (which
    seeds the snake against it) and :func:`pool_order` (which the read of a persisted
    fixture resolves through), so a draw is cut in the same order it is advanced in.

    The ``sorted`` is belt-and-braces rather than the mechanism: the ``pools``
    relationship carries ``order_by=TournamentEventPool.position``, so the rows arrive
    in this order already, and ``UNIQUE (event_id, position)`` makes it a total one. It
    is kept because this function is *the* statement of what "the event's pool order"
    means, and a caller who builds a ``TournamentEvent`` in memory (a test, a REPL)
    never went through that ``ORDER BY``.
    """
    return sorted(event_pools(event), key=lambda pool: pool.position)


def fixture_state(
    fixture: TournamentFixture,
    game_counts: Mapping[uuid.UUID, tuple[int, int]] | None = None,
    voided_match_ids: frozenset[uuid.UUID] = frozenset(),
    pool_positions: Mapping[PoolId, int] | None = None,
) -> FixtureState:
    """Project a persisted :class:`~app.models.tournament_fixture.TournamentFixture` row
    into the pure :class:`~app.draws.FixtureState` a strategy's ``advance()`` reads.

    The ORM↔domain bridge, kept here rather than in ``app.draws`` so that module stays
    constructible from literals and free of any SQLAlchemy import — the same split that
    lets every rule about the *shape* of a draw be tested without a database. Shared by
    every path that advances a draw (materialization at go-live #788, completion #789),
    so the projection is written once.

    ``game_counts`` is the games each **side** won, keyed by match id, exactly as
    :func:`app.tournament_queries.game_counts_by_match` returns it — and it holds
    **only completed matches**, because that is what its caller batches over
    (``completed_match_ids``, which filters on ``MatchStatus.completed``). An
    in-progress match's part-scored board is not a result, so a fixture whose match has
    not completed is simply not a key here and projects
    :attr:`~app.draws.FixtureState.games` as ``None`` — the same absence a fixture with
    no match at all gets. Passing nothing (the default) is "no games are known for any
    fixture", which is what every caller that does not tabulate wants.

    ``voided_match_ids`` rides in the same way, and is the whole of what the domain
    knows about a match's status: a fixture whose match id is in it projects
    :attr:`~app.draws.FixtureState.match_voided` ``True``. The ``MatchStatus`` enum
    stops here — ``app.draws`` asks one question of a match's status ("can this pairing
    still produce a result?"), so it is answered once, here, as a ``bool``, and that
    module stays free of the ORM. The ids come off the same outer join the completed
    ones do (``_fixtures_with_match_statuses``), so this costs no extra query and both
    facts are read at one instant. The default — nothing is voided — is the truth for
    every caller whose fixtures have no matches at all.

    **side 1 ← ``entry_a``, side 2 ← ``entry_b``** (#788), the same fixed convention the
    completion seam maps a winning side back to an entry with, so the ``(side_1,
    side_2)`` pair is ``(entry_a, entry_b)``'s. Getting this backwards would hand a
    strategy a mirrored scoreline that still looks like a plausible result, which is
    what ``tests/test_tournament_draws.py`` asserts with an asymmetric one.

    ``pool_positions`` maps this event's pool ids to their places in the event's pool
    order (:func:`pool_order`), and is what fills
    :attr:`~app.draws.FixtureState.pool_position` — the key ``ready_fixtures`` groups a
    plan by. It rides in from the caller for the same reason the games do: it is one
    fact about the *event*, and resolving it here would mean re-parsing the pools JSONB
    once per fixture. Passing nothing means "the pool order was not resolved", which
    projects a ``None`` position — the fixture is then ordered by its pool *id*, the
    order this had before positions existed. Un-pooled fixtures resolve to ``None``
    whatever is passed: there is no pool to place.

    It is the caller — not this function — that loads the counts, because
    ``advance()``'s current caller
    (:func:`app.tournament_materialization.materialize_event`) loads fixtures and
    nothing else. Reading the games here would mean a query per fixture inside the
    projection; the batched load belongs at the seam, alongside the fixture load.
    """
    games = (
        game_counts.get(fixture.match_id)
        if game_counts is not None and fixture.match_id is not None
        else None
    )
    pool_id = PoolId(fixture.pool_id) if fixture.pool_id is not None else None
    return FixtureState(
        fixture_id=FixtureId(fixture.id),
        pool_id=pool_id,
        round=fixture.round,
        position=fixture.position,
        pool_position=(
            pool_positions.get(pool_id)
            if pool_positions is not None and pool_id is not None
            else None
        ),
        entry_a_id=(
            EntryId(fixture.entry_a_id) if fixture.entry_a_id is not None else None
        ),
        entry_b_id=(
            EntryId(fixture.entry_b_id) if fixture.entry_b_id is not None else None
        ),
        winner_entry_id=(
            EntryId(fixture.winner_entry_id)
            if fixture.winner_entry_id is not None
            else None
        ),
        match_id=MatchId(fixture.match_id) if fixture.match_id is not None else None,
        games=(
            FixtureGames(entry_a_games=games[0], entry_b_games=games[1])
            if games is not None
            else None
        ),
        match_voided=(
            fixture.match_id is not None and fixture.match_id in voided_match_ids
        ),
    )


def draw_config(event: TournamentEvent) -> DrawConfig:
    """What the cut needs to know about the event itself: the ids of the pools it has
    configured — **in the event's own pool order**, which is the order the snake seeds
    against.

    It does **not** carry the event's ``draw_type``, though it once did. The draw type
    is what ``cut_draw`` picks the *strategy* with (``strategy_for_event(event)``), and
    it does so before this config exists; copying it in here as well gave the domain
    a second place to learn a fact it had already acted on — one that no strategy read,
    and that a future one could read and be lied to by. See :class:`DrawConfig`.

    The pools arrive as typed :class:`Pool` values, never as raw rows or dicts
    (:func:`app.tournament_pools.pool_read`) — the same model the write boundary
    validated them with, whose ``min_length=1`` id is why a ``PoolId`` reaching the
    domain is never ``""``.

    Every configured pool is passed, whatever the draw type. An un-pooled strategy
    (single-elim, #785) ignores them and writes ``NULL`` pool refs; a pooled one deals
    the field across exactly these ids — which is what makes a fixture's ``pool_id`` a
    string ref that resolves against the event the client is already holding.

    The order is read off each pool's ``position`` (ADR 20260801, "Pools carry an
    explicit ``position``") rather than taken from the JSONB array's incidental
    sequence. Both say the same thing today — the position *is* stamped from the array
    index at the write boundary — and saying it out loud is the point: this order is
    what the snake seeds against, so once pools become rows the order has to come from
    the column that carries it, not from whatever sequence a query happened to return
    them in. A ``sorted`` is stable, so pools stored before the field existed (every
    ``position`` defaulting to ``0``) keep the array order they have always had.
    """
    return DrawConfig(pool_ids=tuple(PoolId(pool.id) for pool in _ordered_pools(event)))


def strategy_for_event(event: TournamentEvent) -> DrawStrategy:
    """The strategy that cuts and advances **this event's** draw — the one production
    door onto :func:`app.draws.strategy_for`.

    ``strategy_for`` is keyword-strict about the qualifier count and has no default, so
    somebody has to read it off the event; this is that somebody, and it is one function
    rather than three call sites each reaching into ``event.draw_settings`` for a pair
    of columns. Which matters because forgetting the second column does not fail — it
    produces a differently-configured strategy — and because the two facts live on one
    row precisely so they are read together (ADR "an event's draw configuration is a
    row, not a column").

    The settings row rides along with the event (``lazy="joined"``), so this is
    attribute access, not a lazy load in async context.
    """
    return strategy_for(
        event.draw_settings.draw_type,
        qualifiers_per_pool=event.draw_settings.qualifiers_per_pool,
    )


async def event_has_draw(db: AsyncSession, event_id: uuid.UUID) -> bool:
    """Whether this event has a draw at all — whether the cut has happened.

    The question the **pool-set freeze** turns on (ADR-0786). Nothing in the database
    stops a ``PATCH`` from *adding* a pool to an event whose draw was dealt across the
    pools it had at the cut — the removal half is a foreign-key violation now
    (ADR 20260801), but an empty new pool breaks no constraint, and the removal's
    violation is a deferred 500 rather than something a director can act on. This is the
    read both halves of that refusal are built on.

    Deliberately **not** ``draw_has_play``. Play is the gate on *destroying* a draw
    (re-cutting, un-cutting); the mere *existence* of one is the gate on moving the
    pools under it. The two are different questions with different answers, and a draw
    that has been cut but not yet played — the ordinary state of a tournament on the
    morning of — is exactly where the pool-set freeze does its work: nothing has been
    played, so the play guard would wave the change through, and every fixture would
    still be orphaned.

    A ``COUNT``, not a load: the answer is a yes/no, and a 200-fixture round-robin
    should not be pulled into memory to learn it.
    """
    fixtures = (
        await db.execute(
            select(func.count())
            .select_from(TournamentFixture)
            .where(TournamentFixture.event_id == event_id)
        )
    ).scalar_one()
    return fixtures > 0


def event_pools(event: TournamentEvent) -> list[Pool]:
    """The pools this event *currently* has, projected — the ones the freeze protects.

    Every reader of an event's pools comes through here (or through
    :func:`_ordered_pools`, which is this plus the order), which is why moving pools out
    of a JSONB column and into ``tournament_event_pools`` rows was invisible above this
    line: :func:`app.tournament_pools.pool_read` composes the same :class:`Pool` out of
    typed columns that this used to validate out of untyped dicts.

    Returns the **pools**, not just their ids, though identity is all the freeze
    compares: a refusal has to *name* the pools it is about (``named_list``), and a
    caller handed a bare ``set[PoolId]`` has no way back to the names — it would parse
    every pool a second time to recover them. One parse, and the id set is a
    comprehension away.

    The ids are the only load-bearing part after the cut, because the ids are what the
    fixtures hold. Everything else here — a pool's tables, its window, its name, and
    the ORDER of the list (read only at the cut, where it seeds the snake) — is free to
    change under a standing draw.
    """
    return [pool_read(pool) for pool in event.pools]


async def draw_has_play(db: AsyncSession, event_id: uuid.UUID) -> bool:
    """Whether this event's draw shows any **evidence of play** — the one thing a cut,
    a re-cut and an un-cut are refused for (ADR-0786).

    Evidence is either half of what play leaves behind on a fixture:

    * a ``winner_entry_id`` — the fixture is *decided*; a result has been recorded; or
    * a ``match_id`` — the fixture has *materialized* into a real match, which may
      already carry games on its scratchpad or a proposed result.

    The ``match_id`` half is what makes this guard deliberately **stricter** than "some
    matches have been played" (issue #785's phrasing): a merely-linked match blocks a
    re-cut, because replacing the draw wholesale would orphan that match and the scores
    already entered on it. A draw must never silently eat a score. The cost of being
    strict is a director who linked a match by accident having to unlink it; the cost of
    being lax is a player's recorded result vanishing.

    A ``COUNT`` rather than a load of the fixtures: the guard's answer is a yes/no, and
    loading a 200-fixture round-robin to learn it would grow with the draw it is
    guarding. It is read inside the tournament's row lock, so what it sees is what the
    last committed writer wrote.
    """
    played = (
        await db.execute(
            select(func.count())
            .select_from(TournamentFixture)
            .where(
                TournamentFixture.event_id == event_id,
                or_(
                    TournamentFixture.winner_entry_id.is_not(None),
                    TournamentFixture.match_id.is_not(None),
                ),
            )
        )
    ).scalar_one()
    return played > 0


class DrawCurrency(enum.Enum):
    """Where an event's draw stands **relative to its field** — the three states the
    go-live precondition is decided on (ADR-0786).

    A draw is a plan made against a field of entrants, and registration stays open right
    up to the moment a tournament goes live — so the plan can be out of date by the time
    it is needed. These are the only three things that can be true of it, and they are a
    closed set rather than a pair of booleans (``has_draw`` / ``is_current``) precisely
    because two booleans can spell a fourth state that does not exist: "no draw, but
    current".

    * ``current`` — the fixtures seat exactly the event's active entrants. Ready.
    * ``uncut`` — the event has no fixtures at all. Nobody has cut its draw.
    * ``stale`` — it has a draw, but the field moved under it: somebody entered
      after the cut, somebody withdrew after it, or both.
    """

    current = "current"
    uncut = "uncut"
    stale = "stale"


async def draw_currency_by_event(
    db: AsyncSession, event_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, DrawCurrency]:
    """Where every event in ``event_ids`` stands, keyed by event id.

    **A set comparison, never a count.** Currency is "these fixtures seat exactly
    these entrants", so the active entry ids are compared against the entry ids the
    event's fixtures actually reference. Comparing *sizes* would look like the same
    rule and pass the same happy-path test, while waving through the one case that
    matters most: one player withdraws and another enters between the cut and
    go-live. Same count, a different field, and a draw that seats a player who has
    left while the player who replaced them is seated nowhere — a tournament that
    starts with a match nobody can play
    (``test_a_swap_between_the_cut_and_go_live_is_stale``).

    Both halves of the comparison are **entry ids**, not user ids, because an entry
    is what a fixture holds and what a withdrawal soft-deletes: a player who
    withdraws and re-enters gets a *new* entry, so their old id leaves the active
    set — and correctly makes the draw stale, since the fixtures still seat the
    entry they left by.

    A ``NULL`` side counts as nothing: it means TBD (a KO round whose feeder is
    undecided), never a bye and never an absent player. The seated set is therefore
    the union of the non-NULL ``entry_a_id`` / ``entry_b_id`` refs — which, for
    every strategy that exists today (and every one designed: a byed seed is placed
    directly into round 2, so it is still *seated somewhere*), is exactly the set of
    entrants the draw covers.

    ``uncut`` is decided on the fixtures EXISTING, not on the seated set being
    empty. The two come apart on the event nobody has entered: no entrants and no
    fixtures compare equal (∅ == ∅) and would report ``current`` — an event with no
    draw at all, called ready to start. Such an event cannot even *be* cut (the
    strategy refuses a field that small), so the empty comparison would be pure
    fiction, and it would be the fiction that carried an unplayable event into
    ``live``.

    TWO statements for the whole batch, whatever the number of events (none at all
    when there are none), for the same reason every other loader here is batched:
    this runs on the go-live path with the tournament's row lock held, and a
    per-event pair of queries would hold that lock for a time that grows with the
    tournament.
    """
    if not event_ids:
        return {}
    active: dict[uuid.UUID, set[uuid.UUID]] = {
        event_id: set() for event_id in event_ids
    }
    seated: dict[uuid.UUID, set[uuid.UUID]] = {
        event_id: set() for event_id in event_ids
    }
    # Whether a draw exists AT ALL is its own fact, read off the rows rather than
    # inferred from ``seated`` being empty — see the docstring.
    cut: set[uuid.UUID] = set()

    entries = (
        await db.execute(
            select(TournamentEntry.event_id, TournamentEntry.id).where(
                TournamentEntry.event_id.in_(active.keys()),
                # Withdrawn entries are not entrants (ADR-0016), so a draw is not stale
                # merely for failing to seat somebody who has left — it is stale for
                # *still* seating them, which is what the comparison below catches.
                TournamentEntry.status == TournamentEntryStatus.entered,
            )
        )
    ).all()
    for event_id, entry_id in entries:
        active[event_id].add(entry_id)

    fixtures = (
        await db.execute(
            select(
                TournamentFixture.event_id,
                TournamentFixture.entry_a_id,
                TournamentFixture.entry_b_id,
            ).where(TournamentFixture.event_id.in_(seated.keys()))
        )
    ).all()
    for event_id, entry_a_id, entry_b_id in fixtures:
        cut.add(event_id)
        seated[event_id].update(
            entry_id for entry_id in (entry_a_id, entry_b_id) if entry_id is not None
        )

    return {
        event_id: (
            DrawCurrency.uncut
            if event_id not in cut
            else DrawCurrency.current
            if seated[event_id] == active[event_id]
            else DrawCurrency.stale
        )
        for event_id in active
    }


async def cut_draw(db: AsyncSession, event: TournamentEvent) -> None:
    """Cut (or re-cut) this event's draw: plan the fixtures its draw type prescribes for
    its active field, and make them the event's fixtures — **all of them, and only
    them**.

    A re-cut **replaces wholesale**, and it does so by deleting first and inserting
    second, in the caller's single transaction. It is deliberately not a reconcile:
    placement is frozen at the cut (ADR-0786), so the fixtures of the *previous* draw
    are not something to be patched into agreement with the new field — they are a plan
    that was made against a field that no longer exists, and every one of them may have
    moved. Matching on ``(pool, round, position)`` and updating the sides in place would
    keep the old rows' ids while silently changing who they seat, which is the same
    thing with a worse audit trail.

    One transaction is what makes "wholesale" true rather than aspirational: the DELETE
    and the INSERTs commit together, so there is no instant in which the event holds
    half of one draw and half of another. Which is why neither this function nor
    ``uncut_draw`` commits — a helpful ``await db.commit()`` inside the DELETE would
    open exactly that window.

    Raises :class:`~app.draws.DrawError` — the base the route turns into a 422 — and
    writes nothing when it does. The format is judged *first*, so a non-singles event is
    refused before the field is even read: there is no arrangement of entrants that
    would make a doubles draw cuttable. And the whole plan is made *before* the DELETE,
    so a refused re-cut cannot leave a director with the draw they had thrown away and
    none of the one they could not have.

    That last property has **two** locks on it, and it is worth knowing that they are
    two, because a test can only ever see one of them fail: the ordering here, and the
    transaction itself (the route rolls back on a ``DrawError``, and nothing on that
    path has committed). Reordering these two lines would not break
    ``test_a_refused_re_cut_leaves_the_standing_draw_untouched`` — the rollback would
    still save it — so do not read that test's green as permission to. The ordering is
    the one that survives somebody deciding a service function ought to commit.

    **The caller must hold the tournament's row lock**, and must commit. The field this
    reads is the field the fixtures are derived from, and an entry that lands between
    the two would produce a draw that never matched any real field of players.

    Refuses a **non-singles** event with :class:`~app.draws.NonSinglesDraw` (the route
    turns it into a 422), *before* the field is read or anything is deleted. A doubles
    or teams event cannot be materialized — a fixture seats one entry per side, a match
    seats that entry's single user (ADR-0788) — so a draw that could never become
    playable is refused at the cut, the earliest and clearest point, rather than at
    go-live. Checked here, before ``strategy_for`` picks a strategy, so the refusal
    lands without reading the field of an event that has no business being cut. It is
    the only "this event cannot be cut" refusal left at this seam — ``strategy_for`` is
    total now that the enum holds only what runs (ADR 20260726), so it refuses nothing.
    """
    if event.format is not EventFormat.singles:
        raise NonSinglesDraw(event.format)
    strategy = strategy_for_event(event)
    planned = strategy.plan_initial(
        draw_config(event), order_entrants(await active_draw_entrants(db, event.id))
    )
    await uncut_draw(db, [event.id])
    db.add_all(
        [
            TournamentFixture(
                event_id=event.id,
                pool_id=fixture.pool_id,
                round=fixture.round,
                position=fixture.position,
                entry_a_id=fixture.entry_a_id,
                entry_b_id=fixture.entry_b_id,
            )
            for fixture in planned
        ]
    )


async def uncut_draw(db: AsyncSession, event_ids: Collection[uuid.UUID]) -> None:
    """Un-cut these events' draws: delete their fixtures, so they have no draw again.

    Takes **ids, not events**, and takes a collection of them, because the fixtures are
    addressed by ``event_id`` and nothing else about an event is read. The account-merge
    path (:func:`app.account_merge._resolve_entry_collisions`) knows only the ids of the
    events a double-counted human invalidated, and would otherwise have to SELECT whole
    ``TournamentEvent`` rows purely to hand them back one attribute apiece — and then
    issue a DELETE per event where one suffices. Unordered, because a DELETE ... IN has
    no order to respect.

    A bulk DELETE rather than ``event.fixtures.clear()`` on the ``delete-orphan``
    relationship: the collection would have to be loaded first (a SELECT of every
    fixture, then one DELETE apiece), and this is the statement that runs before every
    re-cut of a full round-robin. The relationship's cascade still stands for the paths
    that *do* go through the ORM — deleting the event itself.

    Deleting nothing is not an error, and neither is being given nothing to delete. An
    event whose draw was never cut is already in the state this asks for, which is why
    the un-cut route answers 204 either way: it is a DELETE, and asking for a state the
    resource already holds is a success.

    Does not commit — the caller owns the transaction, because on the re-cut path this
    DELETE and the INSERTs that follow it are one atomic replacement.
    """
    if not event_ids:
        return
    await db.execute(
        delete(TournamentFixture).where(TournamentFixture.event_id.in_(event_ids))
    )
