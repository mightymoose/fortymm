---
description: Review a specific In Review ticket, or the top In Review ticket when none is specified. Run the land-the-plane review commands, repair clear findings, leave structured review notes, and move accepted work to In Testing.
model: opus
---

# Review Next Ticket

Review exactly one ticket from **In Review**. With a ticket number, use that eligible issue only. With no argument, select the **topmost ticket according to the Project's current ordering** in **In Review**.

Read the complete ticket specification, Planning notes, Implementation Notes, linked PR, complete diff, and relevant surrounding code/tests. Do not rely on the implementer's summary as evidence.

## Run the Existing Review Commands

Reuse the same review pass already established in `.claude/commands/land-the-plane.md` rather than inventing a parallel review process.

Run these over the ticket's actual implementation diff:

```text
Skill(skill="simplify")
Skill(skill="code-review")
Skill(skill="security-review")
```

Follow the intent of `land-the-plane` for these commands:

- `simplify` may apply edits directly. Those edits are authorized as part of Review.
- `code-review` evaluates correctness and implementation quality.
- `security-review` evaluates vulnerability and security concerns.
- Scale the pass to the diff rather than running meaningless ceremony. A docs-only/generated-only change may have nothing useful for `security-review`; record a justified skip rather than pretending it ran meaningfully.
- Changes involving auth, permissions, data boundaries, migrations, untrusted input, or similarly sensitive surfaces should always receive the relevant security review.

The ticket's Acceptance Criteria remain the authoritative contract. The existing review skills are the mechanism used to inspect the implementation against that contract.

## Repair Loop

If the review commands find a concrete problem and the correct repair is clear:

1. Fix it autonomously on the implementation branch.
2. Add or update tests as appropriate.
3. Run relevant verification.
4. Re-run the applicable `simplify`, `code-review`, and `security-review` commands over the amended diff.
5. Keep the ticket **In Review** while this loop runs.

Do not erase evidence of findings merely because they were repaired.

If the same underlying problem survives two repair attempts, or a finding exposes specification ambiguity/invalid upstream assumptions, stop and involve the user.

## Review Notes

Append a ticket comment with exactly:

### Review Notes

#### Review Commands Run

<List `simplify`, `code-review`, and `security-review`, including any command intentionally skipped and why.>

#### Findings

<List meaningful findings, including repaired findings, or `N/A`.>

#### Repairs Made

<List Review-stage repairs, including `simplify` edits, or `N/A`.>

#### Verification Performed

<List checks performed after review repairs.>

#### Acceptance Criteria Assessment

<State whether the implementation satisfies the criteria and important evidence.>

#### Upstream Gaps

<Anything Discovery, Planning, or Implementation failed to capture that materially contributed to findings, or `N/A`.>

#### Workflow Friction

<Anything that made Review slower, harder, less reliable, or required rediscovering setup/repository knowledge, or `N/A`. Include environment, tooling, CI, test setup, permissions, documentation, GitHub workflow, repeated failures, or avoidable investigation.>

#### Improvement Opportunities

<Concrete changes to Discovery, Planning, Implementation, Review, repository documentation, tooling, CI, environment setup, scripts, fixtures, skills, or agent workflow that could prevent similar friction or findings, or `N/A`.>

Record friction even when successfully worked around. A repaired finding remains valuable feedback.

## Advance

Only when the review pass is clean and the implementation satisfies the ticket:

1. Commit and push any Review repairs.
2. Verify relevant checks.
3. Append Review Notes.
4. Move the ticket to **In Testing**.
5. Stop.

Do not begin Testing here.

## Escalation Contract

Work autonomously when the path is clear. Stop and involve the user for materially ambiguous/contradictory criteria, invalid upstream assumptions, required scope changes, materially different unresolved product/UX/data/architecture choices, unexpectedly destructive/high-risk actions, unavailable required credentials/services/environments, unsafe repository state, two failed repair attempts for the same problem, or inability to complete the stage honestly.

Do not escalate for understandable failures with clear repairs. Never weaken criteria, skip stages, or redefine success.

## Hard Rules

- Process exactly one ticket.
- No argument means top of **In Review**; an argument means that eligible ticket only.
- Run the established `land-the-plane` review commands instead of inventing a separate review methodology.
- Review the actual diff.
- Repair clear local findings autonomously and re-run the applicable review commands.
- Never silently reinterpret acceptance criteria.
- Always leave structured Review Notes with explicit `N/A` where appropriate.
- Move accepted work to **In Testing**.
- Do not merge or mark Done here.
