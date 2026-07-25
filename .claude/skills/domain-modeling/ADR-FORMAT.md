# ADR Format

ADRs live in `docs/adr/` and are **date-prefixed**: `YYYYMMDD-slug.md` — e.g.
`20260722-the-mcp-server-is-an-oauth-resource-server-trusting-auth0.md`.

Create the `docs/adr/` directory lazily — only when the first ADR is needed.

## Template

```md
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

That's it. An ADR can be a single paragraph. The value is in recording *that* a decision was made and *why* — not in filling out sections.

## Optional sections

Only include these when they add genuine value. Most ADRs won't need them.

- **Status** frontmatter (`proposed | accepted | deprecated | superseded by ADR-NNNN`) — useful when decisions are revisited
- **Considered Options** — only when the rejected alternatives are worth remembering
- **Consequences** — only when non-obvious downstream effects need to be called out

## Naming — date prefix, never a sequential number

**`docs/adr/YYYYMMDD-slug.md`.** The date is the date the decision was made;
the slug is lowercase words joined by hyphens, and should read as the decision
itself ("a-null-player-cap-means-no-cap"), not as a topic.

**Do not scan for "the highest number and increment".** That is what this repo
used to say, and it produced ten duplicated prefixes — including four different
`0008-*.md` files — because every worktree numbers off a `main` that has already
moved on, and two agents working in parallel both pick the same "next" number.
Issue numbers (`0783-`, `0915-`) collide the same way when one issue produces
several ADRs. A calendar date is assigned by the world rather than raced for, so
it cannot collide by construction; several ADRs may legitimately share one date,
and the slug distinguishes them.

The legacy `NNNN-` ADRs stay as they are — their numbers are cited from PR
bodies and commit messages, so renaming them would break those links. Refer to
any ADR by its **full filename**, not by a bare number.

`scripts/check-adr-numbering.sh` enforces this on new files in CI (it only ever
looks at ADRs a branch *adds*, so the legacy names are grandfathered).

## When to offer an ADR

All three of these must be true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will look at the code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If a decision is easy to reverse, skip it — you'll just reverse it. If it's not surprising, nobody will wonder why. If there was no real alternative, there's nothing to record beyond "we did the obvious thing."

### What qualifies

- **Architectural shape.** "We're using a monorepo." "The write model is event-sourced, the read model is projected into Postgres."
- **Integration patterns between contexts.** "Ordering and Billing communicate via domain events, not synchronous HTTP."
- **Technology choices that carry lock-in.** Database, message bus, auth provider, deployment target. Not every library — just the ones that would take a quarter to swap out.
- **Boundary and scope decisions.** "Customer data is owned by the Customer context; other contexts reference it by ID only." The explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** "We're using manual SQL instead of an ORM because X." Anything where a reasonable reader would assume the opposite. These stop the next engineer from "fixing" something that was deliberate.
- **Constraints not visible in the code.** "We can't use AWS because of compliance requirements." "Response times must be under 200ms because of the partner API contract."
- **Rejected alternatives when the rejection is non-obvious.** If you considered GraphQL and picked REST for subtle reasons, record it — otherwise someone will suggest GraphQL again in six months.
