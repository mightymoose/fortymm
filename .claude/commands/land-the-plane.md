---
description: Ship the current branch end-to-end — review the diff with /simplify, /code-review and /security-review, then commit, push, open a PR, wait for CI to go green, /qa-review it, and merge if everything passes (raising any issues to the user first). Walks a stacked-PR work order bottom-up, one PR at a time.
---

End-to-end "ship it" workflow. Run the steps below **in order**. If any step fails, stop and report the failure to the user — do not skip ahead.

CI (`.github/workflows/`) already runs lint, typecheck, unit tests, e2e, the OpenAPI drift check, and the iOS build — **this workflow does not duplicate any of that locally.** What it does do that CI cannot is *read the diff*: CI has no reviewer, so `/simplify`, `/code-review` and `/security-review` run here, and they run **before a PR exists**.

## Two modes

**Single branch** — no work order, or a work order with one slice. Run Steps 1–7 once for the current branch. This is the original behaviour and the rest of this document is written for it.

**Stacked** — `.claude/work-order.md` exists with more than one slice, each carrying a `Branch:` and `PR:` line (see `.claude/skills/to-chores/work-order-format.md` §The stack). Then this command walks the stack **bottom-up, one PR at a time**, running Steps 1–6 for each slice before moving to the next. Read [§Walking a stack](#walking-a-stack) first; it overrides the preflight and Steps 2, 3 and 6.

## Preflight

1. Confirm you're in a git repository and on a feature branch (not `main`). If on `main`, stop and tell the user.
2. **Detect the mode.** If `.claude/work-order.md` exists, read its slices. More than one slice with a `Branch:` line ⇒ stacked mode; check out the **lowest slice whose PR is not yet merged** and work from there. Otherwise single-branch mode on the current branch.
3. Run `git status` and `git diff --stat <base>...HEAD` — where `<base>` is `origin/main` in single-branch mode, and the slice's **base branch** in stacked mode. Using `origin/main` for a stacked slice shows every slice beneath it and makes the diff unreviewable.
4. If there are uncommitted changes unrelated to the branch's work-in-progress, surface them and ask the user whether to commit or abort — do **not** auto-commit pre-existing work without acknowledgement.

## Step 1 — Review the diff, before any PR exists

CI gates whether the code *works*. Nothing in CI reads the diff for quality or for vulnerability — that is this step, and it runs **first**, so a PR is never opened over a diff nobody has read.

Run all three over the branch's changes:

```
Skill(skill="simplify")           # reuse, simplification, altitude — applies fixes
Skill(skill="code-review")        # correctness review of the working diff
Skill(skill="security-review")    # vulnerability audit of the pending changes
```

- **`/simplify` produces edits.** They are pre-authorized — the user invoked this command expecting them — so let it apply them; they are committed by Step 2 along with everything else.
- **`/code-review` and `/security-review` produce findings, not edits.** If either surfaces something, **stop and raise it to the user**: report each finding (what, where, why it matters) and ask how they want to proceed. Do **not** auto-fix without acknowledgement. If they choose to fix, that resets this step — re-run the reviews over the amended diff before continuing.
- **If all three are clean:** continue to Step 2.

**Scale the pass to the diff, not to ceremony.** A docs-only or generated-types-only change has nothing for `/security-review` to audit; say you skipped it and why, rather than running a hollow pass. A change touching auth, data boundaries, migrations or anything parsing untrusted input gets all three, always.

**In stacked mode this runs per slice**, over that slice's own diff against its base branch — not the whole stack. `/do-chores` has already opened the slice's PR as a **draft**, which is precisely why the draft exists: it is not review-ready, and nobody is invited to it, until this step has passed. Do not mark it ready before then (Step 3).

## Step 2 — Commit & push

1. Commit the branch's work. Run `git status`; if anything is uncommitted, stage and commit it with a clear message describing the change. This includes any edits Step 1's `/simplify` applied. Pre-existing changes unrelated to this branch that you flagged in Preflight stay out of the commit unless the user said to include them.
2. `git push -u origin HEAD` (the `-u` is a no-op if already tracking).
3. If the push is rejected because the remote moved, **do not** force-push. Pull/rebase, then push.
4. Never use `--no-verify`, `--force-with-lease`, or `--force` here unless the user explicitly asks for it.

## Step 3 — Open a PR

Create a pull request for the branch with `gh pr create`. Write a title and body that summarize the change. Target `main` unless the user said otherwise. Capture the PR URL/number from the output — you need it for Step 4. If a PR for this branch already exists, reuse it (`gh pr view`) rather than creating a duplicate.

**In stacked mode the PR already exists** — `/do-chores` opened it as a draft, and its number is on the slice's `PR:` line. Do not create a second one. Instead:

1. `--base` must still be the slice's parent branch. Verify it (`gh pr view <n> --json baseRefName`) and fix it with `gh pr edit <n> --base <parent>` if it drifted.
2. Mark it ready for review — Step 1's review pass has already run over this slice's diff, so the draft has served its purpose: `gh pr ready <n>`.
3. Add a line to the body naming what it stacks on (`Stacked on #<parent-PR>`) so a reviewer arriving cold knows not to read it against `main`.

## Step 4 — Wait for CI

Poll the PR's checks until every required check has finished:

```bash
gh pr checks <n> --watch
```

(`--watch` blocks and re-polls; if it's unavailable, poll `gh pr checks <n>` manually every 30–60s instead of sleeping in a tight loop.)

- **If any check fails:** stop and report which check failed, with a link and a short excerpt of the failure (`gh run view <run-id> --log-failed` or `mcp__github__get_job_logs`). Ask the user how they want to proceed. Do **not** auto-fix without acknowledgement — once fixed, re-push and re-run this step before continuing.
- **If a check is skipped because the branch didn't touch the trees it gates** (e.g. the iOS workflow on a web-client-only change), that's expected — CI's own path filters already scoped it, so treat "skipped" as passing, not blocking.
- **If everything required is green:** continue to Step 5.

## Step 5 — QA review

Pick the QA pass that matches what the branch actually changed — the `qa-review`
skill drives a **web browser**, so it can only exercise web-client changes. A
branch that touched `ios/**` needs the **iOS Simulator**; a browser pass against
the web app would test code the branch never touched.

### 5a. Web changes (`web-client/**`) → browser QA

Run the `qa-review` workflow — the adversarial "Quinn" black-box pass against the prod-like QA stack:

```
Skill(skill="qa-review")
```

### 5b. iOS changes (`ios/**`) → Simulator QA

Drive the real built app in the iOS Simulator against the **real QA-stack API**
(not MSW, not a unit test). The app reads `FMM_API_BASE_URL` at runtime and mints
a **guest session automatically on launch** — so no email/magic-link auth is
needed to reach an authenticated dashboard. Steps:

1. **Build the app for the simulator** (CI doesn't ship you a build artifact
   to reuse — build fresh from this checkout):
   ```bash
   rm -rf ios/build/sim
   xcodebuild -project ios/Fortymm.xcodeproj -scheme Fortymm -configuration Debug \
     -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
     -derivedDataPath ios/build/sim build
   ```
   The `rm -rf` matters — incremental builds report `BUILD SUCCEEDED` while
   serving a stale dylib. A non-`** BUILD SUCCEEDED **` result stops the workflow.
2. **Stand up the QA API.** `docker-compose.qa.yml`, launched
   via `scripts/qa-up.sh` so it picks a free port instead of hardcoding 8085
   (several stacks may already be running). Capture the assigned URL:
   `[ -f .env ] || cp <main-checkout>/.env .env` then
   `eval "$(scripts/qa-up.sh "$(git rev-parse --abbrev-ref HEAD)" | tee /dev/stderr | tail -n1)"`.
   The launcher reuses the stack if its id already maps to a running project.
   Use `$QA_URL` below.
3. **Install + launch.**
   Find the bundle id with `grep PRODUCT_BUNDLE_IDENTIFIER ios/Fortymm.xcodeproj/project.pbxproj`
   (currently `com.fortymm.ios-client`). On a booted simulator
   (`xcrun simctl list devices booted`; boot one if none):
   ```bash
   APP=ios/build/sim/Build/Products/Debug-iphonesimulator/Fortymm.app
   xcrun simctl terminate booted <bundle-id> 2>/dev/null
   xcrun simctl uninstall booted <bundle-id> 2>/dev/null   # avoid stale install
   xcrun simctl install booted "$APP"
   SIMCTL_CHILD_FMM_API_BASE_URL="$QA_URL/api" xcrun simctl launch booted <bundle-id>
   ```
   `SIMCTL_CHILD_*` forwards the env var into the app; the base must include `/api`
   (QA's nginx serves the API under `/api`, unlike UAT). `$QA_URL` comes from the
   launcher in step 2.
4. **Drive + screenshot.** Capture with `xcrun simctl io booted screenshot <file>`
   and tap/type with `idb ui tap <x> <y> --udid <udid>` (points, not pixels).
   Save evidence to `.qa-review/` (gitignore it). Exercise the screens the branch
   touched at the states that matter — e.g. for a conditional-render change,
   screenshot **both** the present and absent states (create the data through the
   app UI: New match → Start match seeds a scoreable "needs attention" item).
   Verify there's no layout regression (leftover gap, clipped view, etc.).

### Both paths

- **If bugs are found:** relay the report (with screenshots via SendUserFile) and raise them to the user. Ask what they want to do. Do **not** auto-fix without acknowledgement — fixing resets the workflow (re-run Step 1's review pass, re-push, and re-run Step 4 before resuming).
- **If it's clean:** continue to Step 6.

## Step 6 — Merge

Only reach this step if **every** prior step passed clean — green required checks, no QA bugs (or the user explicitly chose to proceed despite something). Merge the PR:

```bash
gh pr merge --squash --delete-branch
```

Use `--squash` unless the user asked for a different merge strategy. If the merge is blocked (required checks still running, conflicts, branch protection), report exactly why and stop — do not override protections.

Note: run from a worktree, `--delete-branch` prints `fatal: 'main' already used by worktree` **after the remote merge has already succeeded**. That is not a failed merge — verify with `gh pr view <n> --json state,mergedAt` before reacting, and clean up the branch by hand rather than retrying the merge.

**In stacked mode, capture the merged branch's tip *before* merging, then rebase the slice above it.** See [§Walking a stack](#walking-a-stack) — skipping the rebase leaves the next PR replaying commits the squash already absorbed, and it conflicts against itself.

## Walking a stack

Only in stacked mode. The stack is a straight line — `main ← s1 ← s2 ← s3` — and it merges **bottom-up, one PR at a time**. Never merge out of order; a middle PR merged first drags its parent's unreviewed commits into `main` with it.

For each slice, lowest first:

1. **Check it out** and run Steps 1–4 against it, diffing against **its own base branch**, not `origin/main`.
2. **Scale Step 5 to the slice's diff, not the stack's.** A slice touching only `web-client/**` does not owe an iOS Simulator pass; a generated-types-only slice has no user-observable surface, so Step 5's QA pass has nothing to drive — say so and skip it rather than running a hollow pass. CI itself already scales Step 4's checks to the slice's diff via its own path filters.
3. **Merge it** (Step 6) — but capture the tip first:

   ```bash
   OLD_BASE=$(git rev-parse <this-slice-branch>)   # BEFORE the merge deletes it
   gh pr merge <n> --squash --delete-branch
   ```

4. **Rebase the slice above onto `main`**, dropping the commits the squash absorbed:

   ```bash
   git fetch origin main
   git checkout <next-slice-branch>
   git rebase --onto origin/main "$OLD_BASE" <next-slice-branch>
   git push --force-with-lease origin <next-slice-branch>
   ```

   `--force-with-lease`, never `--force`. If the rebase conflicts, stop and raise it — a conflict here usually means the slices were not as independent as the work order claimed, which is the user's call, not yours to resolve silently.

5. **Confirm the retarget.** GitHub re-points an open PR at `main` when its base branch is merged and deleted, but it is best-effort. Check `gh pr view <next-n> --json baseRefName` and fix it with `gh pr edit` if it still names the deleted branch.
6. **Update the work order** — the merged slice's `PR:` line gets its merged state — then move to the next slice.

**Stop the walk at the first slice that fails any gate.** The slices above it stay open and unmerged; report which merged, which is blocked and why, and leave the rest alone. Do not skip a blocked slice to merge the one above it — that is what "the stack is a straight line" forbids.

If a gate failure requires a fix, the fix belongs in **the slice that owns the code**, not in a later one. Commit it there, re-run that slice's gates, and continue — then rebase everything above it, because you have just rewritten a branch the rest of the stack sits on.

## Step 7 — Collect the garbage

Only after the merge is confirmed. `--delete-branch` removes the *branch*; nothing has ever removed the *worktree*. Left alone this accumulates fast — it reached 311 worktrees and 82 GB, 77% of them on already-merged branches, and that sprawl is what causes `/epic` to resume into a stale checkout, ADR numbers to be computed against old trees, and QA stacks to OOM a host with no headroom.

```bash
scripts/reap-worktrees.sh            # dry run: what would go
scripts/reap-worktrees.sh --force    # reap worktrees whose PR has merged
```

The script only ever removes a worktree whose PR is **merged** and which holds nothing that isn't already in `main` (no modified tracked files, no source-looking untracked files, no commits added after the merge); anything else it lists as REVIEW and leaves alone. It records branch/sha/path to `.claude/reaped-worktrees.tsv` first, so any reap can be undone with `git worktree add -b <branch> <path> <sha>`.

You are standing in the worktree that was just merged, so the script will skip it as "current" — that one is the user's to remove after they've moved on. Report the counts; don't push past a REVIEW entry on the user's behalf.

Then tear down the QA stack this run brought up in Step 5:

```bash
QA_ID="$(git rev-parse --abbrev-ref HEAD)"          # same derivation qa-up.sh uses
scripts/qa-down.sh "$QA_ID" --dry-run               # read it before you run it
scripts/qa-down.sh "$QA_ID"
```

Pass the **same id Step 5 gave `qa-up.sh`**. In stacked mode the walk has moved on by now, so `HEAD` may name a different slice's branch than the one that brought the stack up — and `qa-down.sh` would then tear down a stack that does not exist and leave the real one running. `docker compose ls | grep fortymm-qa-` confirms which is actually up.

`docker compose down -v` is not a substitute. It leaves the locally-built images and the buildx cache, which is how `Docker.raw` reached 230 GB and wedged the daemon.

**In stacked mode this runs once, at the end of the whole walk — not per slice.** Every slice drives the same stack, so a per-slice teardown just pays for a cold rebuild on the next slice.

**Never** `docker system prune -a` or `docker volume prune`. `fortymm-uat_postgres-data` is unattached and the k3d cluster holds `tailscale-state` Secrets; a blanket prune destroys both silently. `qa-down.sh` refuses one on purpose — do not work around it.

Two ordering traps worth stating, because both have cost a cycle:

- **`gh pr merge --delete-branch` errors from inside a worktree.** Delete the branch as its own step.
- **`reap-worktrees.sh` never removes the worktree the caller is standing in.** It skips it as "current" and still reports success, so a reap that runs before you move out is a no-op that looks like a success.

## Reporting

End with a single-line summary listing: commit + push status, the PR URL, CI outcome, QA-review verdict, and merge status. Keep it terse — the user can read the diff.

In stacked mode, give one such line **per slice**, bottom-up, plus a final line naming how many PRs merged and which (if any) are still open and why.
