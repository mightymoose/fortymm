---
name: do-chores
description: Drive a work order written by /to-chores — dispatch each chore to its domain-expert subagent in dependency order, tick it off, commit per chore, and open one stacked draft PR per slice. Resumable; leaves review and merging to /land-the-plane.
argument-hint: "[optional path to a work order, else .claude/work-order.md]"
---

# Do Chores

Drive a **work order** to done: dispatch each **chore** to its domain-expert
subagent, tick it off in the file once it reports done, **commit it**, and close
each **tracer-bullet** slice by opening a **stacked draft PR**. The work order's
checkboxes and its per-slice `Branch:`/`PR:` lines are the state, so this skill is
**resumable** — safe to re-run after a stop or in a fresh session.

**One commit per chore, one branch and one PR per slice**, each slice stacked on
the one before it. Read the work order's shape — and the stack's mechanics — from
[work-order-format.md](../to-chores/work-order-format.md).

This skill opens PRs as **drafts** and never merges. Reviewing, gating and merging
the stack bottom-up is `/land-the-plane`'s job.

## Setup

Read the work order at **`.claude/work-order.md`** (or the path argument). If it's
missing, stop and tell the user to run `/to-chores` first. Treat the file as the
source of truth: **ticked box = done**, `⚠ BLOCKED` = needs attention, unticked =
pending.

**Locate the stack.** Read `Stack base:`, `Branch prefix:`, and each slice's
`Branch:` / `PR:` lines, then reconcile them against reality — `git branch --list
'<prefix>-s*'` and `gh pr list --head <branch>` for any slice whose `PR:` is set.
A resume must never re-cut a branch that exists or re-open a PR that is already
open; if the file and the repo disagree, the **repo wins** and you correct the
file. Check out the branch of the earliest unfinished slice before doing anything
else, so the first commit does not land on the wrong branch.

