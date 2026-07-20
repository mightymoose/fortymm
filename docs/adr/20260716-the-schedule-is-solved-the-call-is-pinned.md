# The schedule is solved; the call is pinned

Date: 2026-07-16
Status: accepted (amended 2026-07-19)
(Number this ADR by its PR at land time; date-prefixed until then.)

> **Amendment (2026-07-19, #1141):** a pin is no longer a *fully* rigid `(table, start)`
> interval. A called match's **table** is still a hard constant it can never leave, but its
> **start can be pushed later** when a predecessor overruns — the solver slides it on the same
> table and the persisted change fires the same "moved" correction. Read "pins are fixed
> intervals" and "we never rearrange what we told a player" below as: *a called match's table
> never changes; its start can slide later, always with a correction.* The whole-or-nothing
> invariant in Consequences still holds — no pinned placement changes except through a capacity
> break (an overrun now among them), and every such break still carries a correction. See
> [ADR "A called match holds its table and slides later"](20260719-a-called-match-holds-its-table-and-slides-later.md).

## Context

A fixture's placement — `table_id` + `scheduled_start` (ADR-0790) — is written today by a
manual per-fixture PATCH, one director decision at a time. The `/simulator` route holds a
client-side prototype of something better: a Gantt board fed by a fake greedy solver, with
a re-solve-on-completion loop and pinned completions. The prototype proved the interaction;
none of it is real — no API, no persistence, no notifications.

Meanwhile the real problem is a genuine combinatorial one: pack every cut fixture onto the
venue's tables inside each pool's window, with no player in two places at once, minimum
rest between a player's matches, and tables shared across events — and keep that schedule
honest all day as matches run long, players withdraw, and tables break.

## Decision

### The solver schedules; the strategy still draws

CP-SAT (ortools, already in the worker) owns **placement only**. The draw cut — pairings,
pool membership, rounds — stays with the pure `DrawStrategy` family (ADR-0786): pairings
are a fairness rule that wants determinism, not an optimizer's degree of freedom. The
solver's decision variables are exactly the two ADR-0790 columns, over 5-minute buckets.

Hard constraints: one match per table at a time (across events — pools share the
catalogue); one match per player at a time plus a 10-minute rest floor (across events);
a fixture runs on one of its pool's tables inside its pool's slot window; pinned fixtures
are fixed intervals; in-progress matches occupy their tables to estimated end. Durations
come from a fixed `length_games → minutes` mapping isolated in one pure function (learned
durations are a later drop-in). Objective, in weight order: makespan, then total player
wait beyond the rest floor, then a small stability penalty on moving *unpinned* plans away
from the previous solve — the board should not churn cosmetically. Solves run under a hard
time cap; FEASIBLE is accepted. Mid-tournament we want a good answer now, not a proof.

### Two tiers: a plan is an estimate, a call is a promise

Every solve places **all** unpinned fixtures, so the board always shows a full projected
day — labeled as estimates, notifying no one. A fixture is **called** when its projected
start enters a ~10-minute call-ahead window (or immediately, when a table frees with no
warning): calling pins it — `pinned_at` set, both players notified, in one transaction —
and a pin is a **hard constraint in every later solve**. We never rearrange what we told
a player. The one exception is physics, not optimization: a pin whose table was removed
or whose opponent withdrew is re-placed (or voided), and that fires a distinct
"moved" / "cancelled" correction. Pins die with their fixtures on a re-cut — the match
they promised no longer exists.

A **manual placement is a pin**: the director's hand is a human commitment the solver
schedules around, not a suggestion it may undo. While live, placing a fixture *is* calling
it — same notification, same transaction. Because a director's casual drag now spends the
players' attention, the UI prices it before the click: any placement action that would
notify gets a consequence-stating confirm ("both players were told Table 3 — moving sends
a correction"), and called fixtures carry a visible called-at / notified-count marker.
Pre-live placements are silent pins — free rearranging while planning.

### One solve in flight; drift discards everything

Triggers — go-live, `on_match_completed`, any scheduling-input mutation (catalogue, pools,
entries, re-cut), the owner's Run-scheduler button, and a 1-minute pin tick while live —
all funnel into one coalesced enqueue per tournament: a queued solve absorbs new triggers;
a running one gets a rerun flag. Each run is a row in `schedule_solves` (status, trigger,
solver verdict, timings, input fingerprint) — which the admin page reads verbatim.

The job snapshots its inputs transactionally, solves outside any transaction, then
re-opens one, re-reads the fingerprint and pin set under row locks, and on **any** drift
applies nothing and re-runs. No per-fixture merging: a solve's output is taken whole or
not at all. Pins are written only inside this guarded apply or by the pin tick, which
takes the same locks — so "pinned" and "notified" cannot drift apart, and a solve cannot
clobber a pin set while it was thinking.

### The prototype dies; the Schedule tab is the board

The `/simulator` route, its fake solver, and its sim controls are deleted. Its Gantt and
player-timeline views move to the tournament detail Schedule tab, joined by a solve-status
strip and the Run-scheduler button; freshness is polling while live. Infeasibility is a
designed state on the strip, in the director's terms ("3 Group B matches don't fit before
18:00") — it is the *point* of pre-live solves, which are allowed as soon as a draw exists
so a director learns the day doesn't fit before going live, not after.

## Consequences

- Players can trust a call absolutely; they can trust an estimate approximately — and the
  UI never blurs which one they're reading. Notifications ("Match calls" category: called
  / moved / cancelled, prefs-respecting) fire exactly once per pin transition.
- The whole-or-nothing apply forfeits partial progress under heavy write races, buying an
  invariant simple enough to property-test: across any re-solve sequence, no pinned
  placement ever changes except through a capacity break, and every such break has a
  correction notification.
- The manual PATCH keeps its shape but gains meaning (pin), so the existing Schedule tab
  write path survives; directors lose nothing and gain a solver doing the other 95%.
- Learned durations, KO-stage scheduling, and a what-if sandbox mode all layer on without
  revisiting this decision: they are new inputs, new fixtures, and a dry-run flag
  respectively — the two-tier pin model is indifferent to each.
