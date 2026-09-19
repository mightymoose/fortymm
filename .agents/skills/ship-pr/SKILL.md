---
name: ship-pr
description: "Publish the current branch as a GitHub pull request, then own the review loop until CI is green and Codex approves the current head. Use when the user asks to ship, publish, or finish a PR and wants failures and review findings fixed automatically."
---

# Ship PR

Take the current branch from local completion to a review-clean pull request. The
terminal state is a still-open PR whose current head has passing checks and a
Codex-authored thumbs-up. Do not merge, close, or deploy the PR.

Invoking this skill authorizes pushing the task's branch, creating or updating
its PR, posting review requests, rerunning checks, and pushing fixes needed to
reach the terminal state. It does not authorize including unrelated work,
rewriting shared branch history, changing branch protection, dismissing human
reviews, or broadening the feature.

## Publish

1. Read the applicable `AGENTS.md` files and inspect the working tree, current
   branch, remote, default branch, and commits that will enter the PR.
2. Refuse to publish the repository's default branch. Never force-push. If the
   branch contains uncommitted changes, include and commit only changes clearly
   belonging to the user's current task. Preserve unrelated changes; ask only
   when their ownership cannot be determined safely.
3. Run cheap, relevant preflight checks. If the task changed an API route or
   schema, follow the root `AGENTS.md` generation requirements before publishing.
4. Push with upstream tracking. Reuse the open PR for this head branch when one
   exists; otherwise create one against the default branch with a useful title,
   summary, and test plan. Capture the PR number, URL, and head SHA.

Use the `gh` CLI for GitHub state. Prefer structured output such as
`gh pr view --json ...`, `gh pr checks`, `gh run view`, and `gh api` rather than
scraping terminal prose.

## Run one review round

Every round belongs to exactly one head SHA.

1. Post a fresh PR comment whose exact trigger is `@codex review`. Record the
   trigger comment ID, its creation time, and the head SHA. This explicit trigger
   makes the workflow independent of automatic-review settings.
2. Monitor CI and Codex concurrently. Poll about every 30-60 seconds and keep the
   user informed during long waits. Do not treat the initial Codex eyes reaction
   as completion.
3. Wait until the checks for that SHA are terminal and Codex has completed the
   review request. A successful Codex result is a `+1`/thumbs-up reaction or
   equivalent thumbs-up response authored by the Codex GitHub app/bot for this
   round. Do not count a human reaction, an earlier review, or a review of an
   older SHA.
4. Inspect all failure surfaces, not only the PR summary:
   - failed, cancelled, or timed-out checks and their failed logs;
   - merge conflicts or an unmergeable PR state;
   - Codex review findings, inline comments, and review threads;
   - new actionable human or bot feedback posted while the round was running.

Codex normally appears as the `chatgpt-codex-connector` GitHub bot, but verify
the actor is the Codex app/bot instead of relying on an exact login forever.

## Repair and repeat

If anything actionable failed:

1. Gather every finding from the round before editing. Separate product/code
   defects from transient infrastructure failures, stale results, and unrelated
   requests.
2. Diagnose root causes from the failing logs and relevant code. Make the
   smallest in-scope fix that addresses the cause. Do not weaken tests, skip
   checks, suppress findings, or change protections merely to make the PR green.
3. Add or update regression coverage when a code defect warrants it. Run the
   narrow failing checks locally, then the broader relevant suite.
4. Commit only the repair changes with a descriptive message and push normally.
   Reply to or resolve review threads only after their concern is actually
   addressed.
5. Start a new round for the new head SHA. A thumbs-up or green check from a
   prior SHA never carries forward.

For a likely flaky or infrastructure-only failure, rerun the failed job once.
If it repeats, investigate it as a real failure. Continue iterating without an
arbitrary code-fix limit while new evidence is available and progress is being
made.

## Completion and blockers

Finish only when all of these are true for the same current head SHA:

- no check is queued or in progress;
- every check is successful, neutral, or intentionally skipped, with no failed,
  cancelled, or timed-out check;
- the PR has no merge conflict;
- all in-scope actionable review findings are addressed;
- the latest explicit Codex review request produced a Codex-authored thumbs-up.

Then report the PR URL, final head SHA, passing-check summary, and Codex approval,
and end. Do not merge the PR and do not leave a new `@codex` task after success.

Do not wait forever on a service that never started. If Codex neither reacts nor
posts a result after 20 minutes, verify that the exact trigger was used and that
Codex review is enabled, then post one fresh request. If the second request also
has no result after 20 minutes, report the external blocker. Likewise stop and
report when permissions, unavailable credentials, a persistent external outage,
or an ambiguous fix requiring a product decision prevents safe progress. Include
the evidence gathered and the exact action needed to unblock the loop.
