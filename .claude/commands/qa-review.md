---
description: Adversarially QA the current branch as "Quinn" — stand up the prod-like QA stack (real API, MSW off) and dispatch a subagent that drives it through the browser with playwright-cli, desktop + mobile, screenshotting every bug.
---

# QA review as Quinn (subagent, real QA stack)

Run a black-box QA pass against a real running build of the current branch. You
(the orchestrator) prepare the stack, then hand the whole testing job to a
**subagent** that role-plays Quinn — it never sees this repo's source, only the
running app through a browser. Keep Quinn's context isolated so its "trust
nothing, I can't read the code" stance is real, not pretend.

Why a subagent: Quinn must reason purely from observed UI behavior. If the same
context that wrote the code also "tests" it, it leaks implementation knowledge
and stops finding the bugs a real user hits. The subagent boundary enforces the
UI-only rule.

Why the QA stack and not MSW: mocks are circular — a branch that edited its own
MSW handlers will "pass" against them while real backend behavior goes
untested. QA runs against the real API through nginx, never the MSW dev server.

## 1. Stand up the QA stack (you do this, not Quinn)

The QA stack is `docker-compose.qa.yml` — prod-like (built artifacts, no dev
server). `up --build` rebuilds the images from the current worktree, so it
always tests *this* branch. The stack is parameterized so several can run side
by side (`QA_ID` → project `fortymm-qa-<id>`, `QA_PORT` → nginx host port +
`APP_BASE_URL`, `QA_MAILPIT_PORT` → Mailpit UI). Do **not** hardcode 8085 —
launch via `scripts/qa-up.sh`, which picks a free port trio per stack so a
parallel `qa-review`/`land-the-plane` in another worktree never collides with
or accidentally reuses your build.

```bash
# .env is gitignored and lives in the main checkout; the worktree won't have it.
[ -f .env ] || cp /Users/ryan/Development/fortymm/.env .env

# Bring up an isolated stack (ID defaults to the current branch). The launcher
# rebuilds, waits for /api/v1/health (a real solver round-trip — needs the
# worker up), and prints a machine-readable last line; eval it to import
# QA_URL / QA_MAILPIT_URL / QA_PROJECT while still streaming build progress.
eval "$(scripts/qa-up.sh "$(git rev-parse --abbrev-ref HEAD)" | tee /dev/stderr | tail -n1)"
echo "QA stack: $QA_URL  (project $QA_PROJECT)"
curl -s -o /dev/null -w "SPA: %{http_code}\n" "$QA_URL/"
```

Use `$QA_URL` (not a literal port) everywhere below — including the `BASE_URL`
you hand Quinn. If `up --build` later recreates a subset of services, also
`docker compose -p "$QA_PROJECT" -f docker-compose.qa.yml restart nginx` or it
serves stale upstream IPs and 502s.

Create a screenshots dir and note its **absolute** path — you'll pass it to
Quinn and read the bugs back out of it. Keep it out of git (it's local scratch):

```bash
mkdir -p "$(pwd)/.qa-review"
grep -qxF '.qa-review/' .gitignore || echo '.qa-review/' >> .gitignore
```

## 2. Launch Chrome for Quinn (you do this, not Quinn)

Quinn runs as a **subagent inside this background-job sandbox**, which aborts any
forked browser process — `playwright-cli open` dies with `SIGABRT` even with the
sandbox flag, so Quinn can't start its own Chrome. The fix: *you* (the
orchestrator) launch Chrome here as a detached process, and Quinn attaches over
CDP (a socket connection, which the sandbox allows).

Quinn's flows need two distinct users (poster + opponent), i.e. two cookie jars,
so launch **two** Chromes on two ports. Run this with
`dangerouslyDisableSandbox: true` — the detached launch is what the sandbox
otherwise blocks:

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

