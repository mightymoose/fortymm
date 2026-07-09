---
name: do-chores
description: Drive a work order written by /to-chores — dispatch each chore to its domain-expert subagent in dependency order, verify, tick it off, and commit per slice. Resumable; leaves the PR to /land-the-plane.
disable-model-invocation: true
argument-hint: "[optional path to a work order, else .claude/work-order.md]"
---

# Do Chores

Drive a **work order** to done: dispatch each **chore** to its domain-expert
subagent, verify, tick it off in the file, and commit each **tracer-bullet** slice
as a working increment. The work order's checkboxes are the state, so this skill is
**resumable** — safe to re-run after a stop or in a fresh session.

Read the work order's shape from
[work-order-format.md](../to-chores/work-order-format.md).

## Setup

Read the work order at **`.claude/work-order.md`** (or the path argument). If it's
missing, stop and tell the user to run `/to-chores` first. Treat the file as the
source of truth: **ticked box = done**, `⚠ BLOCKED` = needs attention, unticked =
pending.

## Drive loop

Repeat until every chore is ticked or every remaining chore is blocked:

1. **Find ready chores** — unticked, not blocked, with **all `depends-on` ticked**.
2. **Dispatch:**
   - `[main]` chores — do them **inline** yourself (regen, integration, glue). You
     are the main session; the cross-layer work is yours.
   - Any other tag — hand off via the Agent tool with `subagent_type` = the tag
     (`api`, `web-client`, `ios`, `infra`, `e2e`). Give the agent the chore's
     "what to build", scope, and **Read-first** pointers, and tell it to
     self-verify with the chore's **Verify** command. The agents
     **implement but do not ship** — they return a summary, they don't commit or
     open PRs.
   - **Parallelize** ready chores that touch **different trees** (dispatch them in
     one batch). **Serialize across every `[main]` seam** — never start a chore
     whose `depends-on` includes an unfinished `[main]` chore (this is what keeps
     the OpenAPI regen ahead of the web/iOS chores that consume the new types).
3. **Verify — with a fresh agent, every chore, no exceptions.** An implementing
   agent's report is a *claim*, not evidence, and it is the last party who should
   grade it. You are the second-worst: you watched it happen and you want it to
   pass. So dispatch the **`verifier`** subagent (Agent tool, `subagent_type:
   "verifier"`) with the chore's *what to build*, `Scope`, `Verify`, `Proves`, and
   `Demo`, plus the implementer's summary marked explicitly as an unverified claim,
   plus the **base SHA** for the scope check — the commit the slice builds on
   (`git rev-parse HEAD` before the slice's first chore; record it when you start
   the slice). Without it the verifier has no defined ref to diff against.

   The verifier has **no edit tools**. It re-runs `Verify`, adversarially checks the
   `Proves` claim (did the new test actually get collected? was the command already
   green before the chore? does the test assert behavior or was it weakened to fit
   the code? is there a discriminating assertion?), **runs the `Demo`**, and checks
   the chore stayed inside its `Scope`. It returns `PASS`, `FAIL`, or `INCONCLUSIVE`.

   - **PASS** → tick the box.
   - **FAIL** → treat exactly like a chore failure (see below). Mark `⚠ BLOCKED`.
   - **INCONCLUSIVE** → *not* a pass. Resolve what it couldn't establish, or block.

   Never tick a box on a report you did not have independently reproduced. Never
   verify a chore with the agent that implemented it, and never let a `[main]` chore
   grade itself either — dispatch the verifier for those too.
4. **Close the slice** — when every chore in a slice is ticked, run the slice's
   **demoable outcome** end-to-end as a final check, then **commit the slice** (a
   working, demoable increment; message names the slice). Do not squash slices into
   one commit — per-slice commits are the audit trail.

Every chore ends in a demo, and every slice ends in a demoable increment. If a chore
has no `Demo` — nothing observable, even at a REPL or a job invocation — that is a
signal the chore is a fragment rather than a unit of work; consider merging it into
the chore that makes it observable.

The `## Testing notes` section is **not** this skill's job — it belongs to
`/qa-review` and `/epic`'s final gate. Don't try to satisfy it here; don't delete it.

## On failure — stop the slice

If a chore fails or its Verify won't go green:

- Mark it `⚠ BLOCKED: <reason>` in the file and leave the box unticked.
- **Stop that slice** — do not start its remaining chores, do not retry-thrash, do
  not commit a half-slice.
- **Other slices whose deps are met may continue.**
- When the loop can make no more progress, surface the blocked chores to the user
  with the reason and stop. The user fixes the blocker and re-runs `/do-chores`,
  which resumes from the checkboxes.

## Finish

When all chores are ticked and all slices committed, tell the user the work order
is complete and point them at **`/land-the-plane`** to review and ship. Do not open
a PR or merge yourself — shipping is out of scope for the driver.
