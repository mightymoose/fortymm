---
description: Implement a specific Ready For Implementation ticket, or the top Ready For Implementation ticket when none is specified. Leave structured implementation notes and move successful work to In Review.
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
4. Stop.

Do not begin Review in this command.

## Escalation Contract

Work autonomously when the path forward is clear.

Stop and involve the user when continuing requires judgment rather than execution, including when:

- acceptance criteria are materially ambiguous or contradictory;
- a Discovery or Planning assumption is materially wrong;
- satisfying the ticket requires changing approved scope or behavior;
- multiple materially different product, UX, data-model, or architectural choices have no clear approved answer;
- proceeding requires an unexpectedly destructive, irreversible, security-sensitive, or otherwise high-risk action;
- required credentials, services, environments, or external dependencies are unavailable;
- repository state makes it unsafe to determine which changes belong to the ticket;
- an autonomous repair loop has failed twice for the same underlying problem;
- the stage cannot be completed honestly.

Do not escalate merely because implementation is harder than expected, understandable tests fail, or ordinary tooling checks fail for a clear reason.

When escalating, stop before the unresolved decision, explain what was discovered and why it blocks safe progress, and present the smallest useful set of choices or specific question. Never weaken acceptance criteria, skip a required stage, or redefine success.

## Hard Rules

- Process exactly one ticket per invocation.
- With no argument, use the topmost ticket in **Ready For Implementation**.
- With a ticket number, use that eligible ticket only.
- Treat acceptance criteria as authoritative and Planning notes as guidance.
- Never silently change scope.
- Never include unrelated user changes.
- Verify before handing to Review.
- Always leave structured Implementation Notes with explicit `N/A` where appropriate.
- Move successful implementation to **In Review**.
- Do not review, test, or merge in this command.
