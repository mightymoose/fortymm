---
description: Run a ticket and every child Planning creates from Discovery all the way to merged and Done
---

Run the ticket workflow below for GitHub issue `$1` and for every child ticket
that Planning creates under it.

You are the local OpenCode coordinator. Use the Herdr CLI from this OpenCode
session. Do not perform Discovery, Planning, Implementation, a repair or a
testing pass yourself.

**The run ends at Done, with every pull request merged.** It does not stop at
**Waiting For Sign Off**. That column is a signpost partway through, not the
finish line: it records that Codex passed a leaf and that the leaf is queued for
phase four's testing pass.

So a ticket already sitting in **Waiting For Sign Off** is *not* finished, and it
is never a reason to report that there is nothing to do. It resumes at phase
four. **Resuming a cancelled run** works out where any ticket resumes, and it is
the first thing you run.

The only terminal states are **Done** with the pull request merged, and a **stop**
code from the table below.

## Coordinator rules

These rules apply to every step below. They exist because a coordinator that
stops after it starts a worker makes the user babysit the run.

1. Waiting is your work. Do not end your turn while a worker still runs.
2. Every wait step is one bounded command with an exit code. Run it, read the
   code, and follow the table.
3. **Call the bash tool with `timeout: 600000` for every wait command.** The
   default is 120000 ms, and a wait pass runs for 540 seconds.
4. `blocked` is normal. The workers ask the user questions in their own panes.
   The user answers there, not here. Never stop because a worker is `blocked`.
5. Never answer a worker's question for the user.
6. Stop and report only for the codes marked **stop**.

| Code | Meaning | What you do |
| --- | --- | --- |
| `0` | The gate is open | Continue to the next step |
| `10` | Still working, pass budget spent | Run the same command again, at once |
| `21` | The worker read `unknown` for a whole pass | **stop**, name the pane, change nothing |
| `22` | The worker never started its turn | **stop**, name the pane, change nothing |
| `30` | Codex asked for changes | Repair, re-trigger, poll again. Repeat until Codex passes |
| `31` | Planning bounced the ticket to **To Do** | **stop**, name the ticket |
| `32` | Codex never answered | **stop**. Name the Codex GitHub App prerequisite |
| `33` | A tree cap was reached | **stop**, name the ticket and the cap |
| `1` | A command failed | **stop** and report the output |
| anything else, including a killed or timed-out command | The pass did not finish | Run the same command again, at once |

Run the wait command again as many times as it takes. Do not write a progress
report between runs. Do not ask the user whether to keep waiting.

Never retry a worker and never close a pane on a **stop** code.

### Why `blocked` does not stop the coordinator

Discovery runs `grill-me`, so the worker interviews the user. Every question
puts the worker in `blocked`. Codex also reports `blocked` while it asks the
user to approve a command.

The user answers in the worker's own pane, which is zoomed and whose title
reads `Action Required`. A coordinator that stops on `blocked` adds nothing and
loses the run: the user answers, the worker finishes, and nobody is left
watching the gate. That has happened. The wait loops below poll straight
through `blocked`.

A decomposed ticket multiplies this. Every child gets its own Discovery, so the
user answers one interview per child. That is the design, not a fault.

### One worker pane at a time

The run loops over many tickets. Open panes must not pile up.

Every stage splits its own pane, starts its worker, and closes that pane when
its gate opens. Herdr has no agent-kill command, so closing the pane is how a
worker dies. Two workers never run at once.

### Every stage runs in a worktree

No worker ever runs in the main checkout. The coordinator stays there, and every
pane it splits is given a worktree path as its `--cwd`.

The main checkout usually holds the user's own uncommitted work. A worker that
commits, stashes, or checks out a branch in it destroys that work, and phase four
merges, so a worker standing in the main checkout can move `main` under the user's
feet.

Two scopes, because the two phases need different things.

| Scope | Path | Branch | Lives for | Removed by |
| --- | --- | --- | --- | --- |
| The run | `.claude/worktrees/ticket-flow-run-$1` | detached at `origin/main` | Phase one | You, at the end of phase one |
| One leaf | `.claude/worktrees/<n>` | the leaf's own feature branch | Phases two and four | `scripts/reap-worktrees.sh` after the merge |

Phase one writes no code. Discovery and Planning only rewrite issues and move
board columns, so one detached worktree serves every ticket in the queue. Detached
matters: a scratch branch would carry no pull request, and `reap-worktrees.sh`
only ever reaps a worktree whose branch has a **merged** pull request. Anything
you create on a branch with no pull request, you must remove yourself.

Phase two writes code, so each leaf gets its own worktree on its own branch. That
is the branch the pull request opens on, which is what lets the reaper collect it
later. Phase four reuses the same worktree, because that is where the branch is.

Create the run's worktree once, before you take the first ticket off the queue:

```sh
root=$(git rev-parse --show-toplevel)
run_tree="$root/.claude/worktrees/ticket-flow-run-${1}"

git -C "$root" fetch origin main || exit 1

if [ ! -d "$run_tree" ]; then
  git -C "$root" worktree add --detach "$run_tree" origin/main || exit 1
fi
mise trust "$run_tree/mise.toml"
printf 'run worktree: %s\n' "$run_tree"
```

Create a leaf's worktree the first time phase two reaches that leaf:

```sh
N=<the leaf ticket>
root=$(git rev-parse --show-toplevel)
leaf_tree="$root/.claude/worktrees/${N}"

title=$(gh api "repos/mightymoose/fortymm/issues/${N}" --jq '.title') || exit 1
slug=$(printf '%s' "$title" \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' \
  | cut -c1-40)
branch="${N}-${slug%-}"

git -C "$root" fetch origin main || exit 1

if [ ! -d "$leaf_tree" ]; then
  if git -C "$root" show-ref --verify --quiet "refs/heads/${branch}"; then
    git -C "$root" worktree add "$leaf_tree" "$branch" || exit 1
  else
    git -C "$root" worktree add -b "$branch" "$leaf_tree" origin/main || exit 1
  fi
fi
mise trust "$leaf_tree/mise.toml"
printf 'leaf worktree: %s on %s\n' "$leaf_tree" "$branch"
```

`mise trust` runs once per worktree and is not optional. An untrusted `mise.toml`
puts `node` off `PATH`, so `npx` and every bare tool path exit `127`. The step
looks like it passed having run nothing.

