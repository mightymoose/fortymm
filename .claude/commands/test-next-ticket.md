---
description: Test a specific In Testing ticket, or the top In Testing ticket when none is specified. Run the qa-review skill adversarially, repair current-ticket failures when clear, create To Do issues for separate discoveries, leave structured testing notes, then merge and move successful work to Done.
model: sonnet
---

# Test Next Ticket

Test exactly one ticket from **In Testing**. With a ticket number, use that eligible issue only. With no argument, select the **topmost ticket according to the Project's current ordering** in **In Testing**.

Testing is an adversarial behavioral gate. Its primary testing engine is the existing `qa-review` skill.

Read the ticket specification, relevant parent requirements, Review Notes, and linked PR. Use implementation details only for setup/diagnosis, not to decide what behavior deserves testing.

## Run QA Review

Invoke:

```text
Skill(skill="qa-review")
```

Use `qa-review` to perform the adversarial QA pass against the actual implemented ticket.

The ticket's Acceptance Criteria, constraints, edge cases, and relevant parent behavior define what must be falsified. `qa-review` supplies the QA methodology and environment-driving behavior; this command supplies the ticket-specific contract and lifecycle rules.

Do not replace `qa-review` with an improvised lighter testing pass merely because setup is inconvenient.

If `qa-review` needs environment setup, services, fixtures, test data, browser/simulator configuration, credentials, or commands to be discovered, perform that work when possible and record the friction in Testing Notes even if the QA pass ultimately succeeds.

If `qa-review` itself cannot proceed because of a genuine blocker, use the Escalation Contract rather than silently substituting a weaker test.

## Classify QA Findings

Every meaningful finding from `qa-review` must be classified as one of:

### Current-Ticket Failure

The implementation violates this ticket's Acceptance Criteria, constraints, invariants, or required behavior.

If the correct repair is clear:

1. Repair it autonomously.
2. Add or update regression coverage.
3. Commit and push the repair.
4. Send the ticket back through **Review**.
5. After Review passes again, re-run `qa-review` or the relevant portion of it against the repaired behavior.

Do not create a follow-up ticket as a substitute for fixing the current ticket.

If correct behavior is ambiguous, involve the user.

### Separate Discovery

The finding is real but outside the current ticket's approved scope.

For each separate discovery:

1. Create a concise freeform GitHub issue.
2. Link it back to this ticket.
3. Put it at the **top of To Do**.
4. Do not perform Discovery on it now.

The current ticket may still pass if all of its own Acceptance Criteria are satisfied.

## Testing Notes

Append a ticket comment with exactly:

### Testing Notes

#### QA Review Performed

<Describe the `qa-review` pass and the environment/surfaces it exercised.>

#### Scenarios Exercised

<List meaningful scenarios and environments.>

#### Failures Found

<List current-ticket failures, including repaired failures, or `N/A`.>

#### Separate Issues Created

<Link every unrelated issue created from Testing, or `N/A`.>

#### Repairs and Retesting

<Describe repairs, Review re-entry, and `qa-review` retesting, or `N/A`.>

#### Acceptance Criteria Assessment

<State evidence for each criterion, or summarize clearly if long.>

#### Missing or Weak Criteria

<Anything QA revealed Discovery should have specified more clearly, or `N/A`.>

#### Upstream Gaps

<Anything Discovery, Planning, Implementation, or Review missed that materially affected Testing, or `N/A`.>

#### Workflow Friction

<Anything that made `qa-review` slower, harder, less reliable, or required figuring out setup that could have been known in advance, or `N/A`. Include environment startup, services, fixtures/test data, browser/simulator setup, credentials, permissions, test commands, CI/local differences, flaky tooling, port conflicts, hard-to-find context, retries, or missing scripts/docs/skills.>

#### Improvement Opportunities

<Concrete changes to Discovery, Planning, Implementation, Review, Testing, `qa-review`, repository documentation, QA/dev tooling, CI, environment setup, scripts, fixtures, or agent workflow that would make future testing cheaper, faster, safer, or more reliable, or `N/A`.>

Record friction even when successfully worked around. If a future tester could avoid investigation, failure, retry, workaround, or setup discovery, record it.

## Merge and Complete

Only after:

- `qa-review` has completed successfully;
- all current-ticket Acceptance Criteria pass;
- current-ticket repairs have passed Review again;
- relevant checks are green;
- no escalation remains;

then:

1. Append Testing Notes.
2. Merge using the repository's normal merge strategy and protections.
3. Verify the merge succeeded.
4. Move the ticket to **Done**.
5. Close the issue if that is the repository's normal convention.
6. Stop.

Never bypass branch protection or required checks.

## Escalation Contract

Work autonomously when the path is clear. Stop and involve the user for materially ambiguous/contradictory criteria, invalid upstream assumptions, required scope changes, materially different unresolved product/UX/data/architecture choices, unexpectedly destructive/high-risk actions, unavailable required credentials/services/environments, unsafe repository state, two failed repair attempts for the same problem, inability to run `qa-review` meaningfully, or inability to complete honestly.

Do not escalate for understandable failures with clear repairs. Never weaken criteria, skip stages, substitute a weaker QA pass, or redefine success.

## Hard Rules

- Process exactly one ticket.
- No argument means top of **In Testing**; an argument means that eligible ticket only.
- Use `qa-review` as the adversarial testing engine.
- Test behavior against the specification, not implementer expectations.
- Current-ticket failures must be fixed before Done.
- Separate discoveries become linked issues at the **top of To Do**.
- Code changes during Testing require Review again.
- Always leave structured Testing Notes with explicit `N/A` where appropriate.
- Record QA setup/tooling friction even when successfully resolved.
- Merge only after `qa-review` and the ticket's Acceptance Criteria pass.
