---
description: Take a specific Ready For Implementation ticket, or the top Ready For Implementation ticket when none is specified, and coordinate fresh-context Implementation, Review, and Testing stages through Done. Holds a human review gate on the pull request between Review and Testing, and resumes a ticket already mid-arc.
model: opus
---

# Implement Ticket End-to-End

Coordinate exactly one ticket through:

`Ready For Implementation → In Progress → In Review → Waiting For Sign Off → [human gate] → In Testing → Done`

A change request at the gate sends it back: `Waiting For Sign Off → In Progress`, and round the loop again.

Re-invoked on a ticket already mid-arc, it detects where the ticket got to and continues from there.

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

Run each stage — `implement-next-ticket`, `review-next-ticket`, `test-next-ticket` — in a **fresh context/subagent** whenever Claude Code provides a mechanism to do so, passing the explicit ticket number.

Dispatch each stage as its own unit. A stage's `model:` frontmatter only takes effect when it runs as its own context — loaded inline, the stage quietly runs on the coordinator's model, the same class of silent override the root `CLAUDE.md` warns about for call-site `model` parameters.

Do not let the implementation context become its own reviewer/tester merely to save time. Handoff through durable artifacts: ticket specification, Planning notes, stage notes, code, PR, tests, and repository state — not private reasoning transcripts.

## Stage 1 — Implementation

Invoke `implement-next-ticket` for the selected ticket in a fresh context. That stage moves the ticket to **In Progress** when it claims it, so a ticket sitting In Progress with no pull request is an implementation run in flight or a dead one, not an unclaimed ticket. Success means implementation on a pushed branch, PR linked, Implementation Notes appended, and the ticket **In Review**. If it escalates, stop and surface the escalation unchanged.

Do not wait for CI between the stages. Review waits for green itself, as a step of its own, and a red build is Review's finding to report.

## Stage 2 — Review

Invoke `review-next-ticket` for the same ticket in a new fresh context. Success means adversarial review completed, clear findings repaired/re-reviewed, Review Notes appended, a non-draft pull request open with CI green, a decision comment posted on it, and the ticket in **Waiting For Sign Off**. If it escalates, stop.

**Recover the decision comment's timestamp from the stage report.** It is the watch anchor.

**Review writes the Waiting For Sign Off column, not the coordinator.** The ticket is In Review while the repair loop runs, and moves to Waiting For Sign Off at the moment the ask is posted. Verify it landed there before entering the watch; do not write it yourself to paper over a stage that did not finish.

## The Human Gate

Between Review and Testing a human decides. `.claude/rules/the-review-gate.md` is the single definition of the signal — who may give it, what counts, the three comment surfaces, and the check itself. Read it; do not restate it here.

The coordinator holds the gate. It does not review, and it does not repair. Every repair round runs in a fresh `review-next-ticket` context.

### The watch

After Review stops, watch the pull request for **15 minutes**. Poll over REST, never the project board — a board poll is GraphQL, and a single run has exhausted all 5000 points and blocked a status write.

**Anchor the watch to the decision comment Review just posted.** `review-next-ticket` reports that comment's timestamp; only comments strictly newer than it count. An unanchored watch re-reads its own round and either loops on the same "fix line 40" forever or releases on the previous round's `LGTM`. The rule file has the mechanics.

The ticket sits in **Waiting For Sign Off** for the whole watch. Three outcomes:

1. **The signal arrives.** Move the ticket to **In Testing** and invoke `test-next-ticket`.
2. **Any other comment from `mightymoose` arrives**, newer than the anchor. Re-invoke `review-next-ticket` in **targeted mode**, naming exactly those comments. That command moves the ticket to **In Progress** itself and back to **Waiting For Sign Off** when it posts its fresh decision comment — do not write either column here. When it stops, **the 15-minute watch restarts, re-anchored to that round's new decision comment.** There is no limit on rounds; each one is a fresh context.
3. **The budget expires with no comment.** Stop and report. Do not wait longer, do not proceed to Testing, and do not assume silence is consent. An agent must not park on a human for hours.

On expiry the ticket **stays in Waiting For Sign Off**. The watcher went away; the ask did not. That column is what lets a human find the work later without the run's report in front of them.

The expiry report names: the ticket, the PR URL, Review's findings, and **the exact command to resume**. Without that last part every gate is a cliff, and the ticket strands mid-arc with no record of where it got to.

## Resuming a Ticket Already Mid-Arc

Re-invoked on a ticket that is already partway through, this command **detects where it is and continues**. It does not start over.

