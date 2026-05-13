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
3. If there are uncommitted changes unrelated to the branch's work-in-progress, surface them and ask the user whether to commit or abort — do **not** auto-commit pre-existing work without acknowledgement. (Edits produced by Step 1's `simplify` are pre-authorized to commit, since the user invoked this skill expecting that.)

## Step 1 — Simplify

Invoke the `simplify` skill on the changed code:

```
Skill(skill="simplify")
```

Apply any fixes it identifies. When `simplify` produces edits, stage and commit them with a clear message (e.g. `simplify: remove unused fallback in <file>`).

## Step 2 — Run all tests

Run each suite the project ships. Use the project root as cwd. Run independent suites in parallel via separate Bash tool calls in one message. Skip any suite whose directory is absent.

- **API (pytest):** `cd api && pytest` (matches CI in `.github/workflows/api.yml`; assumes `pip install -e '.[dev]'` has been run in `api/.venv`. If pytest isn't on PATH, use `api/.venv/bin/pytest`.)
- **Web client unit tests (vitest):** `cd web-client && npm run test:run`
- **Web client lint + typecheck/build:** `cd web-client && npm run lint && npm run build` (the `build` script is `tsc -b && vite build` — it's the only typecheck.)
- **Web client e2e (Playwright):** `cd web-client && npm run test:e2e`. Playwright defaults to port 5174 which collides with the dev compose web-client; set `PLAYWRIGHT_PORT` to a free port when the dev compose stack is up.
- **Root e2e (Playwright + docker stack):** `cd e2e && npm test`. This suite drives the full docker compose stack; ensure it's running first (or skip if not applicable to this branch's changes).
- **OpenAPI schema drift:** if `api/**` or `web-client/src/api/**` changed, run `mise run regen-api-types` then `git diff --exit-code web-client/src/api/schema.d.ts`. A non-empty diff means the committed schema is stale — commit the regenerated file.

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
