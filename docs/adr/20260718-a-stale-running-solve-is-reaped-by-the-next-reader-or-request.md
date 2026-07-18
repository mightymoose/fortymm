# A stale `running` solve is reaped by the next reader or request

Date: 2026-07-18 (date-numbered — sequential numbers collide across concurrent
worktrees; see ADR-0788's note and the duplicate 0915s in this directory)

## Status

Accepted — fix for issue #1102, decided before implementation.

## Context

`execute_solve` (`app.schedule_solves`) is written so a row is never left
`running` forever: whatever breaks, its `except` clause is the job's boundary
handler, and `_finish_failed_best_effort` writes a terminal `failed` status on a
fresh session. That guarantee holds for any Python exception — but not for a
hard kill. An OOM (or any SIGKILL / pod eviction / node restart) terminates the
worker process instantly; no `except` ever runs, and the row is stranded
`running`.

The worker is deployed as a single-replica `Deployment` running `rq worker`
directly in its own container (`deploy/uat/templates/worker.yaml`) — there is
no separate monitor process that forks a child and can observe an abnormal
child exit (the pattern RQ's own worker uses when *it* forks the job). A cgroup
OOM kill takes out the whole container, worker included, so nothing inside the
app ever gets a chance to record what happened.

The `schedule_solves` row *is* the coalescer's in-progress state
(`request_solve`'s module docstring): a `running` row makes every subsequent
trigger set `rerun_requested` and return **without enqueuing** — by design, to
guarantee one solve in flight per tournament. A stranded `running` row is
therefore not just a bad ledger entry: it permanently wedges that tournament's
scheduler, and the "Run scheduler" button (gated on `solveInFlight`, which
reads `queued`/`running`) stays disabled with no error ever surfaced, because
nothing ever transitions the row out of `running`.

Observed on UAT (issue #1102): a large tournament's solve exceeded the worker's
memory limit, the worker was OOMKilled (exit 137), RQ restarted the worker, and
the in-flight solve row stayed `running` indefinitely. Solver queue depth was
0 — nothing running or queued — yet the UI showed an eternal disabled
"Solving…".

Two things this decision does **not** need to build:

- **The frontend's failure state already exists.** `solve-strip.tsx` /
  `data/solve.ts` already render a fully designed `failed` state (headline,
  server `error` detail, and the "Run scheduler" button re-enabling the moment
  status leaves `queued`/`running`) and already poll the tournament detail
  query every 3s while a solve is in flight (`SOLVE_IN_FLIGHT_POLL_MS`). The
  only missing piece is something to actually *write* `failed` on a stranded
  row — the read/rendering side needs no change.
- **A periodic sweep** (a `schedule-solve-reaper` CronJob/compose loop,
  mirroring `app.retirement_sweep`'s established pattern) was considered and
  rejected as the *primary* mechanism: it would add a new deploy artifact for
  something the read path below already covers, for free, at the cadence the
  UI already polls at.

## Decision

### A 60-second-by-default lease, tied to the solver's own time cap

```python
STALE_RUNNING_LEASE_MULTIPLE = 6


def _stale_running_lease_s() -> float:
    return get_settings().solver_time_cap_s * STALE_RUNNING_LEASE_MULTIPLE
```

The solver's own time cap bounds only phase (b), the CP-SAT call itself;
phases (a) and (c) do unbounded (if normally fast) DB work outside that cap.
6× gives comfortable headroom for that DB work under load while still being
short enough that a genuinely wedged tournament self-heals within roughly one
polling cycle.

*Amendment (landed alongside PR #1126, which made the solver time cap itself
operator-configurable via `SOLVER_TIME_CAP_S`): the lease is read lazily off
`get_settings().solver_time_cap_s` rather than a fixed 60.0 constant, so a
large one-off solve run under a raised cap (e.g. 1200s) isn't reaped out from
under itself by a lease still sized for the 10s default. The multiplier
(`STALE_RUNNING_LEASE_MULTIPLE = 6`) is the fixed, non-configurable part —
mirrors `SOLVE_NUM_WORKERS`'s "read lazily" idiom, not its "operator sets an
absolute value" one.*

### Reaping happens at the two places that already look at the `running` row

No new job, queue, or scheduled process. A `running` row past its lease is
found and terminated at whichever of these happens first:

1. **`request_solve`'s coalescer** — it already takes `FOR UPDATE` on a
   `running` row before deciding what to do with it. Before setting
   `rerun_requested`, it now also checks staleness; if stale, it reaps the row
   in place and falls through to the existing "neither queued nor running"
   branch, inserting a fresh `queued` row for the trigger that just fired.
   This alone is not sufficient for a **pre-live** tournament, though: nothing
   calls `request_solve` again until the director acts, and the button that
   would let them act is disabled until the row is unstuck.

2. **`latest_solve`** — the one query that feeds the tournament detail BFF's
   `latest_schedule_solve`, which is what gates the Run-scheduler button and
   what the frontend already polls every 3s while "in flight". This is a new
   pattern for the codebase: **no GET route currently commits a write** — this
   is the first "read repair". It is scoped tightly: `latest_solve` re-fetches
   only a row it already suspects is stale, re-locks it `FOR UPDATE`,
   re-confirms it is still `running` and still past its lease (the worker may
   have finished in the gap between the two reads), and only then writes
   `failed` and commits — before returning the now-corrected row to its
   caller. It does not turn the route into a general write path.

Both compare against `datetime.now(UTC)` — matching how `started_at` and
`finished_at` are already written — never `_wall_now()`, which is a distinct,
naive-local-time concept used for solver business logic.

A reaped row gets:

```python
STALE_RUNNING_ERROR = "the solve job stopped responding (worker crashed or was killed)"
```

— `status = failed`, `error = STALE_RUNNING_ERROR`, `finished_at = now`,
`wall_time_ms` left `NULL` (the job never produced a result).

### Reaping does not special-case `rerun_requested`

`_finish_failed_best_effort` — the *existing* handler for an ordinary Python
crash — already does not honor `rerun_requested`; it is silently dropped
whenever a job dies mid-run rather than finishing normally. The reaper mirrors
that, rather than introducing a third, inconsistent failure semantics:

- On a **live** tournament, match completions keep calling
  `request_solve(..., match_completed)` regardless of a stuck row; once
  reaped, the very next completion inserts a fresh row on its own.
  `rerun_requested` is redundant there.
- On a **pre-live** tournament, the director already has to return and click
  "Run scheduler" to make further progress, same as any other `failed` row —
  reaping does not change that.

## Consequences

- **`api/`-only.** No schema change (no new column, no migration —
  `started_at` already exists and is all the lease needs), and no web/iOS
  change: the frontend's `failed` rendering and polling cadence already do
  the right thing the moment the row's status changes underneath them.
- **Self-heals within about one polling cycle plus the lease**, with no new
  deploy surface. A director watching the page sees "Solving…" flip to an
  honest "The scheduler hit a problem" instead of an eternal spinner.
- **A GET route can now commit a write**, for the first time in this
  codebase. Scoped to exactly one function's one guarded transition; not a
  precedent for GET routes generally becoming write paths.
- **`rerun_requested` can be silently dropped on reap**, same as it already is
  on an ordinary crash. Accepted because a live tournament's own
  match-completion cadence covers it, and a pre-live tournament requires a
  director's action to proceed either way.
