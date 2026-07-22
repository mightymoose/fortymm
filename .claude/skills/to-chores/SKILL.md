---
name: to-chores
description: Break an agreed plan into a work order of small, agent-tagged chores grouped under tracer-bullet slices, for the domain-expert subagents to implement. Decompose-only — writes the work order and stops; run /do-chores to drive it.
argument-hint: "[optional path to a plan/PRD/issue, else uses the plan in context]"
---

# To Chores

Shard an agreed plan into a **work order**: a checkbox to-do list of **chores**,
each small enough to hand to one domain-expert subagent, grouped under
**tracer-bullet** slices. This skill **decomposes only** — it writes the work
order and stops. `/do-chores` drives it; `/land-the-plane` ships it.

A **chore** is the atomic unit of work: one agent, one tree, one sitting. A
**tracer bullet** is a thin vertical slice that cuts through every layer it needs
end-to-end and is demoable on its own. Slices are the unit of "done"; chores are
the unit of hand-off.

## Prerequisite

There must be an **agreed plan** — in the conversation, or at a path passed as an
argument. Decomposition without a plan is guesswork; if there's neither, stop and
tell the user to plan first (e.g. `/grill-with-docs`).

## Process

### 1. Gather

Work from the plan in context. If the user passed a path (a PRD, a plan doc in
`docs/designs/`, an issue ref), read it in full. Either way, scan the repo's durable
decision docs — `CONTEXT.md` (glossary), `docs/adr/` (ADRs), `CONTEXT-MAP.md` if
present — so chores can point at the decisions they depend on.

Note the **GitHub issue number(s)** this arc closes — the source issue if the plan
came from one, plus any others the plan explicitly resolves. These go in the work
order's `Tickets:` header (`—` if none) so `/do-chores` can move their project-board
cards to *In Progress* and `/epic` to *Done*. If it's ambiguous which issues the arc
closes, ask the user rather than guessing.

### 2. Discover the agents

List `.claude/agents/*.md` and read each one's `name` + `description`. Those
`name`s are the only valid **agent tags** (plus `[main]` for the driver itself).
Do not hardcode the roster — read it, so this skill doesn't rot when agents
change. Each chore is assigned to exactly one tag; match the chore's tree to the
agent that owns it (per the delegation table in the root `CLAUDE.md`).

### 3. Explore the codebase

Explore enough to know which **surfaces** each change touches and which agent owns
each. Note any prefactor that would make a chore smaller or a slice cleaner —
"make the change easy, then make the easy change"; a prefactor is itself a chore.

### 4. Cut tracer-bullet slices

Break the plan into thin vertical slices, each demoable/verifiable on its own.
Give each a one-line **demoable outcome** ("Player sees their rating on the
profile page"). A slice usually spans multiple trees — that's expected; the chores
inside it split the work per agent.

### 5. Shard each slice into chores

Within a slice, cut one chore per agent-tree, in dependency order, and insert an
explicit `[main]` chore at **every cross-layer seam** — most importantly the
OpenAPI regen (`mise run regen-api-types` + `mise run regen-ios-api-types`) after
any `api` chore that changes a route/schema/docstring, which must complete before
the `web-client`/`ios` chores that consume the new types. Wire `depends-on` by
chore ID.

Every chore must pass the **four-part gate** — split it until all four hold:

1. **One agent, one tree** — needs two agents ⇒ split.
2. **One surface, no "and"** — the "what to build" line names a single
   behavior/surface without conjoining two.
3. **Independently verifiable** — has a concrete `Verify` command that goes green
   when the chore is done, a `Proves` line naming the observable claim that green
   command establishes, **and** a `Demo` showing how to watch it work. If you cannot
   write a falsifiable `Proves` sentence, the chore isn't a chore yet — it has no
   definition of done. "The tests pass" is not a claim; "a late-joining cascade
   user's replayed rating matches a from-scratch replay" is. A chore with no `Demo`
   is usually a fragment: fold it into the chore that makes it observable.
4. **Fits one context window** — if the agent would have to read a large slice of
   the codebase to do it, it's too big; split it, or point it at an ADR that
   already carries the decision.

Prefer a `Verify` that *fails before the chore and passes after*. A command that was
already green tells you nothing — say so in `Proves` when the chore adds the very
test that makes it meaningful.

Describe each chore as **behavior + surface, never hard file paths** (they go
stale; the agent is a domain expert and auto-loads its unit `CLAUDE.md`). Inline a
snippet only when it encodes a decision prose can't (a type shape, a schema).

### 6. Write the testing notes

Draft a `## Testing notes` section for the whole plan: the **black-box, user-observable
scenarios** a tester must confirm against the running app. Group them as happy path,
edge cases, regression risks, and *not observable in the UI*. Written in the domain's
language (see `CONTEXT.md`) — never file paths or function names, because the QA agent
never reads the source.

These are the acceptance criteria for the arc, not a restatement of the chores. A chore's
`Proves` line is checked by a command; a testing note is checked by a human or by Quinn
driving a browser. `/qa-review` receives them as **must-cover scenarios** *in addition to*
its own adversarial exploration, and `/epic` checks them off at the very end.

If the plan's whole surface is invisible from the UI (an internal refactor, a background
job), say so explicitly under *not observable in the UI* rather than inventing UI
scenarios — that tells `/epic` to skip the browser pass instead of running a hollow one.

### 7. Flag undocumented decisions

If a chore depends on a decision that isn't captured anywhere (the plan assumes
it, but no ADR/`CONTEXT.md`/plan text pins it down), **stop and ask the user** what
to do — inline it into the chore, go capture it (`/grill-with-docs`), or confirm it
needs no doc. Do not invent the decision, and do not silently write an ADR.

### 8. Quiz the user, then write

Present the breakdown as a numbered list: each slice with its demoable outcome,
and its chores with agent tag + one-line description + depends-on. Then the
testing notes. Ask:

- Granularity right? (too coarse / too fine)
- Dependencies and `[main]` seams correct?
- Any chore that fails the four-part gate?
- Do the testing notes cover what you'd actually want a QA pass to try — and is
  anything listed as *not observable in the UI* that you think should be?

Iterate until the user approves. Then write the work order to
**`.claude/work-order.md`** (gitignored; override with a path argument if given),
using the template in [work-order-format.md](./work-order-format.md). Then
**mirror it into the native task list** — a parent task per slice, a child task per
chore, all `pending` — per [native-tasks.md](./native-tasks.md), so the breakdown
shows up in the UI as a task tree rather than only as checkboxes in a file. Finish
by telling the user the work order is ready and to run `/do-chores`.

## Completion criterion

The work order is written, every chore passes the four-part gate (including a
falsifiable `Proves` line), every cross-layer seam has a `[main]` chore, every
`depends-on` references a real chore ID, the `## Testing notes` section is present,
the native task list mirrors the work order (a parent task per slice, a child task
per chore), and the user has approved the breakdown.
