# 16. A tournament entry is soft-deleted, and an event's entry count is derived

Amended by [Accounts authorize durable Players](20260905-accounts-authorize-durable-players.md): sporting identity belongs
to Player; authentication and preserved historical authorship belong to Account.
The linked decision supersedes conflicting identity and merge-ownership clauses.


Date: 2026-07-11

## Status

Accepted

## Context

Tournament *setup* shipped in epic #595 — tournaments, events, tables, pools,
eligibility predicates, RBAC. Nothing lets a player actually **enter** an event.
Epic #780 ("Run the tournament") tracks the second half, and its first slice
(#781) is the load-bearing one: draw generation (#785, #786) cannot seed a bracket
until there are entrants to seed it with.

Two things are true of the code this lands on top of, and both shaped the decision.

**`TournamentEvent.entered` is a dead column.** It exists at every layer — the
`tournament_events` table, `TournamentEventRead`, and three places in the UI (the
event card's `52 / 64` numeral and fill bar, the "Entries" hero stat, and the
tournaments-list card's total). It is explicitly *not* patchable, and the schema
docstring calls it "server-managed". But the only writer in the entire API is the
literal `entered=0` at event creation. Against the real API every one of those UI
surfaces renders `0`, always. It is a counter with no incrementer — a placeholder
that was waiting for exactly this change.

**Every existing tournament mutation is owner-only.** Editing, publishing and
deleting all funnel through `_require_owner`; `can_edit` is just
`created_by_user_id == current_user.id`. This was deliberate — managing a
tournament is a property of ownership, not a role grant.

## Decision

### An event's entry count is derived, never stored

The `entered` column is **dropped** (fortymm is pre-deploy, so the original
tournaments migration is edited in place rather than chained with an `ALTER`), and
the count is computed from the live entries on read.

`entered` keeps its name and its position in `TournamentEventRead`, so the response
contract is unchanged and the three existing UI surfaces need no edit — they simply
start showing real numbers instead of `0`.

The tournament-list endpoint returns every tournament with all its events, so the
counts are gathered in **one grouped query across all events**, not one count per
event. This is the same N+1 rule ADR 0015 just enforced in match-details.

### Withdrawal is a soft-delete, guarded by a *partial* unique index

An entry carries a `status` of `entered` or `withdrawn`. Withdrawing flips the
status; the row survives.

The uniqueness guard is therefore a **partial** unique index:

```sql
UNIQUE (event_id, user_id) WHERE status = 'entered'
```

It says "at most one *active* entry per player per event" while permitting any
number of historical withdrawn rows.

### Self-registration gets its own permission

A new `tournament.enter` permission, granted to the Beta-tester role, gates entry.

### An entry is one row per user, so #781 is singles-only

Entering a doubles or teams event is rejected server-side, and the UI offers no
Enter control there.

## Consequences

### Deriving the count trades a join for a whole bug class

The stored counter would have had to be incremented on entry, decremented on
withdrawal, and held consistent under concurrent entries — a counter that can drift
from the rows it counts, whose drift is invisible until someone notices the bracket
has 63 players in a 64-slot event. Deriving it makes that class of bug
unrepresentable: there is no second copy of the truth to disagree with the first.

The cost is a `GROUP BY` on every tournament read. We are accepting it unmeasured,
which ADR 0015 is a cautionary tale about — so, concretely: the count is bounded by
`max_players` per event and the query is one statement regardless of event count. If
it ever shows up in a profile, the fix is a materialised counter *with* the drift
tests, not a return to the naive one.

### The partial index is the whole reason withdrawal works

This is the detail a reimplementation is most likely to get wrong, so it is worth
stating baldly: **a plain `UNIQUE (event_id, user_id)` is a bug.** Combined with
soft-delete, it would permanently lock a player out of an event they had ever
withdrawn from — the second entry attempt would collide with their own tombstoned
row. The enter → withdraw → re-enter journey walks straight into it, and it is the
single most important scenario in this slice's tests.

The alternatives were hard-delete on withdrawal (which works with a plain unique
index, but throws away the withdrawal history a tournament director will eventually
want) and reactivating the withdrawn row in place (which turns the create endpoint
into an upsert). The partial index keeps the create path a plain `INSERT` and keeps
the history.

Because the index is partial, the duplicate-entry check is **race-free without a
row lock**: two concurrent entries by the same player cannot both land, and the
loser surfaces as an `IntegrityError` → 409. There is deliberately no
`SELECT ... FOR UPDATE` here. Capacity (`max_players`) is a *different* race with a
different answer, and it is #783's problem, not this ADR's.

### Self-registration inverts the tournament auth model

It is the first non-owner mutation in the tournaments area, so it structurally
cannot use `_require_owner` — the whole point is that a player who does not own the
tournament is writing to it. `tournament.enter` carries that, and the route
additionally authorises that the entry being created or withdrawn is the caller's
*own*. Director-managed entries (#784) are the case where someone writes an entry
that is *not* their own, and that is exactly why it is a separate slice with a
separate permission story rather than a flag on this one.

### The account-merge trap

`merge_user` **tombstones** the ephemeral user rather than deleting it, so
`ON DELETE` never fires no matter what the FK says. A `user_id` FK that is not
explicitly handled in `account_merge.py` therefore leaves rows pointing at a ghost
user. Entries are re-pointed onto the survivor — and because of the partial unique
index, an event that **both** users had actively entered would collide on re-point,
so the loser's row is dropped. This is the same dedup-then-repoint shape
`MatchSidePlayer` already uses.

Nothing in #781's acceptance criteria mentions this. It is the one correctness-
critical item the issue omits, which is why it is called out here.

### Singles-only is a modelling limit, not a policy

One row per user cannot express a doubles pairing or a team — there is nowhere to
put the partner. Rather than ship a doubles flow that silently records half a pair,
non-singles events reject entry outright. Whoever adds doubles will need a
partner/team association, at which point `TournamentEntry` grows a sibling rather
than a nullable column.