**Move the tickets to In Progress.** Read the `Tickets:` header line. For each issue
number listed (skip if it's `—`), move its card on the FortyMM project board:

```bash
scripts/project-status.sh "In Progress" <issue-number> [<issue-number> ...]
```

The board is a convenience, not a gate — if the script warns that an issue isn't on
the board, or `gh` lacks the `project` scope, **note it and keep driving**; never let
a board hiccup stop the work. Do this once at the start of a run (it's idempotent, so
a resume re-running it is harmless).

**Build the native task list.** Mirror the work order into Claude Code's native task
list (the `TodoWrite` tool) so the run's progress shows up in the UI, not just as
checkboxes in the file — a parent task per slice, a child task per chore, per
[native-tasks.md](../to-chores/native-tasks.md). **Derive each task's status from the
checkboxes** (ticked → completed, `⚠ BLOCKED` → pending with the marker kept in the
task text, else pending) so a resume rebuilds the same picture rather than restarting
from scratch. The checkboxes stay the source of truth; the task list is a live view of
them.

## Drive loop

Keep the native task list in lockstep with the checkboxes as you go (see
[native-tasks.md](../to-chores/native-tasks.md)): a chore's task goes `in_progress`
the moment you dispatch it, `completed` only when its box is ticked, and a slice's
parent task `completed` when the slice closes. This is what makes the run legible in
the UI — do it as a side effect of each step below, not as a separate bookkeeping pass.

Repeat until every chore is ticked or every remaining chore is blocked:

0. **Open the slice** — before the slice's first chore, cut its branch off the
   previous slice's branch (slice 1 off `Stack base:`) and record it:

   ```bash
   git checkout -b <prefix>-s<N> <previous-slice-branch-or-stack-base>
   ```

   Write the branch into the slice's `Branch:` line. If the branch already exists
   (a resume), check it out instead of re-cutting it.

1. **Find ready chores** — unticked, not blocked, with **all `depends-on` ticked**.
2. **Dispatch:** mark each chore's native task `in_progress` as you send it out.
   - `[main]` chores — do them **inline** yourself (regen, integration, glue). You
     are the main session; the cross-layer work is yours.
   - Any other tag — hand off via the Agent tool with `subagent_type` = the tag
     (`api`, `web-client`, `ios`, `infra`, `e2e`). Give the agent the chore's
     "what to build", scope, and **Read-first** pointers. The agents **implement
     but do not ship** — they return a summary, they don't commit or open PRs.
   - **Parallelize** ready chores that touch **different trees** — dispatch at
     most one chore per tree at a time, so a batch never exceeds the number of
     experts actually in play. **Serialize across every `[main]` seam** — never
     start a chore whose `depends-on` includes an unfinished `[main]` chore
     (this is what keeps the OpenAPI regen ahead of the web/iOS chores that
     consume the new types).
3. **Tick and commit** — once the implementing agent reports the chore done, tick
   the box, mark the chore's task `completed`, and **commit the chore** — one
   commit, message naming the chore by ID and what it built (`1a [api]: add
   rating to the profile BFF response`). Commit only the chore's own files; trim
   anything outside its `Scope` before committing. This is the atomic, bisectable
   unit — never batch several ticked chores into one commit.

   If the agent reports it couldn't complete the chore, treat it as a chore
   failure (see below).
4. **Close the slice** — when every chore in a slice is ticked and committed,
   ship it:

   ```bash
   git push -u origin <prefix>-s<N>
   gh pr create --draft --base <previous-slice-branch-or-stack-base> \
     --title "<slice N>: <demoable outcome>" --body "<what and why; the chores it contains>"
   ```

   **`--draft`, always** — these PRs are not review-ready until `/land-the-plane`
   has gated them, and a non-draft PR summons reviewers to a diff nothing has
   checked yet. **`--base` is the previous slice's branch, not `main`** — that is
   what makes the PR show only this slice's diff instead of every slice beneath it.
   Getting `--base` wrong is the single most common way a stack turns into an
   unreviewable pile.

   Write the PR number into the slice's `PR:` line immediately, then mark the
   slice's parent task `completed`. If a PR already exists for the branch, reuse it
   (`gh pr view`) rather than creating a duplicate.

Every chore ends in a commit; every slice ends in a draft PR.

**Never merge, and never un-draft.** Both belong to `/land-the-plane`. Do not
rebase a slice onto a moved `main` either — the stack is rebased only as part of
merging it.

The `## Testing notes` section is **not** this skill's job — it belongs to
`/qa-review` and `/epic`'s final gate. Don't try to satisfy it here; don't delete it.

## On failure — stop the slice

If a chore fails or the implementing agent reports it can't complete the chore:

- Mark it `⚠ BLOCKED: <reason>` in the file and leave the box unticked; keep its
  native task `pending` with `⚠ BLOCKED` in the text so the block is visible in the UI.
- **Stop that slice** — do not start its remaining chores and do not retry-thrash.
  The chores that already passed keep their commits; that is the point of
  committing per chore, and it is what lets a resume pick up mid-slice. But **do
  not open the slice's PR** — a slice with a blocked chore is not a demoable
  increment, and a draft PR for a half-slice invites review of work that is known
  to be incomplete. Leave its `PR:` line as `—`.
- **Other slices whose deps are met may continue** — but only if they do not stack
  on the blocked one. A slice stacked on a broken slice inherits the breakage;
  leave it unstarted and say so.
- When the loop can make no more progress, surface the blocked chores to the user
  with the reason and stop. The user fixes the blocker and re-runs `/do-chores`,
  which resumes from the checkboxes.

## Finish

When every chore is ticked and committed and every slice has a draft PR, report the
**stack bottom-to-top** — each slice, its branch, its PR number, and what it stacks
on — and point the user at **`/land-the-plane`**, which gates and merges it from the
bottom up. Do not merge, un-draft, or rebase — shipping is out of scope for the
driver.
