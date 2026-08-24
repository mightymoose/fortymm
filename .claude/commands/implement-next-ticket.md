---
description: Implement one specified Ready For Implementation ticket. Claim it, implement, open the PR, leave structured implementation notes, and stop at In Review. Requires the ticket number, which the implement-ticket-end-to-end orchestrator selects and passes.
model: sonnet
---

# Implement Next Ticket

Implement exactly one GitHub ticket from the project's **Ready For Implementation** column.

The ticket has completed Discovery and Planning. Treat the GitHub issue body as the authoritative specification and the Planning note as implementation guidance.

Implementation owns writing and verifying the code. It does not approve its own work for testing or merge.

## The Ticket

`$ARGUMENTS` must contain a ticket number. Verify that issue is in **Ready For Implementation** and work on it only.

If `$ARGUMENTS` is empty, stop and report: this command does not select tickets. `implement-ticket-end-to-end` selects the next ticket and passes its number here.

## Claim the Ticket

As soon as the ticket is selected, and before you read the ticket in full or touch any code, move it to **In Progress**:

```bash
scripts/project-status.sh "In Progress" <issue-number>
```

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
3. Move the ticket to **In Review**:
   ```bash
   scripts/project-status.sh "In Review" <issue-number>
   ```
4. Stop, and report the next command: `review-next-ticket <ticket-number>`.

`implement-ticket-end-to-end` is the orchestrator. It dispatches Review as its next stage, in a fresh context, and the fresh context is what makes the review a review: a reviewer that just wrote the code is not a reviewer. Do not review your own implementation, and do not invoke `review-next-ticket` yourself.

**Do not wait for CI before stopping.** `review-next-ticket` waits for green itself, as a step of its own. A red build is Review's finding to report, not a reason to sit on a finished implementation.

Run standalone, this command still stops here. Nothing watches an In Review ticket — no cron, no GitHub Action, no hook — so say so in the final report and name the resume command.

## Escalation Contract

`.claude/rules/escalation.md` is the contract — when to stop, when not to, and how.

## Hard Rules

- Process exactly one ticket per invocation, and only the ticket number given. Never select from the board.
- Move the ticket to **In Progress** at selection time, before any other work.
- Never silently change scope, and never include unrelated user changes.
- Verify before handing to Review.
- Always leave structured Implementation Notes with explicit `N/A` where appropriate.
- Move successful implementation to **In Review**, then stop. The orchestrator dispatches Review.
- Do not review your own implementation, and do not invoke `review-next-ticket` yourself.
- Do not wait for CI before stopping. Review owns that wait.
- Never set **In Testing**, and never post the release signal on your own pull request. A human releases Review to Testing (`.claude/rules/the-review-gate.md`).
- Do not test or merge in this command.
