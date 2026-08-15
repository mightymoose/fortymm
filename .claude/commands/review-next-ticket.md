---
description: Review a specific In Review ticket, or the top In Review ticket when none is specified. Adversarially review and repair the implementation, leave structured review notes, and move accepted work to In Testing.
model: opus
---

# Review Next Ticket

Review exactly one ticket from **In Review**. With a ticket number, use that eligible issue only. With no argument, select the **topmost ticket according to the Project's current ordering** in **In Review**.

Read the complete ticket specification, Planning notes, Implementation Notes, linked PR, complete diff, and relevant surrounding code/tests. Do not rely on the implementer's summary as evidence.

## Adversarial Review

Evaluate every Acceptance Criterion plus relevant correctness, failure paths, invariants, concurrency, security/authorization, compatibility/migrations, error recovery, maintainability, architectural consistency, test quality, hidden coupling, and unnecessary scope. Scale review to the change; do not invent ceremonial findings.

## Repair Loop

If a concrete problem has a clear fix, repair it autonomously on the implementation branch, update tests, verify, and re-review the resulting diff. Keep the ticket **In Review**. If the same underlying problem survives two repair attempts, or a finding exposes specification ambiguity/invalid upstream assumptions, stop and involve the user.

## Review Notes

Append a ticket comment with exactly:

### Review Notes

#### Findings

<List meaningful findings, including repaired findings, or `N/A`.>

#### Repairs Made

<List Review-stage repairs, or `N/A`.>

#### Verification Performed

<List checks performed after review repairs.>

#### Acceptance Criteria Assessment

<State whether the implementation satisfies the criteria and important evidence.>

#### Upstream Gaps

<Anything Discovery, Planning, or Implementation failed to capture that materially contributed to findings, or `N/A`.>

#### Workflow Friction

<Anything that made Review slower, harder, less reliable, or required rediscovering setup/repository knowledge, or `N/A`. Include environment, tooling, CI, test setup, permissions, documentation, GitHub workflow, repeated failures, or avoidable investigation.>

#### Improvement Opportunities

<Concrete changes to Discovery, Planning, Implementation, Review, repository documentation, tooling, CI, environment setup, scripts, fixtures, or agent workflow that could prevent similar friction or findings, or `N/A`.>

Record friction even when successfully worked around. A repaired finding remains valuable feedback.

## Advance

Only when acceptable: commit/push review repairs, verify relevant checks, append Review Notes, move the ticket to **In Testing**, and stop. Do not begin Testing here.

## Escalation Contract

Work autonomously when the path is clear. Stop and involve the user for materially ambiguous/contradictory criteria, invalid upstream assumptions, required scope changes, materially different unresolved product/UX/data/architecture choices, unexpectedly destructive/high-risk actions, unavailable required credentials/services/environments, unsafe repository state, two failed repair attempts for the same problem, or inability to complete the stage honestly.

Do not escalate for understandable failures with clear repairs. Never weaken criteria, skip stages, or redefine success.

## Hard Rules

- Process exactly one ticket.
- No argument means top of **In Review**; an argument means that eligible ticket only.
- Review the actual diff.
- Repair clear local findings autonomously and re-review.
- Never silently reinterpret acceptance criteria.
- Always leave structured Review Notes with explicit `N/A` where appropriate.
- Move accepted work to **In Testing**.
- Do not merge or mark Done here.
