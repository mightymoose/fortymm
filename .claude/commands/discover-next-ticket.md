---
description: Take the top ticket from the GitHub Project To Do column, or a specific ticket when one is provided, run discovery using grill-me, rewrite the ticket into the canonical specification template, and move it to Ready For Planning.
model: opus
---

# Discover Next Ticket

Take exactly one GitHub ticket and perform discovery on it using the `grill-me` skill.

The **To Do** column is an inbox. Tickets there are intentionally allowed to be incomplete, informal, speculative, or ambiguous.

Discovery transforms that raw input into the durable specification used by downstream Planning, Implementation, Review, and Testing.

Every successfully discovered ticket moves to **Ready For Planning**.

Discovery does not decide whether the ticket is small enough to implement directly. Planning owns that decision.

## Select the Ticket

If `$ARGUMENTS` contains a ticket number:

1. Use that GitHub issue.
2. Verify that it is eligible for Discovery.
3. Work on that ticket only.

If `$ARGUMENTS` is empty:

1. Inspect the GitHub Project.
2. Find the **To Do** column.
3. Select the **topmost ticket according to the Project's current ordering**.
4. Work on that ticket only.

If **To Do** is empty, report that there is nothing to discover and stop.

Never silently skip the selected ticket because it appears difficult, ambiguous, large, or underspecified. Resolving those things is the purpose of Discovery.

## Perform Discovery

1. Read the complete ticket.
2. Read relevant parent and linked tickets when present.
3. Investigate relevant repository context.
4. Invoke `grill-me`.
5. Work with the user until the ticket is sufficiently understood.
6. Rewrite the GitHub issue body using the exact canonical template below.
7. Verify every section has been completed.
8. Move the ticket to **Ready For Planning**:
   ```bash
   scripts/project-status.sh "Ready For Planning" <issue-number>
   ```
9. Stop.

Do not select another ticket after completing this one.

Do not plan, decompose, or implement the ticket.

## Discovery Principles

### The incoming ticket is an inbox item

Do not expect a **To Do** ticket to already contain requirements, acceptance criteria, or structured information.

The original description is raw input to Discovery.

### Investigate before asking

Use the repository, tests, documentation, linked tickets, existing behavior, and other available evidence to answer questions that can reasonably be answered without the user.

Use `grill-me` to resolve things that actually require human judgment, including:

- intent
- desired behavior
- scope
- tradeoffs
- ambiguous requirements
- product decisions
- constraints that cannot be established from existing evidence

Do not ask the user questions merely because answering them requires repository investigation.

### Match the abstraction level

Acceptance criteria should match the specificity of the ticket.

A high-level feature ticket will generally have behavioral acceptance criteria.

A narrow technical ticket may have explicitly technical acceptance criteria involving:

- APIs
- database invariants
- interfaces
- migrations
- architectural boundaries
- test behavior
- concurrency guarantees
- compatibility requirements
- specific modules or components

Do not artificially make technical tickets implementation-agnostic.

### Discovery defines; Planning sizes

Discovery answers:

> What exactly must this ticket accomplish?

Planning answers:

> Is this an appropriate unit of implementation, and if not, how should it be decomposed?

Discovery must not make that Planning decision.

### Complete every section

Every section of the canonical template is mandatory.

If a section genuinely does not apply, write:

`N/A`

Do not omit the section.

Do not leave it blank.

Do not invent content merely to avoid writing `N/A`.

`N/A` means Discovery explicitly considered the category and determined that it is irrelevant to this ticket.

## Canonical Ticket Template

Use this structure exactly when rewriting the GitHub issue.

---

# Objective

<What must this ticket accomplish?>

# Context

<Why does this work exist? Include relevant current behavior, parent requirements, system context, or repository context necessary to understand the ticket.>

# Acceptance Criteria

- [ ] <Observable or otherwise verifiable condition for completion>
- [ ] <Observable or otherwise verifiable condition for completion>

# Non-Goals

<What related work is explicitly outside the scope of this ticket, or `N/A` if there are no meaningful non-goals?>

# Constraints & Invariants

<Requirements the eventual implementation must preserve or respect, or `N/A` if none apply.>

# Edge Cases & Failure Modes

