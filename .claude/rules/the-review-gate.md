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

## What each side does with it

- **`implement-ticket-end-to-end`** watches for the signal for a bounded 15 minutes after
  Review stops, over the **since-the-anchor** window. On release it moves the ticket to
  **In Testing** and invokes `test-next-ticket`. On any other comment from `mightymoose` newer
  than the anchor it re-invokes `review-next-ticket` in targeted mode. On expiry it stops and
  reports.
- **`test-next-ticket`** re-runs this same check as a **precondition**, over the **ever**
  window, and refuses to run without it. That refusal is the gate's only enforcement outside
  the coordinator, and it is what makes the gate hold when someone runs the stage by hand. A
  rule that lives only in the coordinator's prose is not a gate.

It is a precondition check, not a status transition. `test-next-ticket` does not move the
ticket to satisfy it.
