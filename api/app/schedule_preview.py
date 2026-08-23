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
FastAPI construct. It reads a *loaded* tournament's config (its events, reservations,
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

**Draw coverage is the RESERVATION stage; everything else is skipped and said so.** That
is this **preview's** coverage, not the scheduler's reach: since ADR "a reservation
restricts scheduling, it does not enable it" (20260807) a *live* solve places an
ungrouped fixture over its event's own window on the tournament's tables, so
preview and live solve deliberately differ here. What a preview cannot do is
older than reservations and unchanged by that ADR: it runs **before anyone has
registered**, so no match has been played, so every fixture past a reservation stage has
unknown sides — and no engine, live or preview, places a TBD-sided fixture.
Every event's draw is planned by
:func:`app.tournament_draws.strategy_for_event` — the single source of truth
production's own ``cut_draw`` uses:

* **round-robin** — the whole draw is planned and previewed;
* **rr-then-ko** — the whole draw is planned, and only its **reservation stage** is
  previewed: the knockout fixtures (``reservation_id IS NULL``) are dropped in the
  conversion pass below, because they are TBD-sided until the reservations that feed
  them are played. A live solve does schedule that bracket, incrementally, as those
  reservations resolve; a preview has nothing to resolve it from;
* **single-elim** — the **event** is skipped, and the skip is reported. Its
  bracket *has* a draw strategy (#785) and a live solve places it, but a preview
  would be laying out a round or two and guessing at the rest, so this builder
  previews none of it. The event still reaches the caller as an
  :class:`EventFieldSummary` carrying an :class:`UnpreviewableDrawType` reason,
  which is what turns it into an honest note instead of an event that silently
  vanished;
* **swiss** — skipped the same way, sharing single-elim's ``case`` arm for
  single-elim's reason: a swiss draw pre-cuts a round and pairs each one only on
  advance (ADR "swiss pre-cuts every round and pairs each one on advance"), so
  before a ball is hit there is nothing to lay out. A live solve does place a
  swiss event, round by round as each round is paired.

**A configuration that cannot be cut skips its event too, and says the strategy's
own sentence.** A draw strategy refuses a config that would not be a competition
— a reservation of one, a knockout stage with a single qualifier in it — with
:class:`~app.draws.DegenerateDraw`. That refusal is correct and is not weakened
here: what is wrong is its *blast radius*, because it was raised per event and
propagated out of a per-tournament loop, so one misconfigured event blanked the
preview of every healthy event beside it. The event is skipped instead, carrying
the strategy's **verbatim** message (a :class:`DegenerateConfiguration`), because
that sentence names the numbers the director has to change and no other layer
knows them.

**A skipped event costs its tournament nothing else.** This builder sits inside a
per-event loop of a whole-tournament build, so a refusal raised for one event
takes the preview of every unrelated event beside it (ADR 20260727 made that the
reason rr-then-ko's knockout stage is dropped rather than refused). A skipped
event contributes no fixtures, no reservation windows and no event settings to the
snapshot — its reservations are left out of the minute frame too, so a window it happens
to reserve can never make the rest of the day report a false ``infeasible`` — and
it mints no synthetic entrant.

**One refusal survives, and it is about the whole tournament.** When *no* event is
previewable, :func:`build_preview_snapshot` re-raises the **first** skipped
event's own reason, in the tournament's own event order:
:class:`~app.draws.UnsupportedDrawType` naming that draw type, or
:class:`~app.draws.DegenerateDraw` carrying that message. A snapshot of nothing at
all would solve to "it fits" over zero matches, which is the false confidence a
preview exists to avoid. This module is the only surviving raiser of
``UnsupportedDrawType``: :func:`app.draws.strategy_for` is total, because the enum
holds only draw types that run (ADR).

The per-event :class:`EventFieldSummary` (the count used, how many knockout
fixtures were left out, and the :data:`SkipReason` that left the event out of the
preview whole) is returned alongside the snapshot so
:mod:`app.schedule_preview_solve` composes the preview's honest-notes strip and
per-event breakdown from it without re-deriving it — including the notes that tell
a director an rr-then-ko event's knockout stage is not in the schedule they are
looking at, and that a bracket, a swiss event or an event that cannot be cut is
not in it at all.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import assert_never

from app.draws import (
    DegenerateDraw,
    DrawError,
    EntryId,
    GroupId,
    OrderedEntrant,
    PlannedFixture,
    UnsupportedDrawType,
    group_label,
    seats_both_sides_at_cut,
)
from app.models.tournament import DrawType, Tournament, TournamentEvent
from app.schedule_solves import (
    event_wide_reservation_key,
    group_reservation_ids,
    reservation_key,
    reservation_keys_by_group,
)
from app.scheduling import (
    EventId,
    EventSettings,
    FixtureId,
    PlayerId,
    ReservationId,
    ScheduleFixture,
    ScheduleReservation,
    ScheduleSnapshot,
    TableId,
    Window,
)
from app.schemas.tournament import MatchSettings, Reservation, Slot, TournamentTable
from app.tournament_draws import draw_config, event_reservations, strategy_for_event
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


@dataclass(frozen=True, slots=True)
class UnpreviewableDrawType:
    """This event is out of the preview because of its **draw type** — single-elim or
    swiss, both fully supported and both placed by a live solve, but decided round by
    round as they are played, so before anyone has entered there is nothing to lay out.

    Carries the :class:`DrawType` **structurally**, so the layer that writes the
    director-facing sentence composes it from the fact rather than parsing a message,
    and so an all-unpreviewable tournament can be refused with an
    :class:`~app.draws.UnsupportedDrawType` that names the format."""

    draw_type: DrawType


@dataclass(frozen=True, slots=True)
class DegenerateConfiguration:
    """This event is out of the preview because its **configuration cannot be cut** —
    the draw strategy refused it with :class:`~app.draws.DegenerateDraw` (a group
    that would hold one entrant, a knockout stage that would hold one qualifier). An
    event with **no reservation** is no longer one of these: every stage holds at
    least one group whatever its reservation count (#1483's floor in
    ``app.tournament_reservations.group_count_for``), so a reservation-less event
    has groups to deal into and is previewed over the **event-wide** reservation
    (#1389).

    Carries the strategy's message **verbatim**, and that is the whole point: a
    ``DegenerateDraw``'s message is domain-authored copy naming the numbers the
    director has to change, and only the strategy knows which degeneracy it hit
    (``app.tournaments._draw_refusal`` passes it through unaltered for the same
    reason). A generic "could not be previewed" here would leave the director with
    nothing to act on."""

    message: str


#: Why this preview covers **nothing** of an event — a closed set, so the note the
#: director reads is written by an exhaustive ``match`` and a third reason is a type
#: error until it is handled. Two cases with genuinely different content: a draw type
#: (structural, no message to carry) and a refused configuration (a message and
#: nothing else), which is why this is a union rather than one class with two
#: optional fields that could contradict each other.
SkipReason = UnpreviewableDrawType | DegenerateConfiguration


def skip_refusal(reason: SkipReason) -> DrawError:
    """The whole-tournament refusal that a :data:`SkipReason` becomes when it is the
    **only** thing a tournament had to say — see :func:`build_preview_snapshot`.

    One place, so the mapping from "why this event was left out" to "why this
    tournament cannot be previewed at all" cannot drift between them, and each error
    keeps the payload its own transport arm reads: ``UnsupportedDrawType`` its
    structural ``draw_type``, ``DegenerateDraw`` the strategy's verbatim message."""
    match reason:
        case UnpreviewableDrawType():
            return UnsupportedDrawType(reason.draw_type)
        case DegenerateConfiguration():
            return DegenerateDraw(reason.message)
        case _:
            assert_never(reason)


@dataclass(frozen=True, slots=True)
class EventFieldSummary:
    """What one event contributed to the synthetic field — the honest-notes
    ingredients (ADR "always an honest-notes strip"), per event.

    ``field_size`` is the entrant count actually synthesized for the event (the
    override if the caller gave one, else the event's cap, else
    :data:`DEFAULT_UNCAPPED_FIELD`).

    ``knockout_fixtures`` is how many of the event's drawn fixtures this preview
    **left out** — the ungrouped knockout stage of an rr-then-ko draw (``0`` for a
    plain round-robin, which has none). It is *measured* on the way past rather than
    re-derived from the draw type downstream, so the honest note the caller writes
    from it says something is missing exactly when something is (api/CLAUDE.md —
    don't carry a field and its own derivation).

    ``skip_reason`` is why this builder skipped the **whole** event — its draw type
    (single-elim or swiss) or a configuration the draw refused — and ``None`` for an
    event that was previewed. A skipped event still gets a summary: that is the
    channel the caller's honest note is written from, and the reason the director is
    told the event was left out instead of wondering where it went. Nothing was
    synthesized for it, so its ``field_size`` and ``knockout_fixtures`` are ``0``: no
    field was minted, no draw was planned, and the caller reports the skip rather than
    an assumed count.
    """

    event_id: EventId
    field_size: int
    knockout_fixtures: int
    skip_reason: SkipReason | None = None


@dataclass(frozen=True, slots=True)
class PreviewSnapshot:
    """The output of :func:`build_preview_snapshot`: the frozen
    :class:`~app.scheduling.ScheduleSnapshot` ready to hand to
    :func:`app.scheduling.solve`, plus one :class:`EventFieldSummary` per event
    it synthesized a field for (in the tournament's own event order).

    ``base`` is the **timezone-aware instant** origin of the snapshot's minute frame
    — the earliest reservation window start across every event (each anchored to its
    event's venue ``timezone``), the anchor the snapshot's ``now_min`` is offset from —
    or ``None`` when no event has a reservation (no window to anchor on), in which case
    a caller reports a duration in minutes but no wall-clock finish. It is aware (not
    naive) so the downstream ``estimated_finish`` it seeds is aware too (api/CLAUDE.md —
    a response schema must not emit a naïve datetime). The builder already computes it
    to
    set the frame, so it is handed back rather than re-derived downstream."""

    snapshot: ScheduleSnapshot
    field_summaries: tuple[EventFieldSummary, ...]
    base: datetime | None
    #: Snapshot fixture id → the ``Group C`` label of the group that holds it (#1389):
    #: the pure snapshot speaks only ids, and a fixture card names its group beside
    #: its reservation, so the builder — the one place that still holds the group
    #: rows — hands the labels back with the snapshot. Total over
    #: ``snapshot.fixtures``, and required so a snapshot cannot be built without it.
    #: Whether an event got an **event-wide reservation** is not carried beside this:
    #: it is already a fact of ``snapshot.reservations`` (its key is
    #: :func:`~app.schedule_solves.event_wide_reservation_key`), read off there.
    group_labels: Mapping[str, str]


def preview_field_size(max_players: int | None) -> int:
    """The **preview field** (``CONTEXT.md``): the invented number of entrants the app
    reasons against before registration closes — the event's ``max_players`` cap, or
    :data:`DEFAULT_UNCAPPED_FIELD` for an uncapped (``NULL`` cap) event.

    The one server-side spelling of that rule. The schedule preview's synthetic field
    (:func:`_field_size`) and the group materialisation on an event write
    (``app.tournament_events``, through
    ``app.tournament_reservations.materialise_event_groups``, #1387) both read it, so
    the rows a write materialises and the field the preview deals into them cannot
    disagree. The client's copy is
    ``web-client/.../draw-structure-section/preview-field.ts``, with the same 16.
    """
    if max_players is not None:
        return max_players
    return DEFAULT_UNCAPPED_FIELD


def _field_size(event: TournamentEvent, override: int | None) -> int:
    """How many synthetic entrants to invent for this event: the override if the
    caller gave one, else the event's preview field (:func:`preview_field_size`)."""
    if override is not None:
        return override
    return preview_field_size(event.max_players)


def _slot_bounds(
    date: str, start: str, end: str, timezone: str
) -> tuple[datetime, datetime]:
    """A reservation ``Slot``'s window as timezone-aware **instants**, its
    ``{date, start, end}`` wall-clock components anchored by the event's venue
    ``timezone`` (ADR "tournament times are timezone-aware instants"). Anchoring is
    what puts every event's window on **one real-instant axis** — the same one the
    real solve's
    ``schedule_solves._slot_bounds`` uses — so a multi-timezone tournament's
    preview verdict/duration/finish agree with production instead of mis-comparing
    two venues' naive wall-clocks. Reuses the #1152 ``venue_time`` primitive rather
    than re-deriving the anchor. Takes the slot's components rather than a parsed
    ``Slot`` because a projected reservation carries them as strings; the live
    solve's twin takes the ``Slot``. Both anchor through ``anchor_wallclock``."""
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
    reservations: list[Reservation]
    settings: MatchSettings
    fixtures: list[PlannedFixture]
    field_size: int


def _previewed_fixtures(plan: _EventPlan) -> list[tuple[PlannedFixture, GroupId]]:
    """The fixtures of ``plan`` the preview places, each paired with the group it is
    dealt into: the ones whose **own stage seats both sides at the cut**
    (:func:`~app.draws.seats_both_sides_at_cut`). What that drops is the knockout
    stage of an rr-then-ko draw — see the drop in :func:`build_preview_snapshot`,
    which also counts it for the honest note.

    **Asked of the stage, never of the group id.** Those two answered alike only
    while a bracket was un-grouped end to end; #1483 deals a single-elim or swiss
    stage's fixtures into its group, so ``group_id is not None`` would now keep
    fixtures whose every side is TBD — unplaceable in this engine and in the live one
    alike — and would silently drop the honest note that says so. The stage's own
    draw type is the fact that was always meant here.

    **The group comes back with the fixture**, rather than being re-derived by the
    caller behind an ``assert``. A round-robin stage deals every one of its fixtures
    into a group by construction, so the pair is total for everything this keeps; the
    filter is the one place that has to say so, and a fixture that somehow carried
    none is dropped there rather than crashing the whole tournament's preview
    hundreds of lines later.
    """
    kept: list[tuple[PlannedFixture, GroupId]] = []
    for fixture in plan.fixtures:
        if not seats_both_sides_at_cut(fixture.stage.draw_type):
            continue
        group_id = fixture.group_id
        if group_id is None:
            continue
        kept.append((fixture, group_id))
    return kept


@dataclass(frozen=True, slots=True)
class _SkippedEvent:
    """One event this preview covers **nothing** of, and the :data:`SkipReason` that
    is why — its draw type, or a configuration the draw refused.

    A sibling of :class:`_EventPlan` rather than a flag on it, so a skipped event
    cannot carry a field size, a reservation window or a fixture it never had: it keeps
    its place in the tournament's event order (the second pass walks both kinds in one
    list) and contributes only its summary, which the caller turns into the honest note
    naming it. One kind of skipped event, whatever the reason, so a degenerate
    configuration inherits every one of those guarantees rather than getting a second,
    weaker path to the same place."""

    event: TournamentEvent
    reason: SkipReason


def build_preview_snapshot(
    tournament: Tournament,
    *,
    count_overrides: Mapping[uuid.UUID, int] | None = None,
    now: datetime | None = None,
) -> PreviewSnapshot:
    """Synthesize a :class:`PreviewSnapshot` from a *loaded* tournament's config.

    ``tournament`` must have its ``events`` (and their reservations/settings) already
    loaded — this builder issues no query. For each event it fills a synthetic
    field to the event's cap (or ``count_overrides[event.id]`` when given, or
    :data:`DEFAULT_UNCAPPED_FIELD` for an uncapped event), mints **globally
    disjoint** ``Placeholder`` entrants for it (event A gets ``1..N``, event B
    ``N+1..``, so no synthetic player is ever in two events), runs the real draw
    over them (:func:`app.tournament_draws.strategy_for_event`), and assembles the pure
    :class:`~app.scheduling.ScheduleSnapshot` — reservations become minute windows over
    the tournament's table catalogue, exactly as
    ``schedule_solves._load_solver_inputs`` builds it from DB rows, but from
    synthetic fixtures.

    ``now`` is the real wall-clock instant the preview is judged *from* (an aware
    ``datetime``; defaults to :func:`datetime.now` in UTC when omitted). It is
    **injected**, not read deep inside, so a test can pin it — and it is what makes
    the preview agree with the live solve: the snapshot's ``now_min`` is ``now``'s
    offset from the frame origin, so a reservation dated in the past reports the *same*
    :class:`~app.scheduling.PastWindow` infeasibility a pre-live solve would (ADR
    "fits/doesn't fit means exactly what it will at go-live", #1101), instead of the
    old hardcoded ``now_min = 0`` that could never trip the past-window guard.

    Persists nothing: no ``TournamentEntry`` / ``TournamentFixture`` row is
    created.

    An event this PREVIEW covers nothing of is **skipped**, not refused: it
    contributes no fixtures, no reservation windows, no event settings and no synthetic
    entrants, and comes back as an :class:`EventFieldSummary` carrying its
    :data:`SkipReason` for the caller to write an honest note from. Two things put an
    event there:

    * its **draw type** — today single-elim and swiss, whose every fixture is
      TBD-sided before a ball is hit (:class:`UnpreviewableDrawType`);
    * its **configuration** — the draw strategy refusing a cut that would not be a
      competition, with :class:`~app.draws.DegenerateDraw`
      (:class:`DegenerateConfiguration`, carrying that refusal's message verbatim).
      A field too small for the groups it is asked to fill is one such case. Having
      **no reservation** is not, since #1389 and #1483 — every event holds at least
      one group whatever its reservation count, and a group with no reservation
      resolves to the **event-wide reservation** (the event's own slot over the whole
      catalogue, exactly as the live solve builds it), so the event is previewed.

    Every other event of the tournament is previewed as usual, which is the point:
    this builder is per-tournament, so a refusal raised for one event takes every
    event beside it with it. An **rr-then-ko** event is not skipped for its draw type
    at all — its reservation stage places exactly as a round-robin's does and is
    previewed, and only its knockout fixtures are dropped (ADR 20260727).

    Raises only when **no** event of the tournament is previewable, and raises the
    **first** skipped event's own reason (:func:`skip_refusal`): there is nothing left
    to hand back, and an empty snapshot would solve to "it fits" over zero matches. So
    a bracket-only tournament is an :class:`~app.draws.UnsupportedDrawType` naming
    that draw type — this module raises it itself; :func:`app.draws.strategy_for` is
    total — and a tournament whose one event cannot be cut is the strategy's own
    :class:`~app.draws.DegenerateDraw`, message intact, which is what puts the numbers
    the director must change in the 422 they read.
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
                # ``rr-then-ko`` is planned in FULL and previewed in part: its
                # reservations schedule exactly as a round-robin's do, and its knockout
                # fixtures are dropped in the conversion pass below (ADR 20260727).
                # Planning the whole draw rather than cutting a round-robin in its place
                # is what keeps the previewed reservations the ones production would
                # deal — the same snake, and the same cut-time refusals
                # (``DegenerateDraw`` when K exceeds the smallest reservation) a
                # director would meet for real.
                field_size = _field_size(event, overrides.get(event.id))
                ordered_entrants = [
                    OrderedEntrant(
                        entry_id=EntryId(uuid.UUID(int=next_entrant + offset)),
                        position=offset + 1,
                    )
                    for offset in range(field_size)
                ]
                try:
                    planned = _EventPlan(
                        event=event,
                        reservations=event_reservations(event),
                        settings=MatchSettings.model_validate(event.match_settings),
                        fixtures=strategy_for_event(event).plan_initial(
                            draw_config(event), ordered_entrants
                        ),
                        field_size=field_size,
                    )
                except DegenerateDraw as refusal:
                    # The draw refusing a configuration that would not be a
                    # competition — a group of one, a knockout stage of one
                    # qualifier. The refusal is right and is
                    # left alone; only its reach is fixed. It is raised per event, but
                    # this loop builds one TOURNAMENT, so letting it propagate blanked
                    # the preview of every healthy event beside it (exactly the defect a
                    # skipped draw type was already fixed for). The strategy's message
                    # rides along verbatim: it names the numbers the director has to
                    # change, and recomposing it here would be a second copy of a rule
                    # this module does not own.
                    plans.append(
                        _SkippedEvent(
                            event=event,
                            reason=DegenerateConfiguration(str(refusal)),
                        )
                    )
                    continue
                # Only a planned event consumes its slice of the id space — a skipped
                # one mints no entrant, so the counter advances past the fields that
                # actually exist.
                next_entrant += field_size
                plans.append(planned)
            case DrawType.single_elim | DrawType.swiss:
                # Skipped, not refused — and skipped for a reason that is no longer
                # about reservations. A live solve does place both of these: since
                # #1483 their fixtures are dealt into their stage's group, so a booked
                # event's draw is confined to that group's reservation, and an unbooked
                # one still falls to the event's own window (ADR "a reservation
                # restricts scheduling, it does not enable it"). What a PREVIEW cannot
                # do either way is lay out a draw that is decided as it is played,
                # since it runs before anyone has registered.
                # Refusing here would be per-event in name only: this loop builds one
                # tournament, so it would take the preview of every round-robin event
                # beside it (the same reasoning ADR 20260727 applied to rr-then-ko's
                # knockout stage). Swiss shares the arm for single-elim's reason (ADR
                # "swiss pre-cuts every round and pairs each one on advance").
                plans.append(
                    _SkippedEvent(event=event, reason=UnpreviewableDrawType(draw_type))
                )
            case _:
                assert_never(draw_type)

    # The one refusal left, and it is about the whole tournament rather than an
    # event: nothing at all is previewable here, so there is no partial preview to
    # give and an empty snapshot would solve to "it fits" over zero matches — the
    # false confidence a preview exists to avoid. It speaks the FIRST skipped event's
    # own reason, in the tournament's own event order — the same positional rule as
    # before, generalized from "the first skipped draw type" to "the first event that
    # could not be previewed, and why" — so a mixed tournament needs no priority
    # ranking between two refusals that reach the director through the one 422 mapper.
    # A tournament with no events at all is *not* this case: it has nothing to preview
    # and nothing to blame, and keeps answering with an empty snapshot.
    skipped = [plan for plan in plans if isinstance(plan, _SkippedEvent)]
    if skipped and len(skipped) == len(plans):
        raise skip_refusal(skipped[0].reason)

    # The minute frame's origin: the earliest reservation window start across every
    # previewable event — the same anchor ``_load_solver_inputs`` uses, so ``now_min``
    # and the windows share one frame. A skipped event's reservations are deliberately
    # absent: nothing of that event is placed, so a window it reserves must neither move
    # the frame nor reach the solver, where an empty or past-dated one would report an
    # infeasibility against an event that was never drawn.
    windows: dict[ReservationId, tuple[datetime, datetime]] = {}
    for plan in plans:
        if isinstance(plan, _SkippedEvent):
            continue
        for reservation in plan.reservations:
            key = reservation_key(plan.event.id, reservation.id)
            # The event's own venue ``timezone`` anchors its reservations' wall-clock
            # windows to instants, so two events in different zones land on one
            # axis — exactly as ``_load_solver_inputs`` anchors the real solve.
            windows[key] = _slot_bounds(
                reservation.slot.date,
                reservation.slot.start,
                reservation.slot.end,
                plan.event.timezone,
            )
        # The event-wide reservation (ADR "a reservation restricts scheduling, it does
        # not enable it"), exactly as ``_load_solver_inputs`` builds it for the live
        # solve: one synthetic reservation for the fixtures that resolve to no booked
        # one — every group of an rr-then-ko event with no reservation (#1387). Its
        # window is the event's own ``slot`` read in the event's zone; its tables are
        # the whole tournament catalogue (below). Built exactly when a previewed
        # fixture resolves to it, through the one rule the live solve resolves by
        # (:func:`restricting_reservation_key`), so the per-fixture lookup below is
        # total. A reservation restricts, so its absence must not remove capability:
        # skipping the event would deny a preview the director could have had, and
        # dropping the fixtures would show an rr-then-ko event with nothing in it.
        #
        # Only a PREVIEWED fixture counts. The knockout stage resolves to no
        # reservation too, but it is dropped before the solver sees it (TBD-sided), so
        # an rr-then-ko event whose groups are all booked builds no event-wide window
        # and its frame origin stays its reservations' — unchanged behaviour.
        keys_by_group = reservation_keys_by_group(
            plan.event.id, group_reservation_ids(plan.event)
        )
        event_wide_key = event_wide_reservation_key(plan.event.id)
        if any(
            keys_by_group[group_id] == event_wide_key
            for _, group_id in _previewed_fixtures(plan)
        ):
            event_slot = Slot.model_validate(plan.event.slot)
            windows[event_wide_key] = _slot_bounds(
                event_slot.date, event_slot.start, event_slot.end, plan.event.timezone
            )
    # ``base`` is ``None`` when no event has a reservation, booked or event-wide
    # (nothing to anchor on); the minute frame then falls back to ``datetime.min``
    # (no window uses it anyway).
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
    schedule_reservations: list[ScheduleReservation] = []
    event_settings: list[EventSettings] = []
    schedule_fixtures: list[ScheduleFixture] = []
    group_labels: dict[str, str] = {}
    summaries: list[EventFieldSummary] = []
    for plan in plans:
        event_id = EventId(str(plan.event.id))
        if isinstance(plan, _SkippedEvent):
            # The whole contribution of a skipped event: a summary carrying the reason
            # it was left out. No fixtures, no reservations, no ``EventSettings`` — the
            # snapshot must not carry an event the solver would then have nothing to
            # place — but it keeps its seat in the tournament's event order so the
            # caller's note, and the per-event breakdown built beside it, still name
            # the event the director is missing.
            summaries.append(
                EventFieldSummary(
                    event_id=event_id,
                    field_size=0,
                    knockout_fixtures=0,
                    skip_reason=plan.reason,
                )
            )
            continue
        event_settings.append(
            EventSettings(id=event_id, length_games=plan.settings.length_games)
        )
        for reservation in plan.reservations:
            key = reservation_key(plan.event.id, reservation.id)
            start, end = windows[key]
            tables = tuple(
                TableId(table_id)
                for table_id in reservation.table_ids
                if TableId(table_id) in catalogue_ids
            )
            schedule_reservations.append(
                ScheduleReservation(
                    id=key,
                    table_ids=tables,
                    window=Window(start_min=to_min(start), end_min=to_min(end)),
                )
            )
        event_wide_key = event_wide_reservation_key(plan.event.id)
        if event_wide_key in windows:
            # One spec per reservation, the event-wide one included: the windows
            # pass decided whether this event has one, and this is its only entry.
            start, end = windows[event_wide_key]
            schedule_reservations.append(
                ScheduleReservation(
                    id=event_wide_key,
                    table_ids=catalogue,
                    window=Window(start_min=to_min(start), end_min=to_min(end)),
                )
            )
        keys_by_group = reservation_keys_by_group(
            plan.event.id, group_reservation_ids(plan.event)
        )
        group_labels_by_id = {
            group.id: group_label(group.position) for group in plan.event.groups
        }
        # The SAME filter the windows pass used (``_previewed_fixtures``), so the set
        # of fixtures that reach the snapshot is exactly the set the event-wide guard
        # judged — a fixture kept here is keyed to a window that pass built, and a
        # window built there holds at least one fixture, so the frame origin cannot
        # drift onto an empty window.
        #
        # What the filter drops is the knockout stage of an rr-then-ko draw, read off
        # the fixture's own STAGE (:func:`~app.draws.seats_both_sides_at_cut`) rather
        # than off a null group id — since #1483 a bracket names a group and the two
        # questions have different answers. Dropped rather than refused, and the drop
        # is still right for a reason that is not about reservations: a preview runs
        # before anyone has registered, so no group has been played, so both sides of
        # every one of these fixtures are unknown — and a TBD-sided fixture is
        # unplaceable in this engine and in the live one alike. A live solve does
        # schedule the bracket (ADR "a group restricts scheduling, it does not enable
        # it"), incrementally, as the groups feeding it resolve; a preview has nothing
        # to resolve it from.
        #
        # Counted, not just dropped: the caller turns a non-zero count into the honest
        # note that this event's knockout stage is missing from the schedule shown.
        previewed = _previewed_fixtures(plan)
        knockout_fixtures = len(plan.fixtures) - len(previewed)
        for fixture, group_id in previewed:
            # Which reservation restricts this fixture: its group's, or the event-wide
            # one built above for a group that plays in none (#1387, #1389) — through
            # the same rule the live solve resolves by, so the key is always one the
            # windows pass built and the lookup is total.
            schedule_fixture = _schedule_fixture(
                event_id, fixture, group_id, keys_by_group[group_id]
            )
            schedule_fixtures.append(schedule_fixture)
            group_labels[schedule_fixture.id] = group_labels_by_id[group_id]
        summaries.append(
            EventFieldSummary(
                event_id=event_id,
                field_size=plan.field_size,
                knockout_fixtures=knockout_fixtures,
            )
        )

    snapshot = ScheduleSnapshot(
        table_ids=catalogue,
        reservations=tuple(schedule_reservations),
        events=tuple(event_settings),
        fixtures=tuple(schedule_fixtures),
        now_min=now_min,
    )
    return PreviewSnapshot(
        snapshot=snapshot,
        field_summaries=tuple(summaries),
        base=base,
        group_labels=group_labels,
    )


def _schedule_fixture(
    event_id: EventId,
    fixture: PlannedFixture,
    group_id: GroupId,
    reservation_ref: ReservationId,
) -> ScheduleFixture:
    """Map one synthetic :class:`~app.draws.PlannedFixture` onto the solver's
    :class:`~app.scheduling.ScheduleFixture`.

    A previewable fixture is both-sides-known by definition — the caller kept only the
    fixtures whose stage seats both sides at the cut
    (:func:`~app.draws.seats_both_sides_at_cut`), which is a round-robin draw or the
    group stage of an rr-then-ko one — so both entrant ids are non-``None``. A
    TBD-sided fixture reaching here would be a bug in that filter, so we let the
    ``None`` surface loudly rather than inventing a placeholder.

    ``group_id`` is handed in by the caller's filter rather than re-read off the
    fixture, so there is no ``None`` here to assert away: the one place that decides
    which fixtures are previewable is the one place that answers which group each is
    dealt into.

    ``group_id`` is a GROUP id; ``reservation_ref`` is the solver key of the
    reservation that restricts the fixture, resolved by the caller through
    :func:`app.schedule_solves.restricting_reservation_key` (exactly one per fixture,
    looked up rather than assumed — its group's booked reservation, or the event-wide
    one for a group with none). It already matches the ``ScheduleReservation`` keys;
    the fixture id is a deterministic, event-namespaced composite keyed on the **group**
    (unique because ``(group, round, position)`` is unique within an event, whatever
    the 1:1 does).
    Each synthetic entrant is its own human, so the entry id doubles as the
    ``PlayerId`` — and
    since entry ids are globally disjoint, so are the players.

    The entrant ids are minted as ``uuid.UUID(int=k)`` for the global ordinal
    ``k`` (``1..N``, disjoint across events), so ``entry_id.int`` recovers ``k``.
    The projected ``PlayerId`` is the client-facing ``placeholder-{k}`` spelling
    (the web client strips the ``placeholder-`` prefix to render "Placeholder
    k"); ``k`` is unique across events, so the players stay disjoint and the
    solver's no-double-book-by-player constraint holds.
    """
    assert fixture.entry_a_id is not None
    assert fixture.entry_b_id is not None
    # The two ids answer different questions and are keyed on different things.
    #
    # ``id`` identifies the FIXTURE, so it is namespaced by the **group** that holds it:
    # ``(group, round, position)`` is unique within an event by construction, because a
    # group deals its own rounds. ``reservation_id`` names what CONFINES the fixture —
    # tables inside a window — which is the reservation.
    #
    # They are not interchangeable. Two groups share a reservation routinely now
    # (#1387 maps eight groups across four reservations two apiece), so keying the
    # fixture id on the reservation would collide two group-stage fixtures on
    # ``(reservation, round, position)`` and the snapshot would be refused as
    # incoherent, naming a symptom rather than the cause.
    group_ref = f"{event_id}:{group_id}"
    return ScheduleFixture(
        id=FixtureId(f"{group_ref}:{fixture.round}:{fixture.position}"),
        event_id=event_id,
        reservation_id=reservation_ref,
        player_a_id=PlayerId(f"{PLACEHOLDER_PREFIX}{fixture.entry_a_id.int}"),
        player_b_id=PlayerId(f"{PLACEHOLDER_PREFIX}{fixture.entry_b_id.int}"),
    )