Both snippets are idempotent. A resumed run finds its worktrees already there and
changes nothing. `git fetch` before every create, because a worktree cut from a
stale `origin/main` is a stale base and a green suite on it proves nothing.

Tell each worker the worktree is its workspace. Never let one `cd` out of it.
`zoxide` rebinds `cd`, so a relative `cd web-client` can land in the main
checkout, and the worker then edits and tests the wrong tree while reporting
success.

Worktrees are not free. Each one installs its own `node_modules` and `.venv`, at
roughly 270 MB. That is why the run reaps at the end, and why phase one shares
one worktree instead of taking one per ticket.

### Poll over REST, never GraphQL

`.claude/rules/the-review-gate.md` records a run that spent the whole 5000-point
GraphQL budget and blocked a status write. Every poll below uses REST.

`gh api repos/.../sub_issues`, `.../pulls`, `.../reviews`, `.../comments` and
`.../reactions` are REST. `scripts/project-status.sh` costs about one GraphQL
point per issue, dry run included, so read the board only when a worker is
`idle` or `done`.

## Preconditions

1. Validate that `$1` is a single positive integer. If it is not, stop and ask
   for `/ticket-flow <ticket-number>`.
2. Confirm that `HERDR_ENV=1`. If it is not, stop and explain that this command
   must run inside a Herdr-managed OpenCode pane.
3. Allow only one active run **per ticket**, not one run overall. Inspect
   `herdr agent list`. Stop only if an agent named `ticket-<n>-*` is already
   live for a ticket this run would touch, and name that agent.

   ```sh
   live=$(mktemp)
   names=$(mktemp)
   trap 'rm -f "$live" "$names"' EXIT

   herdr agent list > "$live" || { echo 'herdr agent list failed'; exit 1; }
   jq -r '.result.agents[] | .name // empty' "$live" > "$names" || {
     echo 'could not read the agent list'
     exit 1
   }

   if grep -qE "^ticket-${1}-" "$names"; then
     echo "a run is already live for ticket ${1}:"
     grep -E "^ticket-${1}-" "$names"
     exit 1
   fi
   echo "no live run for ticket ${1}"
   ```

   `herdr agent list` already prints JSON and takes no `--json` flag. Only a named
   agent carries a `name` key, so `.name // empty` skips the unnamed panes the
   user opened by hand. Read the names into a file and grep the file. A pipe would
   report grep's status, so a failed `herdr agent list` would read as "nothing
   live" and let a second run start on a ticket that already has one.

   Several `/ticket-flow` runs on different tickets are fine and expected. Their
   agent names carry the ticket number, so they never collide. Their panes are
   their own. `implement-next-ticket` gives each ticket its own git worktree, so
   they do not share a working tree either.

   Two runs do share one thing: the 5000-point hourly GraphQL budget. Only
   `scripts/project-status.sh` spends it here, at about a point per issue, so
   several runs cost little. Every poll in this command is REST.

   Check the queue too. Two parents can list the same child. If a ticket this run
   would queue is already live in another run, drop it from this queue and say so
   in the completion brief. Do not run Discovery on it twice.
4. The Codex GitHub App must be installed on `mightymoose/fortymm` with code
   review enabled. You cannot check this from here and you cannot install it.
   The Codex poll exits `32` when no review ever arrives, and that code names
   this prerequisite.

## The run's state

Keep three lists in your running notes and update them after every stage. They
are the whole control flow.

| List | Holds | Seeded with |
| --- | --- | --- |
| Queue | Tickets still needing Discovery and Planning, each with its depth | `$1` at depth `0` |
| Leaves | Tickets that reached **Ready For Implementation** | empty |
| Containers | Tickets that Planning decomposed | empty |

Carry a depth with every queued ticket. A child's depth is its parent's depth
plus one. Without it you cannot tell a runaway decomposition from a wide one.

Two caps guard the tree. Stop with `33` past either one.

- No ticket deeper than 3.
- At most 25 tickets in the run.

The run has two phases and they do not interleave. **Phase one empties the
queue.** **Phase two walks the leaves.** Expand the whole tree before you
implement anything, so the user sees the full shape of the work before the
first pull request opens.

## Resuming a cancelled run

**Run this first, every time, before phase one.** A `/ticket-flow` run is
resumable by construction: it holds no state of its own, and every fact it needs
is already on GitHub. Reconstruct that state and jump to the right phase.

Never restart a phase a ticket has already passed. A resumed run that re-enters
phase one on a ticket sitting in **Waiting For Sign Off** will try to drag it
back to **To Do**. That has happened.

The script walks the sub-issue tree from `$1`, then reports every ticket's true
position and where to resume it:

```sh
ROOT="${1:?usage: pass the root ticket number}"
REPO=mightymoose/fortymm
BOT=chatgpt-codex-connector

tree=$(mktemp); facts=$(mktemp); cols=$(mktemp)
trap 'rm -f "$tree" "$facts" "$cols"' EXIT

# 1. Walk the sub-issue tree, breadth first, depth-tagged. REST only.
printf '%s 0\n' "$ROOT" > "$tree"
depth=0
while [ "$depth" -lt 3 ]; do
  parents=$(awk -v d="$depth" '$2==d {print $1}' "$tree")
  [ -n "$parents" ] || break
  for pnum in ${=parents}; do
    kids=$(gh api "repos/$REPO/issues/$pnum/sub_issues" --paginate --jq '.[].number' 2>/dev/null) || kids=""
    for k in ${=kids}; do
      grep -qx "$k $((depth+1))" "$tree" || printf '%s %s\n' "$k" "$((depth+1))" >> "$tree"
    done
  done
  depth=$((depth+1))
done
tickets=$(awk '{print $1}' "$tree")

# 2. One batched board read for every ticket. Costs ~1 GraphQL point each.
scripts/project-status.sh --dry-run "To Do" ${=tickets} > "$cols" 2>&1 || true

# 3. Per ticket: children, column, PR, merged, codex verdict.
printf '%-7s %-6s %-24s %-6s %-7s %-9s %s\n' TICKET KIND COLUMN PR MERGED CODEX "RESUME AT"
while read -r n d; do
  kids=$(gh api "repos/$REPO/issues/$n" --jq '.sub_issues_summary.total' 2>/dev/null) || kids=0
  [ "${kids:-0}" -gt 0 ] && kind=container || kind=leaf

  col=$(sed -n "s/^→ #${n}: \"\([^\"]*\)\".*/\1/p" "$cols")
  [ -n "$col" ] || col='-'

  pr=''; merged='-'; verdict='-'
  if [ "$kind" = leaf ]; then
    cands=$(gh api "repos/$REPO/issues/$n/timeline" --paginate --jq \
      '.[] | select(.event=="cross-referenced" and .source.issue.pull_request != null)
           | .source.issue.number' 2>/dev/null) || cands=""
    for c in ${=cands}; do
      hit=$(gh api "repos/$REPO/pulls/$c" --jq \
        "select((.body // \"\") | test(\"(?i)(clos(e|es|ed)|fix(es|ed)?|resolv(e|es|ed))\\\\s+#${n}\\\\b\"))
             | \"\(.number) \(.merged)\"" 2>/dev/null) || hit=""
      [ -n "$hit" ] && { pr=${hit%% *}; merged=${hit##* }; }
    done
  fi

  if [ -n "$pr" ]; then
    : > "$facts"
    gh api "repos/$REPO/issues/$pr/reactions" --paginate --jq \
      ".[]|select(.user.login|startswith(\"$BOT\"))|{at:.created_at,kind:\"reaction\",text:.content}|@json" >> "$facts" 2>/dev/null
    gh api "repos/$REPO/pulls/$pr/reviews" --paginate --jq \
      ".[]|select(.user.login|startswith(\"$BOT\"))|{at:.submitted_at,kind:\"review\",text:.body}|@json" >> "$facts" 2>/dev/null
    gh api "repos/$REPO/pulls/$pr/comments" --paginate --jq \
      ".[]|select(.user.login|startswith(\"$BOT\"))|{at:.created_at,kind:\"inline\",text:.body}|@json" >> "$facts" 2>/dev/null
    verdict=$(python3 - "$facts" <<'PY'
import json,re,sys
v=[]
for line in open(sys.argv[1]):
    line=line.strip()
    if not line: continue
    r=json.loads(line); k=r["kind"]; t=r.get("text") or ""
    if k=="reaction":
        if t=="+1": v.append((r["at"] or "","PASS"))
    elif k=="inline": v.append((r["at"] or "","FINDINGS"))
    elif k=="review":
        if re.search(r"\bP[01]\b",t): v.append((r["at"] or "","FINDINGS"))
        elif t.strip(): v.append((r["at"] or "","PASS"))
print(sorted(v)[-1][1] if v else "NONE")
PY
)
  fi

  # 4. Derive the resume point. PR state outranks the board, always.
  if [ "$kind" = container ]; then
    at='phase 3/4 rollup (no PR of its own)'
  elif [ "$merged" = true ]; then
    at='nothing to run'
  elif [ -n "$pr" ] && [ "$verdict" = PASS ]; then
    at='phase 4 testing pass'
  elif [ -n "$pr" ] && [ "$verdict" = FINDINGS ]; then
    at='phase 2 repair round'
  elif [ -n "$pr" ]; then
    at='phase 2 codex review (post @codex review)'
  elif [ "$col" = "Ready For Implementation" ]; then
    at='phase 2 implementation'
  elif [ "$col" = "Ready For Planning" ]; then
    at='phase 1 planning'
  else
    at='phase 1 discovery'
  fi

  printf '%-7s %-6s %-24s %-6s %-7s %-9s %s\n' \
    "#$n" "$kind" "$col" "${pr:+#$pr}" "$merged" "$verdict" "$at"
done < "$tree"
```

It prints one row per ticket, for example:

```text
TICKET  KIND   COLUMN                   PR     MERGED  CODEX     RESUME AT
#1551   container Ready For Planning       -      -       -         phase 3/4 rollup (no PR of its own)
#1602   leaf   Waiting For Sign Off     #1626  false   PASS      phase 4 testing pass
#1603   leaf   Waiting For Sign Off     #1625  false   PASS      phase 4 testing pass
```

### How to read it

**Pull request state outranks the board column, always.** A card says what some
agent last wrote. A merged pull request says what actually happened.

| `RESUME AT` | What you do |
| --- | --- |
| `phase 1 discovery` | Put the ticket on the queue. Run Discovery, then Planning |
| `phase 1 planning` | Put the ticket on the queue. Skip Discovery |
| `phase 2 implementation` | Add to the leaves. It needs a worker and a pull request |
| `phase 2 codex review (post @codex review)` | Add to the leaves. The pull request exists but Codex has never answered. Enter the review loop at the trigger |
| `phase 2 repair round` | Add to the leaves. Codex's latest verdict has findings. Enter the review loop at the repair |
| `phase 4 testing pass` | Add to the leaves. Codex passed. Skip straight to testing |
| `nothing to run` | Merged. Confirm the card reads **Done** and move on |
| `phase 3/4 rollup` | A container. It never gets a worker. It follows its children |

### Then run the phases in order, skipping what is done

1. **Phase one** runs only for tickets whose row says `phase 1 ...`. If no row
   says that, the tree is already expanded. Skip phase one entirely, including
   the run worktree.
2. **Phase two** runs only for leaves whose row says `phase 2 ...`, entering the
   Codex loop at the point the row names.
3. **Phase three** moves any container whose children are all parked.
4. **Phase four** runs for every leaf whose row says `phase 4 testing pass`, in
   the order the tree produced, and for each leaf phase two just finished.

A run whose every row reads `phase 4 testing pass` is a normal resume, not an
error. Go straight to phase four. Do not re-expand the tree, do not re-implement,
and do not ask whether you should proceed.

### What resume never does

- It never moves a ticket backwards to re-run a stage that already completed.
- It never re-opens a pull request that exists, or opens a second one.
- It never re-runs Discovery on a ticket past **Ready For Planning**.
- It never treats a missing board column as proof that work is missing. Read the
  pull request.

A backwards move is legitimate only as a response to a finding. Codex asking for
changes sends a leaf back to a repair round. Planning bouncing a ticket sends it
to **To Do**. Neither of those is a resume decision, and resume makes neither.

## Phase one: empty the queue

Create the run's worktree first, with the snippet in **Every stage runs in a
worktree**. Every pane in this phase uses `$run_tree` as its `--cwd`.