<Important boundary conditions, failure scenarios, concurrency cases, unusual inputs, or other cases that must be considered, or `N/A` if none apply.>

# Relevant References

<Parent/related issues, documentation, tests, modules, existing implementations, architectural decisions, or other useful references, or `N/A` if none apply.>

# Open Questions

<Unresolved questions that downstream work needs to know about, or `N/A` if none remain.>

---

## Template Rules

### Objective

State the desired outcome clearly.

Describe what must become true, not the implementation steps an agent should perform.

For narrowly technical tickets, the objective itself may appropriately be technical.

### Context

Include enough context that a downstream agent can understand why the ticket exists.

Preserve useful information from the original freeform ticket.

When the ticket is a child of a larger piece of work, reference the parent rather than duplicating its entire specification.

### Acceptance Criteria

Acceptance criteria are the contract against which implementation, review, and testing will eventually be evaluated.

They must be observable or otherwise verifiable.

They may become increasingly code-specific as Planning produces narrower technical tickets.

Acceptance Criteria should almost never be `N/A`. If there is no meaningful definition of completion, Discovery is probably not finished.

### Non-Goals

Capture exclusions when they materially clarify the boundary of the work.

Otherwise write `N/A`.

### Constraints & Invariants

Capture things the eventual implementation is not permitted to violate.

These may include behavioral, architectural, compatibility, security, data, performance, migration, or concurrency requirements.

Otherwise write `N/A`.

### Edge Cases & Failure Modes

Capture cases meaningfully relevant to correctness.

Do not generate hypothetical edge cases merely to populate the section.

Otherwise write `N/A`.

### Relevant References

Include only references that materially help downstream work.

Prefer precise references such as issue numbers, documentation paths, tests, modules, or files over vague prose.

Otherwise write `N/A`.

### Open Questions

Prefer resolving questions during the `grill-me` process.

This section exists so unresolved uncertainty is explicit rather than silently lost.

If Discovery has resolved all meaningful questions, write `N/A`.

## Completion Check

Before completing Discovery, verify:

- [ ] Exactly one ticket was selected.
- [ ] With no argument, it was the top ticket in **To Do**.
- [ ] With a ticket number, that specific eligible ticket was used.
- [ ] `grill-me` was used.
- [ ] Relevant parent and linked tickets were inspected.
- [ ] Relevant repository context was investigated.
- [ ] The Objective is clear.
- [ ] Acceptance Criteria define completion.
- [ ] Every canonical template section is present.
- [ ] Every section contains meaningful content or explicitly says `N/A`.
- [ ] Important ambiguity has either been resolved or appears under Open Questions.
- [ ] Useful information from the original freeform description has been preserved.
- [ ] No implementation plan has been produced.
- [ ] No subtickets have been created.
- [ ] No implementation work has begun.

When all applicable checks pass:

1. Replace the GitHub issue body with the completed canonical template.
2. Move the ticket to **Ready For Planning**:
   ```bash
   scripts/project-status.sh "Ready For Planning" <issue-number>
   ```
3. Report which ticket was discovered.
4. Stop.

## Hard Rules

- Process exactly one ticket per invocation.
- With no argument, always select the **topmost ticket in To Do**.
- With a ticket number, use that ticket and do not select another ticket.
- Use `grill-me` for the discovery conversation.
- Treat the original **To Do** description as raw input.
- Rewrite the issue using the exact canonical template.
- Never omit a template section.
- Use `N/A` when a section was considered and does not apply.
- Never use `N/A` to avoid investigating something that may be relevant.
- Preserve useful information from the original ticket.
- Investigate available evidence before asking the user.
- Ask the user when intent or requirements genuinely require human judgment.
- Do not decide whether the ticket is small enough to implement.
- Do not move the ticket directly to **In Progress** or **Ready For Implementation**.
- Do not create subtickets.
- Do not decompose the ticket.
- Do not produce an implementation plan.
- Do not implement code.
- Planning owns sizing and decomposition.
- Every successfully discovered ticket moves to **Ready For Planning**.
- Every Planning-generated subticket starts in **To Do** and must independently pass through Discovery.
- Treat the rewritten issue body as the durable contract for downstream Planning, Implementation, Review, and Testing.
