# The conflict core is a second, max-placed solve over optional placements

Date: 2026-08-03 (date-numbered — sequential numbers collide across concurrent
worktrees; see the ADR-FORMAT note and the duplicate 0915s in this directory)

## Status

Accepted — fix for issue #1129, decided before implementation. Extends
"An infeasible solve explains itself with a resolved, structured reason"
(2026-07-18, #1100), which deliberately scoped this out and left
`NoSingleCause` as its honest placeholder.

## Context

#1100 ships four `InfeasibilityReason` arms: three *certain* structural
pre-checks (`PoolHasNoTables`, `WindowTooShortForMatch`, `PoolOverCapacity`),
the equally-certain `PastWindow`, and one best-effort residual,
`NoSingleCause(required_min, available_min)`, for the case where CP-SAT proves
`INFEASIBLE` but no structure explains it.

That residual is honest but coarse, and — as #1100's own ADR observed — it can
*never* report a capacity deficit: if every pool passed `PoolOverCapacity`, then
`Σ required ≤ Σ available` necessarily. So the director is told "there is enough
total table-time, this is a timing conflict" without ever learning *which*
fixtures or *which* humans form that conflict.

### What CP-SAT can and cannot hand back

A bare `solver.Solve()` returning `INFEASIBLE` proves emptiness and says nothing
structured about why; `ResponseStats()` is timing and search telemetry only.
CP-SAT does support unsat cores, but **only over assumption literals we
deliberately add** (`AddAssumptions` / `SufficientAssumptionsForInfeasibility`),
and the constraints that actually bind here are `AddNoOverlap` over intervals
(table contention and per-player rest), which **CP-SAT cannot reify behind an
enforcement literal**.

This is the key finding that shaped the decision: *both* routes the issue
proposes require the **same** remodel — a per-fixture `placed` literal — because
that literal is the only thing worth gating. The routes differ only in what is
read back off it. So the choice is not "assumptions vs. optional placement"; it
is "given optional placement, do we read a core or an optimum?"

## Decision

### 1. Certain per-player over-subscription is a *pre-check*, not a residual

A player plays one match at a time, and their fixtures in a pool must all run
inside that pool's window. So for each `(pool, player)`:

```
Σ durations + (match_count − 1) × REST_MIN  >  window_span
```

is a **necessary condition** for infeasibility — a pigeonhole over one human,
provable by arithmetic on the snapshot with no solver at all. It therefore joins
arms 1–3 in the cheap pre-check pass, as a fifth certain arm:

**`PlayerOverSubscribed(pool_id, player_id, match_count, required_min, window_span_min)`**

**The rest term is `(N − 1)`, not `N`.** The model pads *every* player interval
by `REST_MIN`, which is correct for `AddNoOverlap` (it enforces a gap in either
direction) but wrong as a pigeonhole bound: the last match of the day needs no
trailing rest *inside* the window. Using `N × REST_MIN` would overcount demand
and could **falsely accuse a player** — unacceptable for an arm whose whole
claim is certainty. Every certain arm in this union is deliberately
conservative: it may miss a real infeasibility, it may never invent one.

This placement is what makes the residual arm honest, and it is the
non-obvious part of this ADR: because a *certain* check runs first, the residual
core below can never carry a provably over-subscribed player — they were caught
earlier and more cheaply. Attribution is therefore split by *provability*, not
by subject matter.

### 2. The residual core is a second, max-placed solve — and it names fixtures only

Only on a CP-SAT-proven `INFEASIBLE`, a **second** solve runs over the same
snapshot with placement made optional: each unpinned fixture gets a `placed`
literal, its table intervals **and its player intervals** become optional on
that literal, and the objective becomes `maximize Σ placed`. The fixtures it
could not place are the core:

**`UnplaceableFixtures(fixture_ids)`**

Both interval families must become optional on the same literal. Making only the
table intervals optional would leave the rest constraint binding on a dropped
fixture, so dropping it would relieve nothing and the diagnostic could never
explain a rest-driven conflict at all.

The arm carries **fixtures only** — no nested player list. Per decision 1 that
list would be empty by construction in every case this arm is reached, and
populating it with a heuristic ("players appearing in ≥2 dropped fixtures")
would put an unprovable claim inside a union whose every other arm is a proof.

### 3. Pins stay hard; `NoSingleCause` survives as the floor

Called matches are **not** droppable in the diagnostic model. A called match is
a promise already made to two humans (see "a called match holds its table and
slides later"), so "drop this one" is not a remedy a director can act on; the
drop set should contain only fixtures they can actually move.

The cost is that the diagnostic solve can itself return `INFEASIBLE` (pins alone
overflowing the horizon). That, and a diagnostic that exhausts its own cap
without any solution, fall back to the existing `NoSingleCause` aggregate — which
therefore stays in the union rather than being replaced.

### 4. The drop set is reported without ever claiming minimality

The diagnostic is an optimization under a time cap, so it may return `FEASIBLE`
rather than `OPTIMAL` — an upper bound ("dropping these 4 works"), not a proven
minimum ("you must drop at least 4"). Rather than discard it or carry a
proven/partial flag, the copy simply never claims minimality: *"these fixtures
could not be placed"*, not *"you must remove exactly these"*. Under that wording
both statuses say the same true thing, so no extra field or copy variant is
needed — and the director keeps the diagnostic precisely on the large, slow days
where the cap is most likely to bite and where they most need it.

### 5. One builder, flagged — the fast path is constructed identically

`_build_model(snapshot, optional_placement=False)` gains a flag rather than a
parallel `_build_diagnostic_model`. A duplicate builder would re-implement
bucket bounds, pin handling, the fixed-obstacle union and snapshot validation,
and would silently drift — and a diagnostic that drifts explains a model the
tournament never solved. With the flag defaulted off, the ordinary path
constructs exactly the model it does today.

### 6. Its own budget: `diagnostic_solver_time_cap_s`, default 5s

A new setting, mirroring the existing `preview_solver_time_cap_s = 5.0`
precedent. 5s is absorbed by the existing `JOB_TIMEOUT_MARGIN_S = 60`, so the RQ
watchdog and the `STALE_RUNNING_LEASE_MULTIPLE` lease need no change — the
diagnostic fits inside slack the job already holds.

## Consequences

- **The happy path is untouched.** The diagnostic runs only after a proven
  `INFEASIBLE`. Feasible solves build the same model, run one solve, and pay
  nothing. Determinism is preserved: the diagnostic solve reuses
  `random_seed = 0` and the same `num_search_workers`.
- **Two new arms on a closed union.** `PlayerOverSubscribed` and
  `UnplaceableFixtures` join `InfeasibilityReason`. Because the client's copy
  module `match`es exhaustively with no catch-all, both are compile-time
  forcing — which is the point.
- **Cross-layer, as #1100 was.** Pure solver, the apply-time id→name resolution
  (`player_names` already exists, built for `PlayerConflict`), the stored JSONB
  and wire schema, the OpenAPI/type regen (`schema.d.ts` **and** `Types.swift`),
  and the shared client copy module. iOS gets the regenerated types only.
- **The pure module stays pure.** Both new arms carry ids and minute-ints only;
  names and wall-clock are still added at apply time.
- **`NoSingleCause` is now a floor, not the residual.** It is reached only when
  the diagnostic cannot answer, so its "best-effort" labelling becomes more
  accurate, not less.

## Considered and rejected

- **Assumption literals + `SufficientAssumptionsForInfeasibility`.** Shares the
  same remodel and is cheaper (no optimization), and returns a mutually-
  conflicting subset — literally the issue's headline sentence. Rejected because
  CP-SAT guarantees no minimality: the core can come back near-everything, which
  is less actionable than a max-placed drop set that always answers "here is a
  set whose removal makes the day fit."
- **Making the fast path carry `placed` literals pinned true.** Least code, but
  it changes the real model's shape — new booleans, new presolve work, possible
  hint churn — against an issue requirement that the fast path not change.
- **Dropping pins too**, so the diagnostic can never itself be infeasible.
  Rejected as unactionable (see decision 3).
