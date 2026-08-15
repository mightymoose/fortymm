---
description: Take a specific Ready for Implementation ticket, or the top Ready for Implementation ticket when none is specified, and coordinate fresh-context Implementation, Review, and Testing stages through Done.
model: opus
---

# Implement Ticket End-to-End

Coordinate exactly one ticket through:

`Ready for Implementation → In Review → In Testing → Done`

This is an orchestrator. It does not replace stage commands and must not collapse Implementation, Review, and Testing into one self-reviewing context.

## Select the Ticket

If `$ARGUMENTS` contains a ticket number, use that issue, verify it is in **Ready for Implementation**, and coordinate it only.

If `$ARGUMENTS` is empty, select the **topmost ticket according to the Project's current ordering** in **Ready for Implementation**.

If no eligible ticket exists, report that there is nothing to implement and stop.

Record the selected ticket number and pass that same explicit number to every downstream stage.

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
- With no argument, select the **topmost ticket in Ready for Implementation**.
- With a ticket number, use that eligible ticket only.
- Pass the explicit selected ticket number to every stage.
- Use fresh contexts/subagents between stages whenever possible.
- Never merge before Review and Testing pass.
- Never continue past a stage escalation.
- Do not duplicate stage prompts inside the coordinator.
- Preserve every stage's structured retrospective notes.
