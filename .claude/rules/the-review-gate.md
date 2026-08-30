# The review gate

**This file defines one signal, and it now has exactly one consumer.**

`implement-ticket-end-to-end` holds a human review gate: a ticket in that arc reaches Testing
because a human said so, on the pull request. Everything below defines that signal, so the
coordinator and `review-next-ticket` do not keep two prose copies that drift.

**`test-next-ticket` no longer enforces it.** Its Testing precondition is now a passing Codex
review, read as Codex's *latest* verdict, and that check lives in `test-next-ticket.md` itself.
`/ticket-flow` asks Codex for that review and waits for it. Neither command reads this file.

So a `LGTM` here is a coordination signal inside one arc, not a repository-wide gate on
merging. Do not cite this file as a reason to add an `LGTM` poll anywhere else.

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
| `implement-ticket-end-to-end` watch | **Since the anchor** | Has a *new* decision arrived since the round I just posted? |

There used to be a second consumer, `test-next-ticket`, reading an **ever** window. It now
gates on Codex instead, so the anchored window below is the only one this file still defines.

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

The ask always exists before the column points at it: Review posts the comment, and the
coordinator moves the column only after Review reports it. If the move fails, the human still
has the ask.

## What each side does with it

- **`review-next-ticket`** posts the decision comment, reports its timestamp, and stops. It
  moves no columns, in any mode. In a Testing repair round it posts no decision comment
  either, because that round is a repair inside Testing, not a fresh request to release.
- **`implement-ticket-end-to-end`** moves the ticket to **Waiting For Sign Off** after
  `review-next-ticket` reports its decision comment, then watches for the signal for a
  bounded 15 minutes over the **since-the-anchor** window. On release it moves the ticket to
  **In Testing** and invokes `test-next-ticket`. On any other comment from `mightymoose` newer
  than the anchor it moves the ticket to **In Progress**, re-invokes `review-next-ticket` in
  targeted mode, and moves the ticket back to **Waiting For Sign Off** when that round reports
  its fresh decision comment. On expiry it stops and reports, leaving the ticket in
  **Waiting For Sign Off**.
- **`test-next-ticket`** does not read this file at all. It refuses without a passing **Codex**
  review, checked against Codex's latest verdict. That refusal is what makes a Testing gate
  hold when someone runs the stage by hand, and a rule that lives only in a coordinator's
  prose is still not a gate. The actor changed. The principle did not.

Every gate column is the coordinator's write: **Waiting For Sign Off**, the **In Progress**
bounce-back, and **In Testing**. Review posts comments and the coordinator moves the ticket.
One writer for every transition.

A precondition is a check, not a status transition. Neither gate moves a ticket to satisfy
itself, and neither accepts a board column as a substitute for the thing it actually reads.