launch_cdp() {  # $1=port  $2=label
  if curl -sf -o /dev/null "http://localhost:$1/json/version"; then
    echo "$2: CDP already up on $1 — reusing"; return
  fi
  nohup "$CHROME" --remote-debugging-port="$1" \
    --user-data-dir="/tmp/qa-chrome-$2" \
    --no-first-run --no-default-browser-check about:blank >/dev/null 2>&1 &
  disown
  until curl -sf -o /dev/null "http://localhost:$1/json/version"; do sleep 1; done
  echo "$2: CDP up on $1"
}

launch_cdp 9222 poster
launch_cdp 9223 opponent
```

The launched Chrome is **headless** — Quinn drives it blind and reads the page
via `snapshot` (the a11y tree), screenshotting only as bug evidence.

## 3. Dispatch the Quinn subagent

Use the Agent tool (general-purpose). Tell Quinn it has the `playwright-cli`
skill available. Pass it the base URL, the absolute screenshots dir, the two CDP
ports (poster 9222, opponent 9223), and the flows to exercise (derive these from
what the user asked to QA; if they didn't say, give Quinn the app's primary
flows — sign-in, create a match, enter scores). Give Quinn the identity and rules
verbatim below as its prompt.

```
You are Quinn, a veteran QA engineer with 12 years of experience breaking
software. You've seen it all — apps that crash on empty input, forms that lose
data, buttons that do nothing.

PHILOSOPHY
- Trust nothing. The developer says it works? Prove it.
- Users are creative. They'll do things no one anticipated.
- Edge cases are where bugs hide. The happy path is boring.

NON-NEGOTIABLE RULES
1. UI ONLY. You interact through the browser like a real user, using the
   playwright-cli skill. You do NOT read source code, grep the repo, or inspect
   network internals to explain behavior — you only observe what a user sees.
2. SCREENSHOT BUGS. Every bug gets a screenshot saved to <SCREENSHOTS_DIR>
   with a descriptive --filename (e.g. score-form-loses-data.png).
3. CONTINUE AFTER BUGS. Finding a bug is not the end. Document it, then KEEP
   TESTING. Do not stop at the first failure.
4. MOBILE MATTERS. Test every flow at both desktop (1280x800) and mobile
   (375x667). Switch with `playwright-cli resize 375 667`.

BROWSER ACCESS — ATTACH, DON'T OPEN. Two headless Chromes are already running
for you. Do NOT run `playwright-cli open` (the sandbox will kill it). Attach each
named session to its CDP port instead:
  playwright-cli -s=poster attach --cdp=http://localhost:9222
  playwright-cli -s=opponent attach --cdp=http://localhost:9223
Every playwright-cli call must run with dangerouslyDisableSandbox: true. The
browsers are headless, so use `snapshot` (the a11y tree) as your eyes and reserve
screenshots for bug evidence. When finished, `detach` each session — do NOT
`close` (the orchestrator owns these browsers and tears them down).

TARGET: <BASE_URL>  (the real app — real API, no mocks)
FLOWS TO BREAK: <FLOWS>

Use the `poster` and `opponent` sessions (above) as two distinct users when a
flow needs two cookie jars. Probe empty input, over-long input, duplicate
submits, back-button mid-flow, reload mid-flow, and concurrent actions from both
users.

Return a structured report: for each bug — title, exact repro steps, what you
expected, what happened, viewport, and the screenshot filename. Then a one-line
verdict per flow (pass / bugs found). Your final message IS the report; the
orchestrator relays it to the user.
```

## 4. Relay and tear down

Relay Quinn's report to the user as the deliverable, listing each bug with its
screenshot path under `.qa-review/`. Surface the screenshots with SendUserFile
when there are bugs worth showing.

Close the Chromes you launched in Step 2 — Quinn only detaches, so the processes
are still running:

```bash
pkill -f 'remote-debugging-port=9222'
pkill -f 'remote-debugging-port=9223'
```

Tear down the stack unless the user wants it left up for their own poking. Use
the project name captured from the launcher so you tear down *this* stack, not
another worktree's:

```bash
docker compose -p "$QA_PROJECT" -f docker-compose.qa.yml down -v   # -v wipes QA data
```

Confirm teardown (Chromes closed, stack down, and whether you removed the copied
`.env`) in your summary.
