---
description: Ship the current branch end-to-end — run /simplify, all test suites, commit, push, open a PR, /code-review and /qa-review it, then merge if everything passes (raising any issues to the user first).
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
- **Root e2e (Playwright + docker stack):** `cd e2e && npm test`. This suite drives the full docker compose stack; ensure it's running first (or skip if not applicable to this branch's changes).
- **OpenAPI schema drift:** if `api/**` or `web-client/src/api/**` changed, run `mise run regen-api-types` then `git diff --exit-code web-client/src/api/schema.d.ts`. A non-empty diff means the committed schema is stale — commit the regenerated file.

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

## Step 6 — QA review

Run the `qa-review` workflow — the adversarial "Quinn" black-box pass against the prod-like QA stack:

```
Skill(skill="qa-review")
```

- **If Quinn finds bugs:** relay the bug report (with screenshots via SendUserFile) and raise them to the user. Ask what they want to do. Do **not** auto-fix without acknowledgement.
- **If it's clean:** continue to Step 7.

## Step 7 — Merge

Only reach this step if **every** prior step passed clean — green tests, no code-review issues, no QA bugs (or the user explicitly chose to proceed despite something). Merge the PR:

```bash
gh pr merge --squash --delete-branch
```

Use `--squash` unless the user asked for a different merge strategy. If the merge is blocked (required checks still running, conflicts, branch protection), report exactly why and stop — do not override protections.

## Reporting

End with a single-line summary listing: simplify outcome, each suite's result, commit + push status, the PR URL, code-review outcome, QA-review verdict, and merge status. Keep it terse — the user can read the diff.
