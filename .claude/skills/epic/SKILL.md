---
name: epic
description: Drive a change end-to-end through the fortymm arc — /grill-with-docs → /to-chores → /do-chores → /land-the-plane — as a GATED conductor. It sequences the four phases and carries the plan→work-order→stacked-PR artifact chain, stopping for your decision at every phase boundary; the work ships as one commit per chore and one stacked PR per slice, merged bottom-up by /land-the-plane's own gated step, and once the whole stack lands the arc moves the work order's tickets to Done. Use to run a whole feature/bugfix through the arc from one entry point; use the individual skills when you only want one phase.
argument-hint: "[the goal to drive — an issue ref, a plan/PRD path, or a one-line description]"
---

# Epic — a gated conductor for the fortymm arc

Run a change through the four phases of the fortymm workflow, in order, **stopping
at every human gate**:

```
[preflight] → /grill-with-docs → /to-chores → /do-chores → /land-the-plane
```

## This is a conductor, NOT an autopilot

The gates between phases are the whole point — they are where the human catches a
false premise, right-sizes the decomposition, and decides what ships. This skill
**never runs a phase's decision on the user's behalf**. At each boundary it
summarises what the phase produced, states the decision that's now the user's,
and **waits for an explicit go-ahead** before starting the next phase. It never
skips a gate and never retries a blocked phase in a loop; the one merge in the
arc is `/land-the-plane`'s own gated Step 6, not a decision `/epic` makes itself.

If you find yourself wanting to "just push through" a gate to save a round-trip:
don't. The one time the gate cost a round-trip this arc was designed for, it
also caught a wrong claim before it shipped.

## Step 0 — Preflight (do this before grilling)

The individual skills and the domain-expert agents register at **session launch**,
so a stale checkout silently runs an old set (this is the failure the
`check-main-freshness.sh` SessionStart hook warns about). Before starting the arc,
confirm freshness so `/to-chores` and `/do-chores` dispatch to the current agents:

1. `git fetch origin` and compare local default branch to `origin/<default>`
   (`git rev-list --count main..origin/main`).
2. If behind **and** `.claude/skills`/`.claude/agents` changed upstream: **stop**.
   Tell the user to fast-forward the main checkout and **restart the session**,
   because a mid-session pull won't re-register skills/agents. Resume `/epic`
   after the restart.
3. If behind only on unrelated code, note it and continue (or offer to ff first).
4. Confirm the target of the arc (the `argument-hint`: an issue ref, a plan doc,
   or a described goal). If it's an issue, read it now.

## The arc, phase by phase

Each phase is run by its own skill (invoke it via the Skill tool; if a skill's
`disable-model-invocation` blocks that, tell the user to type the `/command` and
continue once it returns). After each phase, **stop at the gate.**

### 1. `/grill-with-docs` — sharpen the plan, capture the decisions

Runs the relentless interview (`/grilling`) with `/domain-modeling`, producing an
**agreed plan** plus any ADRs / `CONTEXT.md` entries the decisions warrant —
written *during* the grill, not deferred.

**Gate:** the plan is only "agreed" when the user says so. Do not advance to
decomposition on your own read of the conversation. Surface the plan's crux
decisions and confirm before continuing.

### 2. `/to-chores` — shard the agreed plan into a work order

Breaks the plan into `.claude/work-order.md`: tracer-bullet slices of small,
agent-tagged chores, with `[main]` steps at every cross-layer seam (OpenAPI
regen especially). The work order ends with a `## Testing notes` section — the
black-box, user-observable acceptance scenarios for the whole arc. Decompose-only.

**Gate:** `/to-chores` already quizzes the user on granularity and requires
approval before it writes the file. Relay that approval step — do not fabricate
the plan a chore depends on; if a decision isn't captured, that's a loop back to
`/grill-with-docs`, not an invention. **Right-size the ceremony:** a genuinely
single-tree change is one slice / one or two chores, not a manufactured epic.

### 3. `/do-chores` — drive the work order to green, as a stack

Dispatches each chore to its domain-expert subagent in dependency order. On a
reported done it ticks the checkbox and **commits the chore**; when a slice
completes it pushes the slice's branch and opens a **stacked draft PR**.
Serialises across every `[main]` seam; parallelises independent trees.

**One commit per chore, one PR per slice**, each slice branched off the one below
it. The stack's state — branches and PR numbers — lives in the work order, which is
what makes the arc resumable across sessions.

**Gate:** on a chore failure, `/do-chores` marks it `⚠ BLOCKED` and stops that
slice — surface the blocker to the user and stop; don't retry-thrash. A blocked
slice also blocks every slice stacked above it, so say which those are. Only when
every slice has a draft PR do you offer to land.

### 4. `/land-the-plane` — review and ship

