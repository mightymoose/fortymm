---
description: Ship the current branch end-to-end — run /simplify, all test suites, commit, push, open a PR, /code-review, /security-review and /qa-review it, then merge if everything passes (raising any issues to the user first).
---

End-to-end "ship it" workflow for the current branch. Run the steps below **in order**. If any step fails, stop and report the failure to the user — do not skip ahead.

## Preflight

1. Confirm you're in a git repository and on a feature branch (not `main`). If on `main`, stop and tell the user.
2. Run `git status` and `git diff --stat origin/main...HEAD` so you (and the user) can see what's about to ship.
3. If there are uncommitted changes unrelated to the branch's work-in-progress, surface them and ask the user whether to commit or abort — do **not** auto-commit pre-existing work without acknowledgement. (Edits produced by Step 1's `simplify` are pre-authorized to commit, since the user invoked this command expecting that.)

## Step 1 — Simplify

Invoke the `simplify` skill on the changed code:

```
Skill(skill="simplify")
```

Apply any fixes it identifies. When `simplify` produces edits, stage and commit them with a clear message (e.g. `simplify: remove unused fallback in <file>`).

## Step 2 — Run all tests

Run each suite the project ships. Use the project root as cwd. Run independent suites in parallel via separate Bash tool calls in one message. Skip any suite whose directory is absent.

- **API (ruff + mypy + pytest):** from `api/`, run the same gates as CI (`.github/workflows/api.yml`) **in order** — `ruff check app tests`, `ruff format --check app tests`, `mypy` (strict; config in `pyproject.toml`), then `pytest`. Assumes `pip install -e '.[dev]'` has been run in `api/.venv`; if the tools aren't on PATH, prefix with `api/.venv/bin/` (e.g. `api/.venv/bin/mypy`). A ruff failure is usually auto-fixable (`ruff check --fix`, `ruff format`) — apply, then re-run; mypy/pytest failures stop the workflow.
- **Web client unit tests (vitest):** `cd web-client && npm run test:run`
- **Web client lint + typecheck/build:** `cd web-client && npm run lint && npm run build` (the `build` script is `tsc -b && vite build` — it's the only typecheck.)
- **Web client e2e (Playwright):** `cd web-client && npm run test:e2e`. Playwright defaults to port 5174 which collides with the dev compose web-client; set `PLAYWRIGHT_PORT` to a free port when the dev compose stack is up.
- **Root e2e (Playwright + docker stack):** `cd e2e && npm test`. This suite drives the full docker compose stack; it self-manages the stack, so just run it. It is the only **automated** coverage for the tournament create → go-live → play → crown lifecycle. A browser QA pass can reach those flows once it grants itself the Beta tester role (see `qa-review.md` §2b), but that is a hand-driven exploratory pass, not a regression gate — it proves the flow worked once, for one operator, on one stack.

  **Never scope it out because "the branch didn't touch `e2e/`".** A web-client-only or api-only change absolutely can break it; that is precisely what it is for, and skipping it on that reasoning once already shipped a break that CI then caught, costing a full merge cycle. Run it whenever the branch touches **`api/`, `web-client/`, `ios/`, `e2e/`, `deploy/`, `nginx/`, or any `docker-compose*.yml`**.

  The one case you may skip: a branch that touches **only** `*.md`, `docs/`, or `.claude/` — no application code, no stack config. Charging a cold docker stack build to a README edit buys nothing. Say explicitly that you skipped it and why.
- **OpenAPI schema drift:** if `api/**` or `web-client/src/api/**` changed, run `mise run regen-api-types` then `git diff --exit-code web-client/src/api/schema.d.ts`. A non-empty diff means the committed schema is stale — commit the regenerated file.
- **iOS app build (xcodebuild):** if `ios/**` changed, the compile is the gate (the app ships no XCTest target). Clean-build for the simulator **from the worktree's own `ios/` dir** (a worktree has its own checkout — building the main repo's `ios/` tests the wrong code): `rm -rf ios/build/sim && xcodebuild -project ios/Fortymm.xcodeproj -scheme Fortymm -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/build/sim build`. The `rm -rf` matters — incremental builds report `BUILD SUCCEEDED` while serving a stale dylib. A non-`** BUILD SUCCEEDED **` result stops the workflow.

If any suite fails: stop, report the failure, do not push.

## Step 3 — Commit & push

Only after every suite is green:

1. Commit the branch's work. Run `git status`; if anything is uncommitted (the branch changes, plus any `simplify` / schema-regen edits from Steps 1–2), stage and commit it with a clear message describing the change. Pre-existing changes unrelated to this branch that you flagged in Preflight stay out of the commit unless the user said to include them.
2. `git push -u origin HEAD` (the `-u` is a no-op if already tracking).
3. If the push is rejected because the remote moved, **do not** force-push. Pull/rebase, re-run tests, then push.
4. Never use `--no-verify`, `--force-with-lease`, or `--force` here unless the user explicitly asks for it.

## Step 4 — Open a PR

Create a pull request for the branch with `gh pr create`. Write a title and body that summarize the change and its testing (you already know the diff and which suites passed). Target `main` unless the user said otherwise. Capture the PR URL/number from the output — you need it for Step 5. If a PR for this branch already exists, reuse it (`gh pr view`) rather than creating a duplicate.

