---
description: Review a specific In Review ticket, or the top In Review ticket when none is specified. Run the land-the-plane review commands, repair clear findings, leave structured review notes, then post a decision comment on the pull request, move the ticket to Waiting For Sign Off, and stop for a human.
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
5. Keep the ticket **In Review** while this loop runs. The ticket is not waiting on a human yet, so it must not sit in **Waiting For Sign Off**.

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

## Hand Off to a Human

Review does not decide that work is ready for Testing. A human does, on the pull request. See `.claude/rules/the-review-gate.md` for the signal, who may give it, and why it is a comment rather than a GitHub approval.

Only when the review pass is clean and the implementation satisfies the ticket:

1. Commit and push any Review repairs.
2. Verify relevant checks.
3. Append Review Notes.
4. **Make sure a pull request exists and is not a draft.** The human reviews the PR, so the PR is a required output of this stage. If none exists, open one. If it is a draft, mark it ready — CI runs zero Actions on a draft, so a draft PR shows a green board having run nothing.
5. Wait for CI to go green.
6. **Post one decision comment on the pull request.**
7. **Move the ticket to Waiting For Sign Off.**
8. Stop.

**Post the comment first, then move the column.** The comment is the ask and the column is only its signpost: a ticket parked in Waiting For Sign Off before the ask exists points at a pull request that carries no question, and if the move fails after the comment, the human still has the ask.

**Waiting For Sign Off is the only column this command moves a ticket into.** It never sets **In Testing**. Only a human's `LGTM` releases the work to Testing, and `implement-ticket-end-to-end` writes that transition when it reads the signal.

Do not begin Testing here.

### The decision comment

One comment, on the PR, addressed to the human who must decide. It states:

- the decision being asked for, and how to give it — a comment whose whole body is `LGTM` releases the work to Testing, anything else sends it back through a targeted repair round;
- the evidence: what was reviewed, what was repaired, what CI says;
- what to look at, specifically — the parts where a reasonable reviewer could disagree, and any judgment call already baked in.

Do not repeat the Review Notes. They are already on the ticket, and a reviewer who wants them will follow the link. This comment is the ask, not the record.

**Report the comment's timestamp in the final report.** It is the coordinator's watch anchor — the point after which a comment counts as a new decision. Without it the watch re-reads its own round's comments and either loops forever or releases on a previous round's `LGTM`.

### Running standalone

Run outside `implement-ticket-end-to-end`, this command still moves the ticket to **Waiting For Sign Off**, but leaves it there with no watcher. That is correct, not a failure — but nothing will notice the `LGTM` when it arrives. Say so in the final report, name the PR URL, and give the command that resumes the arc.

The column carries the ask on its own. A ticket in **Waiting For Sign Off** is waiting on a human whether or not an agent is watching, so a run that ends here strands nothing.

## Targeted Mode

`implement-ticket-end-to-end` re-invokes this command in **targeted mode** when the human comments something other than the release signal. Targeted mode is not a second full review.

A ticket entering targeted mode is in **Waiting For Sign Off**, not **In Review**. Accept it from either column. The eligibility rule at the top of this file governs a fresh review, not a repair round the coordinator asked for by number.

Given the named comments:

1. **Move the ticket back to In Progress.** The human asked for changes, so the work is being done again and is no longer waiting on anyone. Do this first, before touching code, so the board never shows a ticket asking for a decision that has already been given.
2. Address **exactly** those comments. Nothing else. A comment is not an invitation to re-review the diff.
3. Re-run only the verification the change actually touches.
4. Push to the **same branch**. Do not open a second pull request.
5. Wait for CI to go green.
6. Reply on each thread, saying what changed or why it did not.
7. Post a fresh decision comment.
8. **Move the ticket back to Waiting For Sign Off.**
9. Stop. The coordinator's watch restarts from here.

This command owns both writes, in both directions. The coordinator detects the change request and hands off; it does not also move the ticket. Two owners for one transition is how a ticket ends up in a column neither of them chose.

A targeted round that escalates leaves the ticket **In Progress**. That is honest: the work is unfinished, and nobody is waiting on the human.

If a comment asks for something that would change approved scope or acceptance criteria, do not implement it. Escalate.

## Testing Repair Rounds

`test-next-ticket` invokes this command in a fresh context when Testing repairs a current-ticket failure. The scope is the repair diff, not a second full review, and the ticket is in **In Testing**, which is where it stays.

1. Run the applicable review commands over the repair diff.
2. Repair clear findings, as in the Repair Loop.
3. Report the outcome to the caller. Fold what was found into the ticket's Testing Notes rather than posting fresh Review Notes.

**Post no decision comment and move no column.** The human already released this work, and the gate's precondition window is "ever" by design (`.claude/rules/the-review-gate.md`) — a second ask on a released ticket is noise, and a column move would say the work waits on a human while Testing still owns it.

## Escalation Contract

`.claude/rules/escalation.md` is the contract — when to stop, when not to, and how.

## Hard Rules

- Process exactly one ticket.
- Run the established `land-the-plane` review commands over the actual diff instead of inventing a separate review methodology.
- Repair clear local findings autonomously and re-run the applicable review commands.
- Always leave structured Review Notes with explicit `N/A` where appropriate.
- A non-draft pull request is a required output of this stage.
- Post exactly one decision comment on the pull request — before the column move — then move the ticket to **Waiting For Sign Off** and stop.
- **Never set In Testing.** Only a human's `LGTM` releases the work, and the coordinator writes that transition.
- In targeted mode, move the ticket to **In Progress** first, address only the named comments, push to the same branch, then move it back to **Waiting For Sign Off**.
- In a Testing repair round, review the repair diff only: no decision comment, no column writes.
- Do not merge or mark Done here.