Take one ticket off the queue at a time. Call it `T`. Run the four steps below
against `T`, then take the next ticket.

### Read the card first

Read the column with the snippet below. It prints the column and nothing else.

```sh
T=<the ticket>

card=$(scripts/project-status.sh --dry-run "To Do" "${T}" 2>&1) || {
  printf '%s\n' "$card"
  exit 1
}
current=$(printf '%s\n' "$card" \
  | sed -n "s/^→ #${T}: \"\([^\"]*\)\".*/\1/p")
printf 'ticket %s is in: %s\n' "${T}" "${current:-<not on the board>}"
```

**Never read the raw output of this command.** `--dry-run` prints
`→ #1551: "Waiting For Sign Off" → "To Do" (dry run)`, and that arrow reads like
an instruction to move the ticket to **To Do**. It is not. It is the probe target
echoed back, and the only part that means anything is the column on the left. The
`sed` above throws the arrow away so you never see it. This has already sent a
signed-off ticket back to **To Do**.

`--dry-run` is the first argument and is not optional. Without it this command
performs the move it is only supposed to describe.

Then skip a stage the ticket has already passed:

| Column | What you do |
| --- | --- |
| `To Do`, or not on the board | Run Discovery, then Planning |
| `Ready For Planning` | Skip Discovery. Run Planning |
| `Ready For Implementation` | Skip both. Add `T` to the leaves |
| `In Progress`, `In Review`, `Waiting For Sign Off`, `In Testing`, `Done` | Skip both. **Resuming a cancelled run** already placed this ticket. Do not queue it here |

This is what makes a re-run cheap. A run that stopped halfway does not redo
finished work.

### Discovery

1. Split a sibling pane in the current tab, preserving the current directory
   and user focus:

   ```sh
   split=$(herdr pane split --current --direction right --cwd "$run_tree" --no-focus)
   discovery_pane=$(printf '%s\n' "$split" | jq -r '.result.pane.pane_id')
   herdr pane zoom --pane "$discovery_pane" --on
   ```

2. Start a fresh Codex worker in auto mode in that pane. Use a unique name
   containing the ticket number:

   ```sh
   herdr agent start "ticket-${T}-discovery" --kind codex --pane "$discovery_pane" -- \
     --sandbox workspace-write --ask-for-approval on-request \
     -c sandbox_workspace_write.network_access=true \
     -m gpt-5.6-sol -c model_reasoning_effort=high
   ```

   Auto mode is `--sandbox workspace-write --ask-for-approval on-request`. The
   worker edits files and runs commands inside the workspace without an
   approval prompt. It still asks before it acts outside the workspace.

   `network_access=true` matters. Without it the sandbox refuses every `gh`
   call, and the worker asks the user to approve each retry. Discovery and
   Planning both read and write GitHub constantly, so that setting is the
   difference between a run the user watches and a run the user operates.

3. Prompt it to execute the repository's complete Discovery command for this
   issue, then confirm the worker took the turn:

   ```sh
   herdr agent prompt "ticket-${T}-discovery" \
     "Execute the complete Discovery workflow in .claude/commands/discover-next-ticket.md for GitHub issue #${T}. Work on this issue only."

   herdr agent wait "ticket-${T}-discovery" --until working --timeout 60000 || exit 22
   ```

   The handshake matters. Without it, a card another run already moved to
   `Ready For Planning` opens the gate before this worker writes anything.

4. Wait for Discovery. Run the command below with the bash tool's `timeout` set
   to `600000`, then follow the exit-code table. Exit `10` is the normal case
   for a long interview. Run the command again immediately and say nothing.

   ```sh
   deadline=$(( $(date +%s) + 540 ))
   unknown_all=1
   while :; do
     agent_status=$(herdr agent get "ticket-${T}-discovery" \
       | jq -r '.result.agent.agent_status')
     printf 'discovery agent: %s\n' "$agent_status"

     case "$agent_status" in
       blocked)
         echo 'the worker is waiting on the user in its own pane, keep waiting'
         unknown_all=0
         ;;
       unknown|null|'') ;;
       *) unknown_all=0 ;;
     esac

     if [ "$agent_status" = idle ] || [ "$agent_status" = done ]; then
       card=$(scripts/project-status.sh --dry-run "Ready For Planning" "${T}" 2>&1) || {
         printf '%s\n' "$card"
         exit 1
       }
       printf '%s\n' "$card"
       if grep -Fq "→ #${T}: \"Ready For Planning\"" <<<"$card"; then
         echo 'READY'
         exit 0
       fi
     fi

     if [ "$(date +%s)" -ge "$deadline" ]; then
       [ "$unknown_all" = 1 ] && { echo 'UNKNOWN: the worker state cannot be read'; exit 21; }
       echo 'STILL WAITING'
       exit 10
     fi
     sleep 20
   done
   ```

Both signals must hold in the same pass. The status alone is not enough. The
worker writes the status as its last command, so a status-only gate kills a
worker that is still writing the ticket. A `done` agent also releases the gate,
because a worker that exited cannot do more work.

The loop reads the agent first and the board second, so the card it reads is
never older than the `idle` it accepted. It reads the board only when the agent
is `idle` or `done`, because a board read while the worker is `working` or
`blocked` can never open the gate and `scripts/project-status.sh` spends
GraphQL budget this repo has exhausted before.

The loop holds the board output in `card`, not in `status`. In zsh, `status` is
a read-only parameter, so assigning to it kills the loop on its first pass.

### Handoff gate

The Discovery wait exited `0`, so the card reads `Ready For Planning` and the
Discovery agent is `idle` or `done`. Kill the Discovery worker by closing its
pane:

```sh
herdr pane close "$discovery_pane"
```

Herdr has no separate agent-kill command. Closing the pane ends the worker
process, so the Planning pane starts with no Discovery worker still running.

Any missing card or verification error stops the workflow and leaves the
Discovery pane open.

### Planning

1. Create a sibling pane with the same current directory and no focus change:

   ```sh
   split=$(herdr pane split --current --direction right --cwd "$run_tree" --no-focus)
   planning_pane=$(printf '%s\n' "$split" | jq -r '.result.pane.pane_id')
   ```

