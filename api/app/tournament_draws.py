"""Persisting a draw: the cut, the un-cut, and the guard that protects them
(ADR-0786).

``app.draws`` is the *pure* half of this — it plans fixtures from an ordered field and
knows nothing about a session. This module is the half that touches the database: it
reads the event's field, hands it to the strategy, and writes what comes back. The
split is what lets every rule about *what a draw looks like* be tested with literals,
and leaves this module with only the three things a database is actually needed for:

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
from collections.abc import Collection, Sequence

from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.draws import (
    DrawConfig,
    Entrant,
    EntryId,
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


def fixture_state(fixture: TournamentFixture) -> FixtureState:
    """Project a persisted :class:`~app.models.tournament_fixture.TournamentFixture` row
    into the pure :class:`~app.draws.FixtureState` a strategy's ``advance()`` reads.

    The ORM↔domain bridge, kept here rather than in ``app.draws`` so that module stays
    constructible from literals and free of any SQLAlchemy import — the same split that
    lets every rule about the *shape* of a draw be tested without a database. Shared by
    every path that advances a draw (materialization at go-live #788, completion #789),
    so the projection is written once.
    """
    return FixtureState(
        fixture_id=FixtureId(fixture.id),
        pool_id=PoolId(fixture.pool_id) if fixture.pool_id is not None else None,
        round=fixture.round,
        position=fixture.position,
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
    )


def draw_config(event: TournamentEvent) -> DrawConfig:
    """What the cut needs to know about the event itself: the ids of the pools it has
    configured — **in the event's own pool order**, which is the order the snake seeds
    against.

    It does **not** carry the event's ``draw_type``, though it once did. The draw type
    is what ``cut_draw`` picks the *strategy* with (``strategy_for(event.draw_type)``),
    and it does so before this config exists; copying it in here as well gave the domain
    a second place to learn a fact it had already acted on — one that no strategy read,
    and that a future one could read and be lied to by. See :class:`DrawConfig`.

    The pools are *parsed*, not indexed: ``TournamentEvent.pools`` is JSONB, and
    ``p["id"]`` on an untyped dict is a ``KeyError`` waiting for the one malformed row
    (api/CLAUDE.md — "parse, don't validate"). ``Pool`` is the same model the write
    boundary validated them with, so a pool that could be *stored* can be read here —
    and its ``min_length=1`` id is why a ``PoolId`` reaching the domain is never ``""``.

    Every configured pool is passed, whatever the draw type. An un-pooled strategy
    (single-elim, #785) ignores them and writes ``NULL`` pool refs; a pooled one deals
    the field across exactly these ids — which is what makes a fixture's ``pool_id`` a
    string ref that resolves against the event the client is already holding.
    """
    return DrawConfig(
        pool_ids=tuple(PoolId(Pool.model_validate(pool).id) for pool in event.pools),
    )


async def event_has_draw(db: AsyncSession, event_id: uuid.UUID) -> bool:
    """Whether this event has a draw at all — whether the cut has happened.

    The question the **pool-set freeze** turns on (ADR-0786). A fixture's ``pool_id`` is
    a string ref into the event's own ``pools`` JSONB and *not* a foreign key — there is
    no pools table for it to point at — so nothing in the database stops a ``PATCH``
    from replacing the pools out from under a cut draw and leaving every fixture in the
    event referring to a pool that no longer exists. "Integrity is procedural, not
    schematic": this is the read that procedure is built on.

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
    """The pools this event *currently* has, parsed — the ones the freeze protects.

    Parsed through :class:`Pool`, exactly as ``draw_config`` parses them, rather than
    indexed as ``p["id"]`` on an untyped JSONB dict (api/CLAUDE.md — "parse, don't
    validate"). It is the same model the write boundary validated these rows with, so
    a pool that could be *stored* can be read back here; a malformed one fails loudly
    at the boundary instead of raising a ``KeyError`` somewhere downstream.

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
    return [Pool.model_validate(pool) for pool in event.pools]


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
    writes nothing when it does. The strategy is chosen *first*, so an unimplemented
    draw type is refused before the field is even read: there is no arrangement of
    entrants that would make a swiss draw cuttable today. And the whole plan is made
    *before* the DELETE, so a refused re-cut cannot leave a director with the draw they
    had thrown away and none of the one they could not have.

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
    go-live. Checked here beside ``strategy_for`` so the two "this event cannot be cut"
    refusals sit together and neither reads the field of an event that has no business
    being cut.
    """
    if event.format is not EventFormat.singles:
        raise NonSinglesDraw(event.format)
    strategy = strategy_for(event.draw_type)
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
