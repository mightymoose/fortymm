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
- **the freeze** (``event_has_draw`` / ``event_groups``) — whether a draw exists at
  all, and the groups it was cut across. The two facts the event ``PATCH`` needs to
  refuse a groups payload that would orphan the fixtures (there is no FK to stop it).
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
from types import MappingProxyType

from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.draws import (
    DrawConfig,
    DrawStrategy,
    Entrant,
    EntryId,
    FixtureGames,
    FixtureId,
    FixtureStage,
    FixtureState,
    GroupId,
    MatchId,
    NonSinglesDraw,
    order_entrants,
    strategy_for,
    unseated_entrant_allowance,
)
from app.models import (
    DrawType,
    EventFormat,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentEventStage,
    TournamentFixture,
)
from app.models.draw_type import DRAW_TYPES_BY_ID
from app.schemas.tournament import GroupRead, Reservation
from app.tournament_draw_settings import draw_settings_of
from app.tournament_queries import stage_ids_for_events
from app.tournament_reservations import (
    group_count_for,
    group_read,
    materialise_event_groups,
    ordered_reservations,
    reservation_read,
)


async def active_draw_entrants(db: AsyncSession, event_id: uuid.UUID) -> list[Entrant]:
    """The event's field, as the draw domain needs to see it: one :class:`Entrant` per
    **active** entry.

    Withdrawn entries are filtered out here, at the one place the cut reads them, for
    the same reason the entrants list filters them (ADR-0016): a withdrawn player is not
    an entrant, and a draw cut from a field that included them would seat a person who
    has left the event — and every group's size would be computed against a field that
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


async def active_draw_entrants_by_event(
    db: AsyncSession, event_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, list[Entrant]]:
    """The batched sibling of :func:`active_draw_entrants`: every id in ``event_ids``'
    active field, keyed by event id, in ONE statement whatever the number of events.

    Exists for the ``published → live`` dry run (``app.tournament_lifecycle``), which
    plans a cut ahead of time for every at-fault event to learn whether it would
    succeed — reading one event's field at a time there would turn a batched
    precondition back into a per-event query, growing the time the tournament's row
    lock is held with the tournament's size. Same query shape as the single-event
    version (the three columns ``order_entrants`` reads, filtered to active entries),
    widened to an ``IN``.

    Every id in ``event_ids`` is a key in the result, even one with no active entrants
    (an empty list) — mirroring :func:`draw_currency_by_event`'s pre-seeded dict, so a
    caller never has to guard a missing key with ``.get``.

    Empty input returns ``{}`` without a query, same as :func:`draw_currency_by_event` —
    an ``IN ()`` is never worth asking the database.
    """
    if not event_ids:
        return {}
    entrants: dict[uuid.UUID, list[Entrant]] = {event_id: [] for event_id in event_ids}
    rows = (
        await db.execute(
            select(
                TournamentEntry.event_id,
                TournamentEntry.id,
                TournamentEntry.seed,
                TournamentEntry.created_at,
            ).where(
                TournamentEntry.event_id.in_(event_ids),
                TournamentEntry.status == TournamentEntryStatus.entered,
            )
        )
    ).all()
    for event_id, entry_id, seed, created_at in rows:
        entrants[event_id].append(
            Entrant(entry_id=EntryId(entry_id), seed=seed, created_at=created_at)
        )
    return entrants


def group_order(event: TournamentEvent) -> dict[GroupId, int]:
    """Each of this event's group ids mapped to its **0-based place in the event's group
    order** — the lookup :func:`fixture_state` resolves a fixture's ``group_id``
    through.

    Computed once per event rather than per fixture: a fixture carries its group's *id*,
    not its index, so somebody has to do the join and a 200-fixture round-robin should
    not project the groups 200 times.

    The rank is the group's index *after* sorting on ``Group.position`` (ADR 20260801),
    not the stored ``position`` read straight off: it is then the same sequence
    :func:`draw_config` hands the snake, by construction and not by two functions
    agreeing — including on an event whose groups predate the field, where every stored
    position is ``0`` and the stable sort leaves the array order standing.
    """
    return {
        GroupId(group.id): index for index, group in enumerate(_ordered_groups(event))
    }


def _ordered_groups(event: TournamentEvent) -> list[GroupRead]:
    """This event's groups, projected, in the director's order — ascending ``position``.

    One definition of "the event's group order", shared by :func:`draw_config` (which
    seeds the snake against it) and :func:`group_order` (which the read of a persisted
    fixture resolves through), so a draw is cut in the same order it is advanced in.

    The ``sorted`` is belt-and-braces rather than the mechanism: the ``groups``
    relationship carries ``order_by=TournamentEventStageGroup.position``, so the rows
    arrive in this order already, and ``UNIQUE (stage_id, position)`` makes it a total
    one. It
    is kept because this function is *the* statement of what "the event's group order"
    means, and a caller who builds a ``TournamentEvent`` in memory (a test, a REPL)
    never went through that ``ORDER BY``.
    """
    return sorted(event_groups(event), key=lambda group: group.position)


#: The one spelling of "no stage was resolved" :func:`fixture_state`'s ``stages``
#: parameter accepts — a real, empty mapping rather than ``None``, exactly as
#: ``app.models.tournament_event_draw_settings.NO_SETTINGS`` is for the same reason: a
#: ``.get()`` against an empty dict and a ``.get()`` guarded by ``is not None`` return
#: the identical ``None``, so carrying both spellings bought nothing but a branch to
#: keep in sync. ``MappingProxyType`` so the shared default cannot be mutated by
#: whoever receives it.
_NO_STAGES: Mapping[uuid.UUID, FixtureStage] = MappingProxyType({})


def fixture_state(
    fixture: TournamentFixture,
    game_counts: Mapping[uuid.UUID, tuple[int, int]] | None = None,
    voided_match_ids: frozenset[uuid.UUID] = frozenset(),
    group_positions: Mapping[GroupId, int] | None = None,
    stages: Mapping[uuid.UUID, FixtureStage] = _NO_STAGES,
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

    ``group_positions`` maps this event's group ids to their places in the event's group
    order (:func:`group_order`), and is what fills
    :attr:`~app.draws.FixtureState.group_position` — the key ``ready_fixtures`` groups a
    plan by. It rides in from the caller for the same reason the games do: it is one
    fact about the *event*, and resolving it here would mean re-parsing the groups JSONB
    once per fixture. Passing nothing means "the group order was not resolved", which
    projects a ``None`` position — the fixture is then ordered by its group *id*, the
    order this had before positions existed. Un-grouped fixtures resolve to ``None``
    whatever is passed: there is no group to place.

    It is the caller — not this function — that loads the counts, because
    ``advance()``'s current caller
    (:func:`app.tournament_materialization.materialize_event`) loads fixtures and
    nothing else. Reading the games here would mean a query per fixture inside the
    projection; the batched load belongs at the seam, alongside the fixture load.

    ``stages`` maps this event's stage ids to a :class:`~app.draws.FixtureStage`
    carrying that stage's place in the event's stage order AND its own draw type
    (``app.tournament_materialization.materialize_event`` builds it straight off the
    already-eager ``TournamentEvent.stages``, the sibling of what ``group_order``
    resolves for ``group_positions``), and is what fills
    :attr:`~app.draws.FixtureState.stage` — the discriminator
    :class:`~app.draws.RrThenKoStrategy` reads to split one event's fixtures between
    its two stages, in place of re-deriving the split from ``group_id is None`` (ADR
    20260815 decision 6). It rides in from the caller for the same reason
    ``group_positions`` does: it is one fact about the *event*, resolved once rather
    than reconstructed per fixture. **Always a real mapping, never** ``None`` — the
    empty default (:data:`_NO_STAGES`) and an event's real stage map read identically
    through ``.get()``, so there is exactly one spelling of "no stage resolved" rather
    than two. Passing the default projects ``stage=None`` — harmless for the three draw
    types that never read it, and refused loudly by :class:`~app.draws.RrThenKoStrategy`
    (:class:`~app.draws.MissingStageAssignment`) for the one that does.
    """
    games = (
        game_counts.get(fixture.match_id)
        if game_counts is not None and fixture.match_id is not None
        else None
    )
    group_id = GroupId(fixture.group_id) if fixture.group_id is not None else None
    return FixtureState(
        fixture_id=FixtureId(fixture.id),
        group_id=group_id,
        round=fixture.round,
        position=fixture.position,
        group_position=(
            group_positions.get(group_id)
            if group_positions is not None and group_id is not None
            else None
        ),
        stage=stages.get(fixture.stage_id),
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
    """What the cut needs to know about the event itself: the ids of the groups it has
    configured — **in the event's own group order**, which is the order the snake seeds
    against.

    It does **not** carry the event's ``draw_type``, though it once did. The draw type
    is what ``cut_draw`` picks the *strategy* with (``strategy_for_event(event)``), and
    it does so before this config exists; copying it in here as well gave the domain
    a second place to learn a fact it had already acted on — one that no strategy read,
    and that a future one could read and be lied to by. See :class:`DrawConfig`.

    The groups arrive as typed :class:`Group` values, never as raw rows or dicts
    (:func:`app.tournament_reservations.group_read`) — the same model the write boundary
    validated them with, whose ``min_length=1`` id is why a ``GroupId`` reaching the
    domain is never ``""``.

    Every configured group is passed, whatever the draw type, and **every strategy
    now uses them**. A grouped one (round-robin, and the group half of rr-then-ko)
    deals the field across exactly these ids; a single-stage un-grouped one
    (single-elim, swiss) deals every fixture into the one group its stage holds
    (#1483, ``app.draws._sole_group``) — which is what confines a bracket to its
    reservation's tables and window. Either way a fixture's ``group_id`` is a string
    ref that resolves against the event the client is already holding.

    Only ``rr-then-ko``'s knockout stage still writes a ``NULL`` group ref, because
    this relationship is pinned to stage 0 and that stage has no groups to name until
    #1484 materialises them.

    The order is read off each group's ``position`` (ADR 20260801, "Groups carry an
    explicit ``position``") rather than taken from the JSONB array's incidental
    sequence. Both say the same thing today — the position *is* stamped from the array
    index at the write boundary — and saying it out loud is the point: this order is
    what the snake seeds against, so once groups become rows the order has to come from
    the column that carries it, not from whatever sequence a query happened to return
    them in. A ``sorted`` is stable, so groups stored before the field existed (every
    ``position`` defaulting to ``0``) keep the array order they have always had.
    """
    return DrawConfig(
        group_ids=tuple(GroupId(group.id) for group in _ordered_groups(event))
    )


def strategy_for_event(event: TournamentEvent) -> DrawStrategy:
    """The strategy that cuts and advances **this event's** draw — the one production
    door onto :func:`app.draws.strategy_for`.

    ``strategy_for`` takes the **parsed settings arm**, so somebody has to decode it off
    the event's settings row; this is that somebody, and it is one function rather than
    three call sites each parsing the same blob. Which matters because the draw type and
    the settings beside it are one fact and live on one row precisely so they are read
    together (ADR "an event's draw configuration is a row, not a column").

    The settings row rides along with the event (``lazy="joined"``), so the read is
    attribute access, not a lazy load in async context; the parse it feeds is
    :func:`app.tournament_draw_settings.draw_settings_of`, the single read boundary onto
    that column.
    """
    return strategy_for(draw_settings_of(event.draw_settings))


async def event_has_draw(db: AsyncSession, event_id: uuid.UUID) -> bool:
    """Whether this event has a draw at all — whether the cut has happened.

    The question the **group-set freeze** turns on (ADR-0786). Nothing in the database
    stops a ``PATCH`` from *adding* a group to an event whose draw was dealt across the
    groups it had at the cut — the removal half is a foreign-key violation now
    (ADR 20260801), but an empty new group breaks no constraint, and the removal's
    violation is a deferred 500 rather than something a director can act on. This is the
    read both halves of that refusal are built on.

    Deliberately **not** ``draw_has_play``. Play is the gate on *destroying* a draw
    (re-cutting, un-cutting); the mere *existence* of one is the gate on moving the
    groups under it. The two are different questions with different answers, and a draw
    that has been cut but not yet played — the ordinary state of a tournament on the
    morning of — is exactly where the group-set freeze does its work: nothing has been
    played, so the play guard would wave the change through, and every fixture would
    still be orphaned.

    A ``COUNT``, not a load: the answer is a yes/no, and a 200-fixture round-robin
    should not be pulled into memory to learn it.
    """
    fixtures = (
        await db.execute(
            select(func.count())
            .select_from(TournamentFixture)
            .where(TournamentFixture.stage_id.in_(stage_ids_for_events([event_id])))
        )
    ).scalar_one()
    return fixtures > 0


def event_groups(event: TournamentEvent) -> list[GroupRead]:
    """The groups this event *currently* has, projected — the ones the freeze protects.

    Every reader that needs a group's **identity** (id, position) comes through here (or
    through :func:`_ordered_groups`, which is this plus the order): the freeze
    (``app.tournament_events._enforce_group_set_frozen``), :func:`group_order`,
    :func:`draw_config`. :func:`app.tournament_reservations.group_read` is the
    projection, and it is what makes a group's ``id`` the same id a fixture's
    ``group_id`` holds.

    Deliberately thin — no name, no window, no tables. A caller that needs those reads
    :func:`event_reservations` instead: the two used to be one joined projection
    (slice 1's read-side wire shape), and splitting the read in two is what stops a
    caller that only needs identity from paying for — or accidentally depending on — a
    reservation's editable fields.
    """
    return [group_read(group) for group in event.groups]


def event_reservations(event: TournamentEvent) -> list[Reservation]:
    """The reservations this event *currently* has, projected — the venue side a
    caller consults for a window, a table set, or a display name.

    The scheduler's inputs (``app.schedule_preview``, ``app.schedule_preview_solve``,
    ``app.schedule_solves``) and the event-update verb's re-solve trigger
    (``app.tournament_events._event_scheduling_facts``) all read through here: what they
    need is a reservation's identity, window and tables, never a group's. A caller that
    wants a **label** for a fixture's group does not come through here either — see
    ``app.draws.group_label`` — because a group's label is derived from its position,
    not read off its reservation's editable name (ADR 20260808).

    Reads ``TournamentEvent.reservations`` itself — eager (``selectin``) since #1387,
    and the only collection that holds every reservation. It used to read through
    ``event.groups[].reservation`` while every group had exactly one reservation; now
    that an ``rr-then-ko`` event's group count derives from its field, a reservation
    may have no group mapped onto it (one group, four reservations) and a group may
    have no reservation (an event with none), so the group chain is neither complete
    nor duplicate-free. In ``position`` order
    (:func:`app.tournament_reservations.ordered_reservations`).
    """
    return [
        reservation_read(reservation) for reservation in ordered_reservations(event)
    ]


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
                TournamentFixture.stage_id.in_(stage_ids_for_events([event_id])),
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
    the union of the non-NULL ``entry_a_id`` / ``entry_b_id`` refs.

    **That set is the field itself for three draw types, and one short of it for a
    swiss draw over an odd field.** It used to be assumed exactly equal, on the strength
    of every strategy then designed seating its byed entrants somewhere — a round-robin
    bye sits out one round of a schedule that seats it in the others, a single-elim bye
    is seated onto its round-2 side at the cut. Swiss breaks that: it emits ``⌊n/2⌋``
    fixtures a round, and a bye is the *absence* of a row, so an odd field leaves one
    entrant referenced nowhere. Under the plain equality such a draw read ``stale`` the
    moment it was cut and go-live refused it with a 409 no re-cut could clear.

    So the comparison is now: **nobody seated has left** (``seated <= active``, which is
    what a withdrawal breaks) **and no more entrants are unseated than this draw type's
    byes can account for** (:func:`~app.draws.unseated_entrant_allowance`, which is
    ``0`` for the three and the field's parity for swiss). For every draw type but
    swiss the pair is exactly the old equality, so the check they are protected by has
    not moved: an entry that lands after the cut is still ``stale``, by name, on the
    same 409. See that function for what the swiss allowance can and cannot tell apart.

    ``uncut`` is decided on the fixtures EXISTING, not on the seated set being
    empty. The two come apart on the event nobody has entered: no entrants and no
    fixtures compare equal (∅ == ∅) and would report ``current`` — an event with no
    draw at all, called ready to start. Such an event cannot even *be* cut (the
    strategy refuses a field that small), so the empty comparison would be pure
    fiction, and it would be the fiction that carried an unplayable event into
    ``live``.

    AT MOST THREE statements for the whole batch, whatever the number of events (none
    at all when there are none), for the same reason every other loader here is
    batched: this runs on the go-live path with the tournament's row lock held, and a
    per-event set of queries would hold that lock for a time that grows with the
    tournament. The third is the draw types, which the allowance above turns on; it is
    read here rather than off ``TournamentEvent.draw_settings`` because this loader is
    handed **ids**, not rows, and a relationship walk would be the per-event query this
    function exists not to issue.

    That third statement asks only about the events that are **cut**, and is not issued
    at all when none of them is. The allowance is reached from one arm of the answer
    below — the arm an uncut event never takes — so every draw type read for an uncut
    event is a row fetched and thrown away. Uncut is not the rare case here: it is the
    state of every event of every tournament that has not had its draws cut yet, and
    those tournaments reach this loader on the same locked go-live path as the rest.
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

    # ``event_id`` no longer lives on the fixture (ADR 20260815 decision 5), so this
    # joins ``tournament_event_stages`` for it rather than reading
    # ``TournamentFixture.event_id`` — the one column that dropped, in the one query
    # here that needs the event id back rather than merely filtering by it.
    fixtures = (
        await db.execute(
            select(
                TournamentEventStage.event_id,
                TournamentFixture.entry_a_id,
                TournamentFixture.entry_b_id,
            )
            .join(
                TournamentEventStage,
                TournamentEventStage.id == TournamentFixture.stage_id,
            )
            .where(TournamentEventStage.event_id.in_(seated.keys()))
        )
    ).all()
    for event_id, entry_a_id, entry_b_id in fixtures:
        cut.add(event_id)
        seated[event_id].update(
            entry_id for entry_id in (entry_a_id, entry_b_id) if entry_id is not None
        )

    # The third statement: the draw type of each CUT event, which decides how many of
    # its entrants its fixtures may legitimately leave unseated. Read as the FK id and
    # mapped here via ``app.models.draw_type.DRAW_TYPES_BY_ID`` — the same map the
    # settings row's own ``draw_type`` property reads, and the FK plus the seed-vs-enum
    # migration test are what make an unmappable id unreachable. A plain dict lookup,
    # not a join onto ``draw_types`` (ADR 20260815 retired that join) — this is a
    # targeted column-only ``select``, not a whole-entity ORM load, so no eager
    # relationship on the settings row could apply here regardless.
    draw_types: dict[uuid.UUID, DrawType] = {}
    if cut:
        draw_types = {
            event_id: DRAW_TYPES_BY_ID[draw_type_id]
            for event_id, draw_type_id in (
                await db.execute(
                    select(
                        TournamentEvent.id,
                        TournamentEventDrawSettings.draw_type_id,
                    )
                    .join(
                        TournamentEventDrawSettings,
                        TournamentEvent.draw_settings_id
                        == TournamentEventDrawSettings.id,
                    )
                    # ``in_`` over the cut ids, so this scales with the events that
                    # reach the allowance and not with the batch or the table.
                    .where(TournamentEvent.id.in_(cut))
                )
            ).all()
        }

    return {
        event_id: (
            DrawCurrency.uncut
            if event_id not in cut
            else DrawCurrency.current
            if _covers_the_field(
                draw_types[event_id],
                active=active[event_id],
                seated=seated[event_id],
            )
            else DrawCurrency.stale
        )
        for event_id in active
    }


def _covers_the_field(
    draw_type: DrawType, *, active: set[uuid.UUID], seated: set[uuid.UUID]
) -> bool:
    """Do these fixtures cover this field — the comparison
    :func:`draw_currency_by_event` calls ``current``.

    Two questions, and both have to hold:

    * **nobody the fixtures seat has left.** A withdrawn entry is not an entrant
      (ADR-0016), so a draw that still names one is stale however many byes the format
      has. This is the subset test, and it is the half a bye allowance must never reach
      — "the draw seats somebody who is gone" is the opposite complaint from "an
      entrant the draw does not seat".
    * **no more entrants are unseated than this draw type byes.**
      :func:`~app.draws.unseated_entrant_allowance` is ``0`` for every draw type whose
      byed entrants are seated somewhere anyway, which makes this pair exactly the
      equality it replaced for all of them.

    The allowance is measured against the **active** field, not the seated set: it is
    a question about the tournament's parity ("does somebody have to sit out?"), and
    reading it off the fixtures would ask the draw to justify itself.
    """
    if not seated <= active:
        return False
    return len(active) - len(seated) <= unseated_entrant_allowance(
        draw_type, len(active)
    )


async def cut_draw(db: AsyncSession, event: TournamentEvent) -> None:
    """Cut (or re-cut) this event's draw: plan the fixtures its draw type prescribes for
    its active field, and make them the event's fixtures — **all of them, and only
    them**.

    A re-cut **replaces wholesale**, and it does so by deleting first and inserting
    second, in the caller's single transaction. It is deliberately not a reconcile:
    placement is frozen at the cut (ADR-0786), so the fixtures of the *previous* draw
    are not something to be patched into agreement with the new field — they are a plan
    that was made against a field that no longer exists, and every one of them may have
    moved. Matching on ``(group, round, position)`` and updating the sides in place
    would keep the old rows' ids while silently changing who they seat, which is the
    same thing with a worse audit trail.

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

    That last property has **two** locks on it when the group count holds, and it is
    worth knowing that they are two, because a test can only ever see one of them
    fail: the ordering here, and the transaction itself (the route rolls back on a
    ``DrawError``, and nothing on that path has committed). Reordering these two lines
    would not break ``test_a_refused_re_cut_leaves_the_standing_draw_untouched`` — the
    rollback would still save it — so do not read that test's green as permission to.
    The ordering is the one that survives somebody deciding a service function ought
    to commit.

    **The cut re-derives an ``rr-then-ko`` event's group count from the real field**
    (#1387 decision 1). The rows were materialised against the preview field — the
    cap, or 16 — and the snake judges a group's size against the entrants actually
    registered; the two numbers never meet, and a 40-cap event with ten registrants
    would otherwise deal ten players across eight groups and be refused as
    ``DegenerateDraw``. So, for that draw type only, the count is derived again here
    from ``len(entrants)`` and the rows re-materialised (keeping the lowest positions,
    and the mapping re-read as ``position % reservation count``) **only when the
    derived count differs from the stored one**. When it holds — every first cut of a
    correctly sized event, every re-cut whose field did not cross a group boundary —
    nothing is written and the plan-before-delete ordering above stands. That skip is
    not an optimization with a hole in it: the mapping cannot move while the count
    holds, because a reservation changes only through an event write and every event
    write re-materialises.

    When the count moves on a **re-cut**, both orderings cannot hold: a fixture
    foreign-keys its group, so the old fixtures have to go before a group row can.
    That branch deletes first, re-materialises, flushes (a fresh group's id is the
    database's and the snake needs it), then plans, and the transaction rollback is
    the only lock on a refused plan. After it the identities and the mapping freeze,
    as they do after any cut (decision 3); ``uncut_draw`` writes no group row, so an
    uncut event keeps its cut-time count until the next event write re-materialises
    it from the preview field.

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
    entrants = order_entrants(await active_draw_entrants(db, event.id))
    # The real-field re-derivation (see the docstring). ``group_count_for`` answers
    # ``len(event.reservations)`` for every draw type but ``rr-then-ko``, and that is
    # the count those events already hold, so the branch is reached by an
    # ``rr-then-ko`` event alone — stated by the draw type rather than trusted to the
    # arithmetic, so a reader sees the scope without working it out, and so a cut of
    # any other draw type reads no reservation at all.
    re_materialised = draw_settings_of(
        event.draw_settings
    ).draw_type is DrawType.rr_then_ko and group_count_for(
        DrawType.rr_then_ko,
        field_size=len(entrants),
        reservation_count=len(event.reservations),
    ) != len(event.groups)
    if re_materialised:
        # Delete-first, the one branch where the wholesale ordering below cannot be
        # kept: a fixture names its group, so a group row cannot go while a fixture of
        # the standing draw still points at it.
        await uncut_draw(db, [event.id])
        await materialise_event_groups(db, event, field_size=len(entrants))
        # A fresh group's ``id`` is ``gen_random_uuid()``, minted by the INSERT;
        # ``draw_config`` hands those ids to the snake, so the rows have to exist
        # before it reads them. Then ``event.groups`` — a VIEWONLY association the
        # materialisation cannot write through, loaded when the caller loaded the
        # event — is re-read so it reflects the rows just written.
        await db.flush()
        await db.refresh(event, attribute_names=["groups"])
    planned = strategy.plan_initial(draw_config(event), entrants)
    if not re_materialised:
        await uncut_draw(db, [event.id])
    # This event's stage ids keyed by ``position`` — what a planned fixture's
    # ``stage_id`` is resolved against below (ADR 20260815 decision 5's write seam).
    # Built from the already-eager ``TournamentEvent.stages`` collection
    # (``lazy="selectin"``) rather than a query of its own: the caller already loaded
    # ``event`` with its stages, so re-selecting them here would be a second
    # statement for a collection already in hand.
    stage_ids = {stage.position: stage.id for stage in event.stages}
    # A planned fixture's STAGE (ADR 20260815 decision 5) — taken from the fixture
    # itself (``PlannedFixture.stage``, the same :class:`~app.draws.FixtureStage`
    # projection the read side carries), never re-derived here.
    #
    # It used to be inferred: stage 0 for a fixture that named a group, the event's
    # un-grouped stage otherwise. That was only ever correct while "names a group" and
    # "belongs to the group stage" were the same set, and #1483 ends that — a
    # single-elim bracket now names its stage's group and is emphatically not a group
    # stage. The strategy that dealt the fixture is the thing that knows which stage it
    # dealt it into, so it says so, and this seam stops guessing. #1484, which gives an
    # rr-then-ko knockout stage groups of its own, would have silently sent every
    # knockout fixture to stage 0 under the old inference.
    db.add_all(
        [
            TournamentFixture(
                stage_id=_stage_id_at(stage_ids, fixture.stage.position),
                group_id=fixture.group_id,
                round=fixture.round,
                position=fixture.position,
                entry_a_id=fixture.entry_a_id,
                entry_b_id=fixture.entry_b_id,
            )
            for fixture in planned
        ]
    )


def _stage_id_at(stage_ids: Mapping[int, uuid.UUID], position: int) -> uuid.UUID:
    """The id of this event's stage at ``position``, or a loud failure — never a
    silent ``IndexError``/``KeyError`` — when the event's minted stages and its draw
    settings' draw type disagree about how many there should be.

    The template (``app.tournament_event_stages``) is the only writer of an event's
    stages, and it keeps them in lockstep with the draw type on ``draw_settings`` by
    construction: an rr-then-ko event always has a stage at position 1, everything
    else always has one at position 0. This can only fire if that invariant has
    already broken elsewhere — a re-mint that ran stale, a draw type changed without
    remint — in which case a fixture minted onto a nonexistent stage would be a worse
    failure, raised somewhere with no context linking it back to the cause.
    """
    try:
        return stage_ids[position]
    except KeyError:
        raise RuntimeError(
            f"cut_draw needs a stage at position {position} but the event has none "
            f"(stages at {sorted(stage_ids)}) — its stages and its draw settings' "
            "draw type have drifted out of the template's lockstep (ADR 20260815 "
            "decision 3)"
        ) from None


async def uncut_draw(db: AsyncSession, event_ids: Collection[uuid.UUID]) -> None:
    """Un-cut these events' draws: delete their fixtures, so they have no draw again.

    Takes **ids, not events**, and takes a collection of them, because the fixtures are
    addressed by ``event_id`` and nothing else about an event is read. The account-merge
    path (:func:`app.account_merge._resolve_entry_collisions`) knows only the ids of the
    events a double-counted human invalidated, and would otherwise have to SELECT whole
    ``TournamentEvent`` rows purely to hand them back one attribute apiece — and then
    issue a DELETE per event where one suffices. Unordered, because a DELETE ... IN has
    no order to respect.

    The fixtures are addressed by ``stage_id`` now, not ``event_id`` (ADR 20260815
    decision 5), so the ``event_id.in_(...)`` filter this docstring's title still
    describes is a ``stage_id.in_(subquery)`` against :func:`_stage_ids` underneath —
    mechanical, not a change of what this deletes.

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
        delete(TournamentFixture).where(
            TournamentFixture.stage_id.in_(stage_ids_for_events(event_ids))
        )
    )