Read all of: the board column, whether the branch exists, whether a PR exists, whether that PR is a draft, whether CI is green, whether the gate signal is present, and whether the PR is merged.

**They disagree.** A ticket sitting In Review with a merged PR is a real state that has occurred. So the precedence is fixed, highest first:

| # | Condition | Resume at |
| --- | --- | --- |
| 1 | The PR is **merged** | Nothing to run. Set the ticket **Done**, then reap. |
| 2 | Gate signal present, CI green | Set **In Testing**, invoke `test-next-ticket`. |
| 3 | A non-draft PR is open with a decision comment on it | Set **Waiting For Sign Off** if it is not already there, then re-enter **the watch**. |
| 4 | A PR is open, draft or with no decision comment | Re-invoke `review-next-ticket`. |
| 5 | A branch exists, no PR | Re-invoke `review-next-ticket`, which opens the PR. |
| 6 | None of the above | Start at **Stage 1**. |

**Rows 2 and 3 need an anchor, and a resumed run has no memory of one.** Recover it: the anchor is the **newest decision comment on the pull request**. Every round posts one, so the newest marks the start of the round still awaiting a decision. If no decision comment can be identified, fall back to row 4 and let a fresh `review-next-ticket` post one — that is cheaper and safer than releasing on a signal that answered an earlier round. Report which anchor was used.

Row 3 is the one place the coordinator may write **Waiting For Sign Off**. A run that died between posting the ask and moving the column leaves exactly that mismatch, and correcting it is repair, not ownership.

**Git and PR state outrank the board column, always.** The column is written *after* a stage finishes, so it is the stalest signal of the set — a run that died mid-stage leaves it describing a stage that already completed. Use it only to break a tie the rows above cannot, and when it contradicts the PR, correct the column rather than the plan.

Report which row matched and why before acting on it.

## Stage 3 — Testing

Invoke `test-next-ticket` for the same ticket in another fresh context. Testing routes its repairs through fresh `review-next-ticket` **Testing repair rounds**; the ticket stays **In Testing** and Testing owns that loop — a repair round posts no new ask and does not re-open the gate, because the human already released this work (the gate's "ever" window). Final success means Testing passed, notes appended, unrelated discoveries are at the top of **To Do**, PR merged, and ticket **Done**. If it escalates, stop.

## Reap Last, From Outside

The coordinator's final act, after Testing has merged and moved the ticket to **Done**:

1. **Move to the main checkout first.** `cd` out of the run's worktree.
2. Then run `scripts/reap-worktrees.sh --force --docker`.

The order is the whole point. `reap-worktrees.sh` never removes the worktree the caller is standing in — it skips it as "current" and still reports success. A reap that runs before the move is a no-op that looks like a win, and the directory it was supposed to remove is the one the run was using.

**This runs on an escalation too.** An escalated run tears down the same resources a successful one does. The only thing an escalation changes is that no merge happened, so there is no branch or QA stack for *this* command to collect — those belong to whoever merged.

The coordinator does **not** clean up after a merge it delegated. `test-next-ticket` merged, so `test-next-ticket` tore down the QA stack and the branch. Doing it twice here would race a teardown that already ran.

`docker system prune -a` and `docker volume prune` are forbidden anywhere in this arc. They destroy `fortymm-uat_postgres-data` and the k3d `tailscale-state` Secrets silently.

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

`.claude/rules/escalation.md` is the contract — when to stop, when not to, and how. One addition for the coordinator: never reinterpret a stage escalation as permission to improvise. Surface it and stop.

## Hard Rules

- Coordinate exactly one ticket, and pass its explicit number to every stage.
- Use fresh contexts/subagents between stages whenever possible.
- Never merge before Review and Testing pass.
- Never continue past a stage escalation.
- Do not duplicate stage prompts inside the coordinator.
- Preserve every stage's structured retrospective notes.
- Never move a ticket into **In Testing** without the gate signal.
- **In Testing** is the coordinator's only gate-related column write. `review-next-ticket` owns **Waiting For Sign Off** and the **In Progress** bounce-back.
- Hold the gate for a bounded 15 minutes, restarting the watch after every targeted round.
- On expiry, leave the ticket in **Waiting For Sign Off**.
- Never repair code in the coordinator. Every repair round is a fresh `review-next-ticket`.
- On resume, read every state signal and follow the fixed precedence. Git and PR state outrank the board column.
- Reap worktrees at the **start** of the run and again as its **final act**, from the main checkout.
- Run the full cleanup on an escalation, not only on success.
- Do not clean up after a merge a stage performed. Whoever merges cleans up.
- Never run `docker system prune -a` or `docker volume prune`.
