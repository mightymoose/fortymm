# An event's group rows are materialised from a derived count and mapped round-robin

Date: 2026-08-22 (date-numbered, because sequential numbers collide across
concurrent worktrees. See `scripts/check-adr-numbering.sh`)

## Status

Accepted. Decided in the discovery and planning for #1387, the second child of
#1370. Supersedes
20260808-an-events-pool-count-is-its-pool-rows-and-a-derived-count-is-a-projection.
That ADR decided that a derived count is reported and never materialised. This
ADR reverses that, because the rows it was protecting no longer carry a venue.

Builds on 20260808-a-structural-setting-is-owned-by-the-director-or-derived-by-the-system,
which records the ownership model, and on the split #1368 made: a group and a
reservation are separate rows, joined by a mapping row.

## Context

The superseded ADR was written when a pool was one row with two faces. It was
the set of entrants who play all-play-all, and it was the tables and the window
they play on. A derived count could not create such a row, because the
derivation supplies no name, no window and no tables. So the app reported the
gap instead.

#1368 split the row. A group is an ordered set of entrants, parented on its
stage. A reservation is a set of tables held for a window, parented on the
event. A join row maps one to the other. A group now needs nothing the
derivation cannot supply: a position, and nothing else.

#1386 built the derivation on both sides. The automatic group count is
`max(1, ceil(field / 5))`, and the reservation count plays no part in it. The
derivation has one production caller, which this ADR records.

Two numbers never meet. The derivation runs against the **preview field**: the
event's player cap, or 16 when it has none. The cut judges each group's size
against the **real registered field**. A 40-player cap derives 8 groups. Ten
registrants dealt across 8 groups give groups of 1, and the snake refuses the
draw. #1370 as written bricked the cut for every event whose field stayed under
about 40% of its cap, which includes the out-of-the-box event.

Only one draw type deals entrants into groups and shows the Draw structure tab.
`round_robin` deals into groups and shows no tab. `single_elim` and `swiss` deal
into no group at all.

## Decision

**The server materialises an event's group rows from a derived count, on every
event write. A group maps to the reservation at `position % reservation count`.
The cut re-derives the count from the real field once, then the set and the
mapping freeze.**

1. **The default group size is five.** The automatic count is
   `max(1, ceil(field / 5))`, #1386's derivation called with every structural
   setting automatic. This ADR writes no arithmetic of its own.

2. **The server owns the rows.** After every write to an `rr-then-ko` event with
   no draw, the event's stage-0 group row count equals the count the derivation
   returns for its preview field. No client sends a group list. A create and a
   patch reach the same rule, and a patch that carries only `max_players` or
   only `draw_type` reaches it too.

3. **The materialisation covers `rr-then-ko` only.** Every other draw type keeps
   one group per reservation, exactly as before. The seam holds two rules, and
   says so. Whether `round_robin` should run groups of five is a product
   question about that draw type.

4. **A group count creates no reservation.** An event with one reservation and a
   40-player cap holds 8 groups and 1 reservation.

5. **The mapping is round-robin.** A group at `position` maps to the reservation
   at `position % reservation count`. Eight groups across four reservations put
   two on each. A group on an event with no reservation carries no join row, and
   the join's three legs stay `NOT NULL`. "No reservation" is the absence of the
   row, never a null column on it.

6. **A shrink keeps the lowest positions.** Going from 8 groups to 2 keeps
   positions 0 and 1 and drops the tail, so the surviving labels and mapping
   agree with what the page showed.

7. **The cut re-derives from the real field.** `cut_draw` derives the count from
   the active entrants, and re-materialises the rows only when that count
   differs from the stored one. Ten registrants under a 40-player cap cut into 2
   groups of 5. For any field of 2 or more entrants, `ceil(N / 5)` groups over
   `N` entrants leave no group of one, so the snake's refusal is unreachable
   from the derived count.

8. **After the cut, nothing recomputes the count.** The freeze is a freeze on
   identities and on the mapping, which is what it already was. A
   `max_players` change on a cut event succeeds and moves no group row. A
   rename is never refused. `uncut_draw` writes no group row, so an uncut event
   keeps its cut-time count until the next event write re-materialises it from
   the preview field.

9. **A reservation added to or removed from a cut event answers 409.** A
   reservation added after the cut can hold no group, because the mapping froze
   there. Allowing it would book a table set the fixtures can never reach, with
   nothing on screen saying why. A reservation removed leaves the groups mapped
   to it with nowhere to play. The 409 names those groups by derived label, and
   says that a reservation's name, tables and window stay editable.

## Consequences

**The re-cut has two orderings, and the count decides which.** `cut_draw` plans
before it deletes, so a refused re-cut cannot destroy the standing draw. When
the derived count holds, that ordering stands and nothing is written before the
plan. When the count moves on a re-cut, a fixture foreign-keys its group, so
the old fixtures have to go before a group row can. That branch deletes first,
re-materialises, flushes, then plans, and the transaction rollback is the only
lock on a refused plan. A test pins that lock and was falsified against a
mid-branch commit.

**The uncut oscillation is intended.** Cut at 2 groups from 10 registrants,
uncut, then any event write returns the event to the 8 its cap derives. The
next cut returns it to 2.

**The Draw structure tab and the cut disagree.** The tab derives against the
preview field, so a 40-cap event with 10 registrants reads 8 groups and cuts
into 2. #1398 owns that disagreement.

**`groups[].reservation_id` is nullable on the wire.** Both generated clients
move with it, and the web client's parser accepts a null while still refusing a
non-null id that names no entry of `reservations[]`.

**The solver and the preview meet a group with no reservation.** A fixture in
such a group takes the event-wide reservation in the solver, the same door an
ungrouped fixture takes. The preview leaves such a fixture out of the schedule
shown. #1389 owns making that a first-class rule.

**`TournamentEvent.reservations` is eager.** The wire reads it, because the
group chain is neither complete nor duplicate-free once a group count and a
reservation count differ. The three pinned page reads each cost two more
statements.

**Superseded guidance that no longer applies.** The rule that a derived count in
excess of the rows is reported and never materialised is reversed. The two
consequences about a manual count being subject to the set freeze, and about
lowering one being destructive, described rows that carried a venue. A group
row carries none now, so lowering the cap removes group rows, writes no
reservation change, and shows no confirm.

## Alternatives considered

**Derive from the cap after the cut too, and refuse writes that would move the
count.** Rejected. A 40-cap event cut at 10 registrants holds 2 groups, the cap
derives 8, and every write to the event answers 409 forever. A rename is
refused.

**Derive from the real field after the cut.** Rejected. A walk-in moves the
count, and the next unrelated edit answers 409.

**Materialise for every draw type.** Rejected. `single_elim` and `swiss` would
take group rows nothing reads. `round_robin` would change meaning: a 40-cap
round-robin becomes eight mini round-robins with no knockout to join them.

**Relax the join row's `reservation_id` to nullable.** Rejected. The primary
key is the group's id alone, so an absent row already means "no reservation".
No migration was owed, and all three legs stay `NOT NULL`.

**Re-materialise on every cut, whether or not the count moved.** Rejected. When
the count holds, the mapping cannot have moved, because a reservation changes
only through an event write and every event write re-materialises. Writing
nothing keeps the plan-before-delete ordering for every cut that does not need
the other one.
