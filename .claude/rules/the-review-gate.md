# The review gate

A ticket does not reach Testing because an agent reviewed it. It reaches Testing because
**a human said so, on the pull request.** This file is the single definition of that signal.
`implement-ticket-end-to-end` watches for it and `test-next-ticket` refuses without it. Both
reference this file, and neither restates the rule, because two prose copies drift.

## Why a comment, and not an approval

`implement-next-ticket` opens the pull request as `mightymoose`, and GitHub refuses a
self-approval. A bare GitHub approval is therefore unreachable on this repo, so the signal
has to be a comment.

## The signal

**A comment authored by `mightymoose` whose whole body normalizes to `lgtm`.**

Normalize by trimming leading and trailing whitespace, lowercasing, and stripping trailing
punctuation. `Lgtm`, `LGTM`, and `lgtm.` all release the gate. A real signal has arrived as
the four characters `Lgtm`.

Nothing else releases it:

| Not a signal | Why |
| --- | --- |
| `LGTM but fix line 40` | A change request. Whole-body equality, never a substring match, is what keeps it in the repair loop |
| `lgtm` from any other author | This repo runs agents that comment on pull requests. An agent must never release its own gate |
| A 👍 reaction | Reactions are not comments and are not read |
| A GitHub approval with no comment | Unreachable here, see above — and not read either |

Strictness is the point. A gate that guesses at intent is not a gate.

## The three surfaces are three REST calls

A comment can arrive on any of three surfaces, and they are **different endpoints**:

| Surface | Endpoint |
| --- | --- |
| Plain issue comment | `repos/{owner}/{repo}/issues/{pr}/comments` |
| Review body | `repos/{owner}/{repo}/pulls/{pr}/reviews` |
| Inline review comment | `repos/{owner}/{repo}/pulls/{pr}/comments` |

**Read all three.** `gh pr view --json comments` returns only the first, and a human reviewing
in the GitHub UI lands on the second by default — so a watch built on it reports "no signal" on
a gate that was released hours ago, and parks until its budget expires. This has happened: the
issue-comments surface held two comments, neither of them the signal, while the review body
held `Lgtm`.

Poll over **REST**, not GraphQL. A 15-minute watch that polls the project board burns the
GraphQL budget — a single run has exhausted all 5000 points and blocked a status write. The three
endpoints above and `gh pr view` are REST. `gh project item-*` is GraphQL only.

## Two windows over the same signal

The two consumers ask different questions, and conflating them breaks the gate in both
directions.

| Consumer | Window | Question |
| --- | --- | --- |
| `test-next-ticket` precondition | **Ever** | Has this pull request ever carried the signal? |
| `implement-ticket-end-to-end` watch | **Since the anchor** | Has a *new* decision arrived since the round I just posted? |

The precondition is deliberately "ever". A ticket that was released, went to Testing, failed,
and came back through a repair round must still satisfy it — the human already released this
work, and re-asking on every repair is not what the gate is for.

The watch is deliberately "since". **The anchor is the decision comment the round just posted.**
`review-next-ticket` reports that comment's timestamp; the coordinator carries it into the
watch; each targeted round replaces it with its own fresh decision comment.

Without an anchor the watch reads every comment ever posted, and two failures follow, both of
which contradict the rules above:

- **The targeted loop never ends.** "Fix line 40" sends the work back for a targeted round; the
  watch restarts, re-reads the same comment, and sends it back again. Forever.
- **A stale `LGTM` releases a later round.** The signal from round one is still on the pull
  request, so round two's watch releases immediately, with no human having looked at round
  two. That is the bypass "nothing else releases the gate" exists to prevent.

## The check

```bash
PR_NUMBER=<the pull request number>
REPO=mightymoose/fortymm
REVIEWER=mightymoose
SINCE=            # empty for the "ever" window; the anchor timestamp for the watch

BODIES="$(mktemp)"
trap 'rm -f "$BODIES"' EXIT

# `(.created_at // .submitted_at)`: the reviews endpoint carries `submitted_at` and has no
# `created_at` at all. A plain `.created_at` yields null for every review body — silently
# discarding the surface a UI review actually posts to.
for ep in "issues/$PR_NUMBER/comments" "pulls/$PR_NUMBER/reviews" "pulls/$PR_NUMBER/comments"; do
  gh api "repos/$REPO/$ep" --paginate --jq \
    ".[] | select(.user.login==\"$REVIEWER\")
         | {at: (.created_at // .submitted_at), body: .body} | @json" >> "$BODIES"
done

SINCE="$SINCE" python3 - "$BODIES" <<'PY'
import json, os, sys
since = os.environ.get("SINCE") or ""
released = False
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    rec = json.loads(line)
    if since and (rec["at"] or "") <= since:
        continue
    if (rec["body"] or "").strip().lower().rstrip(".!?,;: ") == "lgtm":
        released = True
print("RELEASED" if released else "WAITING")
PY
```

`mktemp`, never a fixed path. This repo runs many agent sessions at once, and two coordinators
watching two pull requests would otherwise clobber the same file — and one could read the
other's comments and release the wrong gate.

Redirect to a file rather than piping the three calls straight into `python3`. A zsh pipeline
reports its **last** element's status, so a failed `gh api` inside one reads as success and the
gate silently answers `WAITING` forever. See `.claude/rules/verify-the-artifact-under-test.md`.

GitHub timestamps are ISO-8601 UTC with a fixed width, so a string comparison orders them
correctly. Use `>`, strictly after, so the anchor comment can never match itself.

## The column that shows the gate is open

A ticket awaiting this signal sits in **Waiting For Sign Off**. The column exists so a human can
find the work without an agent's report in front of them, and so a ticket does not look like it
is still being worked while it is really waiting on a person.

The comment is the gate. The column is only its signpost. So the column never releases anything,
and it never holds anything shut — the check above reads comments, and only comments. A ticket in
the wrong column with a real `LGTM` on its pull request has been released. A ticket in
**Waiting For Sign Off** with no `LGTM` has not.

Post the ask before moving the column. If the move fails, the human still has the ask.

## What each side does with it

- **`review-next-ticket`** posts the decision comment, then moves the ticket to
  **Waiting For Sign Off**. In targeted mode it moves the ticket to **In Progress** first,
  because a change request means the work is being done again, and back to
  **Waiting For Sign Off** when it posts the next round's ask. It never sets **In Testing**.
- **`implement-ticket-end-to-end`** watches for the signal for a bounded 15 minutes after
  Review stops, over the **since-the-anchor** window. On release it moves the ticket to
  **In Testing** and invokes `test-next-ticket`. On any other comment from `mightymoose` newer
  than the anchor it re-invokes `review-next-ticket` in targeted mode, and lets that command
  write both columns. On expiry it stops and reports, leaving the ticket in
  **Waiting For Sign Off**.
- **`test-next-ticket`** re-runs this same check as a **precondition**, over the **ever**
  window, and refuses to run without it. That refusal is the gate's only enforcement outside
  the coordinator, and it is what makes the gate hold when someone runs the stage by hand. A
  rule that lives only in the coordinator's prose is not a gate.

**In Testing** is the coordinator's write. **Waiting For Sign Off** and the **In Progress**
bounce-back are Review's. One transition, one owner.

The precondition is a check, not a status transition. `test-next-ticket` does not move the
ticket to satisfy it, and it does not accept a board column as a substitute for the comment.
