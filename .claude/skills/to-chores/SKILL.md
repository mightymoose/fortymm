---
name: to-chores
description: Break an agreed plan into a work order of small, agent-tagged chores grouped under tracer-bullet slices, for the domain-expert subagents to implement. Decompose-only — writes the work order and stops; run /do-chores to drive it.
disable-model-invocation: true
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
   when the chore is done.
4. **Fits one context window** — if the agent would have to read a large slice of
   the codebase to do it, it's too big; split it, or point it at an ADR that
   already carries the decision.

Describe each chore as **behavior + surface, never hard file paths** (they go
stale; the agent is a domain expert and auto-loads its unit `CLAUDE.md`). Inline a
snippet only when it encodes a decision prose can't (a type shape, a schema).

### 6. Flag undocumented decisions

If a chore depends on a decision that isn't captured anywhere (the plan assumes
it, but no ADR/`CONTEXT.md`/plan text pins it down), **stop and ask the user** what
to do — inline it into the chore, go capture it (`/grill-with-docs`), or confirm it
needs no doc. Do not invent the decision, and do not silently write an ADR.

### 7. Quiz the user, then write

Present the breakdown as a numbered list: each slice with its demoable outcome,
and its chores with agent tag + one-line description + depends-on. Ask:

- Granularity right? (too coarse / too fine)
- Dependencies and `[main]` seams correct?
- Any chore that fails the four-part gate?

Iterate until the user approves. Then write the work order to
**`.claude/work-order.md`** (gitignored; override with a path argument if given),
using the template in [work-order-format.md](./work-order-format.md). Finish by
telling the user the work order is ready and to run `/do-chores`.

## Completion criterion

The work order is written, every chore passes the four-part gate, every
cross-layer seam has a `[main]` chore, every `depends-on` references a real chore
ID, and the user has approved the breakdown.
