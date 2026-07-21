# A called match holds its table and slides later

Date: 2026-07-19
Status: accepted
(Number this ADR by its PR at land time; date-prefixed until then.)

Amends ["The schedule is solved; the call is pinned"](20260716-the-schedule-is-solved-the-call-is-pinned.md).
Fixes the intermittent infeasibility caught in the UAT soak (#1114); closes #1141.

## Context

The original pin model (the ADR above) makes a **called** (pinned, not-yet-started) match a
**fully rigid `(table, start)` constant**: both dimensions frozen, echoed back verbatim, an
immovable interval every other fixture schedules around. The stated reason a pin was *not*
modeled as "start ≥ pinned start" was drift: a variable the objective is indifferent to could
wander between solves, and the whole point of a pin is that what we told the player never
changes.

That rigidity is the root cause of an intermittent infeasibility. A match ahead of a called
one on the **same shared table** overruns its duration estimate; the called match is frozen at
a constant start; the two fixed intervals overlap on that table → a structurally **INFEASIBLE**
solve. Nothing is applied, so the whole board is stuck (no reflow for anyone) until the
overrunning match completes and frees the court. With shared table pools and long matches this
fires under live churn.

A human control desk never hits this: it says "a few more minutes on Table 3" and slides the
called match later on the **same** table. It never tells a player to switch tables, and it
never contradicts the physical reality that the court is still busy.

## Decision

**A called match's *table* stays a hard constant; its *start* becomes a variable that can only
be pushed later.** Rule in one line: **a called match may be pushed later on a re-solve, but
never moved to a different table.**

### In the solver (`api/app/scheduling.py`)

- A pinned fixture's start is a **free integer-minute CP-SAT variable** with
  `start ≥ pin.start_min`, on `table_intervals[pin.table_id]` only — the table never varies, so
  the pin can never be re-placed onto another court. Its occupancy and rest-padded player
  interval both key off that variable. It is **not** snapped to the 5-minute bucket grid the
  unpinned fixtures use: `pin.start_min` may itself be off-grid (a manual director PATCH, a call
  tick), and snapping would both break "no drift" and over-delay the slide.
- **The start is anchored downward in the objective** by folding the called match's `start − now`
  into the **existing player-wait term**, at the same weight as an unpinned fixture. The current
  strict tier order is unchanged: `makespan ≫ player-wait ≫ stability`. Because `pin.start_min`
  is the variable's floor, the wait term is minimized *at the floor* — so with no contention the
  start sits exactly at the promised time (no drift), and under contention it slides to the
  **minimum** legal later value (just past the obstruction).
- **Genuinely in-progress (being-played) matches stay fully fixed** in both dimensions. This
  change is only about *called-but-not-yet-started* fixtures. A match underway must never move.
- Calling is unchanged: `run_pin_tick` / the pin writers in `app/match_calls.py` still call
  matches on the same schedule. This only changes how the solver treats an already-called
  fixture.

### At apply (`api/app/schedule_solves.py`)

- The apply loop no longer blindly echoes a pin verbatim. When the solver returns a called
  match at a **later** start than its stored placement (same table, always), that slid start is
  **persisted** and the existing **"moved" correction** (`notify_pin_repairs`) fires — the
  player is told, same as any other pin repair. When the solver returns it **unchanged** (the
  common, no-contention case), it is still echoed verbatim and notifies no one.
- Reusing the existing table-changed "moved" correction (rather than a distinct gentler
  "same table, a few minutes later" message) is deliberate for now — least new surface, and it
  honors the amended ADR's invariant that *every* persisted pin change carries a correction.

## Consequences

- **The intermittent overrun-overlap infeasibility is gone.** A called match behind an
  overrunning predecessor slides later on the same table and the day stays feasible and applies —
  early finishes visibly compact instead of the board freezing.
- **Pins essentially stop being a source of infeasibility.** With no window ceiling and a start
  that can always slide to the horizon, the two former pin contradictions — *two called matches
  promised the same table at overlapping times* and *a called match under an in-progress overrun*
  — now **auto-resolve** by sliding one later plus a correction, rather than surfacing as
  INFEASIBLE. Infeasibility becomes almost entirely a property of *unpinned* fixtures that cannot
  fit their pool window. This is broader than the single-overrun scenario that motivated the fix,
  and it is accepted: a self-healing slide beats a stuck day.
- **A called match is not specially shielded from being bumped.** Folded into player-wait at
  equal weight, the called match's start is interchangeable with an unpinned match's when they
  compete for the same freed slot — so an unpinned match can occasionally jump the queue and push
  a *called, already-promised* match later. The stronger guarantee (a dedicated, higher-weighted
  "called-delay" tier so a promise is never bumped, and ultimately a **configurable** tier
  ordering) is a deliberate **follow-up**, not built here. Because the tier weights are computed
  symmetrically (each tier's weight is "1 more than the max cost of every tier below it"),
  reordering or inserting a tier later is a localized change to the weight formulas.
  **Revisit trigger:** measure how often an unpinned match actually bumps a called one in
  practice (UAT soak / production) before deciding whether the dedicated tier is worth its cost.
- The module docstring's infeasibility discussion and the amended ADR's "pins are fixed
  intervals / we never rearrange what we told a player" language are updated to: *a called
  match's **table** never changes; its **start** can be pushed later, always with a correction.*