2. Start a fresh low-effort Codex worker in the same auto mode:

   ```sh
   herdr agent start "ticket-${T}-planning" --kind codex --pane "$planning_pane" -- \
     --sandbox workspace-write --ask-for-approval on-request \
     -c sandbox_workspace_write.network_access=true \
     -m gpt-5.6-sol -c model_reasoning_effort=low
   ```

3. Prompt it to execute the complete Planning command for the same issue, then
   confirm the worker took the turn:

   ```sh
   herdr agent prompt "ticket-${T}-planning" \
     "Execute the complete Planning workflow in .claude/commands/plan-next-ticket.md for GitHub issue #${T}. Work on this issue only."

   herdr agent wait "ticket-${T}-planning" --until working --timeout 60000 || exit 22
   ```

4. Wait for Planning. The same exit-code table and the same `timeout: 600000`
   apply. Planning ends in one of three board states, so this gate reads the
   agent only.

   ```sh
   deadline=$(( $(date +%s) + 540 ))
   unknown_all=1
   while :; do
     agent_status=$(herdr agent get "ticket-${T}-planning" \
       | jq -r '.result.agent.agent_status')
     printf 'planning agent: %s\n' "$agent_status"

     case "$agent_status" in
       idle|done) echo 'SETTLED'; exit 0 ;;
       blocked)
         echo 'the worker is waiting on the user in its own pane, keep waiting'
         unknown_all=0
         ;;
       unknown|null|'') ;;
       *) unknown_all=0 ;;
     esac

     if [ "$(date +%s)" -ge "$deadline" ]; then
       [ "$unknown_all" = 1 ] && { echo 'UNKNOWN: the worker state cannot be read'; exit 21; }
       echo 'STILL WAITING'
       exit 10
     fi
     sleep 20
   done
   ```

5. Close the Planning pane:

   ```sh
   herdr pane close "$planning_pane"
   ```

   The run loops, so every pane closes when its gate opens. A pane left open
   for each of twenty tickets makes the session unusable.

### Classify the Planning outcome

Exit `0` above means the worker ended its turn. It does not prove Planning
succeeded. Planning has three outcomes, and they need different next steps.
Read the board and the issue:

```sh
scripts/project-status.sh --dry-run "Ready For Implementation" "${T}"

gh api "repos/mightymoose/fortymm/issues/${T}" --jq \
  '{state, url: .html_url, children: .sub_issues_summary.total}'
```

| What you read | Outcome | What you do |
| --- | --- | --- |
| The card already reads `Ready For Implementation` | Executable | Add `T` to the leaves |
| `children` is greater than `0` | Decomposed | Add `T` to the containers. Push every child onto the queue |
| The card reads `To Do` | Planning bounced it | **stop** with `31`. Report what Planning wrote on the ticket |
| Anything else | Planning did not finish | **stop** with `1`. Report the card and the issue |

Read the children over REST. Never over GraphQL:

```sh
gh api "repos/mightymoose/fortymm/issues/${T}/sub_issues" --paginate --jq '.[].number'
```

Push the children onto the queue in the order this call returns them. Planning
creates them in dependency order and records that order in its planning-note
comment on the parent.

Children arrive in **To Do** carrying only a freeform body. Planning writes no
acceptance criteria for them. That is why the queue re-runs Discovery on each
child and not just Planning.

Push each child at its parent's depth plus one. Check both caps before you push.
Stop with `33` if the child's depth would exceed 3, or if the run would then hold
more than 25 tickets. Name the ticket and the cap that stopped you.

### Phase one ends

The queue is empty. Remove the run's worktree, because no pull request will ever
carry its branch and the reaper will therefore never collect it:

```sh
root=$(git rev-parse --show-toplevel)
git -C "$root" worktree remove "$root/.claude/worktrees/ticket-flow-run-${1}"
```

If that refuses because the tree is dirty, a worker wrote code in the wrong
phase. Read what changed before you force anything, and say so in the brief. Report the tree to the user before you open a single pull
request: every container, every leaf, and the order phase two will walk. Then
continue without waiting for an answer.

## Phase two: walk the leaves

Take one leaf at a time, in the order phase one produced. Call it `N`. Run
Implementation, then the Codex review, then move `N` to **Waiting For Sign Off**.
Only then take the next leaf.

One leaf at a time is the rule, because you are one coordinator and every wait
step below blocks you. It is not a working-tree constraint.
`implement-next-ticket` puts each ticket in its own worktree, which is why a
parallel run on another ticket is safe.

### Implementation

Create this leaf's worktree first, with the snippet in **Every stage runs in a
worktree**. Implementation, every repair round, and the phase-four testing pass
all run in it.

1. Split a pane and start an OpenCode worker on GLM 5.3 Flash:

   ```sh
   split=$(herdr pane split --current --direction right --cwd "$leaf_tree" --no-focus)
   impl_pane=$(printf '%s\n' "$split" | jq -r '.result.pane.pane_id')
   herdr pane zoom --pane "$impl_pane" --on

   herdr agent start "ticket-${N}-impl" --kind opencode --pane "$impl_pane" -- \
     -m openrouter/z-ai/glm-5.3-flash --auto
   ```

   `--auto` is OpenCode's approval mode. It is not Codex's sandbox. OpenCode does
   not sandbox by default, so there is no network flag to set and no containment
   either.

2. Prompt it, then confirm the worker took the turn:

   ```sh
   herdr agent prompt "ticket-${N}-impl" \
     "Execute the complete Implementation workflow in .claude/commands/implement-next-ticket.md for GitHub issue #${N}. Work on this issue only. You are already in a dedicated git worktree on this ticket's branch: work here, commit here, and create no worktree and no branch of your own. Never cd out of this directory."

   herdr agent wait "ticket-${N}-impl" --until working --timeout 60000 || exit 22
   ```

