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

**Draw coverage is the POOL stage; everything else is skipped and said so.** That
is this **preview's** coverage, not the scheduler's reach: since ADR "a pool
restricts scheduling, it does not enable it" (20260807) a *live* solve places an
un-pooled fixture over its event's own window on the tournament's tables, so
preview and live solve deliberately differ here. What a preview cannot do is
older than pools and unchanged by that ADR: it runs **before anyone has
registered**, so no match has been played, so every fixture past a pool stage has
unknown sides — and no engine, live or preview, places a TBD-sided fixture.
Every event's draw is planned by
:func:`app.tournament_draws.strategy_for_event` — the single source of truth
production's own ``cut_draw`` uses:

* **round-robin** — the whole draw is planned and previewed;
* **rr-then-ko** — the whole draw is planned, and only its **pool stage** is
  previewed: the knockout fixtures (``pool_id IS NULL``) are dropped in the
  conversion pass below, because they are TBD-sided until the pools that feed them
  are played. A live solve does schedule that bracket, incrementally, as those
  pools resolve; a preview has nothing to resolve it from;
* **single-elim** — the **event** is skipped, and the skip is reported. Its
  bracket *has* a draw strategy (#785) and a live solve places it, but a preview
  would be laying out a round or two and guessing at the rest, so this builder
  previews none of it. The event still reaches the caller as an
  :class:`EventFieldSummary` carrying ``unpreviewable_draw_type``, which is what
  turns it into an honest note instead of an event that silently vanished;
* **swiss** — skipped the same way, sharing single-elim's ``case`` arm for
  single-elim's reason: a swiss draw pre-cuts a round and pairs each one only on
  advance (ADR "swiss pre-cuts every round and pairs each one on advance"), so
  before a ball is hit there is nothing to lay out. A live solve does place a
  swiss event, round by round as each round is paired.

**A skipped event costs its tournament nothing else.** This builder sits inside a
per-event loop of a whole-tournament build, so a refusal raised for one event
takes the preview of every unrelated event beside it (ADR 20260727 made that the
reason rr-then-ko's knockout stage is dropped rather than refused). A skipped
event contributes no fixtures, no pool windows and no event settings to the
snapshot — its pools are left out of the minute frame too, so a window it happens
to reserve can never make the rest of the day report a false ``infeasible``.

**One refusal survives, and it is about the whole tournament.** When *no* event is
previewable, :func:`build_preview_snapshot` raises
:class:`~app.draws.UnsupportedDrawType` naming the first skipped draw type. A
snapshot of nothing at all would solve to "it fits" over zero matches, which is
the false confidence a preview exists to avoid. This is the only surviving raiser
of that exception: :func:`app.draws.strategy_for` is total, because the enum holds
only draw types that run (ADR).

The per-event :class:`EventFieldSummary` (the count used, how many knockout
fixtures were left out, and the draw type that made the event unpreviewable) is
returned alongside the snapshot so :mod:`app.schedule_preview_solve` composes the
preview's honest-notes strip and per-event breakdown from it without re-deriving
it — including the notes that tell a director an rr-then-ko event's knockout stage
is not in the schedule they are looking at, and that a bracket or swiss event is
not in it at all.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import assert_never

from app.draws import (
    EntryId,
    OrderedEntrant,
    PlannedFixture,
    UnsupportedDrawType,
)
from app.models.tournament import DrawType, Tournament, TournamentEvent
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
from app.tournament_draws import draw_config, event_pools, strategy_for_event
from app.venue_time import anchor_wallclock

#: The synthetic field size for an *uncapped* event (``max_players IS NULL``,
#: ADR-0935). An uncapped event has no natural number to auto-fill to, so a
#: preview needs a stand-in; the director may always override it. Sixteen is a
#: plausible club-night field the ADR names as the default.
DEFAULT_UNCAPPED_FIELD = 16


#: The prefix every synthetic entrant's ``PlayerId`` carries — ``placeholder-{k}``
#: for the global ordinal ``k``. Minted by :func:`_schedule_fixture` and read back
#: by :func:`placeholder_label`, so the spelling lives in one place.
PLACEHOLDER_PREFIX = "placeholder-"


def placeholder_label(player_id: str) -> str:
    """``placeholder-7`` → ``Placeholder 7`` — the *display* name of a synthetic
    entrant, the way the preview surface already shows one to the director (ADR
    "the synthetic ids are shown as ``Placeholder N``").

    A preview's players are stand-ins, not humans, so there is nothing to look up:
    the label is derived from the id itself, with no DB read. This is how a
    DB-blind preview resolves the one infeasibility reason that names a *player*
    (:class:`~app.scheduling.PlayerOverSubscribed`) into the same resolved read
    form a real solve records."""
    return f"Placeholder {player_id.removeprefix(PLACEHOLDER_PREFIX)}"


def preview_pool_key(event_id: uuid.UUID, pool_id: uuid.UUID) -> str:
    """The one namespaced ``event:pool`` spelling every preview site keys a pool by
    — the ``SchedulePool`` id, a fixture's ``pool_id`` ref, and the enqueue verb's
    infeasibility-resolution map all pass through here, so the string contract lives
    in exactly one place and cannot drift between them.

    **The namespace is no longer needed for uniqueness, and is kept anyway.** It was
    minted because a pool id was a per-event string and two events of one tournament
    could each hold a "pool-a"; a pool id is a globally unique uuid now (ADR 20260801),
    so the ``event:`` prefix disambiguates nothing. It stays because the *key* is a wire
    value, not an implementation detail: it is what
    :class:`~app.schemas.schedule_preview.SchedulePreviewFixtureRead.pool_id` carries,
    what a stored solve's plan is keyed by, and what an infeasibility reason names — so
    dropping it would be a wire change with client follow-ups, and it would leave every
    solve row already in a database keyed in a space nothing computes any more. It also
    still earns its keep as a *label*: a solver pool id that says which event it belongs
    to is one a human reading a plan or a reason can place."""
    return f"{event_id}:{pool_id}"


@dataclass(frozen=True, slots=True)
class EventFieldSummary:
    """What one event contributed to the synthetic field — the honest-notes
    ingredients (ADR "always an honest-notes strip"), per event.

    ``field_size`` is the entrant count actually synthesized for the event (the
    override if the caller gave one, else the event's cap, else
    :data:`DEFAULT_UNCAPPED_FIELD`).

    ``knockout_fixtures`` is how many of the event's drawn fixtures this preview
    **left out** — the un-pooled knockout stage of an rr-then-ko draw (``0`` for a
    plain round-robin, which has none). It is *measured* on the way past rather than
    re-derived from the draw type downstream, so the honest note the caller writes
    from it says something is missing exactly when something is (api/CLAUDE.md —
    don't carry a field and its own derivation).

    ``unpreviewable_draw_type`` is the draw type that made this builder skip the
    **whole** event (single-elim or swiss), and ``None`` for an event that was
    previewed. A skipped event still gets a summary — that is the channel the
    caller's honest note is written from, and the reason the director is told the
    event was left out instead of wondering where it went. Nothing was synthesized
    for it, so its ``field_size`` and ``knockout_fixtures`` are ``0``: no field was
    minted, no draw was planned, and the caller reports the skip rather than an
    assumed count.
    """

    event_id: EventId
    field_size: int
    knockout_fixtures: int
    unpreviewable_draw_type: DrawType | None = None


@dataclass(frozen=True, slots=True)
class PreviewSnapshot:
    """The output of :func:`build_preview_snapshot`: the frozen
    :class:`~app.scheduling.ScheduleSnapshot` ready to hand to
    :func:`app.scheduling.solve`, plus one :class:`EventFieldSummary` per event
    it synthesized a field for (in the tournament's own event order).

    ``base`` is the **timezone-aware instant** origin of the snapshot's minute frame
    — the earliest pool window start across every event (each anchored to its event's
    venue ``timezone``), the anchor the snapshot's ``now_min`` is offset from — or
    ``None`` when no event has a pool (no window to anchor on), in which case a caller
    reports a duration in minutes but no wall-clock finish. It is aware (not naive) so
    the downstream ``estimated_finish`` it seeds is aware too (api/CLAUDE.md — a
    response schema must not emit a naïve datetime). The builder already computes it to
    set the frame, so it is handed back rather than re-derived downstream."""

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


def _slot_bounds(
    date: str, start: str, end: str, timezone: str
) -> tuple[datetime, datetime]:
    """A pool ``Slot``'s window as timezone-aware **instants**, its ``{date, start,
    end}`` wall-clock components anchored by the event's venue ``timezone`` (ADR
    "tournament times are timezone-aware instants"). Anchoring is what puts every
    event's window on **one real-instant axis** — the same one the real solve's
    ``schedule_solves._slot_bounds`` uses — so a multi-timezone tournament's
    preview verdict/duration/finish agree with production instead of mis-comparing
    two venues' naive wall-clocks. Reuses the #1152 ``venue_time`` primitive rather
    than re-deriving the anchor, and does not import the RQ/Redis-heavy
    ``schedule_solves`` module into this pure builder."""
    return (
        anchor_wallclock(
            datetime.strptime(f"{date} {start}", "%Y-%m-%d %H:%M"), timezone
        ),
        anchor_wallclock(
            datetime.strptime(f"{date} {end}", "%Y-%m-%d %H:%M"), timezone
        ),
    )


@dataclass(frozen=True, slots=True)
class _EventPlan:
    """One event's synthesized field and draw, held between the two passes: the
    first pass plans every previewable event (and finds the earliest window that
    anchors the minute frame); the second converts to the pure snapshot once
    ``base`` is known."""

    event: TournamentEvent
    pools: list[Pool]
    settings: MatchSettings
    fixtures: list[PlannedFixture]
    field_size: int


@dataclass(frozen=True, slots=True)
class _SkippedEvent:
    """One event this preview covers **nothing** of, and the ``draw_type`` that is
    why (single-elim or swiss).

    A sibling of :class:`_EventPlan` rather than a flag on it, so a skipped event
    cannot carry a field size, a pool window or a fixture it never had: it keeps its
    place in the tournament's event order (the second pass walks both kinds in one
    list) and contributes only its summary, which the caller turns into the honest
    note naming it."""

    event: TournamentEvent
    draw_type: DrawType


def build_preview_snapshot(
    tournament: Tournament,
    *,
    count_overrides: Mapping[uuid.UUID, int] | None = None,
    now: datetime | None = None,
) -> PreviewSnapshot:
    """Synthesize a :class:`PreviewSnapshot` from a *loaded* tournament's config.

    ``tournament`` must have its ``events`` (and their pools/settings) already
    loaded — this builder issues no query. For each event it fills a synthetic
    field to the event's cap (or ``count_overrides[event.id]`` when given, or
    :data:`DEFAULT_UNCAPPED_FIELD` for an uncapped event), mints **globally
    disjoint** ``Placeholder`` entrants for it (event A gets ``1..N``, event B
    ``N+1..``, so no synthetic player is ever in two events), runs the real draw
    over them (:func:`app.tournament_draws.strategy_for_event`), and assembles the pure
    :class:`~app.scheduling.ScheduleSnapshot` — pools become minute windows over
    the tournament's table catalogue, exactly as
    ``schedule_solves._load_solver_inputs`` builds it from DB rows, but from
    synthetic fixtures.

    ``now`` is the real wall-clock instant the preview is judged *from* (an aware
    ``datetime``; defaults to :func:`datetime.now` in UTC when omitted). It is
    **injected**, not read deep inside, so a test can pin it — and it is what makes
    the preview agree with the live solve: the snapshot's ``now_min`` is ``now``'s
    offset from the frame origin, so a pool dated in the past reports the *same*
    :class:`~app.scheduling.PastWindow` infeasibility a pre-live solve would (ADR
    "fits/doesn't fit means exactly what it will at go-live", #1101), instead of the
    old hardcoded ``now_min = 0`` that could never trip the past-window guard.

    Persists nothing: no ``TournamentEntry`` / ``TournamentFixture`` row is
    created.

    An event this PREVIEW covers nothing of — today single-elim and swiss, whose
    every fixture is TBD-sided before a ball is hit — is **skipped**, not refused:
    it contributes no fixtures, no pool windows and no event settings, and comes
    back as an :class:`EventFieldSummary` carrying ``unpreviewable_draw_type`` for
    the caller to write an honest note from. Every other event of the tournament is
    previewed as usual, which is the point: this builder is per-tournament, so a
    refusal raised for one event takes every event beside it with it. An
    **rr-then-ko** event is not skipped at all — its pool stage places exactly as a
    round-robin's does and is previewed, and only its knockout fixtures are dropped
    (ADR 20260727).

    Raises :class:`~app.draws.UnsupportedDrawType` — itself, not from
    :func:`app.draws.strategy_for`, which is total — only when **no** event of the
    tournament is previewable, naming the first skipped draw type: there is nothing
    left to hand back, and an empty snapshot would solve to "it fits" over zero
    matches. Also raises :class:`~app.draws.DegenerateDraw` if a synthesized field
    is too small for the event's pools — a clear domain error either way, never a
    partial snapshot. An event with no pools configured is one such case: the
    round-robin strategy refuses an empty pool set with
    :class:`~app.draws.DegenerateDraw`, which propagates.
    """
    overrides = count_overrides or {}
    now = now if now is not None else datetime.now(UTC)

    # The catalogue is rows now (ADR 20260801), eagerly loaded on the tournament and
    # already in the director's order. The solver's ``TableId`` stays a string, so a
    # table's UUID id crosses into it as its text.
    catalogue_tables = [
        TournamentTable.model_validate(table) for table in tournament.tables
    ]
    catalogue = tuple(TableId(str(table.id)) for table in catalogue_tables)
    catalogue_ids = set(catalogue)

    # First pass: plan every previewable event's synthetic draw. A global counter
    # mints the entrant ids so they are disjoint across events (event A: 1..N, event
    # B: N+1.., ...) — no synthetic player is ever seated in two events. A skipped
    # event mints none: no field is synthesized for an event nothing is previewed of.
    next_entrant = 1
    plans: list[_EventPlan | _SkippedEvent] = []
    for event in tournament.events:
        # Off the event's ``draw_settings`` row — the one home of the draw type
        # (ADR "an event's draw configuration is a row, not a column") — bound once
        # so the exhaustive ``match`` below narrows a name rather than re-deriving it
        # per branch.
        draw_type = event.draw_settings.draw_type
        match draw_type:
            case DrawType.round_robin | DrawType.rr_then_ko:
                # The real draw, dispatched exactly as production's ``cut_draw`` does.
                #
                # ``rr-then-ko`` is planned in FULL and previewed in part: its pools
                # schedule exactly as a round-robin's do, and its knockout fixtures are
                # dropped in the conversion pass below (ADR 20260727). Planning the
                # whole draw rather than cutting a round-robin in its place is what
                # keeps the previewed pools the ones production would deal — the same
                # snake, and the same cut-time refusals (``DegenerateDraw`` when K
                # exceeds the smallest pool) a director would meet for real.
                field_size = _field_size(event, overrides.get(event.id))
                ordered_entrants = [
                    OrderedEntrant(
                        entry_id=EntryId(uuid.UUID(int=next_entrant + offset)),
                        position=offset + 1,
                    )
                    for offset in range(field_size)
                ]
                next_entrant += field_size
                plans.append(
                    _EventPlan(
                        event=event,
                        pools=event_pools(event),
                        settings=MatchSettings.model_validate(event.match_settings),
                        fixtures=strategy_for_event(event).plan_initial(
                            draw_config(event), ordered_entrants
                        ),
                        field_size=field_size,
                    )
                )
            case DrawType.single_elim | DrawType.swiss:
                # Skipped, not refused — and skipped for a reason that is no longer
                # about pools. A live solve does place both of these, over the event's
                # own window (ADR "a pool restricts scheduling, it does not enable
                # it"); what a PREVIEW cannot do is lay out a draw that is decided as
                # it is played, since it runs before anyone has registered. Refusing
                # here would be per-event in name only: this loop builds one
                # tournament, so it would take the preview of every round-robin event
                # beside it (the same reasoning ADR 20260727 applied to rr-then-ko's
                # knockout stage). Swiss shares the arm for single-elim's reason (ADR
                # "swiss pre-cuts every round and pairs each one on advance").
                plans.append(_SkippedEvent(event=event, draw_type=draw_type))
            case _:
                assert_never(draw_type)

    # The one refusal left, and it is about the whole tournament rather than an
    # event: nothing at all is previewable here, so there is no partial preview to
    # give and an empty snapshot would solve to "it fits" over zero matches — the
    # false confidence a preview exists to avoid. Named after the first skipped draw
    # type, so the director-facing sentence says which format it is. A tournament with
    # no events at all is *not* this case: it has nothing to preview and nothing to
    # blame, and keeps answering with an empty snapshot.
    skipped = [plan for plan in plans if isinstance(plan, _SkippedEvent)]
    if skipped and len(skipped) == len(plans):
        raise UnsupportedDrawType(skipped[0].draw_type)

    # The minute frame's origin: the earliest pool window start across every
    # previewable event — the same anchor ``_load_solver_inputs`` uses, so ``now_min``
    # and the windows share one frame. A skipped event's pools are deliberately absent:
    # nothing of that event is placed, so a window it reserves must neither move the
    # frame nor reach the solver, where an empty or past-dated one would report an
    # infeasibility against an event that was never drawn.
    windows: dict[str, tuple[datetime, datetime]] = {}
    for plan in plans:
        if isinstance(plan, _SkippedEvent):
            continue
        for pool in plan.pools:
            key = preview_pool_key(plan.event.id, pool.id)
            # The event's own venue ``timezone`` anchors its pools' wall-clock
            # windows to instants, so two events in different zones land on one
            # axis — exactly as ``_load_solver_inputs`` anchors the real solve.
            windows[key] = _slot_bounds(
                pool.slot.date, pool.slot.start, pool.slot.end, plan.event.timezone
            )
    # ``base`` is ``None`` when no event has a pool (nothing to anchor on); the
    # minute frame then falls back to ``datetime.min`` (no window uses it anyway).
    base = min((start for start, _ in windows.values()), default=None)
    origin = base if base is not None else datetime.min

    def to_min(moment: datetime) -> int:
        return int((moment - origin).total_seconds() // 60)

    # ``now_min`` is the real current instant's offset from the frame origin —
    # exactly how ``_load_solver_inputs`` derives the live solve's ``now`` (both
    # ``to_min(now)`` off the same earliest-window base), so the preview's verdict
    # agrees with go-live. Clipped at 0 when the earliest window hasn't opened yet
    # (a future-dated tournament): the day still schedules from its first window,
    # exactly as the pre-live solve does, and the past-window guard (which fires on
    # ``window.end_min <= now_min``) stays inert until a window is genuinely behind
    # us. When ``base`` is ``None`` there are no windows or fixtures to place, so the
    # frame is empty and ``now_min`` is a harmless 0 (``origin`` is naive there — a
    # ``to_min(now)`` on the aware ``now`` would be meaningless anyway).
    now_min = max(0, to_min(now)) if base is not None else 0

    # Second pass: convert each planned event into pure snapshot value-objects.
    schedule_pools: list[SchedulePool] = []
    event_settings: list[EventSettings] = []
    schedule_fixtures: list[ScheduleFixture] = []
    summaries: list[EventFieldSummary] = []
    for plan in plans:
        event_id = EventId(str(plan.event.id))
        if isinstance(plan, _SkippedEvent):
            # The whole contribution of a skipped event: a summary naming the draw
            # type that made it unpreviewable. No fixtures, no pools, no
            # ``EventSettings`` — the snapshot must not carry an event the solver
            # would then have nothing to place — but it keeps its seat in the
            # tournament's event order so the caller's note, and the per-event
            # breakdown built beside it, still name the event the director is missing.
            summaries.append(
                EventFieldSummary(
                    event_id=event_id,
                    field_size=0,
                    knockout_fixtures=0,
                    unpreviewable_draw_type=plan.draw_type,
                )
            )
            continue
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
        # Counted, not just dropped: the caller turns a non-zero count into the honest
        # note that this event's knockout stage is missing from the schedule shown.
        knockout_fixtures = 0
        for fixture in plan.fixtures:
            if fixture.pool_id is None:
                # The knockout stage of an rr-then-ko draw (``pool_id IS NULL`` *is* the
                # stage, ADR-0786). Dropped here rather than refused, and the drop is
                # still right for a reason that is no longer about pools: a preview runs
                # before anyone has registered, so no pool has been played, so both
                # sides of every one of these fixtures are unknown — and a TBD-sided
                # fixture is unplaceable in this engine and in the live one alike. A
                # live solve does schedule the bracket (ADR "a pool restricts
                # scheduling, it does not enable it"), incrementally, as the pools
                # feeding it resolve; a preview has nothing to resolve it from.
                knockout_fixtures += 1
                continue
            schedule_fixtures.append(
                _schedule_fixture(plan.event.id, event_id, fixture)
            )
        summaries.append(
            EventFieldSummary(
                event_id=event_id,
                field_size=plan.field_size,
                knockout_fixtures=knockout_fixtures,
            )
        )

    snapshot = ScheduleSnapshot(
        table_ids=catalogue,
        pools=tuple(schedule_pools),
        events=tuple(event_settings),
        fixtures=tuple(schedule_fixtures),
        now_min=now_min,
    )
    return PreviewSnapshot(
        snapshot=snapshot, field_summaries=tuple(summaries), base=base
    )


def _schedule_fixture(
    event_uuid: uuid.UUID, event_id: EventId, fixture: PlannedFixture
) -> ScheduleFixture:
    """Map one synthetic :class:`~app.draws.PlannedFixture` onto the solver's
    :class:`~app.scheduling.ScheduleFixture`.

    A previewable fixture is always pooled and both-sides-known — a **pool-stage**
    fixture, of a round-robin draw or of the pool stage of an rr-then-ko one, the
    caller having already dropped the un-pooled knockout fixtures — so ``pool_id``
    and both entrant ids are non-``None``. An un-pooled or TBD fixture reaching
    here would be a bug in the caller's filter, so we let the ``None`` surface
    loudly rather than inventing a placeholder. The
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
        player_a_id=PlayerId(f"{PLACEHOLDER_PREFIX}{fixture.entry_a_id.int}"),
        player_b_id=PlayerId(f"{PLACEHOLDER_PREFIX}{fixture.entry_b_id.int}"),
    )
