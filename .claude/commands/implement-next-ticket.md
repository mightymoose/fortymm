---
description: Implement a specific Ready For Implementation ticket, or the top Ready For Implementation ticket when none is specified. Leave structured implementation notes, then hand off to review-next-ticket in a fresh context so the run ends at Waiting For Sign Off with CI green, ready for a human's LGTM.
model: sonnet
---

# Implement Next Ticket

Implement exactly one GitHub ticket from the project's **Ready For Implementation** column.

The ticket has completed Discovery and Planning. Treat the GitHub issue body as the authoritative specification and the Planning note as implementation guidance.

Implementation owns writing and verifying the code. It does not approve its own work for testing or merge.

## Select the Ticket

If `$ARGUMENTS` contains a ticket number, use that issue, verify it is in **Ready For Implementation**, and work on it only.

If `$ARGUMENTS` is empty, select the **topmost ticket according to the Project's current ordering** in **Ready For Implementation**.

If no eligible ticket exists, report that there is nothing to implement and stop.

## Claim the Ticket

As soon as the ticket is selected, and before you read the ticket in full or touch any code, move it to **In Progress**.

Move it first so the board shows the work is claimed. Many agent sessions run against this board at once. A ticket that stays in **Ready For Implementation** while an agent works it can be picked up a second time by another run.

If the move fails, stop and report. Do not implement a ticket you could not claim.

## Prepare

Before editing code:

1. Read the complete ticket, including Discovery specification and Planning notes.
2. Read relevant parent and linked issues.
3. Inspect repository state and relevant code, tests, schemas, interfaces, and conventions.
4. Identify the appropriate branch/worktree strategy.
5. Confirm unrelated user changes will not be included.

Do not redo Discovery or Planning. Tactical details may change, but approved behavior and acceptance criteria may not be silently changed.

## Implement

1. Implement the smallest coherent change that satisfies the ticket.
2. Add or update appropriate tests.
3. Follow repository conventions unless the ticket changes them.
4. Preserve ticket constraints and invariants.
5. Run the most relevant local verification available.
6. Fix ordinary implementation and verification failures autonomously when the correct fix is clear.
7. Re-run relevant verification after repairs.

Do not broaden scope for nearby cleanup. Record unrelated work as a follow-up candidate.

## Prepare the Reviewable Change

When implementation is complete:

1. Ensure the change is on an appropriate feature branch.
2. Commit with a clear message.
3. Push the branch.
4. Create or reuse a pull request.
5. Link the PR to the ticket.
6. Do not merge it.
7. Do not perform independent Review yourself.

Use established repository tooling for commit/push/PR workflows when available.

## Implementation Notes

Before moving forward, append a ticket comment with exactly this structure:

### Implementation Notes

#### What Changed

<Concise description of the implementation actually produced.>

#### Verification Performed

<List tests, checks, builds, or other verification performed.>

#### Deviations From Planning

<Anything materially different from the Planning note and why, or `N/A`.>

#### Unexpected Complexity

<Anything that made implementation meaningfully harder or broader than Planning anticipated, or `N/A`.>

#### Upstream Gaps

<Anything Discovery or Planning failed to capture that would have made implementation clearer, safer, or better scoped, or `N/A`.>

#### Follow-Up Candidates

<Useful work discovered outside this ticket, or `N/A`. Do not create follow-up tickets here unless the workflow explicitly requires it.>

#### Workflow Friction

<Anything that made this stage slower, harder, less reliable, or required figuring something out that could have been known in advance, or `N/A`. Include environment setup, services, fixtures, commands, credentials, permissions, repository conventions, CI/local differences, unreliable tooling, hard-to-find context, GitHub/project automation friction, retries, or missing scripts/docs/skills.>

#### Improvement Opportunities

<Concrete changes that would make future work like this cheaper, faster, safer, or more reliable. This may include changes to Discovery, Planning, prompts, repository documentation, development tooling, CI, environment setup, scripts, fixtures, or agent workflow, or `N/A`.>

These notes are retrospective training data for improving the workflow. Be specific and evidence-based. Do not manufacture criticism merely to populate sections.

Record friction even when you successfully worked around it. If a future agent could avoid an investigation, failure, retry, workaround, or setup discovery, record it.

## Advance the Ticket

Only after implementation and relevant verification succeed:

1. Append Implementation Notes.
2. Ensure the PR is linked.
3. Move the ticket to **In Review**.
4. Hand off to Review, below.

## Hand Off to Review

**Do not stop at In Review.** Invoke `review-next-ticket` for this ticket, by number, **in a fresh context/subagent**, and let it run to its own stop.

**The fresh context is not optional, and it is not about tidiness.** This command is pinned to `sonnet` and `review-next-ticket` is pinned to `opus`. A command's `model:` frontmatter only takes effect when the stage is dispatched as its own unit — invoked inline, its instructions would load into *this* context and Review would quietly run on the implementer's model, which is the same class of silent downgrade the root `CLAUDE.md` warns about for call-site `model` overrides. Dispatch it the way `implement-ticket-end-to-end` dispatches its stages.

The second reason is the ordinary one: a reviewer that just wrote the code is not a reviewer. Fresh context is what makes the review a review.

**If this session has no mechanism to dispatch a fresh context, do not run Review inline.** Stop at **In Review** and report that Review still needs to run. `implement-ticket-end-to-end` invokes Review itself in exactly that case, and a manual `review-next-ticket` picks it up outside the coordinator.

The human's touch point is the **Waiting For Sign Off** column, not this handoff. A ticket parked in **In Review** is waiting on nothing: no cron, no GitHub Action and no hook starts Review, so it sits there until a person notices. That wait is what this handoff removes.

**Do not wait for CI before invoking it.** `review-next-ticket` waits for green itself, as a step of its own, and it is the stage that owns that wait. Waiting here would only duplicate it — and a red build is Review's finding to report, not a reason for this command to sit on a finished implementation.

Review is a genuinely separate stage and stays one:

- It runs the `land-the-plane` review commands against the diff, rather than re-reading the work with the eyes that just wrote it.
- It ends by posting the decision comment and moving the ticket to **Waiting For Sign Off**, which is where a human picks it up.
- **It cannot release its own gate.** Only a comment from the reviewer whose whole body normalizes to `lgtm` moves work to Testing, and `test-next-ticket` refuses without one. See `.claude/rules/the-review-gate.md`. Chaining Review onto Implementation changes when Review starts. It does not change who approves.

If Review escalates, or its repairs cannot be made cleanly, stop and report — leaving the ticket wherever Review left it. Do not paper over a Review finding to reach the column.

Report both stages when you finish: what was implemented, what Review found and repaired, what CI says, and the PR URL.

Do not begin Testing in this command.

## Escalation Contract

`.claude/rules/escalation.md` is the contract — when to stop, when not to, and how.

## Hard Rules

- Process exactly one ticket per invocation.
- Move the ticket to **In Progress** at selection time, before any other work.
- Never silently change scope, and never include unrelated user changes.
- Verify before handing to Review.
- Always leave structured Implementation Notes with explicit `N/A` where appropriate.
- Move successful implementation to **In Review**, then invoke `review-next-ticket` for it by number, in a fresh context/subagent so its `model: opus` pin still applies.
- The run ends at **Waiting For Sign Off**, at an escalation, or at the no-fresh-context stop above. Never review inline.
- Do not wait for CI before handing off. Review owns that wait.
- Never set **In Testing**, and never post the release signal on your own pull request. A human releases Review to Testing (`.claude/rules/the-review-gate.md`).
- Do not test or merge in this command.