3. Wait. The same exit-code table and the same `timeout: 600000` apply. The gate
   needs two signals again: the agent settled, and a pull request exists.

   ```sh
   cands=$(mktemp)
   trap 'rm -f "$cands"' EXIT

   deadline=$(( $(date +%s) + 540 ))
   unknown_all=1
   while :; do
     agent_status=$(herdr agent get "ticket-${N}-impl" \
       | jq -r '.result.agent.agent_status')
     printf 'implementation agent: %s\n' "$agent_status"

     case "$agent_status" in
       blocked)
         echo 'the worker is waiting on the user in its own pane, keep waiting'
         unknown_all=0
         ;;
       unknown|null|'') ;;
       *) unknown_all=0 ;;
     esac

     if [ "$agent_status" = idle ] || [ "$agent_status" = done ]; then
       : > "$cands"
       gh api "repos/mightymoose/fortymm/issues/${N}/timeline" --paginate --jq \
         '.[] | select(.event == "cross-referenced"
                       and .source.issue.pull_request != null
                       and .source.issue.state == "open")
              | .source.issue.number' >> "$cands" || {
         echo 'the timeline query failed'
         exit 1
       }

       found=
       while read -r c; do
         [ -n "$c" ] || continue
         hit=$(gh api "repos/mightymoose/fortymm/pulls/$c" --jq \
           "select((.body // \"\") | test(\"(?i)(clos(e|es|ed)|fix(es|ed)?|resolv(e|es|ed))\\\\s+#${N}\\\\b\"))
                | {number, draft, url: .html_url, head: .head.ref} | @json") || {
           echo 'the pull request read failed'
           exit 1
         }
         [ -n "$hit" ] && found="$hit"
       done < "$cands"

       if [ -n "$found" ]; then
         printf '%s\n' "$found"
         echo 'PR FOUND'
         exit 0
       fi
       echo 'the agent settled but no open pull request closes this issue yet'
     fi

     if [ "$(date +%s)" -ge "$deadline" ]; then
       [ "$unknown_all" = 1 ] && { echo 'UNKNOWN: the worker state cannot be read'; exit 21; }
       echo 'STILL WAITING'
       exit 10
     fi
     sleep 20
   done
   ```

   Discover the pull request yourself. Do not read it out of the worker's pane.
   `implement-next-ticket` publishes no pull request number, and a flash-class
   worker's own account of what it did is not evidence. Git and pull request
   state outrank everything the worker says.

   Ask GitHub for its own link, then confirm it. The `timeline` endpoint is REST
   and it lists every pull request that cross-references the issue. A cross-
   reference alone is not proof, because a sibling child's pull request that
   merely mentions `#N` raises one too. So read each candidate and keep only the
   one whose body *closes* the issue.

   Do not match on the branch name. This repository has no branch convention.
   Seven recent pull requests used three different shapes, including
   `1601-notification-alert-race`, `fix/1583-stale-review-cta` and
   `ticket-1511-derived-date-range`. A branch match would silently find nothing
   and the gate would never open.

4. Close the pane:

   ```sh
   herdr pane close "$impl_pane"
   ```

5. Move the ticket to **In Review**:

   ```sh
   scripts/project-status.sh "In Review" "${N}"
   ```

   `implement-next-ticket` already writes this column as its last action. The
   script is idempotent, so the normal case costs one point and changes nothing.
   The write earns its place when the worker died after opening the pull request
   and before moving the card.

### Codex review, until it signs off

**This is a loop, not a step.** Trigger a review, poll for the verdict, and on
any finding repair it and trigger another. Keep going until Codex passes the
pull request. One round is never enough on its own, because a repair changes the
code Codex judged, and Codex may raise something new about the repair itself.

There are exactly two ways out, and moving on is only one of them:

| Way out | Condition |
| --- | --- |
| Move on to **Park the leaf** | Codex passed. Nothing else |
| **stop** and report | The round cap ran out, or Codex went silent, or a command failed |

Never park a leaf on a verdict you did not read. Never treat "the worker says it
addressed the comments" as a pass. Codex decides, every round, and it decides by
answering a trigger you posted after the repair landed.

Number your rounds. Round one starts here. Every repair starts the next one.

Ask for the review yourself. Do not rely on the App's automatic-review setting.

An explicit trigger gives two things the automatic setting cannot. It starts a
review for a repair round, not only for a new pull request. And its comment is
an anchor, so a later pass can tell this round's answer from the last round's.

Record the pull request number as `PR`. Post the trigger and keep its id and
timestamp:

```sh
anchor_json=$(gh api "repos/mightymoose/fortymm/issues/${PR}/comments" \
  -f body='@codex review' --jq '{id, at: .created_at}')
printf '%s\n' "$anchor_json"
COMMENT_ID=$(printf '%s' "$anchor_json" | jq -r '.id')
ANCHOR=$(printf '%s' "$anchor_json" | jq -r '.at')
```

Then poll. The same exit-code table and the same `timeout: 600000` apply.

```sh
PR=<the pull request number>
COMMENT_ID=<the trigger comment id>
ANCHOR=<the trigger comment timestamp>
REPO=mightymoose/fortymm
BOT=chatgpt-codex-connector

facts=$(mktemp)
trap 'rm -f "$facts"' EXIT

deadline=$(( $(date +%s) + 540 ))
while :; do
  : > "$facts"

  gh api "repos/$REPO/issues/comments/$COMMENT_ID/reactions" --paginate --jq \
    ".[] | select(.user.login | startswith(\"$BOT\"))
         | {kind: \"reaction\", at: .created_at, text: .content} | @json" >> "$facts" || exit 1
  gh api "repos/$REPO/issues/$PR/reactions" --paginate --jq \
    ".[] | select(.user.login | startswith(\"$BOT\"))
         | {kind: \"reaction\", at: .created_at, text: .content} | @json" >> "$facts" || exit 1
  gh api "repos/$REPO/pulls/$PR/reviews" --paginate --jq \
    ".[] | select(.user.login | startswith(\"$BOT\"))
         | {kind: \"review\", at: .submitted_at, text: .body} | @json" >> "$facts" || exit 1
  gh api "repos/$REPO/pulls/$PR/comments" --paginate --jq \
    ".[] | select(.user.login | startswith(\"$BOT\"))
         | {kind: \"inline\", at: .created_at, text: .body} | @json" >> "$facts" || exit 1

  verdict=$(ANCHOR="$ANCHOR" python3 - "$facts" <<'PY'
import json, os, re, sys

anchor = os.environ.get("ANCHOR") or ""
approved = changes = heard = False
review_bodies = []

for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    rec = json.loads(line)
    at = rec.get("at") or ""
    if anchor and at <= anchor:
        continue
    heard = True
    kind = rec["kind"]
    text = rec.get("text") or ""
    if kind == "reaction":
        if text == "+1":
            approved = True
    elif kind == "inline":
        changes = True
    elif kind == "review":
        review_bodies.append(text)

# Rule 3: a review body with no inline comments decides itself.
if not changes:
    for body in review_bodies:
        if re.search(r"\bP[01]\b", body):
            changes = True
        elif body.strip():
            approved = True

if changes:
    print("CHANGES")
elif approved:
    print("APPROVED")
elif heard:
    print("WORKING")
else:
    print("SILENT")
PY
)
  printf 'codex verdict: %s\n' "$verdict"

  [ "$verdict" = APPROVED ] && exit 0
  [ "$verdict" = CHANGES ] && exit 30

  if [ "$(date +%s)" -ge "$deadline" ]; then
    if [ "$verdict" = SILENT ]; then
      echo 'SILENT: no Codex reaction and no Codex review in a whole pass'
      exit 32
    fi
    echo 'STILL WAITING'
    exit 10
  fi
  sleep 20
done
```

