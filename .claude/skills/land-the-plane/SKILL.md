---
name: land-the-plane
description: Use this skill when the user says "/land-the-plane", "land the plane", or otherwise asks to finish/ship the current branch end-to-end. Runs `/simplify` on the changed code, executes all test suites, pushes the branch, then kicks off a code review via `/review`.
version: 1.0.0
---

# Land the Plane

End-to-end "ship it" workflow for the current branch. Run the steps below **in order**. If any step fails, stop and report the failure to the user — do not skip ahead.

## Preflight

1. Confirm you're in a git repository and on a feature branch (not `main`). If on `main`, stop and tell the user.
2. Run `git status` and `git diff --stat origin/main...HEAD` so you (and the user) can see what's about to ship.
3. If there are uncommitted changes, surface them. Ask the user whether to commit them first or abort — do **not** auto-commit without acknowledgement.

## Step 1 — Simplify

Invoke the `simplify` skill on the changed code:

```
Skill(skill="simplify")
```

Apply any fixes it identifies. When `simplify` produces edits, stage and commit them with a clear message (e.g. `simplify: remove unused fallback in <file>`).

## Step 2 — Run all tests

Run each suite the project ships. Use the project root as cwd. Run independent suites in parallel via separate Bash tool calls in one message.

- **API (pytest):** `cd api && uv run pytest` (or whatever the project's standard runner is — check `api/pyproject.toml` / `mise.toml`)
- **Web client unit tests (vitest):** `cd web-client && npm run test:run`
- **Web client lint/typecheck:** `cd web-client && npm run lint && npm run build`
- **E2E (Playwright):** `cd e2e && npm test` — remember [[feedback_playwright_port_collision]]; set `PLAYWRIGHT_PORT` if the dev compose is up.

If any suite fails: stop, report the failure, do not push.

## Step 3 — Push

Only after every suite is green:

1. `git push -u origin HEAD` (the `-u` is a no-op if already tracking).
2. If the push is rejected because the remote moved, **do not** force-push. Pull/rebase, re-run tests, then push.
3. Never use `--no-verify`, `--force-with-lease`, or `--force` here unless the user explicitly asks for it.

## Step 4 — Code review

Invoke the `review` skill on the current branch:

```
Skill(skill="review")
```

If `review` surfaces issues, report them to the user — do not auto-fix without acknowledgement, since simplify + tests already passed and any further edits would need their own re-test/push cycle.

## Reporting

End with a single-line summary listing: simplify outcome, each suite's result, push status, and review outcome. Keep it terse — the user can read the diff.
