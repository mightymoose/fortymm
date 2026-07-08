---
name: epic
description: Drive a change end-to-end through the fortymm arc — /grill-with-docs → /to-chores → /do-chores → /land-the-plane — as a GATED conductor. It sequences the four phases and carries the plan→work-order→PR artifact chain, but stops for your decision at every phase boundary and never merges. Use to run a whole feature/bugfix through the arc from one entry point; use the individual skills when you only want one phase.
disable-model-invocation: true
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
merges (that stays with the user), never skips a gate, and never retries a
blocked phase in a loop.

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
regen especially). Decompose-only.

**Gate:** `/to-chores` already quizzes the user on granularity and requires
approval before it writes the file. Relay that approval step — do not fabricate
the plan a chore depends on; if a decision isn't captured, that's a loop back to
`/grill-with-docs`, not an invention. **Right-size the ceremony:** a genuinely
single-tree change is one slice / one or two chores, not a manufactured epic.

### 3. `/do-chores` — drive the work order to green

Dispatches each chore to its domain-expert subagent in dependency order, verifies
with the chore's own command, ticks the checkbox, and commits **per slice**.
Serialises across every `[main]` seam; parallelises independent trees.

**Gate:** on a chore failure, `/do-chores` marks it `⚠ BLOCKED` and stops that
slice — surface the blocker to the user and stop; don't retry-thrash. Only when
every slice is committed do you offer to land.

### 4. `/land-the-plane` — review and ship

Runs `/simplify`, all applicable test suites, commits + pushes, opens the PR, then
`/code-review`, `/security-review`, and the QA pass **that matches what changed**
(browser for `web-client/**`, Simulator for `ios/**`, skip when neither was
touched). Its review depth should track the change's risk, not a fixed ceremony.

**Gate:** it stops at any surfaced code-review issue, security finding, or QA bug
— raise them to the user, don't auto-fix. And it stops **before merge**: this is
an agent-authored branch, self-merge is blocked (two-party review), so the merge
is always the user's. `/epic` ends here — report the PR and hand off.

## Invariants (hold these across every phase)

- **Never merge.** The arc ends at a ready, green PR; the user merges.
- **Never skip a gate**, even for a "small" change — right-size the *work*, not the
  checkpoints.
- **Carry the artifact chain**: the agreed plan (+ ADRs) → `.claude/work-order.md`
  → the branch/PR. Each phase consumes the previous phase's artifact; don't
  re-establish context the artifact already holds.
- **A failure stops its phase**, surfaced to the user — not a silent workaround.

## Resumability

The state lives in durable artifacts, so `/epic` is resumable: a written ADR /
agreed plan means grilling is done; a `.claude/work-order.md` with ticked boxes
means `/do-chores` can resume from the checkboxes; an open PR means you're in
`/land-the-plane`. On re-entry, read those artifacts to find the current phase and
continue from its gate rather than restarting the arc.
