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
punctuation. `Lgtm`, `LGTM`, and `lgtm.` all release the gate. #1044's real signal was the
four characters `Lgtm`.

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

**Read all three.** `gh pr view --json comments` returns only the first, and #1044's signal
arrived as a review body — so a watch built on it reports "no signal" on a gate that was
released hours ago, and parks until its budget expires. Verified on PR #1358: the issue-comments
surface holds two comments and neither is the signal; the review body holds `Lgtm`.

Poll over **REST**, not GraphQL. A 15-minute watch that polls the project board burns the
GraphQL budget — #1044's run exhausted all 5000 points and blocked a status write. The three
endpoints above and `gh pr view` are REST. `gh project item-*` is GraphQL only.

## The check

```bash
PR_NUMBER=<the pull request number>
REPO=mightymoose/fortymm
REVIEWER=mightymoose

{ gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate \
    --jq ".[] | select(.user.login==\"$REVIEWER\") | .body | @json"
  gh api "repos/$REPO/pulls/$PR_NUMBER/reviews" --paginate \
    --jq ".[] | select(.user.login==\"$REVIEWER\") | .body | @json"
  gh api "repos/$REPO/pulls/$PR_NUMBER/comments" --paginate \
    --jq ".[] | select(.user.login==\"$REVIEWER\") | .body | @json"
} > /tmp/gate-bodies.jsonl

python3 - /tmp/gate-bodies.jsonl <<'PY'
import json, sys
released = False
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    body = json.loads(line) or ""
    if body.strip().lower().rstrip(".!?,;: ") == "lgtm":
        released = True
print("RELEASED" if released else "WAITING")
PY
```

Redirect to a file rather than piping the three calls straight into `python3`. A zsh pipeline
reports its **last** element's status, so a failed `gh api` inside one reads as success and the
gate silently answers `WAITING` forever. See `.claude/rules/verify-the-artifact-under-test.md`.

## What each side does with it

- **`implement-ticket-end-to-end`** watches for the signal for a bounded 15 minutes after
  Review stops. On release it moves the ticket to **In Testing** and invokes `test-next-ticket`.
  On any other comment from `mightymoose` it re-invokes `review-next-ticket` in targeted mode.
  On expiry it stops and reports.
- **`test-next-ticket`** re-runs this same check as a **precondition** and refuses to run
  without it. That refusal is the gate's only enforcement outside the coordinator, and it is
  what makes the gate hold when someone runs the stage by hand. A rule that lives only in the
  coordinator's prose is not a gate.

It is a precondition check, not a status transition. `test-next-ticket` does not move the
ticket to satisfy it.
