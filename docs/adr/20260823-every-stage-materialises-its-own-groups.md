# Every stage materialises its own groups

Date: 2026-08-23 (date-numbered — sequential numbers collide across concurrent
worktrees; see `scripts/check-adr-numbering.sh`)

## Status

Accepted. Decided during discovery for #1484, the third and last child of
#1316. Amends
20260822-an-events-group-rows-are-materialised-from-a-derived-count-and-mapped-round-robin
decision 3. Half-answers the open question left by
20260807-a-pool-restricts-scheduling-it-does-not-enable-it.

## Context

`TournamentEvent.groups` read only stage 0. A round-robin-then-knockout
event's knockout stage never held a group of its own, so a knockout fixture's
`group_id` was always `NULL`. A fixture with no group takes the event-wide
reservation — the whole venue, the whole tournament window — which is exactly
right for a single-elim or swiss event with no reservation at all, and exactly
wrong for a round-robin-then-knockout event whose director booked specific
tables. The #1348 QA pass caught this directly: an event whose only
reservation held two tables had its knockout final scheduled on a third table,
reserved by an unrelated event, while the two it actually booked sat empty.

20260822 gave the materialisation a derived count for `rr-then-ko`'s group
stage and left every other draw type at "one group per reservation." That
second half only ever produced one row in practice, because #1482 (recorded
here, since it shipped no ADR of its own) caps a non-composite event at one
reservation. It was never the rule that mattered; the rule that mattered was
"exactly one," stated as a count nobody derives.

## Decision

**A stage's group count is a property of the stage template, not of a
reservation count. Every stage materialises its groups, whatever its
position. No fixture is ever un-grouped.**

1. **The stage template carries the count source.** `stage_template`
   (`app.tournament_event_stages`) already tells an `rr-then-ko` event's two
   stages apart from a single-stage event's one. It now also says, per
   position, whether that stage's count is derived from the event's
   structural settings (`round_robin`'s `ceil(field / 5)`, floored at one) or
   is simply one. An `rr-then-ko` event's stage 0 and a standalone
   `round-robin` event's only stage share a component draw type
   (`round_robin`) but answer this differently — the source cannot be read off
   the component draw type alone, only off which template position it fills.
   `group_count_for` reads this declaration and no longer takes a reservation
   count at all: nothing derives from how many reservations an event holds.

2. **Every stage holds groups.** `materialise_event_groups` materialises
   every one of an event's stages, not stage 0 alone.
   `TournamentEvent.groups`'s `primaryjoin` no longer pins to
   `TournamentEventStage.position == 0`. A knockout stage of an `rr-then-ko`
   event now holds exactly one group, the same floor #1483 already gives a
   standalone single-elim or swiss stage.

3. **A knockout group carries no director-facing identity.** It has a
   position, so it can map to a reservation, but it is never labelled,
   ranked, or given its own panel — every reader that labels or ranks a group
   filters to the stages that seat both sides of every fixture at the cut
   (`seats_both_sides_at_cut`, #1483). Two groups now legitimately share
   `position: 0` in one event (the group stage's first pool and the knockout
   stage's sole group), and nothing that assumes a position is globally
   unique may see both without first partitioning by stage.

4. **`tournament_fixtures.group_id` is `NOT NULL`.** Once every stage holds a
   group, every fixture a draw plans belongs to one. The identity
   constraint's `NULLS NOT DISTINCT` existed only to give an un-grouped draw a
   uniqueness guard; with no un-grouped draw left to protect, it is dropped.

5. **A non-composite event holds at most one reservation** (#1482, recorded
   here because it shipped without an ADR). Combined with decision 1, this is
   what makes "one group per reservation" and "exactly one group" the same
   fact for those draw types now — the reservation count was never doing
   independent work.

## Consequences

**The #1348 sighting cannot recur.** A round-robin-then-knockout event's
knockout fixtures now resolve to whichever reservation their stage's group
maps onto — `position % reservation count`, the same round-robin mapping
20260822 already defined, applied here to a second stage for the first time.
With one reservation, the knockout group maps to it exactly as the group
stage's groups do.

**This half-answers 20260807's open question.** A reservation can now confine
a knockout stage's fixtures, where before nothing could. It does not give a
director an explicit control to choose *which* reservation the knockout uses
independent of the round-robin mapping — an `rr-then-ko` event with several
reservations still maps its sole knockout group to whichever reservation sits
at position 0. That remaining half stays open.

**The snake must be scoped per stage.** `draw_config` used to read
`event.groups` and hand every id it found straight to whichever strategy was
cutting. Once `event.groups` spans stages, a strategy that deals into groups
(`round_robin`, and the group half of `rr-then-ko`) may only be handed its own
stage's group ids — handing it the whole widened list would deal the field
across the knockout stage's group as if it were one more pool, corrupting the
standings the qualifiers are picked from. The composite strategy reads the
knockout stage's own group id through a separate, explicit channel rather
than by re-deriving it from the same list.

**Every surface that reads a group's identity now needs to know its stage.**
The wire's `GroupRead` gains `stage_id` so the freeze's 409 sentence, the
group-order rank map, the schedule preview's label map, and the client's
group panels can all filter to group-stage groups without re-deriving a
group's stage from context.

**A round-robin event's group count stays fixed at one, not
director-chosen.** Whether a standalone `round-robin` event should ever run
more than one group is unchanged by this ADR — see #1316 Open Question 4.

## Alternatives considered

**Key the count source on the stage's own component draw type.** Rejected.
An `rr-then-ko` event's stage 0 and a standalone `round-robin` event's only
stage are both `round_robin` components, and they must answer differently —
`ceil(field / 5)` against one. Only the template position, keyed on the
*event's* draw type, can tell them apart.

**Key the count source on the event's draw type at each call site.**
Rejected. `group_count_for` would need to compare against
`DrawType.rr_then_ko` explicitly, which is exactly the kind of ad hoc branch
`stage_template`'s exhaustive `match` exists to prevent — a fifth draw type
would have no forcing function to declare its own answer.

**Give a knockout group a derived label from its stage.** Rejected. It still
prints two "Group A"s in the freeze's 409 sentence, and it still shows a
director a group panel for a bracket that has no groups in the director-facing
sense.
