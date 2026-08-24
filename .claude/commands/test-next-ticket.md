---
description: Test one specified In Testing ticket. Refuses without a human LGTM on the pull request. Run the qa-review skill adversarially, repair current-ticket failures when clear, create To Do issues for separate discoveries, leave structured testing notes, then merge, clean up the run's resources, and move successful work to Done. Requires the ticket number, which the implement-ticket-end-to-end orchestrator passes.
model: sonnet
---

# Test Next Ticket

Test exactly one ticket from **In Testing**. `$ARGUMENTS` must contain a ticket number; verify that issue is eligible and test it only. If `$ARGUMENTS` is empty, stop and report: this command does not select tickets. `implement-ticket-end-to-end` selects and passes the number.

Testing is an adversarial behavioral gate. Its primary testing engine is the existing `qa-review` skill.

Read the ticket specification, relevant parent requirements, Review Notes, and linked PR. Use implementation details only for setup/diagnosis, not to decide what behavior deserves testing.

## Precondition — the human review gate

**Before anything else**, confirm the ticket's pull request carries the release signal. `.claude/rules/the-review-gate.md` defines it, who may give it, and the check that reads all three comment surfaces. Read that file and run its check.

If the signal is absent, **refuse to run.** Report which PR was checked and that no `LGTM` from `mightymoose` was found on any of the three surfaces, then stop.

This is a **precondition check, not a status transition.** Do not move the ticket to satisfy it, and do not move it back on refusal. Do not accept a Review Note, a board column, or a coordinator's say-so as a substitute — the whole point is that this holds when someone runs the stage by hand and the coordinator was never involved. A gate that lives only in the coordinator's prose is not a gate.

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
4. Invoke `review-next-ticket` in a fresh context as a **Testing repair round** (see that command). It reviews the repair diff only, posts no decision comment, and moves no column — the ticket stays **In Testing**, and the human's earlier release still covers it because the gate's window is "ever" by design.
5. After that round passes, re-run `qa-review` or the relevant portion of it against the repaired behavior.

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

<Describe repairs, Testing repair rounds, and `qa-review` retesting, or `N/A`.>

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
- current-ticket repairs have passed a Testing repair round;
- relevant checks are green;
- no escalation remains;

then:

1. Append Testing Notes.
2. Merge using the repository's normal merge strategy and protections.
3. Verify the merge succeeded.
4. Move the ticket to **Done**:
   ```bash
   scripts/project-status.sh "Done" <issue-number>
   ```
5. Close the issue if that is the repository's normal convention.
6. Clean up, per the section below.
7. Stop.

Never bypass branch protection or required checks.

## Clean Up After the Merge

Whoever merges cleans up. This command merges, so this command cleans up. A coordinator that delegated the merge does not.

The QA stack comes down whether the run merged or escalated — the stack `qa-review` started exists either way, and a failed run leaks it just as fast. The **branch** is different: delete it only after a confirmed merge. An escalated run's branch holds the only copy of unmerged work.

Capture the stack id **before** merging. It derives from the branch name, and after the merge you are no longer standing on that branch.

```bash
QA_ID="$(git rev-parse --abbrev-ref HEAD)"          # same derivation qa-up.sh uses
# ... merge ...
scripts/qa-down.sh "$QA_ID" --dry-run               # read it before you run it
scripts/qa-down.sh "$QA_ID"
```

Then:

1. After a confirmed merge only: delete the branch locally and on the remote.
2. Fast-forward the main checkout, so the next ticket starts from the merge this run just made:

   ```bash
   MAIN="$(git worktree list | awk 'NR==1{print $1}')"   # first row is the main checkout
   git -C "$MAIN" pull --ff-only origin main
   ```

   Only when that checkout is on `main`. If it is on another branch, or the pull refuses, run `git -C "$MAIN" fetch origin` instead and report it. Never force the update. The SessionStart freshness hook only warns about a stale main. Nothing else pulls it, and a next run on a stale root branches its worktree from code this merge already changed.
3. Confirm nothing survives on the dev-server ports:

   ```bash
   lsof -ti :5173 -i :5174 || echo "clear"
   ```

   A dev server left on 5173 or 5174 makes the next run's `npm run dev` bind a different port, and that run then QAs a build it did not produce.
4. Report what was torn down in the Testing Notes.

### Two ordering traps

- **`gh pr merge --delete-branch` errors from inside a worktree.** Delete the branch as its own step, from the main checkout, after the merge.
- **`scripts/reap-worktrees.sh` never removes the worktree the caller is standing in.** It skips it as "current" and still reports success. This command does not reap worktrees — the coordinator does, as its final act, from outside.

### Never widen the blast radius

`docker system prune -a` and `docker volume prune` are forbidden. `fortymm-uat_postgres-data` is unattached, and the k3d cluster holds `tailscale-state` Secrets. Both would be silently destroyed. `scripts/qa-down.sh` already refuses a blanket prune on purpose; do not work around it. Cleanup is scoped to the resources this run created.

## Escalation Contract

`.claude/rules/escalation.md` is the contract — when to stop, when not to, and how. Two additions for this stage: escalate when `qa-review` cannot run meaningfully, and never substitute a weaker QA pass.

## Hard Rules

- Process exactly one ticket, and only the ticket number given. Never select from the board.
- **Refuse to run without the review gate signal on the pull request.** See `.claude/rules/the-review-gate.md`.
- Use `qa-review` as the adversarial testing engine, testing behavior against the specification, not implementer expectations.
- Current-ticket failures must be fixed before Done.
- Separate discoveries become linked issues at the **top of To Do**.
- Code changes during Testing require a Testing repair round through `review-next-ticket`.
- Always leave structured Testing Notes with explicit `N/A` where appropriate.
- Merge only after `qa-review` and the ticket's Acceptance Criteria pass.
- Whoever merges cleans up. Tear down this run's QA stack after merging, and on an escalation too. Delete the branch only after a confirmed merge.
- After a confirmed merge, fast-forward the main checkout's `main`.
- Never run `docker system prune -a` or `docker volume prune`.
