---
description: Take a specific Ready For Implementation ticket, or the top Ready For Implementation ticket when none is specified, and coordinate fresh-context Implementation, Review, and Testing stages through Done.
model: opus
---

# Implement Ticket End-to-End

Coordinate exactly one ticket through:

`Ready For Implementation → In Review → In Testing → Done`

This is an orchestrator. It does not replace stage commands and must not collapse Implementation, Review, and Testing into one self-reviewing context.

## Select the Ticket

If `$ARGUMENTS` contains a ticket number, use that issue, verify it is in **Ready For Implementation**, and coordinate it only.

If `$ARGUMENTS` is empty, select the **topmost ticket according to the Project's current ordering** in **Ready For Implementation**.

If no eligible ticket exists, report that there is nothing to implement and stop.

Record the selected ticket number and pass that same explicit number to every downstream stage.

## Reap Before You Start

Before Stage 1, from the main checkout:

```bash
scripts/reap-worktrees.sh                 # dry run: read what would go
scripts/reap-worktrees.sh --force --docker
```

This is the only step in the whole arc that ever collects a worktree left behind by a **failed** run. A failed run merges nothing, so no merge-triggered cleanup ever fires for it, and its worktree sits there until something sweeps it. That sprawl is what makes a later run resume into a stale checkout on an already-squash-merged branch.

The script is dry-run by default and only ever reaps a worktree whose PR has **merged** and which holds nothing that is not already in `main`. Do not weaken either property, and do not pass `--include-review` — anything it lists as REVIEW is the user's call.

## Independence Requirement

Run each stage in a **fresh context/subagent** whenever Claude Code provides a mechanism to do so:

1. `implement-next-ticket <ticket-number>`
2. `review-next-ticket <ticket-number>`
3. `test-next-ticket <ticket-number>`

Do not let the implementation context become its own reviewer/tester merely to save time. Handoff through durable artifacts: ticket specification, Planning notes, stage notes, code, PR, tests, and repository state — not private reasoning transcripts.

## Stage 1 — Implementation

Invoke `implement-next-ticket` for the selected ticket in a fresh context. Success means implementation is on a pushed branch, PR linked, Implementation Notes appended, and ticket **In Review**. If it escalates, stop and surface the escalation unchanged.

## Stage 2 — Review

Invoke `review-next-ticket` for the same ticket in a new fresh context. Success means adversarial review completed, clear findings repaired/re-reviewed, Review Notes appended, and ticket **In Testing**. If it escalates, stop.

## Stage 3 — Testing

Invoke `test-next-ticket` for the same ticket in another fresh context. Testing may temporarily route repairs back through Review. Allow `In Testing → repair → In Review → In Testing`, but Testing owns that loop. Final success means Testing passed, notes appended, unrelated discoveries are at the top of **To Do**, PR merged, and ticket **Done**. If it escalates, stop.

## Reap Last, From Outside

The coordinator's final act, after Testing has merged and moved the ticket to **Done**:

1. **Move to the main checkout first.** `cd` out of the run's worktree.
2. Then run `scripts/reap-worktrees.sh --force --docker`.

The order is the whole point. `reap-worktrees.sh` never removes the worktree the caller is standing in — it skips it as "current" and still reports success. A reap that runs before the move is a no-op that looks like a win, and the directory it was supposed to remove is the one the run was using.

**This runs on an escalation too.** An escalated run tears down the same resources a successful one does. The only thing an escalation changes is that no merge happened, so there is no branch or QA stack for *this* command to collect — those belong to whoever merged.

The coordinator does **not** clean up after a merge it delegated. `test-next-ticket` merged, so `test-next-ticket` tore down the QA stack and the branch. Doing it twice here would race a teardown that already ran.

`docker system prune -a` and `docker volume prune` are forbidden anywhere in this arc. They destroy `fortymm-uat_postgres-data` and the k3d `tailscale-state` Secrets silently.

## Coordinator Responsibilities

Choose exactly one ticket; preserve its identity; ensure stages happen in order and independent contexts; verify expected project status after each stage; stop on escalation/failure; do not duplicate stage logic.

## Feedback Loop Preservation

Preserve the durable artifacts: Discovery specification, Planning notes, Implementation Notes, Review Notes, and Testing Notes. Do not summarize them away or replace them with generic coordinator feedback.

Do not create a redundant coordinator retrospective for stage-level feedback.

If orchestration itself caused friction future runs could avoid — failed subagent handoffs, status-transition problems, inability to invoke a stage reliably, missing permissions, or project automation/tooling issues — append a concise **Coordinator Workflow Friction** comment to the ticket containing:

- what got in the way;
- any workaround used;
- the concrete improvement that would prevent it next time.

Record orchestration friction even when the coordinator ultimately succeeds.

## Completion

The coordinator succeeds only when the selected ticket reaches **Done** through all required stages. At the end report concisely: ticket number/title, PR, implementation deviations, number of Review findings repaired, number of Testing failures repaired, separate To Do issues created, and merge result.

## Escalation Contract

Work autonomously when the path is clear. Stop and involve the user when continuing requires judgment rather than execution: materially ambiguous/contradictory criteria, invalid upstream assumptions, required scope changes, unresolved materially different product/UX/data/architecture choices, unexpectedly destructive/high-risk actions, unavailable required credentials/services/environments, unsafe repository state, repeated failed repair loops, or inability to complete a required stage honestly.

Never reinterpret a stage escalation as permission to improvise. Surface it and stop.

## Hard Rules

- Coordinate exactly one ticket.
- With no argument, select the **topmost ticket in Ready For Implementation**.
- With a ticket number, use that eligible ticket only.
- Pass the explicit selected ticket number to every stage.
- Use fresh contexts/subagents between stages whenever possible.
- Never merge before Review and Testing pass.
- Never continue past a stage escalation.
- Do not duplicate stage prompts inside the coordinator.
- Preserve every stage's structured retrospective notes.
- Reap worktrees at the **start** of the run and again as its **final act**, from the main checkout.
- Run the full cleanup on an escalation, not only on success.
- Do not clean up after a merge a stage performed. Whoever merges cleans up.
- Never run `docker system prune -a` or `docker volume prune`.
