# A placement names a real table, and only that is an invariant

Date: 2026-08-01 (date-numbered — sequential numbers collide across concurrent
worktrees; see `scripts/check-adr-numbering.sh`)

## Status

Accepted. **Supersedes one narrow clause of ADR-0790** ("a called match holds its
table and slides later") and the corresponding sentence of `CONTEXT.md`'s
**Placement** entry. Everything else in ADR-0790 stands. Decided during the grill
for #1226, which normalizes pools and tables into real tables.

## Context

ADR-0790 made a placement **soft**: a table and a predicted start, whose
constraints — the table belongs to the fixture's pool, the time falls inside the
pool's window, nothing is double-booked — are **flags derived on read, never
invariants**. That was the right call and remains so. A pool's tables and window
stay editable under a standing draw precisely because the venue changes under a
running tournament, and a placement a later edit outranges is a flag, not a
refusal.

But ADR-0790 also swept a fourth, weaker claim into the same rule.
`TournamentFixturePlacementUpdate` says it outright: this write "does **not**
reject … a `table_id` that names no table in the tournament's `table_catalogue`
(a later pool/catalogue edit can dangle the ref; that is a flag-on-read
concern)". A placement naming a table that does not exist was **stored, not
rejected** — measured, deliberate, documented.

That was defensible while the catalogue was JSONB and `table_id` was a string ref
with nothing to foreign-key. #1226 removes that excuse: `tournament_tables`
becomes a real table. A real FK on `tournament_fixtures.table_id` makes the
dangling ref unrepresentable — which reads, without this ADR, as a straight
violation of a decision the codebase states in three places.

The catalogue's write semantics make it sharper still. `table_catalogue`
"replaces wholesale when present" on PATCH, so *every* catalogue edit today is a
delete-and-recreate of the whole list. Under a FK that stops being implementable
as a replace at all.

## Decision

**"Names a real table" is an invariant. Everything else about a placement stays a
flag.** The two claims are different in kind and get different enforcement:

| Claim | Kind | Enforcement |
| --- | --- | --- |
| the table **exists** | invariant | FK — a bogus `table_id` is a **422**, not a store |
| the table belongs to the fixture's pool | flag | derived on read, as today |
| the start falls inside the pool's window | flag | derived on read, as today |
| nothing is double-booked | flag | derived on read, as today |

The three flags are all statements about a *relationship* between things that
each legitimately move — a pool's tables, its window, another match's time. They
have to stay soft, because the director edits one side while the other stands.

"This id names a table" is not that. It is a statement about whether the
reference **resolves at all**, and a placement whose table does not exist is not
a placement in a state the director chose — it is a dangling pointer. Nothing
downstream can render it, no flag can repair it, and the only honest thing to
show for it is the absence of a table. It should always have been an invariant;
it was soft only because there was no table to point at.

**Removing a table behaves differently depending on who is holding it**, and the
split is the point:

- **A pool that reserves it** → `ON DELETE CASCADE` on
  `tournament_event_pool_tables`. The table quietly drops out of the pools that
  reserved it. This is the case `CONTEXT.md` names by hand — "a table breaks, a
  table frees up" — and it is why a pool's tables stay editable mid-event.
- **A fixture placed at it** → `ON DELETE RESTRICT`, surfaced as a **named 409**
  in the same house style as the pool-set freeze (name the things, then name the
  way out), with an explicit unplace-and-remove opt-in on the verb.

Placements get the louder treatment because silently `SET NULL`-ing one destroys
information on an *unrelated* write: the fixture stops being "placed at a table
that vanished" and becomes indistinguishable from "nobody ever placed this", as
an invisible side effect of editing the venue. The database refuses by default;
the director says yes on purpose.

## Consequences

`table_catalogue`'s wholesale replace becomes a **diff**. A PATCH that omits a
table is now a delete, and a delete can be refused, so the verb has to compute
what changed rather than assign a list.

The refusal is new API surface — a 409 the web client must handle and a confirm
step in the tables tab that does not exist today. That is the honest cost of the
decision, and it is smaller than the alternative: a director who cannot remove a
broken table at all, or one whose schedule silently emptied itself.

`ValueObjectId`'s reason for existing goes with it. It was an
`Annotated[str, Field(min_length=1)]` whose docstring says it exists *only*
because "pools and tables have no tables of their own". They do now.

This ADR does **not** reopen ADR-0790's soft-placement rule in general. A
placement is still a prediction rather than a promise; a match beginning earlier
or later is still normal; a pool edit that outranges a placement is still a flag.
The one thing that changes is that the table it names is now guaranteed to be a
table.
