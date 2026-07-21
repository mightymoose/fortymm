# Overlapping in-progress matches are tolerated and reported, never fatal

Date: 2026-07-20
Status: accepted
(Number this ADR by its PR at land time; date-prefixed until then.)

Amends ["A called match holds its table and slides later"](20260719-a-called-match-holds-its-table-and-slides-later.md)
and ["An infeasible solve explains itself with a resolved reason"](20260718-an-infeasible-solve-explains-itself-with-a-resolved-reason.md).
Closes #1144. Defers the call-time prevention half to #1147.

## Context

[#1141](20260719-a-called-match-holds-its-table-and-slides-later.md) made a *called,
not-yet-started* pin's start a soft floor that slides behind an overrunning predecessor, so
pins essentially stopped being a source of infeasibility. It did **not** cover the residual
path: a placement that collides with a **fully-fixed, in-progress** block on the same table or
the same human. Genuinely in-progress matches stay rigid in both dimensions — reality outranks
any plan — so two in-progress intervals that overlap are `AddNoOverlap`-unsatisfiable and make
the **entire** solve `infeasible`, dropping **all** placements. One bad pin blanks the whole
board (#1144).

**Two overlapping in-progress blocks are never physical truth.** A table holds one match; a
human plays one match. The state only exists as **contradictory data**: the solver reads a
match's *actual* occupancy from its **mutable pin** (`table_id` + `scheduled_start`), because
there is no separate ground-truth "actually started at / on table X" — a real "match started"
fact is a later drop-in. So a director's manual placement PATCH — deliberately **soft** per
[ADR-0790](20260716-the-schedule-is-solved-the-call-is-pinned.md) (out-of-window / occupied-table
saves succeed and surface downstream, never block) — can move an already-live match onto an
occupied table or a busy human, and the next solve faithfully models the impossible data as two
rigid intervals and blanks.

This is the **only** way in. The **automatic** call path already refuses it: the resource-freedom
gate ([#1106](20260718-a-tournament-match-is-called-only-when-its-table-and-players-are-free.md),
`match_calls._held_resources`) defers any due fixture whose table or human is held by an unfinished
in-progress match. The solver's own placements can't self-collide (it enforces no-overlap), and
#1141 slides not-yet-called matches. Only the manual, soft PATCH bypasses the gate.

**We cannot tell which of two colliding in-progress matches is "real."** A fixture carries only
`scheduled_start` (mutable, ADR-0790-editable — the repro re-pins to a *past* start) and
`pinned_at` (refreshed by the system's own moved-repairs). Any winner-guess (earliest-start,
latest-pinned) is defeated by the very edits that create the collision. So the fix must **not**
pick a survivor, and must **never move, eject, or re-time a live match** — a match underway is
sacrosanct (#1141).

## Decision

**The solve refuses to let two contradictory in-progress facts blank the board. It tolerates the
overlap, keeps every fixed block binding on everything it controls, and reports the conflict —
it never resolves which match is real, and never touches a live match.** This is the
ADR-0790-consistent downstream surfacing of a soft write: the write succeeds, the problem shows
up in the next solve as an advisory rather than a wedged board.

### In the solver (`api/app/scheduling.py`)

- **Merge broadly.** On each resource's interval list (every table, every player), before
  `AddNoOverlap`, mutually-overlapping **fixed** obstacle intervals are merged into their union.
  Fixed-vs-fixed can then never force infeasibility, while every **variable** interval (unpinned
  placement, sliding pin) still routes conservatively around the merged occupancy — the union
  stays blocked, so no one else is scheduled onto a genuinely-held table or human. This is the
  general "no fixed-fixed contradiction ever" guarantee; it also absorbs any rest-shadow overlap
  in the same stroke.
- **Report narrowly.** The module detects the **in-progress-vs-in-progress** overlapping pairs
  (the director-actionable ones) and returns them on `SolveResult` as DB-blind, discriminated
  report values: `table_conflict` (a shared `table_id` + the overlapping `fixture_id`s) and
  `player_conflict` (a shared `player_id` + the overlapping `fixture_id`s). Rest-shadow overlaps
  are merged but not reported.
- **In-progress matches are still excluded from output placements** and are never moved, re-timed,
  or dropped. The merge changes only what the *other* fixtures see as occupied, not the running
  matches themselves.
- **The verdict is unchanged by a conflict.** A solve that placed the board is `optimal` /
  `feasible` and *also* carries conflicts; the two are orthogonal. A genuine unpinned-demand
  overflow (out of scope here) still surfaces as the existing structural `infeasible` reasons.

### At apply (`api/app/schedule_solves.py`) and the read boundary

- The conflicts are **resolved** (ids → player names, table labels) using the same resolution
  lookups the infeasibility reasons already use, and persisted to a **new** JSONB column,
  `schedule_solves.placement_conflicts` — parallel to `infeasibility_reasons`, but written on
  **any** verdict (a placed board can still carry conflicts). A discriminated `ResolvedConflict`
  read union parses it back, exactly like `parse_infeasibility_reasons`.
- **No player notification, no correction fires.** Nothing moved, so there is no "moved"/"cancelled"
  pin repair to send. The audience is the **director** ("you double-booked"), not the entrants.

### On the director's surfaces (`web-client`)

- The resolved conflicts render as a warning on the **solve-strip** and **solve-ledger** — the two
  places the director already reads solve outcomes — naming the two fixtures and the shared table
  or human (e.g. *"F1 and crafty-vs-spiked overlap on Table 1"*).

## Consequences

- **A single bad pin can no longer blank the board.** The catastrophic blast radius (#1144) is
  gone regardless of how the contradictory data arose — a soft write's problem is now an advisory,
  not a wedged day.
- **The solver never adjudicates reality.** It does not pick a survivor or pretend a live match
  isn't running; it tolerates the recorded contradiction, stays conservative for everyone else,
  and hands the director exactly what to fix. This keeps "a match underway must never move"
  (#1141) intact.
- **Prevention is deferred, not skipped.** #1147 extends the #1106 `_held_resources` gate to the
  manual placement PATCH as a **confirm-warning** (not a hard block — ADR-0790 keeps manual
  placement soft), so a director is warned *before* creating the collision. This backstop makes
  the conflict report rare rather than routine; it does not replace it, since a warning can be
  confirmed through and direct/racing edits bypass a UX guard.
- **The report channel is new but mirrors the reasons channel.** `placement_conflicts` follows
  the established emit-in-the-pure-module → resolve-at-apply → parse-at-read → render-on-the-strip
  pattern, so it adds surface without a new shape of surface.