Reviews the diff **before any PR exists** — `/simplify`, `/code-review` and
`/security-review`, because CI has no reviewer — then commits + pushes, opens the
PR, and waits for CI to go green (lint, typecheck, unit tests, e2e, OpenAPI drift
and the iOS build all live in CI now, so this phase does not duplicate them
locally). Then the QA pass **that matches what changed** (browser for
`web-client/**`, Simulator for `ios/**`, skip when neither was touched).

**With a multi-slice work order it walks the stack bottom-up**, running those gates
per PR against that slice's own diff and merging each before starting the next. So
this phase produces N merges, not one, and it stops at the first slice that fails a
gate — leaving the slices above it open.

**Feed the QA pass the work order's `## Testing notes`.** Pass them to `/qa-review`
as **must-cover scenarios** — the QA agent covers them *in addition to* its own
adversarial edge-case exploration, never instead of it. When the notes say the
change is *not observable in the UI*, skip the browser pass rather than run a
hollow one, and say so.

**Gate:** it stops at any red CI check or surfaced QA bug — raise them to the
user, don't auto-fix; resolving one may take a separate conversation, at which
point `/epic` picks back up from its resumability rules below. If every step
lands clean, `/land-the-plane`'s own Step 6 **merges the PR itself** — there is
no separate confirmation pause once the gates are clear.
Because the Skill tool runs a sub-skill's steps inline, control returns to this
arc automatically the moment `/land-the-plane` finishes (merged, or stopped at a
gate) — continue straight into Step 5 rather than treating the hand-off as
something you need to re-trigger.

### 5. Check the testing notes — the arc's acceptance gate

Before handing off, walk the work order's `## Testing notes` one by one and state,
for each, **how it was confirmed**: covered by Quinn's QA pass (name the flow), by
a named test, by you driving the app, or **not confirmed**. A note nobody checked
is an unmet acceptance criterion — surface it, don't quietly drop it. "The suite is
green" does not discharge a testing note; the notes exist precisely because a green
suite and a working product are different claims.

### 6. Move the tickets to Done

Move the work order's tickets to **Done** only once **every** PR in the stack is
**actually merged**, not merely green. Confirm each merge independently — don't
trust a step summary — with `gh pr view <number> --json state,mergedAt` for every
`PR:` line in the work order. A partially-merged stack is not a finished arc: the
tickets stay **In Progress**.

If `/land-the-plane` stopped at a gate instead of merging the whole stack (a
surfaced issue awaiting the user, a blocked slice, or the user chose not to merge
yet), the arc isn't done: leave the tickets **In Progress**, report which slices
merged and which are still open with why, and stop — resume this step next time
`/epic` is re-entered and the rest of the stack has since merged.

Once the merge is confirmed **and** every testing note is confirmed (no unmet
acceptance criterion, no `⚠ BLOCKED` chore), read the work order's `Tickets:`
header and, for each issue number (skip `—`):

```bash
scripts/project-status.sh "Done" <issue-number> [<issue-number> ...]
```

A board hiccup (issue not on the board, missing `project` scope) is a note, never a
blocker — as in `/do-chores`.

`/epic` ends here — report the merged PRs (the whole stack, bottom-up), the
testing-notes ledger, the tickets moved to Done, and hand off.

## Invariants (hold these across every phase)

- **Don't merge directly.** `/epic` never runs `gh pr merge` itself — merging is
  `/land-the-plane`'s own Step 6, reached only once every one of its gates
  (CI, QA) is clean, and repeated once per slice when the work order is a stack.
  If a gate finds something, the merge waits for the user's decision, same as
  any other phase gate.
- **Never skip a gate**, even for a "small" change — right-size the *work*, not the
  checkpoints.
- **Carry the artifact chain**: the agreed plan (+ ADRs) → `.claude/work-order.md`
  (chores + `## Testing notes` + the stack's branches and PR numbers) → the
  stacked PRs → the testing-notes ledger. Each phase consumes the previous
  phase's artifact; don't re-establish context the artifact already holds.
- **The stack merges bottom-up, in order.** Never merge a slice whose parent is
  still open, and never skip a blocked slice to reach the one above it.
- **A failure stops its phase**, surfaced to the user — not a silent workaround.
- **Verify, don't trust.** Every claim of green — a subagent's, a prior phase's,
  an issue's "still open" status — gets independently reproduced before it's built
  on. A stale premise caught at a gate is the point of the gates.

## Resumability

The state lives in durable artifacts, so `/epic` is resumable: a written ADR /
agreed plan means grilling is done; a `.claude/work-order.md` with ticked boxes
means `/do-chores` can resume from the checkboxes; **any slice carrying a `PR:`
number** means you're in `/land-the-plane`, at the lowest slice whose PR is not yet
merged. On re-entry, read those artifacts to find the current phase and continue
from its gate rather than restarting the arc.

Reconcile the work order against the repo before trusting it — `git branch`, `gh pr
list`, and `gh pr view <n> --json state,mergedAt` for each recorded PR. A session
that died mid-walk may have merged a PR without writing it down, and re-merging or
re-opening is worse than re-reading. **The repo wins; correct the file.**
