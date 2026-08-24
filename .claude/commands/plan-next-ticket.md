---
description: Plan a specific Ready For Planning ticket, or the top Ready For Planning ticket when none is specified. Move executable work to the bottom of Ready For Implementation or decompose larger work into linked child tickets at the top of To Do.
model: opus
---

# Plan Ticket

Plan exactly one GitHub ticket from the project's **Ready For Planning** column.

The ticket has already completed Discovery. Treat its issue body as the approved specification for what must be accomplished.

Planning determines whether the ticket is already an appropriate unit of implementation or needs to be decomposed into smaller independently executable tickets.

Planning does not implement code.

## Select the Ticket

If `$ARGUMENTS` contains a ticket number:

1. Use that GitHub issue.
2. Verify that it is currently in **Ready For Planning**.
3. Work on that ticket only.

If `$ARGUMENTS` is empty:

1. Inspect the GitHub Project.
2. Find the **Ready For Planning** column.
3. Select the **topmost ticket according to the Project's current ordering**.
4. Work on that ticket only.

If no eligible ticket exists, report that there is nothing to plan and stop.

Never silently skip the selected ticket because it appears difficult, large, or ambiguous.

## Understand the Work

Before making a planning decision:

1. Read the complete discovered ticket.
2. Read its parent ticket when present.
3. Read materially relevant linked tickets.
4. Investigate the repository.
5. Inspect relevant:
   - existing implementations
   - architecture
   - interfaces
   - schemas
   - tests
   - conventions
   - dependencies
   - documentation
6. Identify the implementation boundaries implied by the ticket.
7. Challenge important assumptions against the actual codebase.

## Check the Call Site

When the plan names an optional prop, argument, config key, or feature flag as a risk, a stop condition, or a thing to preserve, **find the call sites and confirm it is actually passed**. Grep for the caller, not only for the declaration.

A declared-but-never-passed parameter is dead weight. A plan that hangs a stop condition on one is measuring something the product never renders, and Implementation inherits a criterion it cannot fail.

This has shipped: a plan made a component's optional `subtitle` prop half of its stop condition, and the page it measured never passes that prop.

Do not redo Discovery.

The ticket's Objective and Acceptance Criteria define **what must be accomplished**.

Planning determines:

> Is this already a coherent implementation unit, or should it be decomposed?

## Planning Decision

Choose exactly one outcome:

1. **Executable as-is**
2. **Decompose**

## Executable As-Is

A ticket is executable as-is when one implementation agent can reasonably:

- understand the relevant context;
- make the required change as one coherent unit;
- verify the change;
- submit it for review without requiring independently deliverable intermediate tickets.

"Executable" does not mean trivial.

Do not create subtickets merely because the work touches multiple files, layers, classes, components, or tests.

Prefer one coherent implementation ticket over unnecessary decomposition.

### When Executable As-Is

If the ticket is executable as-is:

1. Add a concise planning note to the ticket containing:
   - the implementation approach;
   - important code areas likely involved;
   - significant technical considerations or risks;
   - verification expectations.
2. Do not rewrite or replace the Discovery specification.
3. Move the ticket from **Ready For Planning** to **Ready For Implementation**:
   ```bash
   scripts/project-status.sh "Ready For Implementation" <issue-number>
   ```
4. Place the ticket at the **bottom of the Ready For Implementation column**.
5. Stop.

Do not begin implementation.

The bottom placement is intentional. Tickets already waiting for implementation retain their priority over newly planned work.

## Decompose

Decompose the ticket when it contains multiple pieces of work that should be independently discovered, implemented, reviewed, or tested.

Good child tickets should represent coherent outcomes rather than arbitrary implementation steps.

Reasons to decompose may include:

- multiple independently executable behaviors;
- separable architectural concerns;
- work that crosses boundaries best handled independently;
- an implementation unit too large for one implementation context;
- meaningful sequencing or dependency relationships;
- pieces that deserve their own acceptance criteria or testing.

Do not decompose merely to make tickets artificially tiny.

### Creating Child Tickets

When decomposing:

1. Determine the smallest useful set of coherent child tickets.
2. Create each child as a GitHub sub-issue of the parent.
3. Ensure the parent ticket links to every child ticket.
4. Ensure every child ticket links back to its parent through the GitHub issue relationship.
5. Put every new child ticket in **To Do**.
6. Place the newly created child tickets at the **top of the To Do column**.
7. Give each child a concise freeform description containing:
   - what part of the parent it is responsible for;
   - why it exists;
   - relevant architectural or sequencing context;
   - important constraints inherited from the planning decision.
8. Do not fill out the Discovery template for child tickets.
9. Do not write final acceptance criteria for child tickets.

Discovery will refine each child independently.

### Child Ordering

Planning-generated children are intentionally prioritized above existing unplanned work.

When multiple children are created:

1. Place all of them ahead of tickets that were already in **To Do**.
2. Preserve a meaningful execution/discovery order among the children when one exists.
3. If child B depends on child A, order A above B.
4. Still record the dependency explicitly; board ordering is not a substitute for dependency metadata.

The resulting board should look conceptually like:

```text
TO DO

#203 Child A
#204 Child B
#205 Child C
----------------
previous top ticket
previous ticket
...
```

Do not merely add the children somewhere in To Do and assume their creation time will give them the intended priority.

## Parent Ticket After Decomposition

A decomposed parent becomes a **container/tracking ticket**.

It does not have an implementation step of its own unless an explicit integration-level activity is required.

After creating the children:

1. Add a planning note to the parent explaining the decomposition.
2. Link to every child ticket from the parent.
3. Preserve the GitHub parent/sub-issue relationships.
4. Record sequencing or dependencies between children.
5. Record any architectural decisions or shared constraints the children must respect.
6. Mark or otherwise treat the parent as a container/tracking ticket using the project's available metadata.
7. Do not move the parent to **Ready For Implementation**.
8. Do not move the parent to **In Progress** merely to mirror its children.
9. Stop.

The parent should progress based on the completion of its children rather than pretending implementation work is occurring directly on the parent.

If the parent represents a complete behavior that needs whole-feature verification after all children are complete, record that requirement explicitly for later integration/adversarial testing.

## Planning Notes

Planning notes should be concise and useful to downstream agents.

For an executable ticket, capture:

### Implementation Approach

How the work should broadly be approached.

### Relevant Code

Important modules, interfaces, tests, schemas, components, or existing implementations discovered during planning.

### Technical Considerations

Important architectural decisions, compatibility concerns, migrations, concurrency concerns, sequencing requirements, or other implementation constraints.

### Verification

What the implementation agent should verify before handing the ticket to Review.

Do not duplicate the ticket's Objective, Context, or Acceptance Criteria.

Do not turn the planning note into a second specification.

## Decomposition Principles

### Preserve intent

Every child must clearly contribute to satisfying the parent's Objective and Acceptance Criteria.

No parent requirement may silently disappear during decomposition.

### Children return through Discovery

Planning creates **raw child tickets**, not fully discovered tickets.

Every child starts at the **top of To Do**.

Every child must independently pass through:

`To Do → Discovery → Ready For Planning`

before it can reach implementation.

### Acceptance criteria become more specific downstream

The parent may contain broad behavioral acceptance criteria.

Child Discovery may turn those into increasingly technical criteria appropriate to each narrower unit of work.

Planning should provide enough context for that refinement without doing Discovery's job itself.

### Prefer coherent slices

Prefer child tickets that represent independently meaningful outcomes over mechanical tickets such as:

- change model
- change controller
- add tests

Split by meaningful responsibility or deliverable behavior when possible.

Layer-oriented decomposition is appropriate when the layer itself represents an independent architectural contract or independently useful unit of work.

### Preserve dependencies explicitly

If one child genuinely depends on another, record that dependency.

Also order dependency prerequisites above their dependents in **To Do**.

Do not rely on issue ordering alone to communicate required sequencing.

### Avoid recursive ticket explosion

Do not optimize for the smallest imaginable ticket.

A good child is one implementation agent's coherent unit of work.

If a child later proves too broad, its own Planning pass may decompose it again.

## When Planning Finds a Discovery Problem

Repository investigation may reveal that a material assumption in the discovered specification is wrong, contradictory, or unresolved.

Do not silently redefine the requirement.

If Planning cannot proceed without changing the ticket's intended behavior or Acceptance Criteria:

1. Clearly record the problem on the ticket.
2. Move the ticket back to **To Do** for Discovery.
3. Place it according to the project's normal To Do prioritization unless there is an explicit reason to prioritize it.
4. Preserve the existing specification and explain why rediscovery is required.
5. Stop.

Use this only for genuine specification problems.

Do not send tickets backward merely because implementation is technically difficult or because the planner prefers a different design.

## Completion Check

Before completing Planning, verify:

- [ ] Exactly one ticket was selected.
- [ ] With no argument, it was the top ticket in **Ready For Planning**.
- [ ] With a ticket number, that specific eligible ticket was used.
- [ ] The complete discovered specification was read.
- [ ] Relevant parent and linked tickets were inspected.
- [ ] Relevant repository context was investigated.
- [ ] The ticket was classified as either executable as-is or requiring decomposition.
- [ ] The decision is based on coherent implementation boundaries rather than arbitrary size.
- [ ] No code was implemented.
- [ ] No Discovery requirements were silently changed.

If executable as-is:

- [ ] A concise planning note was added.
- [ ] The ticket was moved to **Ready For Implementation**.
- [ ] The ticket was placed at the **bottom of Ready For Implementation**.
- [ ] No unnecessary child tickets were created.

If decomposed:

- [ ] Each child represents a coherent unit of work.
- [ ] Every child was created as a GitHub sub-issue of the parent.
- [ ] Parent and child relationships are visible and navigable.
- [ ] The parent links to all created children.
- [ ] Every child was placed in **To Do**.
- [ ] All newly created children were placed at the **top of To Do**.
- [ ] Meaningful ordering among new children was preserved.
- [ ] Child tickets contain useful freeform context rather than completed Discovery templates.
- [ ] Dependencies and sequencing constraints were explicitly recorded where relevant.
- [ ] All parent requirements remain represented by the decomposition.
- [ ] The parent was treated as a container rather than fake implementation work.

Then stop.

Do not automatically begin Discovery on newly created children.

Do not automatically begin Implementation on an executable ticket.

## Hard Rules

- Process exactly one ticket per invocation.
- With no argument, select the **topmost ticket in Ready For Planning**.
- With a ticket number, use that ticket and require it to be in **Ready For Planning**.
- Planning owns sizing and decomposition.
- Discovery owns requirements clarification and Acceptance Criteria.
- Implementation owns writing the code.
- Never implement during Planning.
- Never silently alter the discovered specification.
- Do not create subtickets for work that is already a coherent implementation unit.
- Do not avoid decomposition when independently executable concerns genuinely exist.
- Every Planning-generated child starts at the **top of To Do**.
- Every child must go through Discovery before implementation.
- Every created child must be linked to its parent.
- The parent must link to its created children.
- An executable ticket moves to the **bottom of Ready For Implementation**.
- A decomposed parent does not move to Ready For Implementation or In Progress merely because its children do.
- Treat the discovered GitHub issue body as the authoritative contract for the work.
