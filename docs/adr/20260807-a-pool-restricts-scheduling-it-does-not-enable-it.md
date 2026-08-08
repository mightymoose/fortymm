# A pool restricts scheduling, it does not enable it

Date: 2026-08-07 (date-numbered — sequential numbers collide across concurrent
worktrees; see `scripts/check-adr-numbering.sh`)

## Status

Accepted. Decided during the grill for #1228, which schedules the knockout stage.
It replaces the design recorded in #1228's comment thread on 2026-08-01, which
minted a pool row for the bracket. ADR-0790 stands unchanged.

## Context

The solver reads its windows and its tables from pools. A pool carries a `Slot`
and a set of reserved tables. `schedule_solves.py` builds one `SchedulePool` per
pool, then places fixtures inside it.

A fixture with no pool has nowhere to go, so the solver skips it:

```python
if fixture.pool_id is None:
    continue
```

Three draw shapes are un-pooled. A single-elim event is un-pooled end to end. A
swiss event is un-pooled end to end. A round-robin-then-knockout event is pooled
in its first stage and un-pooled in its second. So the solver places no
single-elim match, no swiss match, and no knockout match at all.

A pool is already available to every draw type. The event editor's "Table pools"
tab is not gated: `SECTIONS` lists it as a static entry, and the editor maps over
that list whatever the draw type. The API agrees. `draw_config` passes every
configured pool "whatever the draw type", and an un-pooled strategy ignores them
for grouping — `SingleElimStrategy.plan_initial` never reads `config.pool_ids`.

So a director can already reserve tables and a window for a single-elim or swiss
event. Nothing consumes that reservation. The gap is not that these events lack
a way to reserve the venue. The gap is that a fixture's `pool_id` is written only
by the draw, so an un-pooled draw leaves it `NULL`, and the solver reads that
`NULL` as "cannot be placed" when it means "not tied to one particular
reservation".

## Decision

**A pool restricts where and when an event's fixtures may be placed. It is not a
precondition for placing them.**

1. **A fixture with no pool is placed over its event's whole timeline.** The
   window is `TournamentEvent.slot`, read in the event's own `timezone`. The
   tables are every table in the tournament.

2. **A fixture with a pool is placed exactly as it is today** — inside that
   pool's window, on that pool's tables. Nothing about pooled scheduling
   changes.

3. **No pool row is minted, and no schema changes.** The event-wide reservation
   exists only inside the solver's snapshot.

The mechanism is already in place. The solver's `PoolId` is not a database key.
It is a namespaced string the snapshot builds, `f"{event.id}:{pool.id}"`, which
the apply resolves back to a name and clock through `_PoolResolution`. An
event-wide reservation is one more value in that scheme: one synthetic
`SchedulePool` per event that has un-pooled fixtures, carrying the event's window
and the tournament's tables.

`scheduling.py`, the pure solver, is therefore untouched. Every pool-keyed
infeasibility reason — `PoolHasNoTables`, `PoolOverCapacity`,
`WindowTooShortForMatch`, the per-pool-per-player pigeonhole — keeps working, and
reports against the event-wide reservation by name.

## Consequences

**Single-elim becomes schedulable**, which is what #1228 asked for. A
round-robin-then-knockout event's knockout stage becomes schedulable by the same
rule, and the solver still knows nothing about stages.

**Swiss becomes schedulable.** A swiss draw is un-pooled end to end, so it takes
the event-wide reservation and its matches are placed. Before this decision a
swiss match only ever got the table and time a director typed in. This is
intended, not a side effect.

**The `pool_id is None` skip cannot simply be deleted.** It becomes a branch: a
pooled fixture resolves its reservation from its pool, an un-pooled one from its
event. Deleting the guard outright would feed the solver fixtures with no window
at all.

**A pool cannot confine an un-pooled fixture, and a director has no other way to
confine one.** The rule is per **fixture**, not per event. A fixture that names a
pool is held to that pool's tables and window. A fixture that names none takes
the whole venue over its event's window, and the event's own pools are not
consulted — an rr-then-ko event has pools, and its knockout fixtures still take
the event-wide reservation, which is exactly right, because those pools describe
the **group** stage and the knockout must not inherit their windows.

So a director who adds a pool to a single-elim event changes nothing about where
that bracket is played. The only controls over an un-pooled fixture are the
event's own window and the tournament's table list.

Whether a director should be able to say "the knockout runs Sunday, on tables 1
to 4" is a real question this ADR does not answer. It needs a control that is not
a pool, because a pool already means something else. Left open deliberately
rather than half-answered.

**The event-wide reservation needs a name a director can read, and a kind.** An
infeasibility reason names the reservation it blames, so a synthetic one must
resolve to something meaningful rather than to a raw id. A name alone is not
enough: the remedies are pool-shaped, and "add a table to it" or "a smaller
pool" are not things a director can do to an event-wide reservation. Each reason
therefore carries **which kind** of reservation it blames, so the remedy can name
a control that exists — the tournament's table list and the event's window,
rather than a pool's.

**The venue's capacity is counted once per table-hour, however many reservations
claim it.** The day aggregate summed span times table count over every
reservation. An event-wide reservation overlaps its event's real pools by
construction, so a round-robin-then-knockout event double-counted the same tables
for the same hours and reported roughly twice the table-time a venue has, under
copy that already asserts "there's enough". It is now the union of coverage per
table. This also fixes overlapping *pools*, which had the same defect before this
ADR.

**An event with no tables in its tournament still cannot be scheduled.** That is
`PoolHasNoTables` doing its job, and it now fires against the event-wide
reservation with the same message.

**Preview is unchanged.** At preview time no match has been played, so every
knockout fixture past the first round has unknown sides. That is true in
principle, not merely in this implementation. #1228 keeps the "not previewed"
note for knockout rounds. It only stops a single-elim event from aborting its
whole tournament's preview.

## Alternatives considered

**Mint a pool row for the bracket** — the 2026-08-01 design. Rejected. Since
#1226 a pool is a row the director creates, names, and orders, and the event
editor renders every pool as a card. A minted pool would appear as a pool the
director never asked for, and they could rename or delete it. It also
contradicts `CONTEXT.md`'s **Pool** entry, which defines a pool's second face as
"the group of entrants who play all-play-all on that slice". A bracket's
entrants do not.

**Assign bracket fixtures to a pool the director already made.** Rejected as a
scheduling decision taken too early. It also needs a rule for which pool when an
event has several, and that rule is a new director-facing concept.

**Let the solver choose among an event's pools per fixture.** Rejected as
expensive for no gain here. Every infeasibility reason is keyed by one pool, so
"which pool was over capacity" would stop having a single answer, and the
director-facing copy would have to change with it.

**Give the event its own table-assignment surface.** Rejected as unnecessary. It
needs a new join table and a new event-editor section. Pools already are that
surface.

**Add a stage column, a stages table, or a `draw_type_key` on the fixture.**
Rejected in the 2026-08-01 design pass, and still rejected. Nothing here needs to
know about stages.