## Step 5 — Code review

Invoke the `code-review:code-review` skill on the PR you just opened:

```
Skill(skill="code-review:code-review")
```

- **If it surfaces issues:** stop and raise them to the user. Ask what they want to do (e.g. fix now, fix later, or proceed anyway). Do **not** auto-fix without acknowledgement — simplify + tests already passed and any further edits need their own re-test/push cycle. Only continue to Step 6 once the user has decided; if they choose to fix first, that resets the workflow (re-run the relevant suites and re-push before resuming).
- **If it's clean:** continue to Step 6.

## Step 6 — Security review

Invoke the built-in `security-review` skill — a security audit of the pending changes on the branch:

```
Skill(skill="security-review")
```

- **If it surfaces vulnerabilities:** stop and raise them to the user, same as code review — report each finding (severity, location, why it matters) and ask what they want to do. Do **not** auto-fix without acknowledgement; fixing resets the workflow (re-run the relevant suites and re-push before resuming).
- **If it's clean:** continue to Step 7.

## Step 7 — QA review

Pick the QA pass that matches what the branch actually changed — the `qa-review`
skill drives a **web browser**, so it can only exercise web-client changes. A
branch that touched `ios/**` needs the **iOS Simulator**; a browser pass against
the web app would test code the branch never touched.

### 7a. Web changes (`web-client/**`) → browser QA

Run the `qa-review` workflow — the adversarial "Quinn" black-box pass against the prod-like QA stack:

```
Skill(skill="qa-review")
```

### 7b. iOS changes (`ios/**`) → Simulator QA

Drive the real built app in the iOS Simulator against the **real QA-stack API**
(not MSW, not a unit test). The app reads `FMM_API_BASE_URL` at runtime and mints
a **guest session automatically on launch** — so no email/magic-link auth is
needed to reach an authenticated dashboard. Steps:

1. **Stand up the QA API.** Same stack as 7a — `docker-compose.qa.yml`, launched
   via `scripts/qa-up.sh` so it picks a free port instead of hardcoding 8085
   (several stacks may already be running). Capture the assigned URL:
   `[ -f .env ] || cp <main-checkout>/.env .env` then
   `eval "$(scripts/qa-up.sh "$(git rev-parse --abbrev-ref HEAD)" | tee /dev/stderr | tail -n1)"`.
   The launcher reuses the stack if its id already maps to a running project, so
   re-running for an iOS-only change won't rebuild the web/API images needlessly.
   Use `$QA_URL` below.
2. **Build + install + launch** (reuse the clean build from Step 2's iOS gate).
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
   launcher in step 1.
3. **Drive + screenshot.** Capture with `xcrun simctl io booted screenshot <file>`
   and tap/type with `idb ui tap <x> <y> --udid <udid>` (points, not pixels).
   Save evidence to `.qa-review/` (gitignore it). Exercise the screens the branch
   touched at the states that matter — e.g. for a conditional-render change,
   screenshot **both** the present and absent states (create the data through the
   app UI: New match → Start match seeds a scoreable "needs attention" item).
   Verify there's no layout regression (leftover gap, clipped view, etc.).

### Both paths

- **If bugs are found:** relay the report (with screenshots via SendUserFile) and raise them to the user. Ask what they want to do. Do **not** auto-fix without acknowledgement.
- **If it's clean:** continue to Step 8.

## Step 8 — Merge

Only reach this step if **every** prior step passed clean — green tests, no code-review issues, no QA bugs (or the user explicitly chose to proceed despite something). Merge the PR:

```bash
gh pr merge --squash --delete-branch
```

Use `--squash` unless the user asked for a different merge strategy. If the merge is blocked (required checks still running, conflicts, branch protection), report exactly why and stop — do not override protections.

Note: run from a worktree, `--delete-branch` prints `fatal: 'main' already used by worktree` **after the remote merge has already succeeded**. That is not a failed merge — verify with `gh pr view <n> --json state,mergedAt` before reacting, and clean up the branch by hand rather than retrying the merge.

## Step 9 — Collect the garbage

Only after the merge is confirmed. `--delete-branch` removes the *branch*; nothing has ever removed the *worktree*. Left alone this accumulates fast — it reached 311 worktrees and 82 GB, 77% of them on already-merged branches, and that sprawl is what causes `/epic` to resume into a stale checkout, ADR numbers to be computed against old trees, and QA stacks to OOM a host with no headroom.

```bash
scripts/reap-worktrees.sh            # dry run: what would go
scripts/reap-worktrees.sh --force    # reap worktrees whose PR has merged
```

The script only ever removes a worktree whose PR is **merged** and which holds nothing that isn't already in `main` (no modified tracked files, no source-looking untracked files, no commits added after the merge); anything else it lists as REVIEW and leaves alone. It records branch/sha/path to `.claude/reaped-worktrees.tsv` first, so any reap can be undone with `git worktree add -b <branch> <path> <sha>`.

You are standing in the worktree that was just merged, so the script will skip it as "current" — that one is the user's to remove after they've moved on. Report the counts; don't push past a REVIEW entry on the user's behalf.

## Reporting

End with a single-line summary listing: simplify outcome, each suite's result, commit + push status, the PR URL, code-review outcome, security-review outcome, QA-review verdict, and merge status. Keep it terse — the user can read the diff.
