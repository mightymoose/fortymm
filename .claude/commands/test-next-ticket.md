---
description: Test a specific In Testing ticket, or the top In Testing ticket when none is specified. Adversarially test behavior, repair current-ticket failures when clear, create To Do issues for separate discoveries, leave structured testing notes, then merge and move successful work to Done.
model: sonnet
---

# Test Next Ticket

Test exactly one ticket from **In Testing**. With a ticket number, use that eligible issue only. With no argument, select the **topmost ticket according to the Project's current ordering** in **In Testing**.

Testing is an adversarial behavioral gate. Try to falsify the ticket's Acceptance Criteria using the real application or closest realistic surface appropriate to the change.

Read the ticket specification, relevant parent requirements, Review Notes, and linked PR. Use implementation details only for setup/diagnosis, not to decide what behavior deserves testing.

## Testing Surface

Use the most realistic relevant surface: browser black-box QA, iOS Simulator, API/integration execution, database/concurrency exercises, or focused automated tests. Reuse established repository QA commands/skills. Do not force browser testing onto non-browser behavior.

## Adversarial Testing

Where relevant exercise happy paths, failures, retries/recovery, boundaries, unusual valid inputs, concurrency/repeated actions, permissions, state transitions, compatibility, and affected parent-level behavior. Capture concrete evidence for failures.

## Classify Findings

### Current-Ticket Failure

If the implementation violates this ticket's criteria/constraints and the repair is clear: repair it, add regression coverage, commit/push, send it back through **Review**, and after Review passes re-run relevant Testing. Do not create a follow-up as a substitute for fixing this ticket. If correct behavior is ambiguous, involve the user.

### Separate Discovery

If a real finding is outside approved scope: create a freeform GitHub issue, link it back to this ticket, put it at the **top of To Do**, and do not perform Discovery on it now. The current ticket may still pass if its own criteria are satisfied.

## Testing Notes

Append a ticket comment with exactly:

### Testing Notes

#### Scenarios Exercised

<List meaningful scenarios and environments.>

#### Failures Found

<List current-ticket failures, including repaired failures, or `N/A`.>

#### Separate Issues Created

<Link every unrelated issue created from Testing, or `N/A`.>

#### Repairs and Retesting

<Describe repairs, Review re-entry, and retesting, or `N/A`.>

#### Acceptance Criteria Assessment

<State evidence for each criterion, or summarize clearly if long.>

#### Missing or Weak Criteria

<Anything Testing revealed Discovery should have specified more clearly, or `N/A`.>

#### Upstream Gaps

<Anything Discovery, Planning, Implementation, or Review missed that materially affected Testing, or `N/A`.>

#### Workflow Friction

<Anything that made Testing slower, harder, less reliable, or required figuring out setup that could have been known in advance, or `N/A`. Include environment startup, services, fixtures/test data, browser/simulator setup, credentials, permissions, test commands, CI/local differences, flaky tooling, port conflicts, hard-to-find context, retries, or missing scripts/docs/skills.>

#### Improvement Opportunities

<Concrete changes to Discovery, Planning, Implementation, Review, Testing, repository documentation, QA/dev tooling, CI, environment setup, scripts, fixtures, or agent workflow that would make future testing cheaper, faster, safer, or more reliable, or `N/A`.>

Record friction even when successfully worked around. If a future tester could avoid investigation, failure, retry, workaround, or setup discovery, record it.

## Merge and Complete

Only after all current-ticket criteria pass, repairs have passed Review again, relevant checks are green, and no escalation remains: append Testing Notes, merge using normal repository strategy/protections, verify merge succeeded, move ticket to **Done**, close the issue if normal convention, and stop. Never bypass branch protection or required checks.

## Escalation Contract

Work autonomously when the path is clear. Stop and involve the user for materially ambiguous/contradictory criteria, invalid upstream assumptions, required scope changes, materially different unresolved product/UX/data/architecture choices, unexpectedly destructive/high-risk actions, unavailable required credentials/services/environments, unsafe repository state, two failed repair attempts for the same problem, or inability to complete honestly.

Do not escalate for understandable failures with clear repairs. Never weaken criteria, skip stages, or redefine success.

## Hard Rules

- Process exactly one ticket.
- No argument means top of **In Testing**; an argument means that eligible ticket only.
- Test behavior against the specification, not implementer expectations.
- Current-ticket failures must be fixed before Done.
- Separate discoveries become linked issues at the **top of To Do**.
- Code changes during Testing require Review again.
- Always leave structured Testing Notes with explicit `N/A` where appropriate.
- Merge only after Testing passes.