The verdict rules, in order:

1. A `+1` reaction from the bot, on either reaction surface, means **approved**.
2. Any inline review comment from the bot means **changes requested**.
3. A review body with no inline comments decides itself. A body naming a `P0` or
   `P1` finding means changes requested. Any other non-empty body means approved.
4. An `eyes` reaction and nothing else means Codex is still working.
5. Nothing at all for a whole pass means Codex never heard the trigger.

Rule 3 stops a false repair round. Codex reacts 👍 when it finds nothing, but the
documentation does not promise that a clean pass posts no review at all. A repair
worker sent at a clean pull request finds nothing to fix and pushes nothing. Three
such rounds would burn the cap and stop the run on work Codex had already passed.

Rule 5 is why `32` exists. Codex reacts 👀 within seconds of the trigger. Nine
minutes of total silence is not a slow review. It means the App is not installed,
code review is off, or the App cannot see this repository.

Every surface is filtered to records strictly newer than the anchor. Without that
filter, round one's 👍 releases round two, and round one's findings send round two
back for a repair that was already done.

The reviews endpoint carries `submitted_at` and has no `created_at`. A plain
`.created_at` yields null for every review body and silently drops the surface a
review actually lands on.

The four `gh api` calls redirect to a file. They are never piped. A zsh pipeline
reports its last element's status, so a failed call inside one would read as
success and the poll would answer `SILENT` forever and stop a healthy run.

### Repair round, then back to the poll

Exit `30` means Codex asked for changes in **this** round. Collect what it said,
fix it, and ask again. This section always returns to the poll. It never returns
to phase two, and it never falls through to **Park the leaf**.

1. Read the findings newer than the anchor:

   ```sh
   gh api "repos/$REPO/pulls/$PR/reviews" --paginate --jq \
     ".[] | select((.user.login | startswith(\"$BOT\")) and .submitted_at > \"$ANCHOR\")
          | {at: .submitted_at, body}"
   gh api "repos/$REPO/pulls/$PR/comments" --paginate --jq \
     ".[] | select((.user.login | startswith(\"$BOT\")) and .created_at > \"$ANCHOR\")
          | {at: .created_at, path, line, body}"
   ```

2. Split a pane and start a fresh OpenCode worker on the same model:

   ```sh
   split=$(herdr pane split --current --direction right --cwd "$leaf_tree" --no-focus)
   fix_pane=$(printf '%s\n' "$split" | jq -r '.result.pane.pane_id')
   herdr pane zoom --pane "$fix_pane" --on

   herdr agent start "ticket-${N}-fix" --kind opencode --pane "$fix_pane" -- \
     -m openrouter/z-ai/glm-5.3-flash --auto
   ```

   A fresh worker every round. Never reuse the implementation worker. Its pane is
   already closed, and a worker that has been reading its own output for an hour
   is the one most likely to repeat the mistake Codex just named.

3. Prompt it with the findings verbatim. It already stands in this leaf's
   worktree, on the pull request's branch, so tell it to work there and never
   `cd` out. Tell it to address every finding, run that layer's own verification,
   commit, and push to the same branch. Tell it to open no new pull request and
   to create no worktree. Then confirm the turn:

   ```sh
   herdr agent wait "ticket-${N}-fix" --until working --timeout 60000 || exit 22
   ```

4. Wait on the agent only, with the same table and the same `timeout: 600000`.
   Use the Planning wait loop, with `ticket-${N}-fix` as the target.

5. Close the pane:

   ```sh
   herdr pane close "$fix_pane"
   ```

6. Post a fresh `@codex review` comment. Its id and timestamp replace `COMMENT_ID`
   and `ANCHOR`. **Increment the round number and go back to the poll.**

   The fresh anchor is what makes the next round readable. Without it the poll
   re-reads the findings you just fixed and sends the same repair back forever.

Repeat this section as many times as Codex asks. Two rounds is ordinary. A
finding that only appears in round three is still a finding, and it is exactly
the kind a first pass misses.

Cap the rounds at 5 for one pull request. Past the cap, **stop** and report under
`.claude/rules/escalation.md`. Name the pull request, the findings that survived,
and every round you ran. Leave the ticket in **In Review**.

The cap is a stop, never a pass. A capped pull request has not been signed off,
so it does not reach **Waiting For Sign Off**, and phase four never sees it.

### Park the leaf

You arrive here only from a Codex poll that exited `0` in the round you just ran.
Check that before you write the column. If the last code you read was `30`, you
are in the wrong section: go back and run another repair round.

Move the ticket and take the next leaf:

```sh
scripts/project-status.sh "Waiting For Sign Off" "${N}"
```

## Phase three: the containers

Every leaf now sits in **Waiting For Sign Off**. Move every container there too,
including `$1` when Planning decomposed it:

```sh
scripts/project-status.sh "Waiting For Sign Off" <container> [<container> ...]
```

A container holds no code. It never gets a worker and it never gets a pull
request. This write is the only thing that puts one in the column.

Codex has now signed off on the root ticket and on every child. Report the whole
tree to the user, then start phase four at once. Nothing is waiting on a person.

## Phase four: test and merge, in order

Testing runs one ticket at a time, in merge order, each in its own Claude Code
pane. One pane and one testing pass per ticket. Never two at once.

### The order is merge order

Walk the leaves in the order phase one produced. That is sub-issue order, which
Planning writes in dependency order and records in its planning-note comment on
the parent.

