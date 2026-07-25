# Architecture Decision Records

**New ADRs are named `YYYYMMDD-slug.md`** — the date the decision was made, then
the decision itself in lowercase hyphenated words. Example:
`20260722-the-mcp-server-is-an-oauth-resource-server-trusting-auth0.md`.

Format and "when is a decision worth an ADR" live in
`.claude/skills/domain-modeling/ADR-FORMAT.md`.

## Why dates and not `0019-`, `0020-`, …

This directory used to say "scan for the highest number and increment". That
produced **seven duplicated numeric prefixes**, including four different
`0008-*.md` files, because work happens in parallel worktrees: each one numbers
off a `main` that has already moved on, so two branches confidently pick the
same next number and both land. Issue-number prefixes (`0783-`, `0915-`) collide
for the same reason whenever one issue yields several ADRs.

A calendar date is assigned by the world instead of raced for, so it cannot
collide by construction. Several ADRs may share a date — that's fine and already
the case; the slug is what identifies the decision.

## The legacy files stay put

The existing `NNNN-` ADRs are **not** being renumbered: their numbers are cited
from PR bodies and commit messages, and renaming would break those references.
They are grandfathered forever.

The corollary: **refer to an ADR by its full filename, never by a bare number.**
"ADR 0008" is ambiguous — there are four.

## The CI check

`scripts/check-adr-numbering.sh` runs in CI (the `adr-numbering` job in
`.github/workflows/openapi-schema.yml`). It inspects only the ADRs a branch
*adds* versus `origin/main`, so it can never fail on the legacy names.

**It reports, it does not block** — `adr-numbering` is deliberately not in the
branch-protection required contexts, so a badly-named ADR shows a red check
while the merge still proceeds. Treat it as a prompt to rename, not a gate. (Add
`adr-numbering` to the required contexts if you want it blocking; it is a
one-second check, so there is no cost argument against it.)

Run it locally the same way:

```bash
scripts/check-adr-numbering.sh            # vs origin/main
scripts/check-adr-numbering.sh <base-ref>
```
