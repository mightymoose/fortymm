# The escalation contract

Every stage command shares one contract for when to stop and involve the user. This file is
the single copy. Stage commands reference it and add only their stage-specific triggers,
because four prose copies drift.

## When to stop

Work autonomously when the path is clear. Stop and involve the user when continuing requires
judgment rather than execution:

- acceptance criteria are materially ambiguous or contradictory
- a Discovery or Planning assumption is materially wrong
- the work requires a change to approved scope or behavior
- materially different product, UX, data-model, or architectural choices have no clear approved answer
- the next action is unexpectedly destructive, irreversible, security-sensitive, or otherwise high-risk
- required credentials, services, environments, or external dependencies are unavailable
- repository state makes it unsafe to determine which changes belong to the ticket
- the same underlying problem has survived two repair attempts
- the stage cannot be completed honestly

## When not to stop

Do not escalate merely because the work is harder than expected, understandable tests fail,
or ordinary tooling checks fail for a clear reason.

## How to stop

Stop before the unresolved decision. Explain what was discovered and why it blocks safe
progress. Present the smallest useful set of choices or a specific question.

Never weaken acceptance criteria, skip a required stage, or redefine success.
