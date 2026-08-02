# Mirroring the work order into the native task list

Both `/to-chores` and `/do-chores` mirror the work order into Claude Code's
**native task list** (the `TodoWrite` tool) so the slice/chore breakdown — and,
while `/do-chores` runs, its live progress — shows up in the UI instead of living
only as checkboxes in `.claude/work-order.md`. This file is the single source of
truth for that mapping; both skills reference it so they can't drift.

## The shape: tasks made of tasks

The work order is already two levels deep, and the task list mirrors both levels:

- **Each tracer-bullet slice → one parent task.** Its text is the slice's demoable
  outcome (`Slice 1: <outcome>`). This is the "task made of tasks."
- **Each chore → one child task** under its slice's parent. Its text is the chore
  ID + agent tag + the one-line "what to build"
  (`1a [api] Add rating to the profile BFF response + schema`).

Always keep the **chore ID** in the task text — it's the stable handle that ties a
task back to its line in the work order, and it's what lets a resume reconcile the
two instead of guessing.

If the running Claude Code build's task tool doesn't support nested subtasks, fall
back to a flat list of one task per chore, each prefixed with its slice number
(`S1 · 1a [api] …`), so the grouping is still legible. Never drop the per-chore
granularity — **one task per chore is the floor**.

## Status is derived from the work order, never invented

The work-order checkboxes remain the source of truth for run state; the task list
is a *view* of them. Map status straight across so a resume rebuilds the same
picture rather than starting fresh:

| Work-order state | Native task status |
| --- | --- |
| Unticked `- [ ]`, no marker | pending |
| Chore currently dispatched | in_progress |
| Ticked `- [x]` | completed |
| `⚠ BLOCKED: …` | pending, with `⚠ BLOCKED` kept in the task text |

A slice's parent task is `completed` only when **every** chore under it is ticked
and committed — the same bar `/do-chores` uses to close a slice and open its
stacked draft PR. A slice with any pending or blocked chore stays `in_progress`
(or pending, if untouched), and gets no PR.

When `/do-chores` fans a batch of ready chores across different trees, each
dispatched chore's task goes `in_progress` together and flips to `completed` once
the implementing agent reports the chore done, exactly as the checkbox is ticked
on that report.
