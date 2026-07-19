# An infeasible solve explains itself with a resolved, structured reason

Date: 2026-07-18 (date-numbered — sequential numbers collide across concurrent
worktrees; see ADR-0788's note and the duplicate 0915s in this directory)

## Status

Accepted — fix for issue #1100, decided before implementation. Bounds against
its follow-up #1129 (a real CP-SAT conflict core), which this ADR explicitly
scopes out.

## Context

When a schedule solve fails, the director gets a single opaque verdict —
**"Doesn't fit"** — with no explanation of *why* or *what to change*. The
information exists at the point of failure and is thrown away:

- `app.scheduling._build_model` detects a **pool with no tables**
  (`if not pool.table_ids: return _no_plan(Verdict.infeasible)`) and a
  **fixture whose window cannot hold even one match of its duration**
  (`if lo > hi: ...`) — both know the exact `PoolId`/`FixtureId`, both discard
  it into a bare `Verdict.infeasible`.
- A CP-SAT-proven `INFEASIBLE` (`solve()`) returns the same bare verdict with
  no reason at all.

`SolveResult` carries only `verdict / placements / stats`; `schedule_solves`
maps `Verdict.infeasible` → `ScheduleSolveStatus.infeasible` +
`SolverVerdict.infeasible` and stores nothing else; the wire
(`ScheduleSolveRead`) and both UI surfaces (the Schedule-tab **solve strip** and
the admin **solve ledger**) therefore have nothing specific to say and fall back
to one static generic sentence.

The pure solver speaks only in ids and minute-ints (`PoolId` is the namespaced
`"{event.id}:{pool.id}"`; `FixtureId` is a uuid string) and holds no human
names or wall-clock times — those live in the DB/BFF layer. So *where* a reason
is computed and *where* it becomes words is the crux of the design.

### What a plain CP-SAT `INFEASIBLE` can and cannot tell us

A bare `solver.Solve()` returning `INFEASIBLE` proves no solution exists and
says **nothing** about why. CP-SAT can produce an unsat core, but only over
**assumption literals** we deliberately add (`SufficientAssumptionsForInfeasibility`),
and our hardest constraints are `AddNoOverlap` over intervals, which CP-SAT
cannot reify behind an enforcement literal. A faithful core needs a
soft/optional-placement remodel of the objective (maximize placed fixtures; the
dropped set is the diagnostic) — a real change with its own correctness risk.
**That remodel is out of scope here and is issue #1129.** This ADR ships what is
*certain* plus one *honestly-labelled* best-effort residual.

## Decision

### Infeasibility carries a closed sum type of reasons on `SolveResult`

`SolveResult` gains `reasons: tuple[InfeasibilityReason, ...]` — non-empty on
any `infeasible` verdict, empty on every other verdict. `InfeasibilityReason` is
a closed discriminated union (frozen dataclasses, exhaustive `match` with no
catch-all — the codebase's "make illegal states unrepresentable" idiom), with
four arms carrying **ids and minute-ints only** (the pure module stays pure and
REPL-runnable):

1. **`PoolHasNoTables(pool_id)`** — certain.
2. **`WindowTooShortForMatch(pool_id, fixture_id, needed_min, window_span_min)`**
   — certain; a single match cannot fit its window *contiguously* (e.g. a 35-min
   best-of-5 in a 20-min window, whatever the table count). Distinct from #3.
3. **`PoolOverCapacity(pool_id, required_min, capacity_min, table_count)`** —
   certain; the pool's aggregate matches cannot fit `window_span × tables`.
4. **`NoSingleCause(required_min, available_min)`** — the residual: CP-SAT proved
   `INFEASIBLE` but arms 1–3 all passed. Carries the whole-day figures for
   framing, not as a deficit (see below).

`unknown` (time cap exhausted, no solution found) carries **no** reasons — it is
"did not finish", not "does not fit", and stays `failed`/`TIME_CAP_ERROR`.

### Per-pool capacity is a *certain pre-check*, not a post-INFEASIBLE heuristic

A pool's fixtures can run only on *that pool's* tables inside *that pool's*
window, so `Σ(match durations in pool P) > window_span_P × table_count_P` is a
**valid necessary condition** for infeasibility — sharing tables across pools
only lowers real capacity, never raises it, and counting only unpinned demand
only makes the test more conservative. It names the exact pool, and it is pure
arithmetic on the snapshot the solver already holds. So it runs in the same
cheap pre-check pass as arms 1–2, **before CP-SAT is built** (arm 3), rather
than being reverse-engineered from CP-SAT's proof. This is precisely the issue's
own headline example — "the 09:00–13:00 window can't hold 40 best-of-5 matches
on 5 tables."

**Consequence that shapes the residual.** If every pool passes arm 3, then
`Σ required ≤ Σ available` necessarily. So the residual case (arm 4) can *never*
be a raw-capacity shortfall — a whole-day "required vs available" number will
always show a surplus. Arm 4 therefore reports **"there is enough total
table-time (needs ≈Xh, has ≈Yh), so this is a *timing* conflict — a player in
too many matches close together, or tables shared across overlapping windows —
not a capacity shortfall"**, which tells the director *not* to add tables. The
precise "which fixtures/players" is #1129.

All structural causes are **collected**, not first-fail: three no-tables pools
report all three, so the director fixes them in one pass instead of re-running
into the next. In practice the set is either "≥1 structural cause (arms 1–3)"
**or** "exactly one arm-4 finding", never mixed (arm 4 is only reached when 1–3
found nothing).

### The reason is *resolved to names/numbers at apply time* and stored as JSONB

A new JSONB column `schedule_solves.infeasibility_reasons` holds the reasons in
**resolved** form: phase (c) of `execute_solve` already holds the fixtures and
tournament under lock, so it maps `pool_id → pool.name` ("Pool B"),
`fixture_id → its pairing/format`, and minute-ints → the pool's `Slot`
`HH:MM`–`HH:MM` strings and whole-hours, then stores a structured object per
reason (`{kind, pool_name, needed_min, window_span_min, …}`). `ScheduleSolveStatus.infeasible`
is unchanged — the column is purely additive; the existing `error: Text` column
stays `failed`-only (single-prose, cannot hold a structured multi-cause list).

Resolved-at-write, not resolved-at-read, because the solve ledger is a
**historical log** ("append-mostly, never rewritten — the history of the day's
solves is the table itself"). A row should record what the director saw *then*,
be self-contained, and never lose its story because a pool was later renamed or
**deleted** (which would make a raw-id reason unresolvable on read). The one
thing this gives up — names auto-updating on rename — is the wrong behaviour for
a historical record.

**"Resolved" means structured data, not prose.** The stored object and the wire
carry `{kind, pool_name: "Pool B", needed_min: 35, …}` — names and numbers, which
are *data* (like a username), never a finished sentence. The client still owns
the sentence template (below), so the invariant "raw API strings never reach the
UI" holds.

### The client owns one shared reason→copy module; both surfaces render all reasons

The wire (`ScheduleSolveRead`) gains `infeasibility_reasons`, Zod-parsed at the
`data/solve.ts` boundary into a client sum type. **One** copy module (extending
`data/solve.ts`, the way the admin ledger already reuses `VERDICT_LABEL`) maps
each arm `kind` → a headline + specific sentence + a **user-facing remedy**
(no `#1099`/`#1129` issue numbers on screen), interpolating the resolved
names/numbers. Both surfaces consume it and render the **full** list:

- the solve strip's `infeasible` arm replaces its static
  "Add tables, widen a pool window…" sentence with the per-reason list;
- the admin ledger shows the same reasons under its existing headline.

Sharing the copy guarantees the two surfaces tell one story and cannot drift.

## Consequences

- **Cross-layer.** Pure solver (`SolveResult.reasons` + the pre-check arm 3),
  a DB migration (new JSONB column — edited in place pre-deploy per
  `api/CLAUDE.md`), the apply's id→name resolution, `ScheduleSolveRead`, the
  OpenAPI/type regen (`schema.d.ts` **and** `Types.swift`), and both web
  surfaces. iOS gets the regenerated `Types.swift` reference only — no UI.
- **The pure module stays pure.** Reasons are ids + ints; every human name and
  wall-clock string is added at apply. `app.scheduling` remains re-runnable in a
  REPL with no database.
- **`over_capacity` is a real proof, not a guess.** Only arm 4 is best-effort,
  and it is labelled as such and never claims a capacity deficit.
- **Determinism is untouched.** Arms 1–3 are pre-CP-SAT arithmetic; the solver
  parameters (`num_search_workers`, `random_seed = 0`) are unchanged.
- **Bounds #1129.** The "which fixtures/players" core is explicitly deferred;
  arm 4 is the honest placeholder until it lands, and #1129 adds a richer arm to
  this same sum type rather than re-plumbing.
