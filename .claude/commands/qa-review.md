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

**Never hardcode the CDP ports, and never pick them yourself.** Two QA passes
running out of two worktrees at once used to land on the same 9222/9223 and
silently drive each other's browser. Picking a different fixed "non-default" port
is not a fix (the next run reads the same note and picks the same one), and
neither is hashing a slug then probing for a free pair — that's check-then-act,
so two runs starting in the same second still collide.

**Let the kernel assign the port.** `--remote-debugging-port=0` binds an
ephemeral port atomically; Chrome writes it to `DevToolsActivePort` in its
profile dir. No race, no hash, no probe loop.

**Write the ports and PIDs to a file, not to shell variables.** Each step below
runs in its own Bash tool call and **shell state does not persist between them** —
a `$CDP_POSTER` set here is empty by Step 4, which would degrade that step's
`pkill -f "remote-debugging-port=$CDP_POSTER"` into a pattern matching *every*
CDP Chrome on the machine, including a sibling worktree's mid-flow.

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Key everything to this run's stack. $QA_PROJECT comes from scripts/qa-up.sh;
# fall back to the branch name. The profile dir is keyed the same way, so two
# runs never share a cookie jar either.
QA_SLUG="${QA_PROJECT:-fortymm-qa-$(git rev-parse --abbrev-ref HEAD)}"
RUN_DIR=".qa-review/$QA_SLUG"; mkdir -p "$RUN_DIR"

launch_cdp() {  # $1=label
  local dir="/tmp/qa-chrome-$QA_SLUG-$1" port
  # Reuse this run's own browser if it's still alive (a resumed session), but
  # never adopt a stranger's: the port came from OUR profile dir.
  if [ -s "$dir/DevToolsActivePort" ]; then
    port="$(head -1 "$dir/DevToolsActivePort")"
    if curl -sf -o /dev/null "http://localhost:$port/json/version"; then
      echo "$1: reusing CDP on $port"; echo "$port" > "$RUN_DIR/$1.port"; return
    fi
  fi
  rm -f "$dir/DevToolsActivePort"
  nohup "$CHROME" --remote-debugging-port=0 --user-data-dir="$dir" \
    --no-first-run --no-default-browser-check about:blank >/dev/null 2>&1 &
  echo $! > "$RUN_DIR/$1.pid"
  disown
  for _ in $(seq 1 60); do [ -s "$dir/DevToolsActivePort" ] && break; sleep 1; done
  port="$(head -1 "$dir/DevToolsActivePort")"
  echo "$port" > "$RUN_DIR/$1.port"
  echo "$1: CDP up on $port (pid $(cat "$RUN_DIR/$1.pid"))"
}

launch_cdp poster
launch_cdp opponent
echo "poster=$(cat "$RUN_DIR/poster.port")  opponent=$(cat "$RUN_DIR/opponent.port")"
```

Steps 3 and 4 read `.qa-review/$QA_SLUG/{poster,opponent}.port` and `.pid` — read
them fresh in each step rather than carrying a variable across tool calls.

## 2b. Grant the QA user a role that can actually do anything

The QA stack seeds roles but assigns them to **nobody**, and the default `User`
role carries no permissions (`api/scripts/seed_rbac.py`). So a guest or freshly
minted user 403s on every tournament write, and Quinn reports "can't create a
tournament" as a bug on every single run. There is no HTTP endpoint to
self-assign a role, so the sanctioned seam is the database — the same one
`e2e/support/rbac-grant.ts` uses for the composed suite.

After the stack is up, grant **"Beta tester"** (`tournament.view` / `.create` /
`.enter`) to the user Quinn will drive. Substitute the username Quinn signs in as:

`-v ON_ERROR_STOP=1` is not optional: without it `psql` does not reliably signal
a SQL error in its exit status, so a renamed role or a reshaped `user_roles`
would leave the grant silently unapplied — and Quinn would then report the
resulting 403s as a product bug, which is the exact false positive this step
exists to prevent. Check the exit code.

```bash
docker compose -p "$QA_PROJECT" -f docker-compose.qa.yml exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d fortymm -c "
    INSERT INTO user_roles (user_id, role_id)
    SELECT u.id, r.id FROM users u CROSS JOIN roles r
    WHERE u.username = '<USERNAME>' AND r.name = 'Beta tester'
      AND NOT EXISTS (SELECT 1 FROM user_roles ur
                      WHERE ur.user_id = u.id AND ur.role_id = r.id);"
```

Idempotent, so re-running is safe. The user must exist first — grant *after*
Quinn has signed in, or after seeding the account.

**Keep one un-granted identity if the branch touches permission gating**: with
every user granted, the "no permission" path becomes untestable. Say which
identity holds which role when you brief Quinn.

The launched Chrome is **headless** — Quinn drives it blind and reads the page
via `snapshot` (the a11y tree), screenshotting only as bug evidence.

## 3. Dispatch the Quinn subagent

Use the Agent tool (general-purpose). Tell Quinn it has the `playwright-cli`
skill available. Pass it the base URL, the absolute screenshots dir, the two CDP
ports (read them now with `cat .qa-review/$QA_SLUG/{poster,opponent}.port` and
substitute the actual numbers — they differ every run), and the flows to exercise (derive these from
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
  playwright-cli -s=poster attach --cdp=http://localhost:<CDP_POSTER>
  playwright-cli -s=opponent attach --cdp=http://localhost:<CDP_OPPONENT>
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

Kill **this run's** browsers by PID. Do not `pkill -f remote-debugging-port=…`:
this step runs in a fresh Bash call where any variable from Step 2 is empty, so
the pattern would collapse to a prefix that matches a sibling worktree's Chrome
too. Re-derive the slug and read the PIDs back from the file Step 2 wrote:

```bash
QA_SLUG="${QA_PROJECT:-fortymm-qa-$(git rev-parse --abbrev-ref HEAD)}"
RUN_DIR=".qa-review/$QA_SLUG"

for label in poster opponent; do
  pidfile="$RUN_DIR/$label.pid"
  [ -f "$pidfile" ] || continue
  pid="$(cat "$pidfile")"
  kill "$pid" 2>/dev/null
  # Wait for it to actually exit before removing the profile — Chrome writes on
  # its way down, so an immediate `rm -rf` races it and leaves the dir behind.
  for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  rm -rf "/tmp/qa-chrome-$QA_SLUG-$label"
done
rm -f "$RUN_DIR"/*.pid "$RUN_DIR"/*.port
```

Tear down the stack unless the user wants it left up for their own poking. Use
the project name captured from the launcher so you tear down *this* stack, not
another worktree's:

```bash
docker compose -p "$QA_PROJECT" -f docker-compose.qa.yml down -v   # -v wipes QA data
```

Confirm teardown (Chromes closed, stack down, and whether you removed the copied
`.env`) in your summary.
