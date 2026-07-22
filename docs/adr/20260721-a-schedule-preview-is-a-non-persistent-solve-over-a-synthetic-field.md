# A schedule preview is a non-persistent solve over a synthetic field

Date: 2026-07-21 (date-numbered — sequential numbers collide across concurrent
worktrees; see ADR-0788's note and the duplicate 0915s in this directory)

## Status

Accepted — decided before implementation, from a described goal ("add the ability
to run fake schedules for a tournament before users have signed up"). No issue
number yet. Builds directly on:

- **the tournament-verbs MCP ADR**
  (`20260719-tournament-verbs-are-shared-functions-behind-http-and-mcp-adapters.md`)
  and **the match-flow MCP ADR** (`20260718-…`) — a preview is a fourth shared
  verb behind the same HTTP + MCP adapter pattern;
- **the Solve glossary/ADR** (`20260716-the-schedule-is-solved-the-call-is-pinned.md`,
  `CONTEXT.md` "Solve") — a preview reuses the **same CP-SAT engine**, and inherits
  the rule that a solve computes *when and where*, never *who wins*;
- **the infeasible-solve ADR** (`20260718-an-infeasible-solve-explains-itself-…`) —
  infeasibility is a designed outcome, "exactly what a pre-live solve is for";
- **ADR-0935** (a null player cap means no cap) and **ADR-0968** (refusals are
  machine-readable codes).

## Context

A director setting up a tournament wants to know *"given my tables, time windows,
formats and games-per-match, would the schedule even fit — and roughly how long is
the day?"* — **before anyone has registered**, so there are no entrants to solve
over yet. Today the only way to see a schedule is to draw real entrants and run a
real **solve**, which persists placements onto fixtures at go-live.

Three facts about the existing code make a clean, non-persistent preview possible:

- **The draw is pure.** `api/app/draws.py` "issues no query, imports no FastAPI and
  no SQLAlchemy construct." It turns value-object `Entrant`s into `PlannedFixture`s;
  `strategy_for(draw_type)` is an exhaustive match with no catch-all: only
  `round_robin` has a strategy; `single_elim | double_elim | rr_then_ko | swiss` all
  raise `UnsupportedDrawType` (they are enum stubs — `rr_then_ko` included), and the
  real `cut_draw` picks its strategy the same way, so production cannot draw those
  formats at all today.
- **The solver is pure.** `api/app/scheduling.py:solve(snapshot, …)` takes a frozen
  `ScheduleSnapshot` and returns a frozen `SolveResult`, touching no DB. The
  DB-aware orchestration (`schedule_solves.py:_apply_result`) that *persists* onto
  `TournamentFixture` rows is a separate, skippable phase.
- **Every real entrant is a real user.** `TournamentEntry` FK-references `users.id`
  with `RESTRICT` and a unique-active-entry guard; there is deliberately no
  placeholder/walk-in entrant (ADR-0784). So a preview must **not** create entry or
  fixture rows — it builds a synthetic snapshot in memory and throws it away.

## Decision

### A preview is a solve over a synthetic field, computed by the real engine, persisting nothing

The preview pipeline is entirely pure and in-memory:

> per event, synthesize N placeholder `Entrant`s → `strategy_for(event.draw_type).plan_initial(...)` →
> fixtures → assemble a `ScheduleSnapshot` from the tournament's real `table_catalogue`,
> pool windows and `length_games` → `solve()` → `SolveResult` → summary + grid.

No `TournamentEntry`, no `TournamentFixture`, no `ScheduleSolve` ledger row, no
Redis-outliving state. It is the **same** CP-SAT engine a live tournament uses, so
"fits / doesn't fit" means the same thing it will mean at go-live. Following the
Solve vocabulary, a preview is **not** a what-if projection of *outcomes* — it never
predicts who wins; it computes *when and where* a synthetic field would play.

Rejected: **the client-side `solver-sim.ts` mock.** It is instant and needs no
backend, but it is a different engine; a preview that says "fits" while the real
solve later says "infeasible" is worse than no preview. Accuracy *is* the feature.

### The field is auto-filled to capacity, per-event overridable, disjoint across events

Each event auto-fills to its `max_players`; an uncapped event (ADR-0935: null cap =
no cap) has no natural number, so the director supplies one (default 16). The
director may override any event's count to explore "what if 24 show up." Fake
players are **disjoint across events** (event A gets 1..16, event B gets 17..32) —
so the preview ignores the cross-event contention a multi-event player causes and is
therefore **optimistic** on duration. This is surfaced as an honest note, not hidden;
overlap modeling is a deliberate v-next refinement.

### The verb is transport-neutral; HTTP polls, MCP waits

Per the tournament-verbs ADR, the preview core is a transport-neutral function that
raises domain exceptions (never `HTTPException`), owner-gated, allowed only while the
tournament is **pre-live** (`draft` or `published`) and refused on `live`/`archived`.
Three adapters sit over it:

- **HTTP** (`POST /v1/tournaments/{id}/schedule/preview` + a poll/result +
  cancel endpoint): enqueues the job, returns a token immediately, the web client
  **polls** an ephemeral result endpoint (the pattern `solve-strip.tsx` already
  uses). Chosen because the browser request is behind nginx's ~60s
  `proxy_read_timeout`, and worst case a preview queues behind an in-flight ~70s
  real solve — a synchronous block would trip that timeout.
- **MCP** (`preview_schedule` tool): the tool enqueues and **waits internally** with
  a bounded timeout, returning the `SolveResult` in one call — MCP is not behind the
  browser-facing nginx hop, so a longer synchronous call is fine there.

Both transports drive the **same** ephemeral job.

### The compute runs on a dedicated `preview` RQ queue; the result is ephemeral

CP-SAT is CPU-bound and must not run inline in the async API process. The preview job
runs on the existing worker via a **dedicated `preview` queue** (`rq worker preview
solver`), so previews are dequeued *ahead of* pending real solves but cannot preempt
an in-flight one. The `SolveResult` lives only in the RQ/Redis job result with a short
TTL (~5 min); it never touches Postgres or the solve ledger.

Timeout budget (grounded in `solver_time_cap_s = 10.0`, real job_timeout `cap + 60`,
`_solve_num_workers = 1` CFS-throttled, nginx ~60s):

- new `preview_solver_time_cap_s`, default **5s** — feasibility verdict is
  cap-independent (SAT is SAT); only the makespan estimate is slightly less tight, and
  a conservative over-estimate is safe for a preview;
- preview `job_timeout ≈ cap + 15s` — no DB-apply phase, so far less margin than 70s;
- **cancel-on-close**: closing the modal fires a best-effort cancel (`job.cancel()`
  if queued, `send_stop_job_command` if running — requires the forking Worker) to
  reclaim the single throttled slot; `job_timeout` + TTL bound the waste if it misses.

### Draw coverage is round-robin only; every other type is refused loud

A preview must not invent a schedule for a format production cannot run — that is the
false-confidence failure the real-engine decision exists to prevent. Since
`strategy_for` implements only `round_robin` and raises `UnsupportedDrawType` for
everything else (elim, swiss, **and rr-then-ko**), the preview covers:

- **round-robin** — fully (the whole draw);
- **every other draw type, rr-then-ko included** — the whole preview is **refused
  loud** with an actionable, machine-readable reason (ADR-0968), never a partial
  grid. (An earlier draft of this ADR assumed rr-then-ko was implemented and would
  preview its pool stage; it is not. When `draws.py` grows an rr-then-ko strategy,
  previewing its pool stage is a natural follow-up.)

### The summary is feasibility-first, with the full synthetic grid available

Headline: **verdict** (fits/doesn't) + **estimated duration** (makespan → wall-clock).
Body: total matches, byes, peak concurrent tables / utilization, per-event breakdown.
Infeasible: the resolved **infeasibility reasons**. Always: an honest-notes strip
(disjoint-field caveat, the fake counts used, any KO-excluded note). Below the
summary, the **full synthetic grid** reuses the real schedule grid components with
`Placeholder N` names, so preview and reality render identically.

### The web surface is a pre-live "Preview schedule" modal with instant structure and a streamed solve

A "Preview schedule" button (owner-viewed, pre-live only) on the schedule tab opens a
modal that is *not* a blank spinner: because the draw is instant, the modal renders
the fake field, match/bye counts and the grid **skeleton** from the first frame, and
only the placements + verdict stream in when the solve returns — with a **labeled**
wait state (`Queued → "waiting for an in-progress solve"` vs `Running → "Solving… (Ns)"`).

## Consequences

- **One preview verb, two adapters.** The owner-gate + pre-live check + synthetic-
  snapshot build live once; HTTP and MCP are thin, matching the two prior MCP ADRs.
- **Persists nothing, so it sidesteps the real-user FK entirely.** No entry/fixture/
  ledger rows, no migration, no account-merge ripple. The one hard dependency is the
  worker being up — already assumed by `/v1/health`.
- **`api/` + `web-client/` change.** The HTTP preview route is a real `/v1` endpoint,
  so it **does** contribute to `openapi.json` → run `mise run regen-api-types` and
  commit `schema.d.ts` (and `regen-ios-api-types` for the drift guard). The
  `preview_schedule` MCP tool is MCP-only and never reaches `schema.d.ts`.
- **The preview is optimistic, and round-robin-only.** Disjoint fake fields ignore
  multi-event contention; the duration estimate is a floor, stated as such. Overlap
  modeling and extending coverage past round-robin (elim/swiss/rr-then-ko, once
  `draws.py` implements them) are deliberate follow-ups.
- **"Fake schedule" is retired as vocabulary** in favor of **schedule preview** over a
  **synthetic field** (`CONTEXT.md`) — consistent with "solve", not "simulation".