Order matters here in a way it did not in phase two. Phase two only opened pull
requests. Phase four merges them, so a leaf that another leaf depends on must
merge first.

### No gate here, because Codex already opened it

Phase two never parks a leaf until Codex passes it, so every leaf phase four sees
has already cleared the only gate this arc has. There is nothing to wait for and
nobody to ask.

Do not poll for a human `LGTM`. `test-next-ticket` no longer requires one, and
neither does this command. **Waiting For Sign Off** is a signpost now, not a gate.
It records that Codex passed and that the leaf is queued for testing.

Re-read Codex's verdict once before you start the worker. Run the phase-two poll
against this leaf's pull request with an empty anchor, so it reads the latest
verdict rather than one round's answer:

| Verdict | What you do |
| --- | --- |
| `PASS` | Continue to the testing pass |
| `FINDINGS` | Something landed after Codex signed off. Go back to the repair round |
| `SILENT` | No verdict at all. **stop** with `32` |

That re-read is cheap, and it is the only thing standing between a push that
arrived after sign-off and a merge nobody reviewed.

### Release the ticket

```sh
scripts/project-status.sh "In Testing" "${N}"
```

### Run the testing pass

This leaf's worktree already exists from phase two. Re-run the leaf-worktree
snippet anyway. It is idempotent, and a resumed run may not have created it.

1. Split a pane and start a Claude Code worker:

   ```sh
   split=$(herdr pane split --current --direction right --cwd "$leaf_tree" --no-focus)
   test_pane=$(printf '%s\n' "$split" | jq -r '.result.pane.pane_id')
   herdr pane zoom --pane "$test_pane" --on

   herdr agent start "ticket-${N}-test" --kind claude --pane "$test_pane" -- \
     --permission-mode auto
   ```

   Pass no `--model`. `test-next-ticket` carries `model: sonnet` in its own
   frontmatter, and a session-level override would silently undo the repository's
   frontier-plans and sonnet-implements split.

2. Prompt it, then confirm the worker took the turn:

   ```sh
   herdr agent prompt "ticket-${N}-test" \
     "You are in a dedicated git worktree on this ticket's branch. Work here and never cd out of it. First bring the branch up to date with origin/main and push, because earlier tickets in this run have merged since the branch was cut. Then run /test-next-ticket ${N}."

   herdr agent wait "ticket-${N}-test" --until working --timeout 60000 || exit 22
   ```

   The re-sync is not optional. Each leaf branched from `main` before its siblings
   merged. A green QA pass and a green CI run against a base that has since moved
   are not evidence about the merge. `test-next-ticket` waits for CI itself, so it
   will catch what the re-sync exposes.

3. Wait on the agent, then confirm the outcome independently. Use the Planning
   wait loop with `ticket-${N}-test` as the target, then read the board and the
   pull request:

   ```sh
   scripts/project-status.sh --dry-run "Done" "${N}"
   gh api "repos/mightymoose/fortymm/pulls/${PR}" --jq '{merged, state, url: .html_url}'
   ```

   The card reads `Done` and `merged` is `true`, so the pass succeeded. Anything
   else means it did not. `test-next-ticket` stops on a real QA failure rather
   than merging, which is the behaviour you want. Report what it found and stop.
   Do not start the next leaf on top of a failed one.

4. Close the pane:

   ```sh
   herdr pane close "$test_pane"
   ```

Then take the next leaf and return to the verdict re-read above.

### The containers reach Done

Every leaf is merged and `Done`. A container has no pull request, so nothing
merges it. Move each one now, deepest first:

```sh
scripts/project-status.sh "Done" <container> [<container> ...]
```

Close each container issue if that is the repository's convention, the same way
`test-next-ticket` closes a leaf.

### Collect the garbage

Whoever merges cleans up. This run merged, so this run reaps. Read first, then
act:

```sh
root=$(git rev-parse --show-toplevel)
cd "$root" || exit 1

scripts/reap-worktrees.sh
scripts/reap-worktrees.sh --force
```

Stand in the main checkout before you reap. The script never removes the worktree
you are standing in, so reaping from inside a leaf's worktree silently leaves that
leaf behind.

It only removes a worktree whose branch has a **merged** pull request, and only
when nothing would be lost. A leaf that phase four merged qualifies. A leaf that
stopped short does not, and stays for you to inspect.

Confirm the run's own worktree is gone too. Phase one removed it, so this is a
check, not a second removal:

```sh
git -C "$root" worktree list
```

Never pass `--docker`, and never run `docker system prune -a` or
`docker volume prune`. This command starts no containers, so it has none to
collect, and a blanket prune destroys the unattached `fortymm-uat_postgres-data`
volume and the k3d `tailscale-state` secrets.

## What this command does not do

It asks no human for permission. Codex is the reviewer, and its 👍 is what moves
a leaf from **In Review** to **Waiting For Sign Off** and on into Testing. Nothing
in this arc waits for a person, so nothing in it stalls overnight.

That is a deliberate change from how this repository used to work.
`.claude/rules/the-review-gate.md` describes a human gate that
`implement-ticket-end-to-end` still holds for its own arc. **This command does not
use it, and neither does `test-next-ticket` any more.** Do not reintroduce an
`LGTM` poll here on the strength of that file.

The trade is real and worth naming. No person sees the diff between Planning and
merge. Codex's verdict is the only review, the repair loop is the only correction,
and `qa-review` inside `test-next-ticket` is the only behavioural check. If that
is too thin for a given change, do not run it through this command.

It does merge, in phase four, but never itself. `test-next-ticket` merges, moves
the ticket to **Done**, and cleans up after its own run. The coordinator only
opens the gate column and starts the worker.

## Completion brief

Report concisely:

- The root issue number and its GitHub URL.
- The tree: every container and every leaf, with the order phase two walked.
- For each leaf: its pull request URL, the Codex verdict, and how many repair
  rounds it took.
- For each leaf: whether it merged, and the ticket's final column.
- The final board column of every ticket the run touched.
- Every Herdr agent name and pane ID the run used, and confirmation that each
  pane was closed.
- Every worktree the run created, and whether it was reaped or deliberately kept.
- Any blocker or manual follow-up required, and for a **stop** code, the pane
  left open for the user to inspect.
