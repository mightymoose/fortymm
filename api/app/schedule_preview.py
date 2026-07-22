"""Building a schedule-preview snapshot from a synthetic field (ADR "a schedule
preview is a non-persistent solve over a synthetic field").

A **preview** answers *"given my tables, windows, formats and games-per-match,
would the schedule even fit — and roughly how long is the day?"* **before anyone
has registered**, so there is no real field to solve over. This module is the
*pure* builder that manufactures one: given a loaded tournament's config it
synthesizes a **synthetic field** — disjoint ``Placeholder`` entrants, one set
per event — runs the **real** draw over them, and assembles the frozen
:class:`~app.scheduling.ScheduleSnapshot` that :func:`app.scheduling.solve` reads.

Like the two pure domains it sits between (:mod:`app.draws`,
:mod:`app.scheduling`) it holds no session, issues no query, and imports no
FastAPI construct. It reads a *loaded* tournament's config (its events, pools,
table catalogue, per-event caps, draw types and ``length_games``) but creates no
``TournamentEntry`` / ``TournamentFixture`` rows: the whole point of a preview is
that it **persists nothing** (ADR — a synthetic entrant is not a ``users.id``, so
there is no real-user FK to satisfy). The result is thrown away with the request.

**The field is auto-filled to capacity, per-event overridable, disjoint across
events.** Each event fills to its ``max_players``; an uncapped event (a ``NULL``
cap — ADR-0935: no cap) has no natural number, so it defaults to
:data:`DEFAULT_UNCAPPED_FIELD`. The caller may override any event's count. The
synthetic players are **globally unique across events** — event A gets ``1..N``,
event B gets ``N+1..``, and so on — so no synthetic player is ever entered in two
events, which is what makes the preview *optimistic on duration* (it ignores the
cross-event contention a multi-event human would cause — a deliberate,
honestly-noted simplification, ADR).

**Draw coverage is round-robin only; every other type is refused loud (ADR).**
Every event's draw is planned by :func:`app.draws.strategy_for` — the single
source of truth production's own ``cut_draw`` uses — with no special-casing:

* **round-robin** — the whole draw is planned;
* **every other draw type** (single-/double-elim, swiss, **and rr-then-ko**) —
  :func:`app.draws.strategy_for` raises :class:`~app.draws.UnsupportedDrawType`
  (they are enum stubs — production genuinely cannot draw them), and the builder
  lets it propagate: the whole preview is refused loud rather than producing a
  partial, misleading snapshot. A preview must run the *same* engine as
  production, so it cannot invent a pool-stage draw for a type production can't
  cut. (When ``draws.py`` grows an rr-then-ko strategy, this builder covers it
  for free, with no change here.)

The per-event :class:`EventFieldSummary` (the count used) is returned alongside
the snapshot so a later chore can compose the preview's honest-notes strip
without re-deriving it.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime

from app.draws import (
    EntryId,
    OrderedEntrant,
    PlannedFixture,
    strategy_for,
)
from app.models.tournament import Tournament, TournamentEvent
from app.scheduling import (
    EventId,
    EventSettings,
    FixtureId,
    PlayerId,
    PoolId,
    ScheduleFixture,
    SchedulePool,
    ScheduleSnapshot,
    TableId,
    Window,
)
from app.schemas.tournament import MatchSettings, Pool, TournamentTable
from app.tournament_draws import draw_config, event_pools

#: The synthetic field size for an *uncapped* event (``max_players IS NULL``,
#: ADR-0935). An uncapped event has no natural number to auto-fill to, so a
#: preview needs a stand-in; the director may always override it. Sixteen is a
#: plausible club-night field the ADR names as the default.
DEFAULT_UNCAPPED_FIELD = 16


def preview_pool_key(event_id: uuid.UUID, pool_id: str) -> str:
    """The one namespaced ``event:pool`` spelling every preview site keys a pool by
    — the ``SchedulePool`` id, a fixture's ``pool_id`` ref, and the enqueue verb's
    infeasibility-resolution map all pass through here, so the string contract lives
    in exactly one place and cannot drift between them."""
    return f"{event_id}:{pool_id}"


@dataclass(frozen=True, slots=True)
class EventFieldSummary:
    """What one event contributed to the synthetic field — the honest-notes
    ingredients (ADR "always an honest-notes strip"), per event.

    ``field_size`` is the entrant count actually synthesized for the event (the
    override if the caller gave one, else the event's cap, else
    :data:`DEFAULT_UNCAPPED_FIELD`).
    """

    event_id: EventId
    field_size: int


@dataclass(frozen=True, slots=True)
class PreviewSnapshot:
    """The output of :func:`build_preview_snapshot`: the frozen
    :class:`~app.scheduling.ScheduleSnapshot` ready to hand to
    :func:`app.scheduling.solve`, plus one :class:`EventFieldSummary` per event
    it synthesized a field for (in the tournament's own event order).

    ``base`` is the wall-clock origin of the snapshot's minute frame — the earliest
    pool window start across every event, the anchor ``now_min = 0`` is offset from
    — or ``None`` when no event has a pool (no window to anchor on), in which case a
    caller reports a duration in minutes but no wall-clock finish. The builder
    already computes it to set the frame, so it is handed back rather than
    re-derived downstream."""

    snapshot: ScheduleSnapshot
    field_summaries: tuple[EventFieldSummary, ...]
    base: datetime | None


def _field_size(event: TournamentEvent, override: int | None) -> int:
    """How many synthetic entrants to invent for this event: the override if the
    caller gave one, else the event's ``max_players`` cap, else
    :data:`DEFAULT_UNCAPPED_FIELD` for an uncapped (``NULL`` cap) event."""
    if override is not None:
        return override
    if event.max_players is not None:
        return event.max_players
    return DEFAULT_UNCAPPED_FIELD


def _slot_bounds(date: str, start: str, end: str) -> tuple[datetime, datetime]:
    """A pool ``Slot``'s window as naive wall-clock datetimes — the venue's own
    frame (mirrors ``schedule_solves._slot_bounds`` without importing that
    RQ/Redis-heavy module into this pure builder)."""
    return (
        datetime.strptime(f"{date} {start}", "%Y-%m-%d %H:%M"),
        datetime.strptime(f"{date} {end}", "%Y-%m-%d %H:%M"),
    )


@dataclass(frozen=True, slots=True)
class _EventPlan:
    """One event's synthesized field and draw, held between the two passes: the
    first pass plans every event (and finds the earliest window that anchors the
    minute frame); the second converts to the pure snapshot once ``base`` is
    known."""

    event: TournamentEvent
    pools: list[Pool]
    settings: MatchSettings
    fixtures: list[PlannedFixture]
    field_size: int


def build_preview_snapshot(
    tournament: Tournament,
    *,
    count_overrides: Mapping[uuid.UUID, int] | None = None,
) -> PreviewSnapshot:
    """Synthesize a :class:`PreviewSnapshot` from a *loaded* tournament's config.

    ``tournament`` must have its ``events`` (and their pools/settings) already
    loaded — this builder issues no query. For each event it fills a synthetic
    field to the event's cap (or ``count_overrides[event.id]`` when given, or
    :data:`DEFAULT_UNCAPPED_FIELD` for an uncapped event), mints **globally
    disjoint** ``Placeholder`` entrants for it (event A gets ``1..N``, event B
    ``N+1..``, so no synthetic player is ever in two events), runs the real draw
    over them (:func:`app.draws.strategy_for`), and assembles the pure
    :class:`~app.scheduling.ScheduleSnapshot` — pools become minute windows over
    the tournament's table catalogue, exactly as
    ``schedule_solves._load_solver_inputs`` builds it from DB rows, but from
    synthetic fixtures.

    Persists nothing: no ``TournamentEntry`` / ``TournamentFixture`` row is
    created. Raises :class:`~app.draws.UnsupportedDrawType` (from
    :func:`app.draws.strategy_for`) if any event's draw type has no strategy, and
    :class:`~app.draws.DegenerateDraw` if a synthesized field is too small for
    the event's pools — a clear domain error either way, never a partial
    snapshot. An event with no pools configured is one such case: the
    round-robin strategy refuses an empty pool set with
    :class:`~app.draws.DegenerateDraw`, which propagates.
    """
    overrides = count_overrides or {}

    catalogue_tables = [
        TournamentTable.model_validate(table) for table in tournament.table_catalogue
    ]
    catalogue = tuple(TableId(table.id) for table in catalogue_tables)
    catalogue_ids = set(catalogue)

    # First pass: plan every event's synthetic draw. A global counter mints the
    # entrant ids so they are disjoint across events (event A: 1..N, event B:
    # N+1.., ...) — no synthetic player is ever seated in two events.
    next_entrant = 1
    plans: list[_EventPlan] = []
    for event in tournament.events:
        pools = event_pools(event)
        settings = MatchSettings.model_validate(event.match_settings)
        field_size = _field_size(event, overrides.get(event.id))
        ordered_entrants = [
            OrderedEntrant(
                entry_id=EntryId(uuid.UUID(int=next_entrant + offset)),
                position=offset + 1,
            )
            for offset in range(field_size)
        ]
        next_entrant += field_size
        # The real draw, dispatched exactly as production's ``cut_draw`` does —
        # round-robin plans its whole draw; every other type (elim, swiss,
        # rr-then-ko) raises ``UnsupportedDrawType``, which propagates.
        fixtures = strategy_for(event.draw_type).plan_initial(
            draw_config(event), ordered_entrants
        )
        plans.append(
            _EventPlan(
                event=event,
                pools=pools,
                settings=settings,
                fixtures=fixtures,
                field_size=field_size,
            )
        )

    # The minute frame's origin: the earliest pool window start across every
    # event — the same anchor ``_load_solver_inputs`` uses, so ``now_min`` and
    # the windows share one frame. ``now`` is that origin (offset 0): a preview
    # asks "how long is the day starting from its first window", so the synthetic
    # field is free to schedule from the earliest window onward.
    windows: dict[str, tuple[datetime, datetime]] = {}
    for plan in plans:
        for pool in plan.pools:
            key = preview_pool_key(plan.event.id, pool.id)
            windows[key] = _slot_bounds(pool.slot.date, pool.slot.start, pool.slot.end)
    # ``base`` is ``None`` when no event has a pool (nothing to anchor on); the
    # minute frame then falls back to ``datetime.min`` (no window uses it anyway).
    base = min((start for start, _ in windows.values()), default=None)
    origin = base if base is not None else datetime.min

    def to_min(moment: datetime) -> int:
        return int((moment - origin).total_seconds() // 60)

    # Second pass: convert each planned event into pure snapshot value-objects.
    schedule_pools: list[SchedulePool] = []
    event_settings: list[EventSettings] = []
    schedule_fixtures: list[ScheduleFixture] = []
    summaries: list[EventFieldSummary] = []
    for plan in plans:
        event_id = EventId(str(plan.event.id))
        event_settings.append(
            EventSettings(id=event_id, length_games=plan.settings.length_games)
        )
        for pool in plan.pools:
            key = preview_pool_key(plan.event.id, pool.id)
            start, end = windows[key]
            tables = tuple(
                TableId(table_id)
                for table_id in pool.table_ids
                if TableId(table_id) in catalogue_ids
            )
            schedule_pools.append(
                SchedulePool(
                    id=PoolId(key),
                    table_ids=tables,
                    window=Window(start_min=to_min(start), end_min=to_min(end)),
                )
            )
        for fixture in plan.fixtures:
            schedule_fixtures.append(
                _schedule_fixture(plan.event.id, event_id, fixture)
            )
        summaries.append(
            EventFieldSummary(event_id=event_id, field_size=plan.field_size)
        )

    snapshot = ScheduleSnapshot(
        table_ids=catalogue,
        pools=tuple(schedule_pools),
        events=tuple(event_settings),
        fixtures=tuple(schedule_fixtures),
        now_min=0,
    )
    return PreviewSnapshot(
        snapshot=snapshot, field_summaries=tuple(summaries), base=base
    )


def _schedule_fixture(
    event_uuid: uuid.UUID, event_id: EventId, fixture: PlannedFixture
) -> ScheduleFixture:
    """Map one synthetic :class:`~app.draws.PlannedFixture` onto the solver's
    :class:`~app.scheduling.ScheduleFixture`.

    A previewable fixture is always pooled and both-sides-known (the pool stage
    of a round-robin draw), so ``pool_id`` and both entrant ids are non-``None``
    — an un-pooled or TBD fixture would be a bug in :func:`_plan_previewable`, so
    we let the ``None`` surface loudly rather than inventing a placeholder. The
    pool ref is namespaced by the event id, matching the ``SchedulePool`` keys;
    the fixture id is a deterministic, event-namespaced composite (unique because
    ``(pool, round, position)`` is unique within an event). Each synthetic
    entrant is its own human, so the entry id doubles as the ``PlayerId`` — and
    since entry ids are globally disjoint, so are the players.

    The entrant ids are minted as ``uuid.UUID(int=k)`` for the global ordinal
    ``k`` (``1..N``, disjoint across events), so ``entry_id.int`` recovers ``k``.
    The projected ``PlayerId`` is the client-facing ``placeholder-{k}`` spelling
    (the web client strips the ``placeholder-`` prefix to render "Placeholder
    k"); ``k`` is unique across events, so the players stay disjoint and the
    solver's no-double-book-by-player constraint holds.
    """
    assert fixture.pool_id is not None
    assert fixture.entry_a_id is not None
    assert fixture.entry_b_id is not None
    # One namespaced pool ref, used for both the fixture id and its pool_id so
    # the ``event:pool`` spelling cannot drift between them.
    pool_ref = preview_pool_key(event_uuid, fixture.pool_id)
    return ScheduleFixture(
        id=FixtureId(f"{pool_ref}:{fixture.round}:{fixture.position}"),
        event_id=event_id,
        pool_id=PoolId(pool_ref),
        player_a_id=PlayerId(f"placeholder-{fixture.entry_a_id.int}"),
        player_b_id=PlayerId(f"placeholder-{fixture.entry_b_id.int}"),
    )
