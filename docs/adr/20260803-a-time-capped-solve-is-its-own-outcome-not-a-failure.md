# A time-capped solve is its own outcome, not a failure

Date: 2026-08-03 (date-numbered — sequential numbers collide across concurrent
worktrees; see `scripts/check-adr-numbering.sh`)

## Status

Accepted — decided before implementation, for issue #1116.

## Context

CP-SAT returns `Verdict.unknown` when its time cap runs out before it finds any
solution. `schedule_solves.py` records that as **`status = failed`** with
`error = TIME_CAP_ERROR` — the module-level constant `"time cap exhausted
without a solution"`. The DB verdict enum deliberately has no `unknown` member,
on the reasoning that "a run that proved nothing has no verdict at all".

Two things follow, both bad:

1. **The Schedule tab calls a timeout a crash.** `solve-strip.tsx` renders the
   `failed` arm as "The scheduler hit a problem — The run broke before it could
   finish. Run it again." The run did not break, and running it again re-runs the
   same model against the same cap, which cannot help. The remediation is wrong
   in the one place a director looks for it.
2. **The only way to tell a timeout from a crash is to string-match the error
   prose** — precisely the failure mode ADR-0968 exists to eliminate, and the
   client is not even given the string as a code it could switch on.

Three outcomes need three sentences: **infeasible** proved the day does not fit,
**timed_out** proved nothing, **failed** means the code broke. Today the middle
one wears the third one's clothes.

## Decision

**`timed_out` becomes a fourth terminal `ScheduleSolveStatus`, beside
`succeeded`, `infeasible` and `failed`.**

`SolverVerdict` is left alone — it stays `optimal | feasible | infeasible`, and a
timed-out run continues to record no verdict at all, because it genuinely reached
none. The two enums are different facts, as that model already documents.

A time-capped run stops being classified as a failure at the point it is
recorded, rather than being reclassified downstream by reading a magic string.
The client gets a fourth arm in its solve-state sum type, and — because the match
is exhaustive with no catch-all — the compiler refuses to build until that arm
has copy of its own.

`TIME_CAP_ERROR` stops being load-bearing. It may remain as a human-readable
`error` detail, but nothing branches on it.

## Considered alternatives

- **Keep `failed`, add a `failure_code` column** (`'time_cap' | 'error'`). A
  smaller migration, and it mirrors the `detail: {code, message}` shape chosen
  for refusals in the sibling ADR. Rejected because it preserves the framing the
  issue objects to — a timeout stays a kind of failure — and forces every reader
  to consult two fields to learn what the first one means.
- **Add `unknown` to `SolverVerdict`.** Most faithful to CP-SAT's own vocabulary,
  but it directly reverses a deliberate existing decision rather than layering on
  top of it, and "unknown" names the solver's epistemic state where the director
  needs the *outcome*.

## Consequences

- Requires a migration, and `api/CLAUDE.md`'s pre-deploy rule says schema
  mistakes are fixed by editing migrations in place — so this lands as an edit to
  the migration that creates the status enum, not an alter.
- `pytest` never runs migrations (`create_all` builds the test schema), so a
  green suite is **not** evidence the enum change is real. `alembic upgrade head`
  against a fresh Postgres is the check that counts.
- Both generated clients drift: `mise run regen-api-types` and
  `mise run regen-ios-api-types` must land in the same change.
